// Het portaal: één login voor factuurdashboard en mailsorteerder, en de
// controle die nginx gebruikt voor andere onderdelen (auth_request).
//
// Twee manieren van inloggen, nooit allebei:
//  - SSO (Entra, OIDC): zodra alles in de env staat (zie ssoStatus in
//    server.mjs). Sessie in SQLite, cookie __Host-dkt_sessie.
//  - Basic Auth: zolang SSO niet is ingesteld. Dan is het portaal alleen op
//    127.0.0.1 bereikbaar; de nginx-vhost hoort er dan niet te staan.
//
// Elke POST moet van dezelfde herkomst komen (Sec-Fetch-Site/Origin) én het
// CSRF-token van de sessie meesturen (verborgen veld _csrf, dat pagina() in
// elk formulier zet). /graph/notify heeft geen login maar een eigen controle
// op clientState (lib/webhook.mjs).
//
//   GET  /auth/check      200 + X-Portal-User bij een geldige sessie, anders 401
//   GET  /auth/login      naar Microsoft (met state, nonce en PKCE)
//   GET  /auth/callback   terug van Microsoft: id_token controleren, sessie maken
//   POST /auth/logout     sessie weg, daarna de logout van Microsoft
//   GET  /auth/uitgelogd  bevestiging

import http from 'node:http';
import crypto from 'node:crypto';

import { OidcFout, veiligTerug } from './lib/oidc.mjs';
import { LOGIN_COOKIE, SESSIE_COOKIE, cookieRegel, leesCookies } from './lib/sessies.mjs';
import { nuIso, vandaag } from './lib/hulp.mjs';
import {
  bezoekerIp, doorsturen, kop, leesBody, leesRuw, stuurHtml, stuurTekst, zelfdeHerkomst, zelfdeTekst,
} from './lib/web.mjs';
import { STATISCH, stuurStatisch } from './web/statisch.mjs';
import { losPagina } from './web/portaal.mjs';

export const MAX_NOTIFY_BYTES = 256 * 1024;
const IS_HEADERWAARDE = /^[\x21-\x7e]{1,254}$/;

// Middernacht in Amsterdam als UTC-tijd, voor "vandaag gesorteerd".
export function middernachtAmsterdam(nu = new Date()) {
  const dag = vandaag(nu);
  for (const verschil of ['+02:00', '+01:00']) {
    const d = new Date(`${dag}T00:00:00${verschil}`);
    if (vandaag(d) === dag && vandaag(new Date(d.getTime() - 1)) !== dag) return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  return `${dag}T00:00:00Z`;
}

export function maakPortaal({
  opslag,
  sorteerOpslag,
  facturen,
  mailApp,
  webhook,
  auth,
  offertes = null,
  intern = null,
  offertesUrl = '',
  log = () => {},
}) {
  const sso = auth.modus === 'sso';

  function meld(req, tekst) {
    // Voor de journal (en eventueel fail2ban); nooit tokens of codes.
    console.warn(`${nuIso()} ${tekst} (ip ${bezoekerIp(req)})`);
  }

  // Wie is dit? {email, naam, csrf, modus, token} of null.
  function wie(req, res) {
    if (sso) {
      const token = leesCookies(req.headers.cookie)[SESSIE_COOKIE];
      const gevonden = auth.sessies.zoek(token);
      if (!gevonden) return null;
      if (gevonden.cookie && res) res.setHeader('set-cookie', gevonden.cookie);
      const { sessie } = gevonden;
      return { email: sessie.email, naam: sessie.naam, csrf: sessie.csrf, modus: 'sso', token };
    }
    const naam = auth.basic.klaar ? auth.basic.ingelogd(req) : null;
    if (!naam) return null;
    const csrf = crypto.createHmac('sha256', auth.geheim).update('csrf-basic:' + naam).digest('base64url');
    return { email: naam, naam, csrf, modus: 'basic' };
  }

  function weiger(req, res, url) {
    if (!sso) {
      if (!auth.basic.klaar) {
        return stuurTekst(res, 503, 'Dit portaal is nog niet ingesteld: DASHBOARD_USER en DASHBOARD_PASSWORD ontbreken in de env.');
      }
      return auth.basic.vraagInlog(res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      return doorsturen(res, 302, '/auth/login?' + new URLSearchParams({ terug: url.pathname + url.search }));
    }
    return stuurTekst(res, 401, 'Niet ingelogd.');
  }

  // -- /auth/... ---------------------------------------------------------
  async function authRoute(req, res, url) {
    const pad = url.pathname;

    if (pad === '/auth/check' && (req.method === 'GET' || req.method === 'HEAD')) {
      const persoon = wie(req, res);
      if (!persoon || !IS_HEADERWAARDE.test(persoon.email)) {
        kop(res, 401, 'text/plain; charset=utf-8');
        return res.end('');
      }
      kop(res, 200, 'text/plain; charset=utf-8', { 'x-portal-user': persoon.email });
      return res.end('');
    }

    if (pad === '/auth/login' && req.method === 'GET') {
      if (!sso) return doorsturen(res, 302, '/');
      const { url: naar, state } = auth.oidc.start({ terug: url.searchParams.get('terug') || '/' });
      return doorsturen(res, 302, naar, { 'set-cookie': cookieRegel(LOGIN_COOKIE, state, 600) });
    }

    if (pad === '/auth/callback' && req.method === 'GET') {
      if (!sso) return stuurTekst(res, 404, 'Niet gevonden.');
      const wisLogin = cookieRegel(LOGIN_COOKIE, '', 0);
      try {
        const { gebruiker, terug } = await auth.oidc.callback({
          zoekparams: url.searchParams,
          cookieState: leesCookies(req.headers.cookie)[LOGIN_COOKIE],
        });
        const { token } = auth.sessies.maak(gebruiker);
        log('info', `Ingelogd in het portaal: ${gebruiker.email}`);
        return doorsturen(res, 302, veiligTerug(terug), { 'set-cookie': [auth.sessies.cookie(token), wisLogin] });
      } catch (fout) {
        const status = fout instanceof OidcFout ? fout.status : 502;
        meld(req, `inloggen geweigerd (${status}): ${fout.message}`);
        log('warn', `Inloggen in het portaal geweigerd: ${fout.message}`);
        const html = status === 403
          ? losPagina({ titel: 'Geen toegang', tekst: 'Dit account heeft geen toegang tot het portaal van De Koning Tegelwerken.', link: { href: '/auth/login', tekst: 'Met een ander account inloggen' } })
          : losPagina({ titel: 'Inloggen mislukt', tekst: 'Het inloggen kon niet worden afgerond. Probeer het opnieuw.', link: { href: '/auth/login', tekst: 'Opnieuw inloggen' } });
        return stuurHtml(res, status === 403 ? 403 : 400, html, { 'set-cookie': wisLogin });
      }
    }

    if (pad === '/auth/logout' && req.method === 'POST') {
      if (!sso) return doorsturen(res, 303, '/');
      if (!zelfdeHerkomst(req)) return stuurTekst(res, 403, 'Dit formulier moet van het portaal zelf komen.');
      const persoon = wie(req, null);
      const body = await leesBody(req);
      if (!persoon) return doorsturen(res, 303, '/auth/uitgelogd', { 'set-cookie': auth.sessies.wisCookie() });
      if (!zelfdeTekst(body.get('_csrf'), persoon.csrf)) return stuurTekst(res, 403, 'Het formulier is verlopen; laad de pagina opnieuw.');
      auth.sessies.verwijder(persoon.token);
      log('info', `Uitgelogd uit het portaal: ${persoon.email}`);
      return doorsturen(res, 303, auth.oidc.logoutUrl(), { 'set-cookie': auth.sessies.wisCookie() });
    }

    if (pad === '/auth/uitgelogd' && req.method === 'GET') {
      return stuurHtml(res, 200, losPagina({
        titel: 'Uitgelogd', tekst: 'Je bent uitgelogd uit het portaal van De Koning Tegelwerken.',
        link: { href: '/auth/login', tekst: 'Opnieuw inloggen' },
      }));
    }

    return stuurTekst(res, 404, 'Niet gevonden.');
  }

  // -- /graph/notify -------------------------------------------------------
  async function notify(req, res, url) {
    let body = '';
    if (req.method === 'POST') {
      try {
        body = await leesRuw(req, MAX_NOTIFY_BYTES);
      } catch {
        return stuurTekst(res, 413, 'Te groot.');
      }
    }
    const uit = webhook.verwerk({ methode: req.method, zoekparams: url.searchParams, body });
    if (uit.status === 401) meld(req, 'webhook met verkeerde clientState geweigerd');
    if (uit.letterlijk) {
      // Graph wil het token precies terug, als platte tekst en zonder regeleinde.
      kop(res, 200, 'text/plain; charset=utf-8');
      return res.end(uit.tekst);
    }
    kop(res, uit.status, 'text/plain; charset=utf-8');
    return res.end(uit.tekst ? uit.tekst + '\n' : '');
  }

  // -- startpagina -----------------------------------------------------------
  // Het financiële dashboard, met de mailtellingen erbij.
  function start(res, kader) {
    const week = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    return stuurHtml(res, 200, facturen.dashboard({
      kader,
      mail: sorteerOpslag.tellingen({ vandaagVanaf: middernachtAmsterdam(), weekVanaf: week }),
      offertesUrl,
      offertes: offertes ? offertes.tellingen(vandaag()) : null,
    }));
  }

  // -- de router -------------------------------------------------------------
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pad = url.pathname;

      if ((req.method === 'GET' || req.method === 'HEAD') && STATISCH[pad]) return stuurStatisch(res, pad, { versie: url.searchParams.get('v') });
      if (pad === '/graph/notify') return notify(req, res, url);
      // Offerteknop -> portaal: eigen handtekening, geen login (intern.mjs).
      if (pad.startsWith('/intern/')) {
        if (!intern) return stuurTekst(res, 404, 'Niet gevonden.');
        return intern.handle(req, res, url);
      }
      if (pad.startsWith('/auth/')) return authRoute(req, res, url);

      const persoon = wie(req, res);
      if (!persoon) return weiger(req, res, url);

      let body = null;
      if (req.method === 'POST') {
        if (!zelfdeHerkomst(req)) return stuurTekst(res, 403, 'Dit formulier moet van het portaal zelf komen.');
        body = await leesBody(req);
        if (!zelfdeTekst(body.get('_csrf'), persoon.csrf)) {
          meld(req, 'POST zonder geldig CSRF-token geweigerd');
          return stuurTekst(res, 403, 'Het formulier is verlopen of komt niet van het portaal; laad de pagina opnieuw.');
        }
      }

      const kader = { naam: persoon.naam, email: persoon.email, modus: persoon.modus, csrf: persoon.csrf, offertesUrl };
      const ctx = { kader, body };

      if (pad === '/' && req.method === 'GET') return start(res, kader);
      if (pad === '/facturen' || pad === '/mail' || pad === '/offertes') return doorsturen(res, 301, pad + '/' + url.search);
      if (pad.startsWith('/facturen/')) return facturen.handle(req, res, ctx);
      if (pad.startsWith('/mail/')) return mailApp.handle(req, res, ctx);
      if (pad.startsWith('/offertes/') && offertes) return offertes.handle(req, res, ctx);

      return stuurTekst(res, 404, 'Niet gevonden.');
    } catch (fout) {
      console.error(nuIso() + ' fout in het portaal bij ' + req.method + ': ' + fout.message);
      try {
        opslag.log('error', 'Onverwachte fout in het portaal: ' + fout.message);
      } catch { /* database niet beschikbaar */ }
      if (!res.headersSent) return stuurTekst(res, 500, 'Er ging iets mis. De melding staat in het logboek.');
      return res.end();
    }
  });

  return { server };
}
