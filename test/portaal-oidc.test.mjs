// Inloggen met Microsoft (lib/oidc.mjs) en de sessies (lib/sessies.mjs),
// met een nagebootste Entra: eigen sleutels, eigen JWKS, eigen tokendienst.
//   node --test test/portaal-oidc.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';

import { maakOidc, OidcFout, pkceUitdaging, veiligTerug } from '../service/facturen/lib/oidc.mjs';
import { maakSessies, DUUR_MS, SCHUIF_NA_MS } from '../service/facturen/lib/sessies.mjs';
import { ssoStatus, uitEnv } from '../service/facturen/server.mjs';
import { BASIS, CLIENT, GEHEIM, TENANT, claims, nepEntra, sleutelpaar, tekenJwt } from './portaal-hulp.mjs';
import { ruimOp, tijdelijkeOpslag } from './facturen-hulp.mjs';

after(ruimOp);

function opzet({ toegestaan = ['bob@dekoningtegelwerken.nl'], klok = { nu: Date.now() } } = {}) {
  const { opslag } = tijdelijkeOpslag();
  const sessies = maakSessies({ db: opslag.db, geheim: GEHEIM, nu: () => klok.nu });
  const entra = nepEntra();
  const oidc = maakOidc({
    tenantId: TENANT, clientId: CLIENT, clientSecret: 'portaal-secret', baseUrl: BASIS,
    toegestaan, pogingen: sessies.pogingen, fetch: entra.fetch, nu: () => klok.nu,
  });
  return { oidc, sessies, entra, opslag, klok };
}

// Een hele inlogronde tot en met de callback.
async function login({ oidc, entra }, { cookieState, state, code = 'de-code' } = {}) {
  const { url, state: echteState } = oidc.start({ terug: '/mail/' });
  entra.onthoud(url);
  const zoekparams = new URLSearchParams({ code, state: state ?? echteState });
  return oidc.callback({ zoekparams, cookieState: cookieState ?? echteState });
}

const geweigerd = (status, reden) => (fout) => fout instanceof OidcFout && fout.status === status && reden.test(fout.message);

test('de inlog-URL gebruikt code + PKCE (S256), state, nonce en alleen openid profile email', () => {
  const { oidc, entra } = opzet();
  const { url, state } = oidc.start({ terug: '/facturen/' });
  const p = entra.onthoud(url);
  assert.ok(url.startsWith(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?`));
  assert.equal(p.get('client_id'), CLIENT);
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('redirect_uri'), 'https://cms.dekoningtegelwerken.nl/auth/callback');
  assert.equal(p.get('scope'), 'openid profile email');
  assert.equal(p.get('code_challenge_method'), 'S256');
  assert.equal(p.get('state'), state);
  assert.ok(p.get('nonce').length >= 40);
  assert.ok(p.get('code_challenge').length >= 40);
});

test('een geldig token geeft een gebruiker', async () => {
  const o = opzet();
  const { gebruiker, terug } = await login(o);
  assert.deepEqual(gebruiker, { email: 'bob@dekoningtegelwerken.nl', naam: 'Bob Schol' });
  assert.equal(terug, '/mail/');

  const verzoek = o.entra.tokenVerzoeken[0];
  assert.equal(verzoek.get('grant_type'), 'authorization_code');
  assert.equal(verzoek.get('code'), 'de-code');
  assert.equal(verzoek.get('client_secret'), 'portaal-secret');
  assert.equal(verzoek.get('redirect_uri'), 'https://cms.dekoningtegelwerken.nl/auth/callback');
});

test('PKCE: de verifier bij de code past bij de challenge uit de inlog-URL', async () => {
  const o = opzet();
  const { url, state } = o.oidc.start();
  const challenge = o.entra.onthoud(url).get('code_challenge');
  await o.oidc.callback({ zoekparams: new URLSearchParams({ code: 'c', state }), cookieState: state });
  assert.equal(pkceUitdaging(o.entra.tokenVerzoeken[0].get('code_verifier')), challenge);
});

test('een verkeerde audience wordt geweigerd', async () => {
  const o = opzet();
  o.entra.idToken = (nonce) => tekenJwt(claims({ nonce, aud: 'andere-app' }), o.entra.privateKey);
  await assert.rejects(() => login(o), geweigerd(400, /audience/));
});

test('een verkeerde issuer of tenant wordt geweigerd', async () => {
  const o = opzet();
  o.entra.idToken = (nonce) => tekenJwt(claims({ nonce, iss: 'https://login.microsoftonline.com/andere/v2.0' }), o.entra.privateKey);
  await assert.rejects(() => login(o), geweigerd(400, /issuer/));
  o.entra.idToken = (nonce) => tekenJwt(claims({ nonce, tid: '99999999-2222-3333-4444-555555555555' }), o.entra.privateKey);
  await assert.rejects(() => login(o), geweigerd(400, /tenant/));
});

test('een verkeerde nonce wordt geweigerd', async () => {
  const o = opzet();
  o.entra.idToken = () => tekenJwt(claims({ nonce: 'een-andere-nonce' }), o.entra.privateKey);
  await assert.rejects(() => login(o), geweigerd(400, /nonce/));
  o.entra.idToken = () => tekenJwt(claims({ nonce: undefined }), o.entra.privateKey);
  await assert.rejects(() => login(o), geweigerd(400, /nonce/));
});

test('een handtekening met een andere sleutel wordt geweigerd', async () => {
  const o = opzet();
  const vreemd = sleutelpaar();
  o.entra.idToken = (nonce) => tekenJwt(claims({ nonce }), vreemd.privateKey, { kid: 'sleutel-1' });
  await assert.rejects(() => login(o), geweigerd(400, /handtekening/));
});

test('een gewijzigde payload met de oude handtekening wordt geweigerd', async () => {
  const o = opzet();
  o.entra.idToken = (nonce) => {
    const echt = tekenJwt(claims({ nonce }), o.entra.privateKey).split('.');
    const anders = Buffer.from(JSON.stringify(claims({ nonce, preferred_username: 'inbreker@x.nl' }))).toString('base64url');
    return `${echt[0]}.${anders}.${echt[2]}`;
  };
  await assert.rejects(() => login(o), geweigerd(400, /handtekening/));
});

test('alg none of HS256 wordt geweigerd', async () => {
  const o = opzet();
  o.entra.idToken = (nonce) => tekenJwt(claims({ nonce }), o.entra.privateKey, { alg: 'none' });
  await assert.rejects(() => login(o), geweigerd(400, /algoritme/));
});

test('een verlopen token wordt geweigerd', async () => {
  const o = opzet();
  o.entra.idToken = (nonce) => tekenJwt(claims({ nonce, exp: Math.floor(Date.now() / 1000) - 600 }), o.entra.privateKey);
  await assert.rejects(() => login(o), geweigerd(400, /verlopen/));
});

test('een onbekende kid wordt geweigerd', async () => {
  const o = opzet();
  o.entra.idToken = (nonce) => tekenJwt(claims({ nonce }), o.entra.privateKey, { kid: 'onbekend' });
  await assert.rejects(() => login(o), geweigerd(400, /kid/));
});

test('een e-mailadres buiten PORTAL_ALLOWED_EMAILS geeft 403', async () => {
  const o = opzet({ toegestaan: ['iemand-anders@dekoningtegelwerken.nl'] });
  await assert.rejects(() => login(o), geweigerd(403, /PORTAL_ALLOWED_EMAILS/));
});

test('een lege allowlist laat niemand binnen', async () => {
  const o = opzet({ toegestaan: [] });
  await assert.rejects(() => login(o), geweigerd(403, /PORTAL_ALLOWED_EMAILS/));
});

test('state: eenmalig, gebonden aan de browser en tien minuten geldig', async () => {
  const o = opzet();
  await assert.rejects(() => login(o, { cookieState: 'ander-cookie' }), geweigerd(400, /browser/));
  await assert.rejects(() => login(o, { state: 'verzonnen' }), geweigerd(400, /onbekende of verlopen/));

  const { url, state } = o.oidc.start();
  o.entra.onthoud(url);
  await o.oidc.callback({ zoekparams: new URLSearchParams({ code: 'c', state }), cookieState: state });
  await assert.rejects(
    () => o.oidc.callback({ zoekparams: new URLSearchParams({ code: 'c', state }), cookieState: state }),
    geweigerd(400, /onbekende of verlopen/), 'tweede keer dezelfde state',
  );

  const laat = o.oidc.start();
  o.entra.onthoud(laat.url);
  o.klok.nu += 11 * 60 * 1000;
  await assert.rejects(
    () => o.oidc.callback({ zoekparams: new URLSearchParams({ code: 'c', state: laat.state }), cookieState: laat.state }),
    geweigerd(400, /verlopen/),
  );
});

test('een fout van Microsoft of bij het inwisselen van de code wordt netjes geweigerd', async () => {
  const o = opzet();
  const { state } = o.oidc.start();
  await assert.rejects(
    () => o.oidc.callback({ zoekparams: new URLSearchParams({ error: 'access_denied', state }), cookieState: state }),
    geweigerd(400, /access_denied/),
  );
  o.entra.tokenStatus = 400;
  await assert.rejects(() => login(o), geweigerd(400, /code inwisselen mislukt \(400\)/));
});

test('de sleutels worden gecachet', async () => {
  const o = opzet();
  await login(o);
  await login(o);
  assert.equal(o.entra.jwksOpgehaald, 1);
});

test('terug-adressen blijven binnen het portaal', () => {
  assert.equal(veiligTerug('/mail/?map=Facturen'), '/mail/?map=Facturen');
  assert.equal(veiligTerug('https://kwaad.example/'), '/');
  assert.equal(veiligTerug('//kwaad.example/'), '/');
  assert.equal(veiligTerug('/\\kwaad.example'), '/');
  assert.equal(veiligTerug('/auth/logout'), '/');
});

test('de logout-URL gaat naar Microsoft en komt terug op /auth/uitgelogd', () => {
  const { oidc } = opzet();
  const url = new URL(oidc.logoutUrl());
  assert.equal(url.origin + url.pathname, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout`);
  assert.equal(url.searchParams.get('post_logout_redirect_uri'), 'https://cms.dekoningtegelwerken.nl/auth/uitgelogd');
});

// -- sessies ---------------------------------------------------------------
test('sessie: cookie __Host-, Secure, HttpOnly, SameSite=Lax, 8 uur', () => {
  const { sessies } = opzet();
  const { token } = sessies.maak({ email: 'bob@dekoningtegelwerken.nl', naam: 'Bob' });
  const cookie = sessies.cookie(token);
  assert.match(cookie, /^__Host-dkt_sessie=[A-Za-z0-9_-]{43}; /);
  for (const deel of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', 'Max-Age=28800']) assert.ok(cookie.includes(deel), deel);
  assert.ok(!/Domain=/i.test(cookie));
});

test('sessie: in de database staat geen token, alleen een HMAC', () => {
  const { sessies, opslag } = opzet();
  const { token } = sessies.maak({ email: 'bob@dekoningtegelwerken.nl' });
  const rij = opslag.db.prepare('SELECT * FROM sessies').get();
  assert.notEqual(rij.id, token);
  assert.equal(rij.id.length, 64);
  assert.ok(rij.csrf.length >= 43);
});

test('sessie: schuivend 8 uur, en daarna verlopen', () => {
  const klok = { nu: Date.parse('2026-10-09T08:00:00Z') };
  const { sessies } = opzet({ klok });
  const { token } = sessies.maak({ email: 'bob@dekoningtegelwerken.nl' });

  klok.nu += SCHUIF_NA_MS - 1000;
  assert.equal(sessies.zoek(token).cookie, null, 'nog niet opnieuw weggeschreven');

  klok.nu += 2000;
  assert.ok(sessies.zoek(token).cookie, 'na vijf minuten schuift hij op en komt het cookie opnieuw');

  klok.nu += DUUR_MS - 1000;
  assert.ok(sessies.zoek(token), 'binnen 8 uur na de laatste activiteit');

  klok.nu += DUUR_MS + 1000;
  assert.equal(sessies.zoek(token), null, 'meer dan 8 uur stil: verlopen');
  assert.equal(sessies.zoek(token), null, 'en weg uit de database');
});

test('sessie: uitloggen en onzin-tokens', () => {
  const { sessies } = opzet();
  const { token } = sessies.maak({ email: 'bob@dekoningtegelwerken.nl' });
  sessies.verwijder(token);
  assert.equal(sessies.zoek(token), null);
  assert.equal(sessies.zoek(''), null);
  assert.equal(sessies.zoek('x'.repeat(500)), null);
});

test('zonder SESSION_SECRET van 32 tekens geen sessies', () => {
  const { opslag } = tijdelijkeOpslag();
  assert.throws(() => maakSessies({ db: opslag.db, geheim: 'kort' }), /SESSION_SECRET/);
});

// -- wanneer telt SSO als ingesteld? ---------------------------------------
test('SSO is pas aan als alles er is; half ingesteld blijft Basic Auth', () => {
  const volledig = {
    PORTAL_BASE_URL: 'https://cms.dekoningtegelwerken.nl/',
    M365_TENANT_ID: TENANT,
    ENTRA_PORTAL_CLIENT_ID: CLIENT,
    ENTRA_PORTAL_CLIENT_SECRET: 's',
    PORTAL_ALLOWED_EMAILS: 'Bob@DeKoningTegelwerken.nl, iemand@dekoningtegelwerken.nl',
    SESSION_SECRET: GEHEIM,
  };
  const cfg = uitEnv(volledig);
  assert.equal(cfg.portaal.baseUrl, 'https://cms.dekoningtegelwerken.nl');
  assert.deepEqual(cfg.portaal.toegestaan, ['bob@dekoningtegelwerken.nl', 'iemand@dekoningtegelwerken.nl']);
  assert.deepEqual(ssoStatus(cfg.portaal), { aan: true, ontbreekt: [] });

  for (const weg of Object.keys(volledig)) {
    const half = uitEnv({ ...volledig, [weg]: '' });
    assert.equal(ssoStatus(half.portaal).aan, false, weg);
  }
  assert.equal(ssoStatus(uitEnv({ ...volledig, PORTAL_BASE_URL: 'http://cms.dekoningtegelwerken.nl' }).portaal).aan, false, 'alleen https');

  const leeg = uitEnv({});
  assert.equal(leeg.sorteren.model, 'claude-haiku-4-5');
  assert.equal(leeg.sorteren.minuten, 5);
  assert.equal(leeg.mailProvider, 'm365');
});
