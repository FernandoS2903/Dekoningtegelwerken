// Break-glass: noodtoegang tot het portaal als het inloggen met Microsoft
// niet werkt. Alleen bereikbaar via de tailnet (deploy/nginx/cms-tailnet.conf),
// en de app controleert dat zelf nog eens: het bron-IP uit X-Real-IP (alleen
// vertrouwd als het verzoek van nginx op 127.0.0.1 komt) moet in 100.64.0.0/10
// liggen. Voor iedereen daarbuiten bestaat /breakglass niet (404).
//
// Inloggen = gebruikersnaam + wachtwoord + TOTP-code. Het wachtwoord staat als
// scrypt-hash in de env (BREAKGLASS_PASSWORD_HASH; argon2 zit niet in Node
// en dit portaal heeft geen npm-afhankelijkheden), het TOTP-geheim als base32
// (BREAKGLASS_TOTP_SECRET). Een geslaagde login geeft precies dezelfde sessie
// als SSO (sessies.mjs), met auth_method 'breakglass'.
//
// Elke poging komt in de tabel breakglass_log (tijd, IP, gebruiker, uitkomst);
// uit diezelfde tabel volgt de limiet van vijf pogingen per vijftien minuten
// per IP. Een TOTP-stap die al voor een geslaagde login is gebruikt, telt niet
// nog een keer (replay). Bij een geslaagde login gaat er een melding uit (mail).

import crypto from 'node:crypto';
import { bezoekerIp, doorsturen, leesBody, stuurHtml, stuurTekst, zelfdeHerkomst } from './web.mjs';
import { nuIso } from './hulp.mjs';
import { breakglassPagina } from '../web/portaal.mjs';

export const LIMIET = Object.freeze({ pogingen: 5, vensterMs: 15 * 60 * 1000 });
export const SCRYPT = Object.freeze({ N: 2 ** 15, r: 8, p: 1, lengte: 32, zoutBytes: 16 });
export const TOTP = Object.freeze({ stapS: 30, cijfers: 6, speling: 1 });

// -- tailnet ----------------------------------------------------------------

// Binnen 100.64.0.0/10 (het CGNAT-bereik dat Tailscale gebruikt): eerste
// octet 100, tweede octet 64 tot en met 127. 100.24.x en 100.50.x zijn dus
// gewoon internet.
export function inTailnet(ip) {
  const m = String(ip || '').replace(/^::ffff:/i, '').match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  return a === 100 && b >= 64 && b <= 127;
}

// Het bron-IP zoals nginx het meegeeft, of null als het verzoek niet van
// nginx op deze machine komt of de kop ontbreekt.
export function bronIpVanNginx(req) {
  const direct = req.socket?.remoteAddress || '';
  const lokaal = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  if (!lokaal) return null;
  const ip = String(req.headers['x-real-ip'] || '').trim();
  return /^[0-9a-f.:]{3,45}$/i.test(ip) ? ip : null;
}

// -- wachtwoord (scrypt) ------------------------------------------------------

export function maakWachtwoordHash(wachtwoord, { zout = crypto.randomBytes(SCRYPT.zoutBytes) } = {}) {
  const hash = crypto.scryptSync(String(wachtwoord), zout, SCRYPT.lengte, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * 1024 * 1024 });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, zout.toString('base64'), hash.toString('base64')].join('$');
}

export function leesWachtwoordHash(tekst) {
  const d = String(tekst || '').split('$');
  if (d.length !== 6 || d[0] !== 'scrypt') return null;
  const [N, r, p] = d.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0) || N > 2 ** 20) return null;
  const zout = Buffer.from(d[4], 'base64');
  const hash = Buffer.from(d[5], 'base64');
  if (zout.length < 8 || hash.length < 16) return null;
  return { N, r, p, zout, hash };
}

// Altijd dezelfde rekentijd, ook bij een onbruikbare hash.
export function controleerWachtwoord(wachtwoord, hashTekst) {
  const h = leesWachtwoordHash(hashTekst) || { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, zout: Buffer.alloc(16), hash: Buffer.alloc(SCRYPT.lengte), ongeldig: true };
  const uit = crypto.scryptSync(String(wachtwoord), h.zout, h.hash.length, { N: h.N, r: h.r, p: h.p, maxmem: 128 * 1024 * 1024 });
  return !h.ongeldig && crypto.timingSafeEqual(uit, h.hash);
}

// -- TOTP (RFC 6238, HMAC-SHA1, 30 seconden, 6 cijfers) -----------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = 0, waarde = 0, uit = '';
  for (const byte of buf) {
    waarde = (waarde << 8) | byte; bits += 8;
    while (bits >= 5) { uit += B32[(waarde >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) uit += B32[(waarde << (5 - bits)) & 31];
  return uit;
}
export function base32Decode(tekst) {
  const schoon = String(tekst || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!schoon || /[^A-Z2-7]/.test(schoon)) return null;
  const bytes = [];
  let bits = 0, waarde = 0;
  for (const t of schoon) {
    waarde = (waarde << 5) | B32.indexOf(t); bits += 5;
    if (bits >= 8) { bytes.push((waarde >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(bytes);
}

export function totpCode(geheim, stap, { cijfers = TOTP.cijfers } = {}) {
  const teller = Buffer.alloc(8);
  teller.writeBigUInt64BE(BigInt(stap));
  const mac = crypto.createHmac('sha1', geheim).update(teller).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const kern = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(kern % 10 ** cijfers).padStart(cijfers, '0');
}

export const totpStap = (tijdMs, stapS = TOTP.stapS) => Math.floor(tijdMs / 1000 / stapS);

// Geeft de stap waarmee de code klopt (nu, of een stap ervoor of erna), of null.
export function controleerTotp(geheimB32, code, { nu = Date.now(), speling = TOTP.speling } = {}) {
  const geheim = base32Decode(geheimB32);
  const invoer = String(code || '').replace(/\s+/g, '');
  if (!geheim || geheim.length < 10 || !/^\d{6}$/.test(invoer)) return null;
  const midden = totpStap(nu);
  let gevonden = null;
  for (let s = midden - speling; s <= midden + speling; s++) {
    const a = Buffer.from(totpCode(geheim, s));
    if (crypto.timingSafeEqual(a, Buffer.from(invoer)) && gevonden === null) gevonden = s;
  }
  return gevonden;
}

export function otpauthUri({ uitgever, account, geheimB32 }) {
  const label = encodeURIComponent(`${uitgever}:${account}`);
  const p = new URLSearchParams({ secret: geheimB32, issuer: uitgever, algorithm: 'SHA1', digits: String(TOTP.cijfers), period: String(TOTP.stapS) });
  return `otpauth://totp/${label}?${p}`;
}

const zelfdeTekst = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a ?? '')).digest();
  const y = crypto.createHash('sha256').update(String(b ?? '')).digest();
  return crypto.timingSafeEqual(x, y);
};

// -- de route ----------------------------------------------------------------

export function maakBreakglass({
  gebruiker = '', wachtwoordHash = '', totpGeheim = '', sessies, db,
  log = () => {}, meld = async () => {}, nu = () => Date.now(), limiet = LIMIET,
}) {
  const beschikbaar = Boolean(gebruiker && leesWachtwoordHash(wachtwoordHash) && base32Decode(totpGeheim)?.length >= 10 && sessies);
  const q = (sql) => db.prepare(sql);
  const sLog = q('INSERT INTO breakglass_log (tijd, tijd_ms, ip, gebruiker, geslaagd, reden, totp_stap) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const sTel = q('SELECT COUNT(*) AS n FROM breakglass_log WHERE ip = ? AND tijd_ms >= ?');
  const sStapGebruikt = q('SELECT 1 FROM breakglass_log WHERE geslaagd = 1 AND totp_stap = ? LIMIT 1');

  function noteer({ ip, naam, geslaagd, reden = null, stap = null }) {
    const t = nu();
    sLog.run(new Date(t).toISOString(), t, ip, String(naam || '').slice(0, 100), geslaagd ? 1 : 0, reden, stap);
    const tekst = `break-glass ${geslaagd ? 'geslaagd' : 'mislukt'} (ip ${ip}${reden ? ', ' + reden : ''})`;
    console.warn(`${nuIso()} ${tekst}`);
    log('warn', tekst);
  }

  const teVeel = (ip) => sTel.get(ip, nu() - limiet.vensterMs).n >= limiet.pogingen;

  async function handle(req, res, url) {
    const ip = bronIpVanNginx(req);
    if (!ip || !inTailnet(ip)) {
      console.warn(`${nuIso()} /breakglass van buiten de tailnet geweigerd als onbekend (ip ${ip || bezoekerIp(req)})`);
      return stuurTekst(res, 404, 'Niet gevonden.');
    }
    if (!beschikbaar) return stuurTekst(res, 503, 'Break-glass is niet ingesteld (BREAKGLASS_USER, BREAKGLASS_PASSWORD_HASH en BREAKGLASS_TOTP_SECRET in de env).');

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (teVeel(ip)) return stuurHtml(res, 429, breakglassPagina({ fout: 'Te veel pogingen vanaf dit adres. Probeer het over een kwartier opnieuw.', geblokkeerd: true }));
      return stuurHtml(res, 200, breakglassPagina({}));
    }
    if (req.method !== 'POST') return stuurTekst(res, 405, 'Alleen GET en POST.');
    if (!zelfdeHerkomst(req)) return stuurTekst(res, 403, 'Dit formulier moet van het portaal zelf komen.');
    if (teVeel(ip)) {
      noteer({ ip, naam: '', geslaagd: false, reden: 'limiet' });
      return stuurHtml(res, 429, breakglassPagina({ fout: 'Te veel pogingen vanaf dit adres. Probeer het over een kwartier opnieuw.', geblokkeerd: true }));
    }

    const body = await leesBody(req);
    const naam = String(body.get('gebruiker') || '').trim().slice(0, 100);
    const wachtwoord = String(body.get('wachtwoord') || '');
    const code = String(body.get('code') || '');

    // Alle drie altijd controleren, zodat de tijd niets verraadt over wat er fout was.
    const naamOk = zelfdeTekst(naam, gebruiker);
    const wwOk = controleerWachtwoord(wachtwoord, wachtwoordHash);
    const stap = controleerTotp(totpGeheim, code, { nu: nu() });
    const stapNieuw = stap !== null && !sStapGebruikt.get(stap);

    if (!naamOk || !wwOk || stap === null || !stapNieuw) {
      noteer({ ip, naam, geslaagd: false, reden: stap !== null && !stapNieuw ? 'code al gebruikt' : 'gegevens kloppen niet' });
      return stuurHtml(res, 401, breakglassPagina({ fout: 'De combinatie van gebruikersnaam, wachtwoord en code klopt niet.', gebruiker: naam }));
    }

    noteer({ ip, naam, geslaagd: true, stap });
    const { token } = sessies.maak({ email: gebruiker, naam: `Break-glass (${gebruiker})`, authMethod: 'breakglass' });
    try {
      await meld({ ip, gebruiker, tijd: new Date(nu()).toISOString() });
    } catch (fout) {
      log('error', `break-glass: melding versturen mislukt: ${fout.message}`);
    }
    return doorsturen(res, 303, '/', { 'set-cookie': sessies.cookie(token), 'cache-control': 'no-store' });
  }

  return { beschikbaar, handle, inTailnet, pogingen: (ip) => sTel.get(ip, nu() - limiet.vensterMs).n };
}
