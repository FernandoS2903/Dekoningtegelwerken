// De wachtrij van website-aanvragen: elke aanvraag krijgt twee uitgangen,
// de mail naar de mailbox (vangnet, via Graph vanuit info@ naar info@) en
// het doorsturen naar Offerteknop. Mislukt iets, dan komt het later terug
// met een oplopende wachttijd; de bezoeker merkt daar niets van (die heeft
// al een bevestiging). Zolang een koppeling niet is ingesteld, blijft die
// uitgang gewoon wachten, zonder dat dat als fout telt.
//
// Eén ronde per keer; de dienst roept `ronde()` elke minuut aan en direct na
// een nieuwe aanvraag.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { naarContract, nietMeegestuurdTekst, samenvatting, verdeelBijlagen } from './aanvraag-velden.mjs';

export const MAX_POGINGEN = 30;
export const MAX_POGINGEN_AUTH = 6;
// Graph accepteert bij sendMail ongeveer 3 MB aan bijlagen; daarboven blijft
// een bestand uit de mail en wordt het alleen genoemd.
export const MAIL_BIJLAGEN = Object.freeze({ aantal: 20, perStuk: 3 * 1024 * 1024, samen: 3 * 1024 * 1024 });
const MAIL_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

// 1, 2, 4, 8, 16, 32, 60, 60, ... minuten.
export const wachtMinuten = (poging) => Math.min(2 ** Math.max(0, poging - 1), 60);

export function maakWachtrij({ aanvraagOpslag, koppeling, mail = null, mailNaar = '', log = () => {}, nu = () => Date.now() }) {
  let bezig = false;
  const mailKlaar = () => Boolean(mail && mail.beschikbaar && typeof mail.verstuurMail === 'function' && (mailNaar || mail.adres));

  function leesBestand(aanvraag, b) {
    if (!aanvraag.bestandsmap || !b.bestand) return null;
    return readFileSync(path.join(aanvraag.bestandsmap, path.basename(b.bestand)));
  }

  // -- uitgang 1: de mail ----------------------------------------------------
  async function verstuurMail(aanvraag) {
    const sv = samenvatting(aanvraag.velden, aanvraag.bestanden);
    const { mee, niet } = verdeelBijlagen(aanvraag.bestanden, MAIL_BIJLAGEN, MAIL_TYPES);
    const bijlagen = [];
    const nietGelezen = [];
    for (const b of mee) {
      try {
        bijlagen.push({ naam: b.naam, type: b.type, inhoud_b64: leesBestand(aanvraag, b).toString('base64') });
      } catch {
        nietGelezen.push({ ...b, reden: 'niet meer op de schijf' });
      }
    }
    const regels = [
      sv.tekst,
      '',
      `Aanvraag ${aanvraag.referentie}, ontvangen ${aanvraag.tijd} via dekoningtegelwerken.nl/offerte/.`,
      'Deze aanvraag staat ook in Offerteknop als "Nieuwe aanvraag" (of komt daar zodra de koppeling hem heeft doorgestuurd).',
    ];
    const buiten = [...niet, ...nietGelezen];
    if (buiten.length) regels.push('', nietMeegestuurdTekst(buiten) + '. Alle bestanden gaan wel naar Offerteknop als ze binnen die grenzen vallen.');
    await mail.verstuurMail({
      aan: mailNaar || mail.adres,
      onderwerp: sv.titel,
      tekst: regels.join('\n'),
      replyTo: aanvraag.velden.email || null,
      bijlagen,
    });
    return { bijlagen: bijlagen.length, buiten: buiten.length };
  }

  // -- uitgang 2: Offerteknop ---------------------------------------------------
  async function stuurDoor(aanvraag) {
    const { mee, niet } = verdeelBijlagen(aanvraag.bestanden);
    const bijlagen = [];
    const nietGelezen = [];
    for (const b of mee) {
      try {
        bijlagen.push({ ...b, inhoud_b64: leesBestand(aanvraag, b).toString('base64') });
      } catch {
        nietGelezen.push({ ...b, reden: 'niet meer op de schijf' });
      }
    }
    return koppeling.stuur(naarContract(aanvraag, { bijlagen, niet: [...niet, ...nietGelezen] }));
  }

  // Eén aanvraag: probeert wat nog open staat en beschikbaar is. Geeft true
  // als er iets geprobeerd is.
  async function verwerk(aanvraag) {
    const id = aanvraag.id;
    let geprobeerd = false;
    let mislukt = false;
    let wachtMs = null;
    let auth = false;

    if (aanvraag.mail_status === 'wacht' && mailKlaar()) {
      geprobeerd = true;
      try {
        const uit = await verstuurMail(aanvraag);
        aanvraagOpslag.zetMail(id, 'verzonden');
        log('info', `Aanvraag #${id}: mail naar de mailbox verstuurd (${uit.bijlagen} bijlage${uit.bijlagen === 1 ? '' : 'n'}${uit.buiten ? `, ${uit.buiten} niet meegestuurd` : ''}).`);
      } catch (fout) {
        mislukt = true;
        aanvraagOpslag.zetMail(id, 'wacht', { fout: fout.message });
        log('warn', `Aanvraag #${id}: mail versturen mislukt (poging ${aanvraag.pogingen + 1}): ${fout.message}`);
      }
    }

    if (aanvraag.koppeling_status === 'wacht' && koppeling.beschikbaar) {
      geprobeerd = true;
      const uit = await stuurDoor(aanvraag);
      if (uit.uitkomst === 'klaar') {
        aanvraagOpslag.zetKoppeling(id, 'klaar', { offerteId: uit.offerteId, nummer: uit.nummer });
        const weg = (uit.bijlagen || []).filter((b) => b && b.opgenomen === false).length;
        log('info', `Aanvraag #${id}: doorgestuurd naar Offerteknop${uit.nummer ? ' (' + uit.nummer + ')' : ''}${uit.bestaand ? ', bestond daar al' : ''}${weg ? `, ${weg} bijlage${weg === 1 ? '' : 'n'} daar niet opgenomen` : ''}.`);
      } else if (uit.uitkomst === 'stop') {
        aanvraagOpslag.zetKoppeling(id, 'gestopt', { fout: uit.fout });
        log('error', `Aanvraag #${id}: Offerteknop weigert de aanvraag, niet opnieuw geprobeerd: ${uit.fout}`);
      } else {
        mislukt = true;
        auth = uit.uitkomst === 'auth';
        wachtMs = uit.wachtMs ?? null;
        aanvraagOpslag.zetKoppeling(id, 'wacht', { fout: uit.fout });
        log(auth ? 'error' : 'warn', `Aanvraag #${id}: doorsturen naar Offerteknop mislukt (poging ${aanvraag.pogingen + 1}): ${uit.fout}`);
      }
    }

    if (!geprobeerd) return false; // niets beschikbaar: later, telt niet als poging
    if (!mislukt) {
      aanvraagOpslag.zetPoging(id, { pogingen: aanvraag.pogingen, volgendePoging: null });
      return true;
    }
    const pogingen = aanvraag.pogingen + 1;
    if (pogingen >= MAX_POGINGEN || (auth && pogingen >= MAX_POGINGEN_AUTH)) {
      const vers = aanvraagOpslag.aanvraag(id);
      if (vers.mail_status === 'wacht') aanvraagOpslag.zetMail(id, 'gestopt', { fout: `na ${pogingen} pogingen gestopt: ${vers.mail_fout || ''}` });
      if (vers.koppeling_status === 'wacht') aanvraagOpslag.zetKoppeling(id, 'gestopt', { fout: `na ${pogingen} pogingen gestopt: ${vers.koppeling_fout || ''}` });
      aanvraagOpslag.zetPoging(id, { pogingen, volgendePoging: null });
      log('error', `Aanvraag #${id}: na ${pogingen} pogingen gestopt. De aanvraag staat in de database en op de schijf (${aanvraag.bestandsmap || 'zonder bestanden'}).`);
      return true;
    }
    const ms = wachtMs ?? wachtMinuten(pogingen) * 60 * 1000;
    aanvraagOpslag.zetPoging(id, { pogingen, volgendePoging: isoVan(nu() + ms) });
    return true;
  }

  const isoVan = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  async function ronde() {
    if (bezig) return { overgeslagen: true };
    bezig = true;
    let n = 0;
    try {
      // Zonder beschikbare uitgang is er niets te doen; dan ook geen rijen
      // ophalen (en geen logregels elke minuut).
      if (!mailKlaar() && !koppeling.beschikbaar) return { verwerkt: 0 };
      for (const aanvraag of aanvraagOpslag.teDoen(isoVan(nu()), 20)) {
        try {
          if (await verwerk(aanvraag)) n++;
        } catch (fout) {
          log('error', `Aanvraag #${aanvraag.id}: onverwachte fout in de wachtrij: ${fout.message}`);
        }
      }
      return { verwerkt: n };
    } finally {
      bezig = false;
    }
  }

  return { ronde, bezig: () => bezig, mailKlaar };
}
