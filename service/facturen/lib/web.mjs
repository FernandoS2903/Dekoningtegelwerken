// Gedeelde http-hulp voor het portaal en de onderdelen erin (facturen, mail):
// vaste beveiligingskoppen, antwoorden, formulieren lezen en de controle op
// dezelfde herkomst.

import crypto from 'node:crypto';

export const MAX_BODY_BYTES = 64 * 1024;

// Strikt: geen inline scripts of styles. form-action staat ook
// login.microsoftonline.com toe, omdat Uitloggen (een POST) eindigt met een
// doorverwijzing naar de logout van Microsoft; browsers houden form-action
// ook bij doorverwijzingen aan.
export const CSP = [
  "default-src 'none'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "script-src 'self'",
  "object-src 'self'",
  "form-action 'self' https://login.microsoftonline.com",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function kop(res, status, type, extra = {}) {
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

export const stuurHtml = (res, status, html, extra = {}) => { kop(res, status, 'text/html; charset=utf-8', extra); res.end(html); };
export const stuurTekst = (res, status, tekst, extra = {}) => { kop(res, status, 'text/plain; charset=utf-8', extra); res.end(tekst + '\n'); };

export function doorsturen(res, status, waarheen, extra = {}) {
  kop(res, status, 'text/plain; charset=utf-8', { location: waarheen, ...extra });
  res.end('');
}

export function leesRuw(req, max = MAX_BODY_BYTES) {
  return new Promise((klaar, mislukt) => {
    const delen = [];
    let grootte = 0;
    req.on('data', (deel) => {
      grootte += deel.length;
      if (grootte > max) {
        mislukt(new Error('te groot'));
        req.destroy();
        return;
      }
      delen.push(deel);
    });
    req.on('end', () => klaar(Buffer.concat(delen).toString('utf8')));
    req.on('error', mislukt);
  });
}

export async function leesBody(req) {
  return new URLSearchParams(await leesRuw(req));
}

// Een POST moet van dezelfde herkomst komen. Basic Auth en cookies gaan bij
// elk verzoek mee, ook bij een formulier op een andere site.
export function zelfdeHerkomst(req) {
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

export function zelfdeTekst(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

// Het IP van de bezoeker. Achter nginx alleen X-Forwarded-For geloven als
// het verzoek zelf van 127.0.0.1 komt.
export function bezoekerIp(req) {
  const direct = req.socket?.remoteAddress || '';
  const lokaal = direct === '127.0.0.1' || direct === '::1' || direct === '::ffff:127.0.0.1';
  const doorgegeven = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim();
  return lokaal && doorgegeven ? doorgegeven : direct;
}

// Vaste meldingen na een actie: een code in de URL in plaats van vrije
// tekst, zodat er niets uit een verzoek in de pagina kan belanden.
export function meldingenUit(zoekparams, tabel) {
  const code = zoekparams.get('m');
  if (!code || !tabel[code]) return [];
  const [soort, tekst] = tabel[code];
  return [{ soort, tekst }];
}
