// Het aanvraagformulier van de website (/offerte/, js/wizard.js) komt hier
// binnen: POST /api/aanvraag/indienen, als multipart/form-data, zonder login.
// nginx van dekoningtegelwerken.nl stuurt /api/aanvraag/ naar deze dienst.
//
// Volgorde per aanvraag: controleren, bestanden op de schijf, rij in de
// database, bevestiging naar de bezoeker. Pas daarna probeert de wachtrij
// (lib/aanvraag-doorsturen.mjs) de mail en Offerteknop; mislukt dat, dan
// merkt de bezoeker daar niets van.
//
// Spambescherming, naar het patroon van de contactdienst van Handsfree
// Digital (service/contact.mjs daar):
//  1. Origin/Referer op de allowlist           -> 403
//  2. Honeypot-veld ("website") gevuld        -> doet alsof het lukt, slaat niets op
//  3. Minimale invultijd (veld t, 3 s)         -> 400 met een vriendelijke melding
//  4. Rate limit per IP (5 per uur)            -> 429
//  5. Links in de tekst: max 2, en minstens 15 s invultijd
//  6. Daglimiet 100, geteld in de database     -> 429
//
// Privacy: de logregels bevatten alleen id, aantallen en status, nooit de
// inhoud. De inhoud staat in de database en de bestandsmap op deze server,
// in de mail naar de mailbox en in Offerteknop.

import crypto from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { EXTENSIE, boundaryUit, leesMultipart, typeUitInhoud } from './lib/multipart.mjs';
import { OFFERTEKNOP_BIJLAGEN, SOORTEN_BESTAND, aantalLinks, valideer } from './lib/aanvraag-velden.mjs';
import { nuIso } from './lib/hulp.mjs';
import { bezoekerIp } from './lib/web.mjs';

export const MAX_BODY_BYTES = 24 * 1024 * 1024;
export const MAX_BESTANDEN = 12;
export const MAX_BESTAND_BYTES = OFFERTEKNOP_BIJLAGEN.perStuk;
export const RATE = Object.freeze({ aantal: 5, vensterMs: 60 * 60 * 1000 });
export const DAG_LIMIET = 100;
export const MIN_INVULTIJD_MS = 3000;
export const MIN_INVULTIJD_MET_LINKS_MS = 15000;
export const MAX_LINKS = 2;
export const STANDAARD_ORIGINS = ['https://dekoningtegelwerken.nl', 'https://www.dekoningtegelwerken.nl'];

export function maakAanvraagApp({
  aanvraagOpslag,
  wachtrij,
  bestandenMap,
  origins = STANDAARD_ORIGINS,
  log = () => {},
  nu = () => Date.now(),
  rate = RATE,
  dagLimiet = DAG_LIMIET,
}) {
  const toegestaan = new Set(origins.map((o) => String(o).trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean));
  const perIp = new Map();

  function json(res, status, data) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(JSON.stringify(data) + '\n');
  }

  function herkomstOk(req) {
    const bron = req.headers.origin || req.headers.referer;
    if (!bron) return false;
    try { return toegestaan.has(new URL(bron).origin.toLowerCase()); } catch { return false; }
  }

  function rateLimitBereikt(ip) {
    const t = nu();
    const lijst = (perIp.get(ip) || []).filter((x) => t - x < rate.vensterMs);
    if (lijst.length >= rate.aantal) { perIp.set(ip, lijst); return true; }
    perIp.set(ip, lijst);
    if (perIp.size > 5000) for (const [k, v] of perIp) if (!v.length || t - v[v.length - 1] > rate.vensterMs) perIp.delete(k);
    return false;
  }
  const telMee = (ip) => perIp.set(ip, [...(perIp.get(ip) || []), nu()]);

  function leesBody(req) {
    return new Promise((klaar, mislukt) => {
      const delen = [];
      let grootte = 0;
      req.on('data', (deel) => {
        grootte += deel.length;
        if (grootte > MAX_BODY_BYTES) { mislukt(Object.assign(new Error('te groot'), { teGroot: true })); req.destroy(); return; }
        delen.push(deel);
      });
      req.on('end', () => klaar(Buffer.concat(delen)));
      req.on('error', mislukt);
    });
  }

  // Bestanden controleren op inhoud en op de schijf zetten; geeft de lijst
  // voor de database. Bij een fout wordt de map weer weggehaald.
  function bewaarBestanden(referentie, bestanden) {
    const uit = [];
    if (!bestanden.length) return { lijst: uit, map: null };
    const map = path.join(bestandenMap, referentie);
    mkdirSync(map, { recursive: true, mode: 0o700 });
    try {
      let n = 0;
      for (const b of bestanden) {
        const type = typeUitInhoud(b.inhoud);
        if (!type) throw Object.assign(new Error(`${b.naam} is geen foto of PDF.`), { veld: b.veld, status: 400 });
        if (type === 'application/pdf' && b.veld !== 'plattegrond') throw Object.assign(new Error(`${b.naam} is geen foto.`), { veld: b.veld, status: 400 });
        if (b.inhoud.length > MAX_BESTAND_BYTES) throw Object.assign(new Error(`${b.naam} is groter dan ${Math.round(MAX_BESTAND_BYTES / 1024 / 1024)} MB.`), { veld: b.veld, status: 400 });
        n++;
        const bestand = `${String(n).padStart(2, '0')}-${b.veld === 'fotos' ? 'foto' : b.veld}${EXTENSIE[type]}`;
        writeFileSync(path.join(map, bestand), b.inhoud, { mode: 0o600 });
        const naam = (b.naam.replace(/\.[^.]*$/, '') || bestand).slice(0, 150) + EXTENSIE[type];
        uit.push({ soort: b.veld, naam, type, bestand, grootte: b.inhoud.length });
      }
      return { lijst: uit, map };
    } catch (fout) {
      try { rmSync(map, { recursive: true, force: true }); } catch { /* al weg */ }
      throw fout;
    }
  }

  async function indienen(req, res) {
    const ip = bezoekerIp(req);
    if (!herkomstOk(req)) {
      console.warn(`${nuIso()} aanvraag geweigerd: herkomst niet toegestaan (ip ${ip})`);
      return json(res, 403, { error: 'Dit formulier kan alleen vanaf dekoningtegelwerken.nl verstuurd worden.' });
    }
    if (rateLimitBereikt(ip)) {
      console.warn(`${nuIso()} aanvraag geweigerd: te veel verzoeken (ip ${ip})`);
      return json(res, 429, { error: 'Er zijn net al meerdere aanvragen vanaf dit adres verstuurd. Probeer het over een uur opnieuw, of bel ons.' });
    }
    const boundary = boundaryUit(req.headers['content-type']);
    if (!boundary) return json(res, 415, { error: 'Het formulier moet als multipart/form-data verstuurd worden.' });

    let body;
    try {
      body = await leesBody(req);
    } catch (fout) {
      if (fout.teGroot) return json(res, 413, { error: `De aanvraag is te groot (meer dan ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB aan bestanden). Kies minder of kleinere foto's.` });
      return json(res, 400, { error: 'De aanvraag kon niet gelezen worden.' });
    }
    let velden;
    let bestanden;
    try {
      ({ velden, bestanden } = leesMultipart(body, boundary));
    } catch {
      return json(res, 400, { error: 'De aanvraag kon niet gelezen worden.' });
    }

    // Honeypot: doen alsof het lukt, maar niets opslaan of versturen.
    if ((velden.get('website') || []).some((v) => v.trim())) {
      console.log(`${nuIso()} aanvraag: honeypot gevuld, genegeerd (ip ${ip})`);
      return json(res, 200, { ok: true });
    }
    const t = Number((velden.get('t') || [])[0]);
    const invultijd = Number.isFinite(t) && t > 0 ? nu() - t : NaN;
    if (!(invultijd >= MIN_INVULTIJD_MS && invultijd <= 24 * 60 * 60 * 1000)) {
      console.warn(`${nuIso()} aanvraag geweigerd: invultijd ${Number.isFinite(invultijd) ? Math.round(invultijd / 1000) + ' s' : 'onbekend'} (ip ${ip})`);
      return json(res, 400, { error: 'Dat ging wel heel snel. Kijk je antwoorden nog even na en verstuur opnieuw.', veld: 'naam' });
    }

    const uit = valideer(velden);
    if (uit.fout) return json(res, 400, { error: uit.fout, veld: uit.veld });
    const links = aantalLinks(uit.velden);
    if (links > MAX_LINKS || (links > 0 && invultijd < MIN_INVULTIJD_MET_LINKS_MS)) {
      console.warn(`${nuIso()} aanvraag geweigerd: ${links} link(s) in de tekst (ip ${ip})`);
      return json(res, 400, { error: 'Laat links uit de toelichting weg; die kunnen we niet verwerken.', veld: 'toelichting' });
    }
    const bestandenOk = bestanden.filter((b) => SOORTEN_BESTAND.includes(b.veld));
    if (bestandenOk.length > MAX_BESTANDEN) return json(res, 400, { error: `Maximaal ${MAX_BESTANDEN} bestanden per aanvraag.`, veld: 'fotos' });
    if (bestandenOk.filter((b) => b.veld !== 'fotos').some((b, i, l) => l.findIndex((x) => x.veld === b.veld) !== i)) return json(res, 400, { error: 'Eén tegelfoto en één plattegrond per aanvraag.', veld: 'plattegrond' });

    const dagStart = new Date(nu());
    dagStart.setUTCHours(0, 0, 0, 0);
    if (aanvraagOpslag.aantalSinds(dagStart.toISOString().replace(/\.\d{3}Z$/, 'Z')) >= dagLimiet) {
      console.warn(`${nuIso()} aanvraag geweigerd: daglimiet bereikt (ip ${ip})`);
      return json(res, 429, { error: 'Er zijn vandaag ongewoon veel aanvragen binnengekomen. Probeer het morgen opnieuw, of bel ons.' });
    }

    const referentie = crypto.randomUUID();
    let opgeslagen;
    try {
      opgeslagen = bewaarBestanden(referentie, bestandenOk);
    } catch (fout) {
      if (fout.status === 400) return json(res, 400, { error: fout.message, veld: fout.veld });
      log('error', `Aanvraag: bestanden opslaan mislukt: ${fout.message}`);
      return json(res, 500, { error: 'Er ging iets mis bij het opslaan. Probeer het later opnieuw.' });
    }
    let id;
    try {
      id = aanvraagOpslag.nieuw({ bron: 'website', referentie, velden: uit.velden, bestanden: opgeslagen.lijst, bestandsmap: opgeslagen.map });
    } catch (fout) {
      if (opgeslagen.map) { try { rmSync(opgeslagen.map, { recursive: true, force: true }); } catch { /* al weg */ } }
      log('error', `Aanvraag: opslaan in de database mislukt: ${fout.message}`);
      return json(res, 500, { error: 'Er ging iets mis bij het opslaan. Probeer het later opnieuw.' });
    }
    telMee(ip);
    log('info', `Aanvraag #${id} ontvangen via de website (${opgeslagen.lijst.length} bestand${opgeslagen.lijst.length === 1 ? '' : 'en'}); mail en Offerteknop volgen.`);
    json(res, 200, { ok: true, referentie });
    // Direct proberen, los van het antwoord; de timer is het vangnet.
    if (wachtrij) setImmediate(() => wachtrij.ronde().catch((fout) => log('error', `Wachtrij na aanvraag #${id}: ${fout.message}`)));
    return undefined;
  }

  async function handle(req, res, url) {
    if (url.pathname === '/api/aanvraag/indienen') {
      if (req.method !== 'POST') return json(res, 405, { error: 'Alleen POST.' });
      return indienen(req, res);
    }
    return json(res, 404, { error: 'Niet gevonden.' });
  }

  return { handle, stand: () => aanvraagOpslag.stand() };
}
