// Inloggen met Microsoft (Entra ID) voor het portaal: OpenID Connect,
// authorization code flow met PKCE, state en nonce.
//
// App registration "DKT Portaal" (gescheiden van de mail-app): delegated,
// alleen openid profile email, met een client secret. Op de enterprise app
// staat "Assignment required", en daarbovenop moet het e-mailadres in
// PORTAL_ALLOWED_EMAILS staan. Een lege lijst laat niemand binnen.
//
// Het id_token controleren we zelf, zonder bibliotheek:
//  - handtekening (RS256) met de sleutels uit de JWKS van de tenant, via
//    node:crypto en JWK-import; sleutels worden gecachet en alleen opnieuw
//    opgehaald bij een onbekende kid (hooguit eens per vijf minuten);
//  - iss, aud, tid, exp (en nbf) en de nonce van deze inlogpoging.
//
// De state is eenmalig, tien minuten geldig en gebonden aan de browser via
// een eigen cookie; zo kan niemand een ander op zijn eigen account laten
// inloggen. Er staat nooit een token, code of secret in een logregel.

import crypto from 'node:crypto';
import { HttpFout, jsonOfFout, vraag } from './http.mjs';

export const SCOPE = 'openid profile email';
export const POGING_MS = 10 * 60 * 1000;
export const KLOKMARGE_S = 120;
export const JWKS_CACHE_MS = 24 * 60 * 60 * 1000;
export const JWKS_OPNIEUW_MS = 5 * 60 * 1000;

export class OidcFout extends Error {
  constructor(status, reden) {
    super(reden);
    this.name = 'OidcFout';
    this.status = status;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const willekeurig = (n = 32) => b64url(crypto.randomBytes(n));
export const pkceUitdaging = (verifier) => b64url(crypto.createHash('sha256').update(verifier).digest());

function zelfde(a, b) {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y) && a !== undefined && a !== null && a !== '';
}

export function eindpunten(tenantId) {
  const t = encodeURIComponent(tenantId);
  return {
    authorize: `https://login.microsoftonline.com/${t}/oauth2/v2.0/authorize`,
    token: `https://login.microsoftonline.com/${t}/oauth2/v2.0/token`,
    jwks: `https://login.microsoftonline.com/${t}/discovery/v2.0/keys`,
    logout: `https://login.microsoftonline.com/${t}/oauth2/v2.0/logout`,
    issuer: `https://login.microsoftonline.com/${tenantId}/v2.0`,
  };
}

export function splitsLijst(waarde) {
  return String(waarde || '').split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// `pogingen` bewaart state -> {nonce, verifier, terug} (zie sessies.mjs).
export function maakOidc({
  tenantId,
  clientId,
  clientSecret,
  baseUrl,
  toegestaan = [],
  pogingen,
  fetch: fetchFn = globalThis.fetch,
  nu = () => Date.now(),
}) {
  const ep = eindpunten(tenantId);
  const redirectUri = `${baseUrl.replace(/\/+$/, '')}/auth/callback`;
  const uitgelogdUri = `${baseUrl.replace(/\/+$/, '')}/auth/uitgelogd`;
  const lijst = new Set(toegestaan.map((s) => s.toLowerCase()));

  let sleutels = new Map();
  let sleutelsVan = 0;
  let laatsteOphaling = 0;

  async function haalSleutels() {
    laatsteOphaling = nu();
    const antwoord = await vraag(fetchFn, ep.jwks, { headers: { accept: 'application/json' } }, { timeoutMs: 15000 });
    const data = await jsonOfFout(antwoord, ep.jwks);
    const nieuw = new Map();
    for (const jwk of data.keys || []) {
      if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.use && jwk.use !== 'sig')) continue;
      try {
        nieuw.set(jwk.kid, crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' }));
      } catch { /* onbruikbare sleutel overslaan */ }
    }
    sleutels = nieuw;
    sleutelsVan = nu();
  }

  async function sleutel(kid) {
    const verouderd = nu() - sleutelsVan > JWKS_CACHE_MS;
    if (verouderd || (!sleutels.has(kid) && nu() - laatsteOphaling > JWKS_OPNIEUW_MS)) await haalSleutels();
    const gevonden = sleutels.get(kid);
    if (!gevonden) throw new OidcFout(400, 'onbekende sleutel (kid) in het id_token');
    return gevonden;
  }

  // Geeft de claims terug of gooit OidcFout(400).
  async function valideerIdToken(token, { nonce }) {
    const delen = String(token || '').split('.');
    if (delen.length !== 3) throw new OidcFout(400, 'id_token heeft geen drie delen');
    let kop;
    let claims;
    try {
      kop = JSON.parse(Buffer.from(delen[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(delen[1], 'base64url').toString('utf8'));
    } catch {
      throw new OidcFout(400, 'id_token is geen geldige JWT');
    }
    if (kop.alg !== 'RS256') throw new OidcFout(400, `onverwacht algoritme ${String(kop.alg).slice(0, 10)}`);

    const ok = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${delen[0]}.${delen[1]}`),
      await sleutel(kop.kid),
      Buffer.from(delen[2], 'base64url'),
    );
    if (!ok) throw new OidcFout(400, 'handtekening van het id_token klopt niet');

    const seconden = Math.floor(nu() / 1000);
    if (claims.iss !== ep.issuer) throw new OidcFout(400, 'verkeerde issuer');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!aud.includes(clientId)) throw new OidcFout(400, 'verkeerde audience');
    if (claims.tid !== tenantId) throw new OidcFout(400, 'verkeerde tenant');
    if (typeof claims.exp !== 'number' || claims.exp + KLOKMARGE_S < seconden) throw new OidcFout(400, 'id_token is verlopen');
    if (typeof claims.nbf === 'number' && claims.nbf - KLOKMARGE_S > seconden) throw new OidcFout(400, 'id_token is nog niet geldig');
    if (!zelfde(claims.nonce, nonce)) throw new OidcFout(400, 'nonce klopt niet');
    return claims;
  }

  return {
    redirectUri,

    // Nieuwe inlogpoging: geeft de URL naar Microsoft en de state (voor het
    // browsercookie).
    start({ terug = '/' } = {}) {
      const state = willekeurig();
      const nonce = willekeurig();
      const verifier = willekeurig(48);
      pogingen.bewaar(state, { nonce, verifier, terug: veiligTerug(terug), verlooptOp: nu() + POGING_MS });
      const p = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        response_mode: 'query',
        scope: SCOPE,
        state,
        nonce,
        code_challenge: pkceUitdaging(verifier),
        code_challenge_method: 'S256',
      });
      return { url: `${ep.authorize}?${p}`, state };
    },

    // De terugkeer van Microsoft. Geeft {gebruiker: {email, naam}, terug}.
    async callback({ zoekparams, cookieState }) {
      const state = zoekparams.get('state') || '';
      const poging = state ? pogingen.neem(state) : null; // eenmalig
      if (!poging || poging.verlooptOp < nu()) throw new OidcFout(400, 'onbekende of verlopen inlogpoging');
      if (!zelfde(state, cookieState)) throw new OidcFout(400, 'inlogpoging hoort niet bij deze browser');
      if (zoekparams.get('error')) throw new OidcFout(400, 'Microsoft meldde: ' + String(zoekparams.get('error')).slice(0, 60));
      const code = zoekparams.get('code');
      if (!code) throw new OidcFout(400, 'geen code ontvangen');

      const antwoord = await vraag(fetchFn, ep.token, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          code_verifier: poging.verifier,
          scope: SCOPE,
        }).toString(),
      }, { timeoutMs: 20000, pogingen: 1 });

      let data;
      try {
        data = await jsonOfFout(antwoord, ep.token);
      } catch (fout) {
        // Alleen de status: het antwoord kan de code of het secret echoën.
        throw new OidcFout(400, 'code inwisselen mislukt (' + (fout instanceof HttpFout ? fout.status : '?') + ')');
      }

      const claims = await valideerIdToken(data.id_token, { nonce: poging.nonce });
      const kandidaten = [claims.preferred_username, claims.email, claims.upn]
        .filter((s) => typeof s === 'string' && s.includes('@')).map((s) => s.toLowerCase());
      const email = kandidaten.find((s) => lijst.has(s));
      if (!email) throw new OidcFout(403, 'account staat niet in PORTAL_ALLOWED_EMAILS');
      return { gebruiker: { email, naam: String(claims.name || email).slice(0, 100) }, terug: poging.terug };
    },

    logoutUrl() {
      return `${ep.logout}?${new URLSearchParams({ post_logout_redirect_uri: uitgelogdUri })}`;
    },

    valideerIdToken,
  };
}

// Alleen een pad binnen het portaal, nooit een andere host.
export function veiligTerug(terug) {
  const s = String(terug || '/');
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || /[\r\n]/.test(s)) return '/';
  if (s.startsWith('/auth/')) return '/';
  return s.slice(0, 500);
}
