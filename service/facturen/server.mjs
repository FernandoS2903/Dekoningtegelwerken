// Factuurdashboard De Koning Tegelwerken.
//
// Dependency-vrije Node 22-dienst (node:http, node:sqlite, ingebouwde fetch en
// node:crypto), naar het patroon van handsfree-digital-werk/service. Luistert
// op 127.0.0.1:8132 en is bereikbaar via `tailscale serve --set-path /facturen`
// met daarbovenop Basic Auth. Nooit publiek.
//
// Starten:   node service/facturen/server.mjs
// Instellen: /etc/dekoning/facturen.env (600), zie deploy/facturen.env.voorbeeld
//
// Ontbrekende koppelingen laten hun stap over: zonder Microsoft 365 worden er
// geen mails gehaald, zonder bunq geen betalingen, zonder Claude-sleutel wordt
// er niet uitgelezen. De dienst blijft staan en zegt in het scherm wat er mist.
//
// Secrets staan alleen in de env en gaan nooit naar een logregel, een pagina
// of het logboek.

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { maakOpslag, openDatabase } from './lib/db.mjs';
import { maakGraph } from './lib/graph.mjs';
import { maakClaude, STANDAARD_MODEL } from './lib/claude.mjs';
import { maakBunq } from './lib/bunq.mjs';
import { maakSync } from './lib/sync.mjs';
import { magAutomatisch, stuurDoor } from './lib/doorsturen.mjs';
import * as instellingen from './lib/instellingen.mjs';
import { naarBedrag, naarDatum, naarIban, nuIso, vandaag } from './lib/hulp.mjs';
import { overzicht } from './web/overzicht.mjs';
import { factuurPagina } from './web/factuur.mjs';
import { instellingenPagina } from './web/instellingen.mjs';
import { FILTERS } from './web/opmaak.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HIER, '..', '..');

export const STANDAARD_POORT = 8132;
export const MAX_BODY_BYTES = 64 * 1024;

const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "script-src 'self'",
  "object-src 'self'",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Vaste meldingen na een actie. Een code in de URL in plaats van vrije tekst,
// zodat er niets uit een verzoek in de pagina kan belanden.
const MELDINGEN = {
  betaald: ['goed', 'Op betaald gezet.'],
  open: ['goed', 'Terug naar open; een gekoppelde betaling is weer losgemaakt.'],
  negeren: ['goed', 'Op genegeerd gezet.'],
  opnieuw: ['info', 'Wordt bij de volgende ronde opnieuw uitgelezen.'],
  bewerkt: ['goed', 'Gegevens opgeslagen.'],
  gekoppeld: ['goed', 'Betaling gekoppeld en de factuur op betaald gezet.'],
  doorgestuurd: ['goed', 'Doorgestuurd naar de boekhouder.'],
  'geen-adres': ['fout', 'Er is geen e-mailadres van de boekhouder ingesteld; er is niets verstuurd.'],
  'doorsturen-fout': ['fout', 'Doorsturen is mislukt. De reden staat in het logboek onderaan deze pagina en op de instellingenpagina.'],
  'geen-m365': ['fout', 'Microsoft 365 is niet ingesteld, dus doorsturen kan niet.'],
  'geen-betaling': ['fout', 'Die betaling is niet meer bekend; synchroniseer opnieuw.'],
  'sync-gestart': ['info', 'De ronde is gestart. Vernieuw de pagina over een halve minuut.'],
  'sync-bezig': ['info', 'Er loopt al een ronde; even wachten.'],
  opgeslagen: ['goed', 'Instellingen opgeslagen.'],
};

// -- de dienst in elkaar zetten -----------------------------------------
// Alle koppelingen komen als argument binnen, zodat de tests ze kunnen
// nabootsen zonder netwerk.
export function maakServer({
  opslag,
  graph = null,
  claude = null,
  bunq = null,
  pdfMap,
  gebruiker = '',
  wachtwoord = '',
  basisPad = '',
  nu = () => vandaag(),
}) {
  const basis = basisPad.replace(/\/+$/, '');
  const leesInstellingen = () => instellingen.lees(opslag);
  const sync = maakSync({ opslag, graph, claude, bunq, pdfMap, instellingenLezer: leesInstellingen });
  const authKlaar = Boolean(gebruiker && wachtwoord);

  // -- antwoorden ------------------------------------------------------
  function kop(res, status, type, extra = {}) {
    res.writeHead(status, {
      'content-type': type,
      'content-security-policy': CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex, nofollow',
      'cache-control': 'no-store',
      ...extra,
    });
  }

  const stuurHtml = (res, status, html) => { kop(res, status, 'text/html; charset=utf-8'); res.end(html); };
  const stuurTekst = (res, status, tekst) => { kop(res, status, 'text/plain; charset=utf-8'); res.end(tekst + '\n'); };

  function terug(res, pad, code = null) {
    const url = basis + pad + (code ? (pad.includes('?') ? '&' : '?') + 'm=' + code : '');
    kop(res, 303, 'text/plain; charset=utf-8', { location: url || '/' });
    res.end('');
  }

  function meldingenUit(zoekparams) {
    const code = zoekparams.get('m');
    if (!code || !MELDINGEN[code]) return [];
    const [soort, tekst] = MELDINGEN[code];
    return [{ soort, tekst }];
  }

  // -- Basic Auth ------------------------------------------------------
  // Vergelijken via een hash, zodat verschillende lengtes geen uitzondering
  // geven en de vergelijking even lang duurt.
  const afdruk = (waarde) => crypto.createHash('sha256').update(String(waarde)).digest();
  const gebruikerAfdruk = afdruk(gebruiker);
  const wachtwoordAfdruk = afdruk(wachtwoord);

  function ingelogd(req) {
    const kopregel = req.headers.authorization || '';
    if (!kopregel.toLowerCase().startsWith('basic ')) return false;
    let ontcijferd;
    try {
      ontcijferd = Buffer.from(kopregel.slice(6).trim(), 'base64').toString('utf8');
    } catch {
      return false;
    }
    const scheiding = ontcijferd.indexOf(':');
    if (scheiding === -1) return false;
    const naam = afdruk(ontcijferd.slice(0, scheiding));
    const geheim = afdruk(ontcijferd.slice(scheiding + 1));
    return crypto.timingSafeEqual(naam, gebruikerAfdruk) && crypto.timingSafeEqual(geheim, wachtwoordAfdruk);
  }

  function vraagInlog(res) {
    kop(res, 401, 'text/plain; charset=utf-8', {
      'www-authenticate': 'Basic realm="Facturen De Koning Tegelwerken", charset="UTF-8"',
    });
    res.end('Inloggen vereist.\n');
  }

  // Basic Auth stuurt zijn gegevens bij elk verzoek mee, ook bij een formulier
  // op een andere site. Daarom moet een POST van dezelfde herkomst komen.
  function zelfdeHerkomst(req) {
    const site = req.headers['sec-fetch-site'];
    if (site) return site === 'same-origin';
    const origin = req.headers.origin;
    if (origin) {
      try {
        return new URL(origin).host === req.headers.host;
      } catch {
        return false;
      }
    }
    return false;
  }

  function leesBody(req) {
    return new Promise((klaar, mislukt) => {
      const delen = [];
      let grootte = 0;
      req.on('data', (deel) => {
        grootte += deel.length;
        if (grootte > MAX_BODY_BYTES) {
          mislukt(new Error('te groot'));
          req.destroy();
          return;
        }
        delen.push(deel);
      });
      req.on('end', () => klaar(new URLSearchParams(Buffer.concat(delen).toString('utf8'))));
      req.on('error', mislukt);
    });
  }

  // -- statische bestanden ---------------------------------------------
  const STATISCH = {
    '/dashboard.css': [path.join(HIER, 'web', 'dashboard.css'), 'text/css; charset=utf-8'],
    '/dashboard.js': [path.join(HIER, 'web', 'dashboard.js'), 'text/javascript; charset=utf-8'],
    // De lettertypen van de site hergebruiken we; ze staan in de repo-kopie
    // naast de dienst en worden alleen gelezen.
    '/fonts/fraunces-latin-opsz-wght.woff2': [path.join(REPO, 'assets/fonts/fraunces-latin-opsz-wght.woff2'), 'font/woff2'],
    '/fonts/inter-latin-wght.woff2': [path.join(REPO, 'assets/fonts/inter-latin-wght.woff2'), 'font/woff2'],
  };

  function stuurStatisch(res, pad) {
    const [bestand, type] = STATISCH[pad];
    if (!existsSync(bestand)) return stuurTekst(res, 404, 'Niet gevonden.');
    kop(res, 200, type, { 'cache-control': 'private, max-age=3600' });
    createReadStream(bestand).pipe(res);
    return undefined;
  }

  // -- PDF uitleveren --------------------------------------------------
  function stuurPdf(res, factuur) {
    if (!factuur.pdf_pad) return stuurTekst(res, 404, 'Deze factuur heeft geen PDF.');

    // Alleen de bestandsnaam gebruiken, het resultaat moet binnen de pdf-map
    // liggen, en symlinks worden niet gevolgd.
    const bestand = path.resolve(pdfMap, path.basename(String(factuur.pdf_pad)));
    const map = path.resolve(pdfMap);
    if (!bestand.startsWith(map + path.sep)) return stuurTekst(res, 403, 'Niet toegestaan.');
    if (!existsSync(bestand)) return stuurTekst(res, 404, 'PDF niet meer gevonden op de schijf.');
    let echt;
    try {
      echt = realpathSync(bestand);
    } catch {
      return stuurTekst(res, 404, 'PDF niet meer gevonden op de schijf.');
    }
    if (!echt.startsWith(realpathSync(map) + path.sep) || !statSync(echt).isFile()) {
      return stuurTekst(res, 403, 'Niet toegestaan.');
    }

    kop(res, 200, 'application/pdf', {
      'content-disposition': 'inline; filename="factuur.pdf"',
      'content-length': String(statSync(echt).size),
    });
    createReadStream(echt).pipe(res);
    return undefined;
  }

  // -- acties op één factuur -------------------------------------------
  async function doeActie(res, factuur, actie, body) {
    const inst = leesInstellingen();
    const pad = `/factuur/${factuur.id}`;

    if (actie === 'betaald') {
      const datum = naarDatum(body.get('betaald_op')) || nu();
      opslag.zetBetaald(factuur.id, { betaald_op: datum, betaald_via: 'handmatig' });
      opslag.log('info', `Met de hand op betaald gezet (${datum}).`, factuur.id);
      await naBetaald(factuur.id, inst);
      return terug(res, pad, 'betaald');
    }

    if (actie === 'open') {
      opslag.zetOpen(factuur.id);
      opslag.log('info', 'Terug naar open gezet; een gekoppelde betaling is losgemaakt.', factuur.id);
      return terug(res, pad, 'open');
    }

    if (actie === 'negeren') {
      opslag.zetStatus(factuur.id, 'genegeerd');
      opslag.log('info', 'Op genegeerd gezet.', factuur.id);
      return terug(res, pad, 'negeren');
    }

    if (actie === 'opnieuw') {
      opslag.zetOpnieuwUitlezen(factuur.id);
      opslag.log('info', 'Wordt opnieuw uitgelezen.', factuur.id);
      return terug(res, pad, 'opnieuw');
    }

    if (actie === 'koppel') {
      const betalingId = String(body.get('betaling_id') || '');
      const betaling = opslag.betaling(betalingId);
      if (!betaling) return terug(res, pad, 'geen-betaling');
      opslag.zetBetaald(factuur.id, {
        betaald_op: betaling.datum ? String(betaling.datum).slice(0, 10) : nu(),
        betaald_via: 'bunq',
        bunq_betaling_id: betalingId,
        match_score: factuur.suggestie_score,
      });
      opslag.log('info', 'Voorgestelde bunq-betaling bevestigd en op betaald gezet.', factuur.id);
      await naBetaald(factuur.id, inst);
      return terug(res, pad, 'gekoppeld');
    }

    if (actie === 'bewerken') {
      const velden = {
        leverancier: tekst(body.get('leverancier'), 200),
        factuurnummer: tekst(body.get('factuurnummer'), 80),
        factuurdatum: naarDatum(body.get('factuurdatum')),
        vervaldatum: naarDatum(body.get('vervaldatum')),
        bedrag: naarBedrag(body.get('bedrag')),
        valuta: tekst(body.get('valuta'), 10)?.toUpperCase() ?? null,
        iban: naarIban(body.get('iban')),
        betalingskenmerk: tekst(body.get('betalingskenmerk'), 80),
        omschrijving: tekst(body.get('omschrijving'), 200),
      };
      opslag.zetUitgelezen(factuur.id, 'handmatig', velden);
      opslag.zetNotitie(factuur.id, tekst(body.get('notitie'), 2000));
      opslag.log('info', 'Gegevens met de hand aangepast.', factuur.id);
      return terug(res, pad, 'bewerkt');
    }

    if (actie === 'doorsturen') {
      if (!inst.boekhouderEmails.length) {
        opslag.log('warn', 'Doorsturen met de knop geweigerd: geen e-mailadres van de boekhouder ingesteld.', factuur.id);
        return terug(res, pad, 'geen-adres');
      }
      if (!graph || !graph.beschikbaar) return terug(res, pad, 'geen-m365');
      try {
        await stuurDoor(opslag, graph, factuur, { inst, handmatig: true });
        return terug(res, pad, 'doorgestuurd');
      } catch (fout) {
        opslag.log('error', 'Doorsturen met de knop mislukt: ' + fout.message, factuur.id);
        return terug(res, pad, 'doorsturen-fout');
      }
    }

    return stuurTekst(res, 404, 'Onbekende actie.');
  }

  // Na "betaald": categorie in Outlook en eventueel automatisch doorsturen.
  async function naBetaald(factuurId, inst) {
    const vers = opslag.factuur(factuurId);
    if (!vers) return;

    if (inst.outlookCategorie && graph && graph.beschikbaar) {
      try {
        await graph.voegCategorieToe(vers.message_id, 'Betaald');
      } catch (fout) {
        opslag.log('warn', 'Categorie "Betaald" zetten mislukt: ' + fout.message, factuurId);
      }
    }

    const { mag } = magAutomatisch(vers, inst);
    if (!mag) return;
    try {
      await stuurDoor(opslag, graph, vers, { inst, handmatig: false });
    } catch (fout) {
      opslag.log('error', 'Automatisch doorsturen mislukt: ' + fout.message, factuurId);
    }
  }

  // -- de router -------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    try {
      if (!authKlaar) {
        return stuurTekst(res, 503,
          'Dit dashboard is nog niet ingesteld: DASHBOARD_USER en DASHBOARD_PASSWORD ontbreken in de env.');
      }
      if (!ingelogd(req)) return vraagInlog(res);

      const url = new URL(req.url, 'http://localhost');
      let pad = url.pathname;
      if (basis && pad.startsWith(basis)) pad = pad.slice(basis.length) || '/';
      if (pad.length > 1 && pad.endsWith('/')) pad = pad.slice(0, -1);
      if (pad === '') pad = '/';

      if (req.method === 'GET' && STATISCH[pad]) return stuurStatisch(res, pad);

      if (req.method === 'POST' && !zelfdeHerkomst(req)) {
        return stuurTekst(res, 403, 'Dit formulier moet van het dashboard zelf komen.');
      }

      const inst = leesInstellingen();
      const meldingen = meldingenUit(url.searchParams);

      // Overzicht
      if (pad === '/' && req.method === 'GET') {
        const gevraagd = url.searchParams.get('filter') || 'open';
        const filter = FILTERS.some(([s]) => s === gevraagd) ? gevraagd : 'open';
        const zoek = (url.searchParams.get('zoek') || '').trim().slice(0, 100);
        return stuurHtml(res, 200, overzicht({
          basis, opslag, inst, filter, zoek, nu: nu(), meldingen, syncBezig: sync.bezig(),
        }));
      }

      // Nu synchroniseren: op de achtergrond, zodat het verzoek niet wacht.
      if (pad === '/sync' && req.method === 'POST') {
        if (sync.bezig()) return terug(res, '/', 'sync-bezig');
        opslag.log('info', 'Sync-ronde met de hand gestart.');
        sync.draai({ aanleiding: 'knop' }).catch((fout) => {
          opslag.log('error', 'Sync-ronde mislukt: ' + fout.message);
        });
        return terug(res, '/', 'sync-gestart');
      }

      // Instellingen
      if (pad === '/instellingen' && req.method === 'GET') {
        return stuurHtml(res, 200, instellingenPagina({ basis, opslag, inst, meldingen }));
      }

      if (pad === '/instellingen' && req.method === 'POST') {
        const body = await leesBody(req);
        const { fouten } = instellingen.bewaar(opslag, {
          boekhouder_email: body.get('boekhouder_email') ?? '',
          doorstuur_tekst: body.get('doorstuur_tekst') ?? '',
          auto_doorsturen: body.has('auto_doorsturen') ? '1' : '0',
          testmodus: body.has('testmodus') ? '1' : '0',
          outlook_categorie: body.has('outlook_categorie') ? '1' : '0',
          match_drempel: body.get('match_drempel') ?? '',
          terugkijken_dagen: body.get('terugkijken_dagen') ?? '',
        }, { nu: nuIso() });

        if (fouten.length) {
          // Niet omleiden: de pagina opnieuw met de melding erbij, zodat
          // ingevulde waarden niet verdwijnen.
          return stuurHtml(res, 400, instellingenPagina({
            basis, opslag, inst: leesInstellingen(),
            meldingen: fouten.map((tekst) => ({ soort: 'fout', tekst })),
          }));
        }
        return terug(res, '/instellingen', 'opgeslagen');
      }

      if (pad === '/instellingen/test' && req.method === 'POST') {
        const test = {
          graph: graph ? await graph.test() : { ok: false, melding: 'Microsoft 365 is niet ingesteld in de env.' },
          bunq: bunq ? await bunq.test() : { ok: false, melding: 'bunq is niet ingesteld in de env.' },
          claude: claude && claude.beschikbaar
            ? { ok: true, melding: `sleutel aanwezig, model ${claude.model}` }
            : { ok: false, melding: 'geen ANTHROPIC_API_KEY ingesteld in de env.' },
        };
        opslag.log('info', 'Verbindingen getest: '
          + Object.entries(test).map(([naam, u]) => `${naam} ${u.ok ? 'ok' : 'niet ok'}`).join(', '));
        return stuurHtml(res, 200, instellingenPagina({ basis, opslag, inst, test }));
      }

      // Eén factuur
      const factuurPad = pad.match(/^\/factuur\/(\d+)(?:\/([a-z]+))?$/);
      if (factuurPad) {
        const factuur = opslag.factuur(Number(factuurPad[1]));
        if (!factuur) return stuurTekst(res, 404, 'Factuur niet gevonden.');
        const actie = factuurPad[2] || null;

        if (req.method === 'GET' && !actie) {
          return stuurHtml(res, 200, factuurPagina({ basis, opslag, inst, factuur, nu: nu(), meldingen }));
        }
        if (req.method === 'GET' && actie === 'pdf') return stuurPdf(res, factuur);
        if (req.method === 'POST' && actie) return doeActie(res, factuur, actie, await leesBody(req));
      }

      return stuurTekst(res, 404, 'Niet gevonden.');
    } catch (fout) {
      // Nooit een stack of een URL met gegevens naar de browser.
      console.error(nuIso() + ' fout bij ' + req.method + ': ' + fout.message);
      try {
        opslag.log('error', 'Onverwachte fout in het dashboard: ' + fout.message);
      } catch { /* database niet beschikbaar */ }
      return stuurTekst(res, 500, 'Er ging iets mis. De melding staat in het logboek.');
    }
  });

  return { server, sync, opslag, basis };
}

function tekst(waarde, max) {
  const s = String(waarde ?? '').trim();
  return s ? s.slice(0, max) : null;
}

// -- opstarten -----------------------------------------------------------
export function uitEnv(env = process.env) {
  const dataMap = env.DATA_DIR || env.STATE_DIRECTORY || '/var/lib/dekoning-facturen';
  return {
    poort: Number(env.FACTUREN_POORT) || STANDAARD_POORT,
    dataMap,
    pdfMap: path.join(dataMap, 'pdfs'),
    dbPad: path.join(dataMap, 'facturen.db'),
    bunqStatePad: path.join(dataMap, 'bunq_state.json'),
    basisPad: env.BASIS_PAD || '',
    gebruiker: env.DASHBOARD_USER || '',
    wachtwoord: env.DASHBOARD_PASSWORD || '',
    syncMinuten: Math.max(1, Number(env.SYNC_INTERVAL_MIN) || 15),
    m365: {
      tenantId: env.M365_TENANT_ID || '',
      clientId: env.M365_CLIENT_ID || '',
      clientSecret: env.M365_CLIENT_SECRET || '',
      mailbox: env.M365_MAILBOX || '',
      map: env.M365_FOLDER || 'Facturen',
    },
    claude: {
      apiKey: env.ANTHROPIC_API_KEY || '',
      model: env.CLAUDE_MODEL || STANDAARD_MODEL,
    },
    bunq: {
      apiKey: env.BUNQ_API_KEY || '',
      omgeving: env.BUNQ_ENV === 'sandbox' ? 'sandbox' : 'production',
      ibans: String(env.BUNQ_ACCOUNT_IBANS || '').split(',').map((s) => naarIban(s)).filter(Boolean),
    },
  };
}

function start() {
  const cfg = uitEnv();
  mkdirSync(cfg.pdfMap, { recursive: true });

  const opslag = maakOpslag(openDatabase(cfg.dbPad));
  const logger = (niveau, bericht) => opslag.log(niveau, bericht);

  const graph = maakGraph({ ...cfg.m365 });
  const claude = maakClaude({ ...cfg.claude, log: logger });
  const bunq = maakBunq({
    apiKey: cfg.bunq.apiKey,
    omgeving: cfg.bunq.omgeving,
    statePad: cfg.bunqStatePad,
    ibanFilter: cfg.bunq.ibans,
    log: logger,
  });

  const { server, sync } = maakServer({
    opslag, graph, claude, bunq,
    pdfMap: cfg.pdfMap,
    gebruiker: cfg.gebruiker,
    wachtwoord: cfg.wachtwoord,
    basisPad: cfg.basisPad,
  });

  const ontbreekt = [
    !cfg.gebruiker || !cfg.wachtwoord ? 'DASHBOARD_USER/DASHBOARD_PASSWORD' : null,
    !graph.beschikbaar ? 'Microsoft 365' : null,
    !claude.beschikbaar ? 'Claude' : null,
    !bunq.beschikbaar ? 'bunq' : null,
  ].filter(Boolean);
  if (ontbreekt.length) {
    console.warn(nuIso() + ' niet ingesteld: ' + ontbreekt.join(', ') + ' (die stappen worden overgeslagen)');
  }

  server.listen(cfg.poort, '127.0.0.1', () => {
    console.log(`${nuIso()} factuurdashboard luistert op 127.0.0.1:${cfg.poort}`
      + `${cfg.basisPad ? ' onder ' + cfg.basisPad : ''}, data in ${cfg.dataMap}`);
  });

  // De timer start pas na de eerste wachttijd; direct bij het opstarten
  // synchroniseren zou een herstart een dure bezigheid maken.
  const timer = setInterval(() => {
    sync.draai({ aanleiding: 'timer' }).catch((fout) => {
      console.error(nuIso() + ' sync mislukt: ' + fout.message);
    });
  }, cfg.syncMinuten * 60 * 1000);
  timer.unref();

  for (const signaal of ['SIGTERM', 'SIGINT']) {
    process.on(signaal, () => {
      console.log(nuIso() + ' afsluiten op ' + signaal);
      server.close(() => process.exit(0));
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
