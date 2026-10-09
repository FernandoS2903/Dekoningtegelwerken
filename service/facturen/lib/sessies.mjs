// Portaalsessies in SQLite, plus de opslag van lopende inlogpogingen.
//
// Het cookie bevat een willekeurig token van 256 bits. In de database staat
// alleen een HMAC daarvan (sleutel SESSION_SECRET): wie de database heeft,
// kan daar niet mee inloggen. Elke sessie heeft een eigen CSRF-token.
//
// Cookie: __Host-dkt_sessie; Secure, HttpOnly, SameSite=Lax, Path=/, geen
// Domain (dat eist __Host-). Geldig 8 uur na de laatste activiteit
// (schuivend); we schrijven de nieuwe verlooptijd hooguit eens per vijf
// minuten weg en sturen dan ook het cookie opnieuw mee.

import crypto from 'node:crypto';

export const SESSIE_COOKIE = '__Host-dkt_sessie';
export const LOGIN_COOKIE = '__Host-dkt_login';
export const DUUR_MS = 8 * 60 * 60 * 1000;
export const SCHUIF_NA_MS = 5 * 60 * 1000;

export function leesCookies(kopregel) {
  const uit = {};
  for (const deel of String(kopregel || '').split(';')) {
    const is = deel.indexOf('=');
    if (is === -1) continue;
    const naam = deel.slice(0, is).trim();
    if (naam && !(naam in uit)) uit[naam] = deel.slice(is + 1).trim();
  }
  return uit;
}

export function cookieRegel(naam, waarde, maxAgeSeconden) {
  return `${naam}=${waarde}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconden))}`;
}

export function maakSessies({ db, geheim, nu = () => Date.now() }) {
  if (!geheim || String(geheim).length < 32) throw new Error('SESSION_SECRET ontbreekt of is korter dan 32 tekens');
  const sleutel = (token) => crypto.createHmac('sha256', geheim).update(String(token)).digest('hex');
  const q = (sql) => db.prepare(sql);

  const sNieuw = q(`INSERT INTO sessies (id, email, naam, csrf, aangemaakt_op, verloopt_op, bijgewerkt_op)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const sZoek = q('SELECT * FROM sessies WHERE id = ?');
  const sSchuif = q('UPDATE sessies SET verloopt_op = ?, bijgewerkt_op = ? WHERE id = ?');
  const sWeg = q('DELETE FROM sessies WHERE id = ?');
  const sOpruimen = q('DELETE FROM sessies WHERE verloopt_op < ?');

  const sPoging = q(`INSERT INTO oidc_pogingen (state, nonce, verifier, terug, verloopt_op) VALUES (?, ?, ?, ?, ?)`);
  const sNeemPoging = q('SELECT * FROM oidc_pogingen WHERE state = ?');
  const sWegPoging = q('DELETE FROM oidc_pogingen WHERE state = ?');
  const sOpruimenPogingen = q('DELETE FROM oidc_pogingen WHERE verloopt_op < ?');

  return {
    maak({ email, naam = '' }) {
      const token = crypto.randomBytes(32).toString('base64url');
      const csrf = crypto.randomBytes(32).toString('base64url');
      const t = nu();
      sNieuw.run(sleutel(token), email, naam, csrf, new Date(t).toISOString(), t + DUUR_MS, t);
      return { token, csrf };
    },

    // Geeft {sessie, cookie} of null. `cookie` is gevuld als het cookie
    // opnieuw mee moet (de sessie is opgeschoven).
    zoek(token) {
      if (!token || token.length > 100) return null;
      const id = sleutel(token);
      const sessie = sZoek.get(id);
      if (!sessie) return null;
      const t = nu();
      if (sessie.verloopt_op < t) {
        sWeg.run(id);
        return null;
      }
      let cookie = null;
      if (t - sessie.bijgewerkt_op > SCHUIF_NA_MS) {
        sSchuif.run(t + DUUR_MS, t, id);
        cookie = cookieRegel(SESSIE_COOKIE, token, DUUR_MS / 1000);
      }
      return { sessie, cookie };
    },

    verwijder(token) { if (token) sWeg.run(sleutel(token)); },

    opruimen() {
      sOpruimen.run(nu());
      sOpruimenPogingen.run(nu());
    },

    cookie: (token) => cookieRegel(SESSIE_COOKIE, token, DUUR_MS / 1000),
    wisCookie: () => cookieRegel(SESSIE_COOKIE, '', 0),

    // -- inlogpogingen (voor oidc.mjs) -------------------------------------
    pogingen: {
      bewaar(state, { nonce, verifier, terug, verlooptOp }) {
        sOpruimenPogingen.run(nu());
        sPoging.run(state, nonce, verifier, terug, verlooptOp);
      },
      // Eenmalig: ophalen is meteen verwijderen.
      neem(state) {
        const r = sNeemPoging.get(state);
        if (!r) return null;
        sWegPoging.run(state);
        return { nonce: r.nonce, verifier: r.verifier, terug: r.terug, verlooptOp: r.verloopt_op };
      },
    },
  };
}
