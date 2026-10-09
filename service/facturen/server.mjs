// Portaal De Koning Tegelwerken: factuurdashboard en mailsorteerder.
//
// Dependency-vrije Node 22-dienst (node:http, node:sqlite, ingebouwde fetch en
// node:crypto), naar het patroon van handsfree-digital-werk/service. Luistert
// alleen op 127.0.0.1:8132. Publiek wordt het pas via nginx op
// https://cms.dekoningtegelwerken.nl, en alleen als het inloggen met
// Microsoft (Entra SSO) is ingesteld. Zonder SSO-instellingen blijft het bij
// Basic Auth op 127.0.0.1.
//
//   /             startpagina van het portaal (portaal.mjs)
//   /facturen/    factuurdashboard (dit bestand, maakFacturenApp)
//   /mail/        mailsorteerder: logboek, regels, instellingen (mail.mjs)
//   /auth/...     inloggen, uitloggen, /auth/check voor nginx auth_request
//   /graph/notify webhook van Microsoft Graph (zonder login, eigen controle)
//
// Starten:   node service/facturen/server.mjs
// Instellen: /etc/dekoning/facturen.env (600), zie deploy/facturen.env.voorbeeld
//
// Ontbrekende koppelingen laten hun stap over: zonder Microsoft 365 worden er
// geen mails gehaald of gesorteerd, zonder bunq geen betalingen, zonder
// Claude-sleutel wordt er niet uitgelezen en alleen op regels gesorteerd. De
// dienst blijft staan en zegt in het scherm wat er mist.
//
// Secrets staan alleen in de env en gaan nooit naar een logregel, een pagina
// of het logboek.

import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream, existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { maakOpslag, openDatabase } from './lib/db.mjs';
import { maakMailKoppeling } from './lib/mail/koppeling.mjs';
import { maakClaude, STANDAARD_MODEL } from './lib/claude.mjs';
import { maakClassificeerder, STANDAARD_SORTEER_MODEL } from './lib/classificeer.mjs';
import { maakBunq } from './lib/bunq.mjs';
import { maakSync } from './lib/sync.mjs';
import { maakSorteerOpslag } from './lib/sorteer-opslag.mjs';
import { maakSorteerder } from './lib/sorteren.mjs';
import { maakWebhook } from './lib/webhook.mjs';
import { maakSessies } from './lib/sessies.mjs';
import { maakOidc, splitsLijst } from './lib/oidc.mjs';
import { magAutomatisch, stuurDoor } from './lib/doorsturen.mjs';
import * as instellingen from './lib/instellingen.mjs';
import { naarBedrag, naarDatum, naarIban, nuIso, vandaag } from './lib/hulp.mjs';
import {
  MAX_BODY_BYTES, kop, leesBody, meldingenUit as meldingenVan, stuurHtml, stuurTekst, zelfdeHerkomst,
} from './lib/web.mjs';
import { maakMailApp } from './mail.mjs';
import { maakPortaal } from './portaal.mjs';
import { overzicht } from './web/overzicht.mjs';
import { factuurPagina } from './web/factuur.mjs';
import { instellingenPagina } from './web/instellingen.mjs';
import { FILTERS } from './web/opmaak.mjs';
import { STATISCH, stuurStatisch } from './web/statisch.mjs';

export { STATISCH };


export const STANDAARD_POORT = 8132;
export { MAX_BODY_BYTES };

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

// -- het factuurdashboard -------------------------------------------------
// Alle koppelingen komen als argument binnen, zodat de tests ze kunnen
// nabootsen zonder netwerk. `handle(req, res, ctx)` doet alleen het
// dashboard; inloggen en CSRF regelt wie hem aanroept (het portaal, of
// maakServer hieronder met Basic Auth). In ctx: `kader` (portaalbalk en
// CSRF-token voor de pagina's) en `body` (al gelezen formulier).
export function maakFacturenApp({
  opslag,
  graph = null,
  claude = null,
  bunq = null,
  pdfMap,
  basisPad = '',
  nu = () => vandaag(),
}) {
  const basis = basisPad.replace(/\/+$/, '');
  const leesInstellingen = () => instellingen.lees(opslag);
  const sync = maakSync({ opslag, graph, claude, bunq, pdfMap, instellingenLezer: leesInstellingen });

  function terug(res, pad, code = null) {
    const url = basis + pad + (code ? (pad.includes('?') ? '&' : '?') + 'm=' + code : '');
    kop(res, 303, 'text/plain; charset=utf-8', { location: url || '/' });
    res.end('');
  }

  const meldingenUit = (zoekparams) => meldingenVan(zoekparams, MELDINGEN);

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
  async function handle(req, res, ctx = {}) {
    const kader = ctx.kader || null;
    const lees = () => (ctx.body ? Promise.resolve(ctx.body) : leesBody(req));
    try {
      const url = new URL(req.url, 'http://localhost');
      let pad = url.pathname;
      if (basis && pad.startsWith(basis)) pad = pad.slice(basis.length) || '/';
      if (pad.length > 1 && pad.endsWith('/')) pad = pad.slice(0, -1);
      if (pad === '') pad = '/';

      if (req.method === 'GET' && STATISCH[pad]) return stuurStatisch(res, pad);

      const inst = leesInstellingen();
      const meldingen = meldingenUit(url.searchParams);

      // Overzicht
      if (pad === '/' && req.method === 'GET') {
        const gevraagd = url.searchParams.get('filter') || 'open';
        const filter = FILTERS.some(([s]) => s === gevraagd) ? gevraagd : 'open';
        const zoek = (url.searchParams.get('zoek') || '').trim().slice(0, 100);
        return stuurHtml(res, 200, overzicht({
          basis, opslag, inst, filter, zoek, nu: nu(), meldingen, syncBezig: sync.bezig(), kader,
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
        return stuurHtml(res, 200, instellingenPagina({ basis, opslag, inst, meldingen, kader }));
      }

      if (pad === '/instellingen' && req.method === 'POST') {
        const body = await lees();
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
            basis, opslag, inst: leesInstellingen(), kader,
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
        return stuurHtml(res, 200, instellingenPagina({ basis, opslag, inst, test, kader }));
      }

      // Eén factuur
      const factuurPad = pad.match(/^\/factuur\/(\d+)(?:\/([a-z]+))?$/);
      if (factuurPad) {
        const factuur = opslag.factuur(Number(factuurPad[1]));
        if (!factuur) return stuurTekst(res, 404, 'Factuur niet gevonden.');
        const actie = factuurPad[2] || null;

        if (req.method === 'GET' && !actie) {
          return stuurHtml(res, 200, factuurPagina({ basis, opslag, inst, factuur, nu: nu(), meldingen, kader }));
        }
        if (req.method === 'GET' && actie === 'pdf') return stuurPdf(res, factuur);
        if (req.method === 'POST' && actie) return doeActie(res, factuur, actie, await lees());
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
  }

  return { handle, sync, opslag, basis };
}

// -- los factuurdashboard met Basic Auth -------------------------------------
// Zonder portaal: het dashboard alleen, met Basic Auth en de controle op
// dezelfde herkomst. Gebruikt door de tests van het dashboard.
export function maakServer({ gebruiker = '', wachtwoord = '', ...opties }) {
  const app = maakFacturenApp(opties);
  const basic = maakBasicAuth({ gebruiker, wachtwoord, realm: 'Facturen De Koning Tegelwerken' });

  const server = http.createServer(async (req, res) => {
    if (!basic.klaar) {
      return stuurTekst(res, 503,
        'Dit dashboard is nog niet ingesteld: DASHBOARD_USER en DASHBOARD_PASSWORD ontbreken in de env.');
    }
    if (!basic.ingelogd(req)) return basic.vraagInlog(res);
    if (req.method === 'POST' && !zelfdeHerkomst(req)) {
      return stuurTekst(res, 403, 'Dit formulier moet van het dashboard zelf komen.');
    }
    return app.handle(req, res, {});
  });

  return { server, sync: app.sync, opslag: app.opslag, basis: app.basis };
}

// Basic Auth. Vergelijken via een hash, zodat verschillende lengtes geen
// uitzondering geven en de vergelijking even lang duurt.
export function maakBasicAuth({ gebruiker = '', wachtwoord = '', realm = 'Portaal De Koning Tegelwerken' }) {
  const afdruk = (waarde) => crypto.createHash('sha256').update(String(waarde)).digest();
  const gebruikerAfdruk = afdruk(gebruiker);
  const wachtwoordAfdruk = afdruk(wachtwoord);

  // Geeft de gebruikersnaam terug, of null.
  function ingelogd(req) {
    const kopregel = req.headers.authorization || '';
    if (!kopregel.toLowerCase().startsWith('basic ')) return null;
    let ontcijferd;
    try {
      ontcijferd = Buffer.from(kopregel.slice(6).trim(), 'base64').toString('utf8');
    } catch {
      return null;
    }
    const scheiding = ontcijferd.indexOf(':');
    if (scheiding === -1) return null;
    const naam = afdruk(ontcijferd.slice(0, scheiding));
    const geheim = afdruk(ontcijferd.slice(scheiding + 1));
    const ok = crypto.timingSafeEqual(naam, gebruikerAfdruk) && crypto.timingSafeEqual(geheim, wachtwoordAfdruk);
    return ok ? gebruiker : null;
  }

  function vraagInlog(res) {
    kop(res, 401, 'text/plain; charset=utf-8', {
      'www-authenticate': `Basic realm="${realm}", charset="UTF-8"`,
    });
    res.end('Inloggen vereist.\n');
  }

  return { klaar: Boolean(gebruiker && wachtwoord), ingelogd, vraagInlog };
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
    // Alleen nog voor het losse dashboard (maakServer); in het portaal staat
    // het factuurdashboard altijd onder /facturen.
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
    mailProvider: (env.MAIL_PROVIDER || 'm365').trim().toLowerCase(),
    sorteren: {
      model: env.SORT_MODEL || STANDAARD_SORTEER_MODEL,
      minuten: Math.max(1, Number(env.SORT_INTERVAL_MIN) || 5),
    },
    webhookGeheim: env.GRAPH_WEBHOOK_SECRET || '',
    portaal: {
      baseUrl: String(env.PORTAL_BASE_URL || '').trim().replace(/\/+$/, ''),
      // De portaal-app staat in dezelfde tenant als de mail-app.
      tenantId: env.ENTRA_TENANT_ID || env.M365_TENANT_ID || '',
      clientId: env.ENTRA_PORTAL_CLIENT_ID || '',
      clientSecret: env.ENTRA_PORTAL_CLIENT_SECRET || '',
      toegestaan: splitsLijst(env.PORTAL_ALLOWED_EMAILS),
      sessieGeheim: env.SESSION_SECRET || '',
      offertesUrl: String(env.OFFERTES_URL || '').trim(),
    },
  };
}

// Is inloggen met Microsoft compleet ingesteld? Pas dan vervalt Basic Auth
// en mag het portaal via nginx publiek. Half ingesteld telt als niet.
export function ssoStatus(portaal) {
  const ontbreekt = [];
  if (!/^https:\/\/[^/\s]+$/.test(portaal.baseUrl)) ontbreekt.push('PORTAL_BASE_URL (https://host, zonder pad)');
  if (!/^[0-9a-f-]{36}$/i.test(portaal.tenantId)) ontbreekt.push('M365_TENANT_ID (als GUID)');
  if (!portaal.clientId) ontbreekt.push('ENTRA_PORTAL_CLIENT_ID');
  if (!portaal.clientSecret) ontbreekt.push('ENTRA_PORTAL_CLIENT_SECRET');
  if (!portaal.toegestaan.length) ontbreekt.push('PORTAL_ALLOWED_EMAILS');
  if (String(portaal.sessieGeheim).length < 32) ontbreekt.push('SESSION_SECRET (minstens 32 tekens)');
  return { aan: ontbreekt.length === 0, ontbreekt };
}

function start() {
  const cfg = uitEnv();
  mkdirSync(cfg.pdfMap, { recursive: true });

  const opslag = maakOpslag(openDatabase(cfg.dbPad));
  const sorteerOpslag = maakSorteerOpslag(opslag.db);
  const logger = (niveau, bericht) => opslag.log(niveau, bericht);
  const leesInstellingen = () => instellingen.lees(opslag);

  const mail = maakMailKoppeling({ provider: cfg.mailProvider, ...cfg.m365 });
  const claude = maakClaude({ ...cfg.claude, log: logger });
  const classificeerder = maakClassificeerder({ apiKey: cfg.claude.apiKey, model: cfg.sorteren.model });
  const bunq = maakBunq({
    apiKey: cfg.bunq.apiKey,
    omgeving: cfg.bunq.omgeving,
    statePad: cfg.bunqStatePad,
    ibanFilter: cfg.bunq.ibans,
    log: logger,
  });

  // Het factuurdashboard leest de map Facturen via dezelfde mailkoppeling.
  const facturen = maakFacturenApp({ opslag, graph: mail, claude, bunq, pdfMap: cfg.pdfMap, basisPad: '/facturen' });
  const sorteerder = maakSorteerder({ sorteerOpslag, mail, classificeerder, instellingenLezer: leesInstellingen, log: logger });

  const sso = ssoStatus(cfg.portaal);
  const webhook = maakWebhook({
    mail, sorteerOpslag, sorteerder,
    geheim: cfg.webhookGeheim,
    notificatieUrl: cfg.portaal.baseUrl ? cfg.portaal.baseUrl + '/graph/notify' : '',
    actief: sso.aan,
    log: logger,
  });
  const mailApp = maakMailApp({
    opslag, sorteerOpslag, sorteerder, webhook, mail, classificeerder,
    basisPad: '/mail', sorteerMinuten: cfg.sorteren.minuten,
  });

  let auth;
  if (sso.aan) {
    const sessies = maakSessies({ db: opslag.db, geheim: cfg.portaal.sessieGeheim });
    const oidc = maakOidc({ ...cfg.portaal, pogingen: sessies.pogingen });
    auth = { modus: 'sso', sessies, oidc, baseUrl: cfg.portaal.baseUrl };
  } else {
    auth = {
      modus: 'basic',
      basic: maakBasicAuth({ gebruiker: cfg.gebruiker, wachtwoord: cfg.wachtwoord }),
      // Alleen voor de CSRF-tokens; zonder SESSION_SECRET één per start.
      geheim: cfg.portaal.sessieGeheim || crypto.randomBytes(32).toString('hex'),
    };
  }

  const { server } = maakPortaal({
    opslag, sorteerOpslag, facturen, mailApp, webhook, auth,
    offertesUrl: cfg.portaal.offertesUrl,
    log: logger,
  });

  const ontbreekt = [
    !sso.aan && (!cfg.gebruiker || !cfg.wachtwoord) ? 'DASHBOARD_USER/DASHBOARD_PASSWORD' : null,
    !mail.beschikbaar ? 'Microsoft 365' : null,
    !claude.beschikbaar ? 'Claude' : null,
    !bunq.beschikbaar ? 'bunq' : null,
  ].filter(Boolean);
  if (ontbreekt.length) {
    console.warn(nuIso() + ' niet ingesteld: ' + ontbreekt.join(', ') + ' (die stappen worden overgeslagen)');
  }
  console.log(nuIso() + (sso.aan
    ? ' inloggen: Microsoft (SSO) voor ' + cfg.portaal.baseUrl
    : ' inloggen: Basic Auth, alleen lokaal (SSO mist: ' + sso.ontbreekt.join(', ') + ')'));
  if (!webhook.actief) console.log(nuIso() + ' webhook uit: de mailsorteerder pollt alleen');

  server.listen(cfg.poort, '127.0.0.1', () => {
    console.log(`${nuIso()} portaal luistert op 127.0.0.1:${cfg.poort}, data in ${cfg.dataMap}`);
  });

  // De factuurronde start pas na de eerste wachttijd; direct bij het
  // opstarten synchroniseren zou een herstart een dure bezigheid maken.
  const factuurTimer = setInterval(() => {
    facturen.sync.draai({ aanleiding: 'timer' }).catch((fout) => {
      console.error(nuIso() + ' sync mislukt: ' + fout.message);
    });
  }, cfg.syncMinuten * 60 * 1000);
  factuurTimer.unref();

  // Sorteren is goedkoop (een delta query); de eerste ronde na een halve
  // minuut, zodat een nieuw startpunt of een subscription snel klaarstaat.
  const sorteerRonde = async () => {
    await sorteerder.draai({ aanleiding: 'timer' });
    await webhook.onderhoud();
  };
  setTimeout(() => sorteerRonde().catch(() => {}), 30 * 1000).unref();
  setInterval(() => sorteerRonde().catch((fout) => {
    console.error(nuIso() + ' sorteren mislukt: ' + fout.message);
  }), cfg.sorteren.minuten * 60 * 1000).unref();

  if (auth.sessies) setInterval(() => auth.sessies.opruimen(), 60 * 60 * 1000).unref();

  for (const signaal of ['SIGTERM', 'SIGINT']) {
    process.on(signaal, () => {
      console.log(nuIso() + ' afsluiten op ' + signaal);
      server.close(() => process.exit(0));
    });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) start();
