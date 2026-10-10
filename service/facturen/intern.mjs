// /intern/...: wat Offerteknop bij ons aanroept, zonder login maar met de
// HMAC van de koppeling (lib/offerteknop.mjs). Alleen rechtstreeks vanaf
// deze server; via nginx bestaat /intern/ niet (de vhost geeft 404) en een
// verzoek met X-Forwarded-For wordt hier ook geweigerd.
//
//   POST /intern/offerteknop/webhook   statuswijziging van een offerte -> spiegel
//   POST /intern/mail/verstuur         Offerteknop levert een mail aan, wij
//                                      versturen hem vanuit de mailbox (Graph
//                                      sendMail). Alleen naar het klantadres van
//                                      de genoemde offerte of naar de mailbox zelf;
//                                      met een limiet per uur en per dag.

import { nuIso } from './lib/hulp.mjs';
import { KOPPEN, isLokaal } from './lib/offerteknop.mjs';
import { kop, leesRuw } from './lib/web.mjs';

export const MAX_INTERN_BYTES = 12 * 1024 * 1024;
export const MAX_BIJLAGEN_BYTES = 3.5 * 1024 * 1024;
export const RELAY_LIMIET = Object.freeze({ uur: 20, dag: 100 });
const IS_EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/;

export function maakIntern({ offerteOpslag, offerteknop, mail = null, log = () => {}, limiet = RELAY_LIMIET, nu = () => Date.now() }) {
  function json(res, status, data) {
    kop(res, status, 'application/json; charset=utf-8');
    res.end(JSON.stringify(data) + '\n');
  }

  // Lokaal, ondertekend, niet eerder gezien, JSON-object. Geeft {body} of
  // antwoordt zelf en geeft null.
  async function toegang(req, res, url) {
    if (!isLokaal(req)) { json(res, 403, { error: 'Alleen vanaf deze server.' }); return null; }
    if (req.method !== 'POST') { json(res, 405, { error: 'Alleen POST.' }); return null; }
    let ruw;
    try {
      ruw = Buffer.from(await leesRuw(req, MAX_INTERN_BYTES), 'utf8');
    } catch {
      json(res, 413, { error: 'Te groot.' });
      return null;
    }
    const uit = offerteknop.controleer({ methode: req.method, pad: url.pathname + url.search, koppen: req.headers, body: ruw });
    if (uit.fout) {
      console.warn(`${nuIso()} /intern geweigerd: ${uit.fout}`);
      json(res, 401, { error: uit.fout });
      return null;
    }
    if (!offerteOpslag.registreerHandtekening(uit.handtekening, { nu: nu() })) { json(res, 409, { error: 'Dit verzoek is al verwerkt.' }); return null; }
    let body;
    try { body = ruw.length ? JSON.parse(ruw.toString('utf8')) : {}; } catch { json(res, 400, { error: 'Ongeldige JSON.' }); return null; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { json(res, 400, { error: 'De aanvraag moet een JSON-object zijn.' }); return null; }
    return body;
  }

  // -- webhook ---------------------------------------------------------------
  function webhook(res, body) {
    const id = String(body.id || '');
    const gebeurtenis = String(body.gebeurtenis || '');
    const o = body.offerte;
    if (!id || !gebeurtenis || !o || typeof o !== 'object' || !Number.isInteger(Number(o.id))) return json(res, 400, { error: 'id, gebeurtenis en offerte zijn verplicht.' });
    if (!offerteOpslag.noteerGebeurtenis(id, gebeurtenis, o.id)) return json(res, 200, { ok: true, herhaald: true });
    offerteOpslag.bewaar(o);
    log('info', `Offerteknop: offerte ${o.nummer_str || o.id} ${gebeurtenis}${o.klant_naam ? ' (' + o.klant_naam + ')' : ''}.`);
    return json(res, 200, { ok: true });
  }

  // -- mailrelay ---------------------------------------------------------------
  async function verstuur(res, body) {
    const aan = String(body.aan || '').trim().toLowerCase();
    const onderwerp = String(body.onderwerp || '').trim();
    const offerteId = body.gerelateerd_type === 'offerte' && Number.isInteger(Number(body.gerelateerd_id)) ? Number(body.gerelateerd_id) : null;
    const weiger = (status, fout) => {
      offerteOpslag.noteerRelay({ offerteId, aan, onderwerp, status: 'geweigerd', fout });
      log('warn', `Mailrelay geweigerd (${status}): ${fout}`);
      return json(res, status, { error: fout });
    };
    if (!IS_EMAIL.test(aan)) return weiger(400, 'Ongeldig ontvangeradres.');
    if (!onderwerp) return weiger(400, 'Onderwerp ontbreekt.');
    if (!body.html && !body.tekst) return weiger(400, 'De mail heeft geen inhoud.');
    if (!mail || !mail.beschikbaar || typeof mail.verstuurMail !== 'function') return weiger(503, 'De mailbox is niet ingesteld; er kan niets verstuurd worden.');

    // Geen vrije relay: alleen het klantadres van de offerte, of de mailbox zelf.
    const eigen = String(mail.adres || '').toLowerCase();
    if (aan !== eigen) {
      if (offerteId === null) return weiger(403, 'Alleen mail bij een offerte wordt verstuurd.');
      let offerte;
      try {
        offerte = await offerteknop.offerte(offerteId);
      } catch (fout) {
        return weiger(502, `De offerte kon niet gecontroleerd worden bij Offerteknop (${fout.message}).`);
      }
      const klantAdres = String(offerte?.klant_email || '').toLowerCase();
      if (!klantAdres || klantAdres !== aan) return weiger(403, 'De ontvanger is niet het klantadres van deze offerte.');
      offerteOpslag.bewaar(offerte);
    }

    const stand = offerteOpslag.relayTelling(nu());
    if (stand.uur >= limiet.uur) return weiger(429, `De limiet van ${limiet.uur} mails per uur is bereikt.`);
    if (stand.dag >= limiet.dag) return weiger(429, `De limiet van ${limiet.dag} mails per dag is bereikt.`);

    const bijlagen = Array.isArray(body.bijlagen) ? body.bijlagen : [];
    let totaal = 0;
    for (const b of bijlagen) {
      if (!b || typeof b !== 'object' || typeof b.inhoud_b64 !== 'string') return weiger(400, 'Een bijlage mist zijn inhoud.');
      totaal += Math.floor(b.inhoud_b64.length * 3 / 4);
    }
    if (totaal > MAX_BIJLAGEN_BYTES) return weiger(413, 'De bijlagen zijn samen te groot voor een directe verzending (maximaal 3,5 MB).');

    try {
      await mail.verstuurMail({
        aan, onderwerp,
        html: body.html ? String(body.html) : null,
        tekst: body.tekst ? String(body.tekst) : null,
        replyTo: body.reply_to && IS_EMAIL.test(String(body.reply_to)) && String(body.reply_to).toLowerCase() !== eigen ? String(body.reply_to) : null,
        bijlagen: bijlagen.map((b) => ({ naam: String(b.naam || 'bijlage'), type: String(b.type || 'application/octet-stream'), inhoud_b64: b.inhoud_b64 })),
      });
    } catch (fout) {
      offerteOpslag.noteerRelay({ offerteId, aan, onderwerp, status: 'mislukt', fout: fout.message });
      log('error', `Mail voor Offerteknop versturen mislukt (${aan}): ${fout.message}`);
      return json(res, 502, { error: 'Versturen vanuit de mailbox is mislukt.' });
    }
    offerteOpslag.noteerRelay({ offerteId, aan, onderwerp, status: 'verzonden' });
    log('info', `Mail voor Offerteknop verstuurd vanuit de mailbox naar ${aan}${offerteId !== null ? ` (offerte ${offerteId})` : ''}.`);
    return json(res, 200, { verzonden: true, message_id: null });
  }

  async function handle(req, res, url) {
    const body = await toegang(req, res, url);
    if (!body) return undefined;
    if (url.pathname === '/intern/offerteknop/webhook') return webhook(res, body);
    if (url.pathname === '/intern/mail/verstuur') return verstuur(res, body);
    return json(res, 404, { error: 'Onbekend intern pad.' });
  }

  return { handle };
}

export { KOPPEN };
