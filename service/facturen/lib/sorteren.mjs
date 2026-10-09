// De mailsorteerder: nieuwe mail in de Inbox in de juiste map zetten.
//
// Eén ronde:
//  1. delta query op de Inbox. De allereerste ronde legt alleen een startpunt
//     vast ("nu"); bestaande inboxmail wordt nooit gesorteerd.
//  2. per nieuwe mail:
//     - overslaan (blijft staan, niet beoordelen): agenda, gemarkeerd, concept,
//       mail van de eigen mailbox of het eigen domein;
//     - beslissen, in deze volgorde: regel uit de database (adres wint van
//       domein, een regel wint altijd) -> website-afzender (Offerteaanvragen,
//       zonder AI) -> Claude;
//     - uitvoeren: zekerheid >= drempel -> verplaatsen en het nieuwe id
//       bewaren; daaronder blijft de mail staan met categorie "Controleren".
//  3. de nieuwe deltaLink bewaren.
//
// Nooit verwijderen, nooit als gelezen markeren. Een mislukte classificatie
// laat de mail ongemoeid en komt als fout in het logboek. Er draait nooit
// meer dan één ronde tegelijk; komt er tijdens een ronde een seintje van de
// webhook, dan volgt er direct daarna nog één.
//
// De sorteerder praat alleen via de mailinterface (lib/mail/koppeling.mjs).

import { INBOX } from './mail/koppeling.mjs';
import { INBOX_NAAM } from './classificeer.mjs';
import { SORTEER_MAPPEN } from './instellingen.mjs';
import { domeinVan, normaliseerAdres } from './sorteer-opslag.mjs';
import { nuIso } from './hulp.mjs';

export const CATEGORIE_CONTROLEREN = 'Controleren';
export const MAPNAMEN = SORTEER_MAPPEN.map((m) => m.naam);
export const FACTUREN_MAP = 'Facturen';

export function maakSorteerder({
  sorteerOpslag,
  mail,
  classificeerder = null,
  instellingenLezer,
  log = () => {},
  nu = () => nuIso(),
}) {
  const eigenAdres = normaliseerAdres(mail?.adres);
  const eigenDomein = eigenAdres ? domeinVan(eigenAdres) : '';

  let bezig = false;
  let nogEens = false;
  let lopend = null;
  const mapIds = new Map();

  // -- mappen ------------------------------------------------------------
  // Facturen is de map die het factuurdashboard leest (M365_FOLDER, mag
  // genest zijn); die maken we nooit aan. De rest wordt aangemaakt als hij
  // aan staat en nog ontbreekt.
  async function mapId(naam, { aanmaken = true } = {}) {
    if (naam === INBOX_NAAM) return INBOX;
    if (mapIds.has(naam)) return mapIds.get(naam);
    let id = null;
    if (naam === FACTUREN_MAP) {
      id = (await mail.mapInfo()).id;
    } else if (aanmaken) {
      const uit = await mail.mapAanmaken(naam);
      if (uit.nieuw) log('info', `Map "${naam}" aangemaakt onder Inbox.`);
      id = uit.id;
    } else {
      id = (await mail.mapZoeken(naam))?.id || null;
    }
    if (id) mapIds.set(naam, id);
    return id;
  }

  async function zorgVoorMappen(inst) {
    for (const naam of MAPNAMEN) {
      if (inst.sorteerMappen[naam]) await mapId(naam);
    }
  }

  // Voor "Verbindingen testen": bestaat elke map? Maakt niets aan.
  async function controleerMappen() {
    const uit = [];
    for (const naam of MAPNAMEN) {
      try {
        const id = naam === FACTUREN_MAP ? (await mail.mapInfo()).id : (await mail.mapZoeken(naam))?.id;
        uit.push({ naam, bestaat: Boolean(id) });
      } catch (fout) {
        uit.push({ naam, bestaat: false, fout: fout.message });
      }
    }
    return uit;
  }

  // -- beslissen ---------------------------------------------------------
  function overslaanReden(bericht) {
    if (bericht.soort === 'agenda') return 'agenda-uitnodiging';
    if (bericht.gemarkeerd) return 'gemarkeerd';
    if (bericht.concept) return 'concept';
    const adres = bericht.afzender.adres;
    if (eigenAdres && adres === eigenAdres) return 'van de eigen mailbox';
    return null;
  }

  // Mail van het eigen domein slaan we over, behalve als Bob het adres zelf
  // als regel of website-afzender heeft opgegeven (bijvoorbeeld het
  // afzenderadres van het offerteformulier).
  function eigenDomeinOverslaan(bericht, inst) {
    const adres = bericht.afzender.adres;
    if (!eigenDomein || domeinVan(adres) !== eigenDomein) return false;
    const regel = sorteerOpslag.regelVoor(adres);
    if (regel && regel.soort === 'adres') return false;
    if (inst.websiteAfzenders.includes(adres)) return false;
    return true;
  }

  function isWebsite(adres, inst) {
    const domein = domeinVan(adres);
    return inst.websiteAfzenders.some((a) => (a.includes('@') ? a === adres : (domein === a || domein.endsWith('.' + a))));
  }

  async function beslis(bericht, inst) {
    const adres = bericht.afzender.adres;

    const regel = sorteerOpslag.regelVoor(adres);
    if (regel) {
      return { bron: 'regel', map: regel.map, zekerheid: 1, reden: `regel op ${regel.soort} ${regel.waarde}` };
    }

    if (adres && isWebsite(adres, inst)) {
      return { bron: 'website', map: 'Offerteaanvragen', zekerheid: 1, reden: 'afzender staat bij de website-afzenders' };
    }

    if (!classificeerder || !classificeerder.beschikbaar) {
      return { bron: 'ai', map: null, zekerheid: null, reden: 'geen Claude-sleutel ingesteld', nietBeoordeeld: true };
    }

    const { tekst, bijlagen } = await mail.inhoud(bericht.id, { metBijlagen: bericht.heeftBijlagen });
    const uit = await classificeerder.classificeer({
      afzender: [bericht.afzender.naam, bericht.afzender.adres ? `<${bericht.afzender.adres}>` : ''].filter(Boolean).join(' '),
      onderwerp: bericht.onderwerp,
      tekst,
      bijlagen,
      mappen: MAPNAMEN,
    });
    return { bron: 'ai', ...uit };
  }

  // -- één mail ------------------------------------------------------------
  async function verwerk(bericht, inst, telling) {
    const basis = {
      message_id: bericht.id,
      internet_id: bericht.internetId,
      ontvangen: bericht.ontvangen,
      afzender_naam: bericht.afzender.naam,
      afzender: bericht.afzender.adres,
      onderwerp: bericht.onderwerp,
      van_map: INBOX_NAAM,
    };

    const overslaan = overslaanReden(bericht) || (eigenDomeinOverslaan(bericht, inst) ? 'van het eigen domein' : null);
    if (overslaan) {
      sorteerOpslag.log({ ...basis, bron: 'overgeslagen', status: 'overgeslagen', reden: overslaan });
      telling.overgeslagen++;
      return;
    }

    let besluit;
    try {
      besluit = await beslis(bericht, inst);
    } catch (fout) {
      sorteerOpslag.log({ ...basis, bron: 'ai', status: 'fout', reden: 'beoordelen mislukt', fout: fout.message });
      log('error', `Sorteren: beoordelen mislukt voor een mail van ${bericht.afzender.adres || 'onbekend'}: ${fout.message}`);
      telling.fouten++;
      return;
    }

    const rij = { ...basis, bron: besluit.bron, naar_map: besluit.map, zekerheid: besluit.zekerheid, reden: besluit.reden };

    if (besluit.nietBeoordeeld) {
      sorteerOpslag.log({ ...rij, status: 'niet beoordeeld' });
      telling.nietBeoordeeld++;
      return;
    }

    try {
      // Twijfel: blijft staan, met een categorie zodat hij opvalt in Outlook.
      if (besluit.bron === 'ai' && besluit.zekerheid < inst.sorteerDrempel) {
        await mail.categorie(bericht.id, CATEGORIE_CONTROLEREN);
        sorteerOpslag.log({ ...rij, status: 'controleren' });
        telling.controleren++;
        return;
      }

      if (besluit.map === INBOX_NAAM) {
        sorteerOpslag.log({ ...rij, status: 'inbox' });
        telling.inbox++;
        return;
      }

      if (!inst.sorteerMappen[besluit.map]) {
        sorteerOpslag.log({ ...rij, status: 'map uit', reden: `${besluit.reden} (map staat uit)` });
        telling.inbox++;
        return;
      }

      const doel = await mapId(besluit.map);
      if (!doel) throw new Error(`map "${besluit.map}" niet gevonden`);
      const nieuwId = await mail.verplaats(bericht.id, doel);
      sorteerOpslag.log({ ...rij, huidig_id: nieuwId, huidige_map: besluit.map, status: 'verplaatst' });
      telling.verplaatst++;
    } catch (fout) {
      // Mappen opnieuw opzoeken: misschien is er een weggegooid of hernoemd.
      mapIds.clear();
      sorteerOpslag.log({ ...rij, status: 'fout', fout: fout.message });
      log('error', `Sorteren: verplaatsen of categorie zetten mislukt: ${fout.message}`);
      telling.fouten++;
    }
  }

  // -- een ronde -----------------------------------------------------------
  async function ronde(aanleiding) {
    const inst = instellingenLezer();
    if (!inst.sorteren) return { uit: true };
    if (!mail || !mail.beschikbaar) return { overgeslagen: 'mailkoppeling niet ingesteld' };

    const deltaLink = sorteerOpslag.staat('delta_link');
    if (!deltaLink) return startpunt('eerste ronde');

    await zorgVoorMappen(inst);

    let uit;
    try {
      uit = await mail.nieuweBerichten({ deltaLink });
    } catch (fout) {
      if (!fout.verlopen) throw fout;
      log('warn', 'Sorteren: de deltaLink was verlopen; er is een nieuw startpunt vastgelegd. Mail van tussendoor is niet gesorteerd.');
      return startpunt('deltaLink verlopen');
    }

    const startmoment = sorteerOpslag.staat('startmoment') || '';
    const telling = { aanleiding, bekeken: 0, verplaatst: 0, controleren: 0, inbox: 0, overgeslagen: 0, nietBeoordeeld: 0, fouten: 0 };

    for (const bericht of uit.berichten) {
      if (bericht.verwijderd) continue;
      // Al eens langs geweest (ook na terugzetten, dan met een nieuw id).
      if (sorteerOpslag.alGezien({ internetId: bericht.internetId, id: bericht.id })) continue;
      // Een oude mail die alleen gewijzigd is (gelezen, vlag eraf) is niet nieuw.
      if (startmoment && bericht.ontvangen && bericht.ontvangen < startmoment) continue;
      telling.bekeken++;
      await verwerk(bericht, inst, telling);
    }

    sorteerOpslag.zetStaat('delta_link', uit.deltaLink);
    return telling;
  }

  async function startpunt(waarom) {
    const vanaf = nu();
    const uit = await mail.nieuweBerichten({ deltaLink: null, vanaf });
    sorteerOpslag.zetStaat('delta_link', uit.deltaLink);
    sorteerOpslag.zetStaat('startmoment', vanaf);
    log('info', `Sorteren: startpunt vastgelegd (${waarom}); alleen mail vanaf nu wordt gesorteerd.`);
    return { startpunt: true };
  }

  async function draai({ aanleiding = 'timer' } = {}) {
    if (bezig) {
      nogEens = true;
      return { bezig: true };
    }
    bezig = true;
    const gestart = nu();
    let resultaat;
    try {
      resultaat = await ronde(aanleiding);
    } catch (fout) {
      resultaat = { fout: fout.message };
      log('error', 'Sorteerronde mislukt: ' + fout.message);
    } finally {
      bezig = false;
    }
    sorteerOpslag.zetStaat('laatste_ronde', JSON.stringify({ gestart, klaar: nu(), ...resultaat }));

    if (nogEens) {
      nogEens = false;
      lopend = draai({ aanleiding: 'na vorige ronde' });
    }
    return resultaat;
  }

  // -- handwerk vanuit het logboek ------------------------------------------
  // Beide acties werken op het huidige id van de mail en leggen zelf een
  // regel met bron "handmatig" vast.
  async function verplaatsHandmatig(logId, naar, { altijd = '', gebruiker = '' } = {}) {
    const rij = sorteerOpslag.logRegel(logId);
    if (!rij) throw new Error('die regel bestaat niet (meer)');
    if (rij.bron === 'handmatig') throw new Error('dit is zelf al een correctie; gebruik de oorspronkelijke regel');
    if (![...MAPNAMEN, INBOX_NAAM].includes(naar)) throw new Error('onbekende map');
    const huidig = rij.huidig_id || rij.message_id;
    const waar = rij.huidige_map || INBOX_NAAM;

    let nieuwId = huidig;
    if (naar !== waar) {
      const doel = await mapId(naar);
      if (!doel) throw new Error(`map "${naar}" niet gevonden`);
      nieuwId = await mail.verplaats(huidig, doel);
    }

    const status = naar === INBOX_NAAM ? 'teruggezet' : 'gecorrigeerd';
    sorteerOpslag.zetHuidig(rij.id, { huidig_id: nieuwId, huidige_map: naar, status });
    sorteerOpslag.log({
      message_id: rij.message_id, huidig_id: nieuwId, internet_id: rij.internet_id, ontvangen: rij.ontvangen,
      afzender_naam: rij.afzender_naam, afzender: rij.afzender, onderwerp: rij.onderwerp,
      van_map: waar, naar_map: naar, huidige_map: naar, bron: 'handmatig', status,
      reden: `${status === 'teruggezet' ? 'teruggezet' : 'andere map'}${gebruiker ? ' door ' + gebruiker : ''}`,
    });

    let regel = null;
    if ((altijd === 'adres' || altijd === 'domein') && rij.afzender) {
      regel = sorteerOpslag.voegRegelToe({ soort: altijd, waarde: rij.afzender, map: naar, door: gebruiker || null });
      log('info', `Sorteerregel: ${regel.soort} ${regel.waarde} -> ${regel.map}${gebruiker ? ' (' + gebruiker + ')' : ''}`);
    }
    return { nieuwId, regel };
  }

  return {
    draai,
    bezig: () => bezig,
    // Alleen voor de tests: wacht ook een ingeplande vervolgronde af.
    async klaar() { while (lopend) { const p = lopend; lopend = null; await p; } },
    terugzetten: (logId, opties = {}) => verplaatsHandmatig(logId, INBOX_NAAM, opties),
    andereMap: verplaatsHandmatig,
    controleerMappen,
    status() {
      let laatste = null;
      try { laatste = JSON.parse(sorteerOpslag.staat('laatste_ronde') || 'null'); } catch { /* kapot */ }
      return {
        startmoment: sorteerOpslag.staat('startmoment'),
        heeftStartpunt: Boolean(sorteerOpslag.staat('delta_link')),
        laatste,
        model: classificeerder?.beschikbaar ? classificeerder.model : null,
      };
    },
  };
}
