// Een nagebootste Entra (Microsoft-login) voor de tests van het portaal:
// eigen RSA-sleutels, een JWKS en een tokendienst die een id_token tekent.
// Geen testbestand zelf.

import crypto from 'node:crypto';

export const TENANT = '11111111-2222-3333-4444-555555555555';
export const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
export const BASIS = 'https://cms.dekoningtegelwerken.nl';
export const GEHEIM = 'een-sessiegeheim-van-ruim-tweeëndertig-tekens-lang';

export function sleutelpaar() {
  return crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
}

export function jwk(publicKey, kid) {
  const { n, e } = publicKey.export({ format: 'jwk' });
  return { kty: 'RSA', use: 'sig', kid, n, e };
}

export function tekenJwt(claims, privateKey, { kid = 'sleutel-1', alg = 'RS256' } = {}) {
  const kop = Buffer.from(JSON.stringify({ alg, typ: 'JWT', kid })).toString('base64url');
  const lijf = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const handtekening = crypto.sign('RSA-SHA256', Buffer.from(`${kop}.${lijf}`), privateKey).toString('base64url');
  return `${kop}.${lijf}.${handtekening}`;
}

// Geldige claims voor deze tenant en client; per test te overschrijven.
export function claims({ nonce, nu = Date.now(), ...rest }) {
  const s = Math.floor(nu / 1000);
  return {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: CLIENT,
    tid: TENANT,
    iat: s - 10,
    nbf: s - 10,
    exp: s + 3600,
    nonce,
    name: 'Bob Schol',
    preferred_username: 'bob@dekoningtegelwerken.nl',
    oid: 'oid-1',
    ...rest,
  };
}

// fetch voor de JWKS en de tokendienst. `idToken(nonce)` bepaalt wat de
// tokendienst teruggeeft; de nonce haalt hij uit de laatste inlog-URL.
export function nepEntra() {
  const { publicKey, privateKey } = sleutelpaar();
  const entra = {
    publicKey,
    privateKey,
    kid: 'sleutel-1',
    jwksOpgehaald: 0,
    tokenVerzoeken: [],
    nonce: null,
    // Standaard: een geldig token met de nonce van de laatste poging.
    idToken: (nonce) => tekenJwt(claims({ nonce }), privateKey, { kid: entra.kid }),
    tokenStatus: 200,
  };
  entra.fetch = async (url, opties = {}) => {
    const antwoord = (status, data) => ({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      async json() { return data; },
      async text() { return JSON.stringify(data); },
    });
    if (String(url).endsWith('/discovery/v2.0/keys')) {
      entra.jwksOpgehaald++;
      return antwoord(200, { keys: [jwk(publicKey, 'sleutel-1')] });
    }
    if (String(url).endsWith('/oauth2/v2.0/token')) {
      const p = new URLSearchParams(opties.body);
      entra.tokenVerzoeken.push(p);
      if (entra.tokenStatus !== 200) return antwoord(entra.tokenStatus, { error: 'invalid_grant' });
      return antwoord(200, { id_token: entra.idToken(entra.nonce), token_type: 'Bearer' });
    }
    throw new Error('nepEntra: onverwacht verzoek naar ' + url);
  };
  // Na oidc.start(): de nonce uit de inlog-URL onthouden.
  entra.onthoud = (inlogUrl) => {
    const p = new URL(inlogUrl).searchParams;
    entra.nonce = p.get('nonce');
    return p;
  };
  return entra;
}
