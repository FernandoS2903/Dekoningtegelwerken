// Het onderdeel Mail van het portaal: logboek, regels en instellingen van de
// mailsorteerder. Zelfde opzet als maakFacturenApp in server.mjs:
// `handle(req, res, ctx)` doet alleen dit onderdeel; inloggen en CSRF regelt
// het portaal.

import * as instellingen from './lib/instellingen.mjs';
import { domeinVan, normaliseerAdres } from './lib/sorteer-opslag.mjs';
import { INBOX_NAAM } from './lib/classificeer.mjs';
import { nuIso } from './lib/hulp.mjs';
import { kop, leesBody, meldingenUit, stuurHtml, stuurTekst } from './lib/web.mjs';
import { BRON_NAAM, STATUS_NAAM, logboekPagina, mailInstellingenPagina, regelsPagina } from './web/mail.mjs';
import { offerteknopPad } from './lib/offerteknop.mjs';

const MELDINGEN = {
  gestart: ['info', 'De ronde is gestart. Vernieuw de pagina over een paar seconden.'],
  bezig: ['info', 'Er loopt al een ronde; even wachten.'],
  teruggezet: ['goed', 'De mail staat weer in de Inbox.'],
  verplaatst: ['goed', 'De mail is verplaatst.'],
  'verplaatst-regel': ['goed', 'De mail is verplaatst en er is een regel gemaakt voor de volgende keer.'],
  'actie-fout': ['fout', 'Dat lukte niet. De reden staat in het logboek onder Facturen › Instellingen.'],
  'offerte-fout': ['fout', 'De concept-offerte kon niet gemaakt worden. De reden staat in het logboek onder Facturen › Instellingen.'],
  'offerte-niet-ingesteld': ['fout', 'De koppeling met Offerteknop is niet ingesteld.'],
  'regel-toegevoegd': ['goed', 'Regel opgeslagen.'],
  'regel-weg': ['goed', 'Regel verwijderd.'],
  opgeslagen: ['goed', 'Instellingen opgeslagen.'],
};

const IS_ADRES = /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/;
const IS_DOMEIN = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const DOELEN = [...instellingen.SORTEER_MAPPEN.map((m) => m.naam), INBOX_NAAM];

export function maakMailApp({
  opslag,
  sorteerOpslag,
  sorteerder,
  webhook,
  mail,
  classificeerder = null,
  offertes = null,
  basisPad = '/mail',
  sorteerMinuten = 5,
}) {
  const basis = basisPad.replace(/\/+$/, '');

  function terug(res, pad, code) {
    kop(res, 303, 'text/plain; charset=utf-8', { location: basis + pad + (code ? (pad.includes('?') ? '&' : '?') + 'm=' + code : '') });
    res.end('');
  }

  const keuze = (waarde, lijst) => (lijst.includes(waarde) ? waarde : '');

  async function handle(req, res, ctx = {}) {
    const kader = ctx.kader || null;
    const gebruiker = kader?.email || kader?.naam || '';
    const lees = () => (ctx.body ? Promise.resolve(ctx.body) : leesBody(req));
    const url = new URL(req.url, 'http://localhost');
    let pad = url.pathname;
    if (basis && pad.startsWith(basis)) pad = pad.slice(basis.length) || '/';
    if (pad.length > 1 && pad.endsWith('/')) pad = pad.slice(0, -1);
    const meldingen = meldingenUit(url.searchParams, MELDINGEN);
    const gemeen = { basis, kader, webhook: webhook.status(), status: sorteerder.status(), minuten: sorteerMinuten };

    // -- logboek ---------------------------------------------------------
    if (pad === '/' && req.method === 'GET') {
      const filter = {
        map: keuze(url.searchParams.get('map') || '', DOELEN),
        bron: keuze(url.searchParams.get('bron') || '', Object.keys(BRON_NAAM)),
        status: keuze(url.searchParams.get('status') || '', Object.keys(STATUS_NAAM)),
      };
      const rijen = sorteerOpslag.logLijst({ ...filter, max: 300 });
      // Welke mails al een concept-offerte hebben (knop wordt een link).
      const concepten = offertes ? Object.fromEntries(rijen.map((r) => [r.id, offertes.conceptVan ? offertes.conceptVan(r) : null]).filter(([, c]) => c)) : {};
      return stuurHtml(res, 200, logboekPagina({
        ...gemeen, filter, meldingen, bezig: sorteerder.bezig(), rijen, concepten, offerteknop: Boolean(offertes),
      }));
    }

    // Maak offerte: een concept in Offerteknop uit deze mail, daarna door
    // naar de editor daar. Een tweede klik opent hetzelfde concept.
    const maakOfferte = pad.match(/^\/log\/(\d+)\/offerte$/);
    if (maakOfferte && req.method === 'POST') {
      await lees();
      if (!offertes) return terug(res, '/', 'offerte-niet-ingesteld');
      const regel = sorteerOpslag.logRegel(Number(maakOfferte[1]));
      if (!regel) return stuurTekst(res, 404, 'Mail niet gevonden in het logboek.');
      try {
        const { bewerkUrl } = await offertes.conceptUitMail(regel, { gebruiker });
        if (!bewerkUrl) return terug(res, '/', 'offerte-fout');
        // Via de eenmalige inloglink als die er is, anders de editor zelf.
        const open = offertes.openUrl ? offertes.openUrl(offerteknopPad(bewerkUrl)) : '';
        kop(res, 303, 'text/plain; charset=utf-8', { location: open || bewerkUrl });
        return res.end('');
      } catch (fout) {
        opslag.log('error', 'Concept-offerte maken uit een mail mislukt: ' + fout.message);
        return terug(res, '/', fout.status === 503 ? 'offerte-niet-ingesteld' : 'offerte-fout');
      }
    }

    if (pad === '/sorteer' && req.method === 'POST') {
      await lees();
      if (sorteerder.bezig()) return terug(res, '/', 'bezig');
      opslag.log('info', `Sorteerronde met de hand gestart${gebruiker ? ' door ' + gebruiker : ''}.`);
      sorteerder.draai({ aanleiding: 'knop' }).catch(() => {});
      return terug(res, '/', 'gestart');
    }

    const actie = pad.match(/^\/log\/(\d+)\/(terug|verplaats)$/);
    if (actie && req.method === 'POST') {
      const body = await lees();
      try {
        if (actie[2] === 'terug') {
          await sorteerder.terugzetten(Number(actie[1]), { gebruiker });
          return terug(res, '/', 'teruggezet');
        }
        const naar = keuze(String(body.get('naar') || ''), DOELEN);
        if (!naar) return stuurTekst(res, 400, 'Kies een map.');
        const altijd = keuze(String(body.get('altijd') || ''), ['adres', 'domein']);
        const { regel } = await sorteerder.andereMap(Number(actie[1]), naar, { altijd, gebruiker });
        return terug(res, '/', regel ? 'verplaatst-regel' : (naar === INBOX_NAAM ? 'teruggezet' : 'verplaatst'));
      } catch (fout) {
        opslag.log('error', 'Mail verplaatsen vanuit het logboek mislukt: ' + fout.message);
        return terug(res, '/', 'actie-fout');
      }
    }

    // -- regels ----------------------------------------------------------
    if (pad === '/regels' && req.method === 'GET') {
      return stuurHtml(res, 200, regelsPagina({ ...gemeen, regels: sorteerOpslag.regels(), meldingen }));
    }

    if (pad === '/regels' && req.method === 'POST') {
      const body = await lees();
      const soort = keuze(String(body.get('soort') || ''), ['adres', 'domein']);
      const ruw = normaliseerAdres(body.get('waarde'));
      const map = keuze(String(body.get('map') || ''), DOELEN);
      const waarde = soort === 'domein' ? domeinVan(ruw) : ruw;
      const fouten = [];
      if (!soort) fouten.push('Kies adres of domein.');
      if (soort === 'adres' && !IS_ADRES.test(waarde)) fouten.push('Dat is geen geldig e-mailadres.');
      if (soort === 'domein' && !IS_DOMEIN.test(waarde)) fouten.push('Dat is geen geldig domein.');
      if (!map) fouten.push('Kies een map.');
      if (fouten.length) {
        return stuurHtml(res, 400, regelsPagina({
          ...gemeen, regels: sorteerOpslag.regels(), invoer: { soort, waarde: ruw, map },
          meldingen: fouten.map((tekst) => ({ soort: 'fout', tekst })),
        }));
      }
      const regel = sorteerOpslag.voegRegelToe({ soort, waarde, map, door: gebruiker || null });
      opslag.log('info', `Sorteerregel: ${regel.soort} ${regel.waarde} -> ${regel.map}${gebruiker ? ' (' + gebruiker + ')' : ''}`);
      return terug(res, '/regels', 'regel-toegevoegd');
    }

    const weg = pad.match(/^\/regels\/(\d+)\/verwijder$/);
    if (weg && req.method === 'POST') {
      await lees();
      const regel = sorteerOpslag.regel(Number(weg[1]));
      if (!regel) return stuurTekst(res, 404, 'Regel niet gevonden.');
      sorteerOpslag.verwijderRegel(regel.id);
      opslag.log('info', `Sorteerregel verwijderd: ${regel.soort} ${regel.waarde} -> ${regel.map}${gebruiker ? ' (' + gebruiker + ')' : ''}`);
      return terug(res, '/regels', 'regel-weg');
    }

    // -- instellingen ----------------------------------------------------
    if (pad === '/instellingen' && req.method === 'GET') {
      return stuurHtml(res, 200, mailInstellingenPagina({ ...gemeen, inst: instellingen.lees(opslag), meldingen }));
    }

    if (pad === '/instellingen' && req.method === 'POST') {
      const body = await lees();
      const nieuw = {
        sorteren: body.has('sorteren') ? '1' : '0',
        sorteer_drempel: body.get('sorteer_drempel') ?? '',
        website_afzenders: body.get('website_afzenders') ?? '',
      };
      for (const m of instellingen.SORTEER_MAPPEN) {
        nieuw['sorteer_map_' + m.sleutel] = body.has('sorteer_map_' + m.sleutel) ? '1' : '0';
      }
      const { fouten } = instellingen.bewaar(opslag, nieuw, { nu: nuIso() });
      if (fouten.length) {
        return stuurHtml(res, 400, mailInstellingenPagina({
          ...gemeen, inst: instellingen.lees(opslag), meldingen: fouten.map((tekst) => ({ soort: 'fout', tekst })),
        }));
      }
      return terug(res, '/instellingen', 'opgeslagen');
    }

    if (pad === '/instellingen/test' && req.method === 'POST') {
      await lees();
      const test = {
        mailbox: mail && mail.beschikbaar ? await mail.test() : { ok: false, melding: 'de mailkoppeling is niet ingesteld in de env' },
        mappen: mail && mail.beschikbaar ? await sorteerder.controleerMappen() : [],
        claude: classificeerder && classificeerder.beschikbaar
          ? { ok: true, melding: `sleutel aanwezig, model ${classificeerder.model}` }
          : { ok: false, melding: 'geen ANTHROPIC_API_KEY; alleen regels en website-afzenders worden gesorteerd' },
      };
      opslag.log('info', 'Verbindingen mailsorteerder getest: mailbox ' + (test.mailbox.ok ? 'ok' : 'niet ok')
        + ', ontbrekende mappen: ' + (test.mappen.filter((m) => !m.bestaat).map((m) => m.naam).join(', ') || 'geen'));
      return stuurHtml(res, 200, mailInstellingenPagina({ ...gemeen, inst: instellingen.lees(opslag), test }));
    }

    return stuurTekst(res, 404, 'Niet gevonden.');
  }

  return { handle, basis };
}
