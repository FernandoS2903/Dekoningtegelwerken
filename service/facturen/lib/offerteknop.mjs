// Koppeling met Offerteknop (de offertetool, tenant De Koning Tegelwerken).
//
// Beide diensten draaien op deze server; het verkeer loopt alleen over
// 127.0.0.1 en is aan beide kanten ondertekend met HMAC-SHA256 over
// methode, pad, tijd, nonce en de sha256 van de body (zelfde schema als
// lib/tenantapi/hmac.js in Offerteknop):
//
//   X-Tenant, X-Tijd (unix-seconden), X-Nonce (16-64 hex), X-Handtekening (hex)
//
// Twee sleutels, elk met één richting:
//   OFFERTEKNOP_API_SLEUTEL     ondertekent wat wij naar Offerteknop sturen
//                               (lijst, concept); Offerteknop noemt hem "in"
//   OFFERTEKNOP_WEBHOOK_SLEUTEL controleert wat Offerteknop naar ons stuurt
//                               (webhook, mailrelay); Offerteknop noemt hem "uit"
//
// Wat hier binnenkomt (controleer) is pas vertrouwd na de handtekening, de
// tijd (vijf minuten speling) en de replaycache; zie intern.mjs.

import crypto from 'node:crypto';
import { HttpFout, vraag } from './http.mjs';

export const MAX_AFWIJKING_S = 300;
export const KOPPEN = Object.freeze({ tenant: 'x-tenant', tijd: 'x-tijd', nonce: 'x-nonce', handtekening: 'x-handtekening' });
const NONCE_RE = /^[0-9a-f]{16,64}$/i;

export const bodyHash = (body) => crypto.createHash('sha256').update(body == null ? Buffer.alloc(0) : body).digest('hex');

export function onderteken({ sleutel, methode, pad, tijd, nonce, body }) {
  const tekst = [String(methode).toUpperCase(), String(pad), String(tijd), String(nonce), bodyHash(body)].join('\n');
  return crypto.createHmac('sha256', String(sleutel)).update(tekst).digest('hex');
}

export function maakKoppen({ sleutel, tenant, methode, pad, body, nu = Date.now() }) {
  const tijd = Math.floor(nu / 1000);
  const nonce = crypto.randomBytes(16).toString('hex');
  return {
    [KOPPEN.tenant]: tenant,
    [KOPPEN.tijd]: String(tijd),
    [KOPPEN.nonce]: nonce,
    [KOPPEN.handtekening]: onderteken({ sleutel, methode, pad, tijd, nonce, body }),
  };
}

// Geeft {handtekening} of {fout}. Zelfde meldingen voor een verkeerde
// sleutel en een gewijzigde body.
export function controleerHandtekening({ sleutel, methode, pad, tijd, nonce, body, handtekening, nu = Date.now() }) {
  const t = Number(tijd);
  if (!Number.isInteger(t) || !/^\d{9,11}$/.test(String(tijd))) return { fout: 'Ongeldige of ontbrekende tijd.' };
  if (Math.abs(Math.floor(nu / 1000) - t) > MAX_AFWIJKING_S) return { fout: 'Het verzoek is te oud of de klok loopt te veel uit.' };
  if (!NONCE_RE.test(String(nonce || ''))) return { fout: 'Ongeldige of ontbrekende nonce.' };
  const gegeven = String(handtekening || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(gegeven)) return { fout: 'Ongeldige of ontbrekende handtekening.' };
  const verwacht = onderteken({ sleutel, methode, pad, tijd: t, nonce, body });
  const a = Buffer.from(gegeven, 'hex');
  const b = Buffer.from(verwacht, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { fout: 'Ongeldige handtekening.' };
  return { handtekening: gegeven };
}

// Rechtstreeks van deze server, niet via nginx: de socket is lokaal én er is
// geen X-Forwarded-For (die zet nginx altijd; zie de vhost).
const LOKAAL = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export function isLokaal(req) {
  if (!LOKAAL.has(req.socket?.remoteAddress || '')) return false;
  for (const k of ['x-forwarded-for', 'x-real-ip', 'x-forwarded-host', 'forwarded']) {
    if (req.headers[k] !== undefined) return false;
  }
  return true;
}

// Een pad binnen Offerteknop: begint met één slash, geen tweede host.
export const IS_OFFERTEKNOP_PAD = /^\/(?!\/)[A-Za-z0-9_\-./?=&%+]*$/;

// Van een URL in Offerteknop (bewerk_url) naar het pad erbinnen.
export function offerteknopPad(url) {
  try {
    const u = new URL(String(url || ''), 'https://x');
    return u.pathname + u.search;
  } catch {
    return '/offertes/';
  }
}

export class OfferteknopFout extends Error {
  constructor(status, melding) { super(melding); this.name = 'OfferteknopFout'; this.status = status; }
}

export function maakOfferteknop({
  baseUrl = '',
  tenant = '',
  sleutelIn = '',
  sleutelUit = '',
  fetch: fetchFn = globalThis.fetch,
  nu = () => Date.now(),
} = {}) {
  const basis = String(baseUrl || '').replace(/\/+$/, '');
  const beschikbaar = Boolean(basis && tenant && String(sleutelIn).length >= 32 && String(sleutelUit).length >= 32);
  const ontbreekt = [
    !basis ? 'OFFERTEKNOP_URL' : null,
    !tenant ? 'OFFERTEKNOP_TENANT' : null,
    String(sleutelIn).length < 32 ? 'OFFERTEKNOP_API_SLEUTEL' : null,
    String(sleutelUit).length < 32 ? 'OFFERTEKNOP_WEBHOOK_SLEUTEL' : null,
  ].filter(Boolean);

  async function roep(methode, pad, body = null) {
    if (!beschikbaar) throw new OfferteknopFout(503, 'Offerteknop is niet ingesteld (' + ontbreekt.join(', ') + ').');
    const ruw = body === null ? null : Buffer.from(JSON.stringify(body));
    const koppen = maakKoppen({ sleutel: sleutelIn, tenant, methode, pad, body: ruw, nu: nu() });
    const antwoord = await vraag(fetchFn, basis + pad, {
      method: methode,
      headers: { ...koppen, accept: 'application/json', 'user-agent': 'dekoning-portaal/1.0', ...(ruw ? { 'content-type': 'application/json' } : {}) },
      ...(ruw ? { body: ruw } : {}),
    }, { timeoutMs: 30000, pogingen: methode === 'GET' ? 3 : 1 });
    if (!antwoord) throw new OfferteknopFout(0, 'geen antwoord van Offerteknop');
    const tekst = await antwoord.text().catch(() => '');
    let data = null;
    try { data = tekst ? JSON.parse(tekst) : null; } catch { data = null; }
    if (!antwoord.ok) {
      const melding = data?.error || `Offerteknop gaf ${antwoord.status}`;
      throw new OfferteknopFout(antwoord.status, melding);
    }
    return data;
  }

  return {
    beschikbaar,
    ontbreekt,
    tenant,
    basis,

    // Lijst met de nieuwste versie per offerte; `sinds` ISO.
    lijst({ sinds = null, status = [], limiet = 200, archief = 'alle' } = {}) {
      const p = new URLSearchParams();
      if (sinds) p.set('sinds', sinds);
      if (status.length) p.set('status', status.join(','));
      p.set('limiet', String(limiet));
      if (archief) p.set('archief', archief);
      return roep('GET', '/api/tenant/offertes?' + p.toString());
    },
    offerte: (id) => roep('GET', `/api/tenant/offertes/${encodeURIComponent(String(id))}`),
    concept: (body) => roep('POST', '/api/tenant/offertes/concept', body),

    // Eenmalige inloglink voor Offerteknop (route /inloggen-via-koppeling
    // daar): payload met slug, e-mail, verloop (60 s) en jti, ondertekend met
    // de API-sleutel. De gebruiker van het portaal moet daar beheerder zijn.
    inlogToken({ email, nuMs = nu() }) {
      if (!beschikbaar) throw new OfferteknopFout(503, 'Offerteknop is niet ingesteld.');
      const payload = Buffer.from(JSON.stringify({
        slug: tenant, email: String(email || '').trim().toLowerCase(),
        exp: Math.floor(nuMs / 1000) + 60, jti: crypto.randomBytes(12).toString('hex'),
      })).toString('base64url');
      return payload + '.' + crypto.createHmac('sha256', sleutelIn).update(payload).digest('base64url');
    },

    // Inkomend van Offerteknop: {ok} of {fout}. `pad` is pad plus query.
    controleer({ methode, pad, koppen, body }) {
      if (!beschikbaar) return { fout: 'Offerteknop is niet ingesteld.' };
      if (String(koppen[KOPPEN.tenant] || '').toLowerCase() !== tenant.toLowerCase()) return { fout: 'Onbekende tenant.' };
      return controleerHandtekening({
        sleutel: sleutelUit, methode, pad, body,
        tijd: koppen[KOPPEN.tijd], nonce: koppen[KOPPEN.nonce], handtekening: koppen[KOPPEN.handtekening], nu: nu(),
      });
    },
  };
}

export { HttpFout };
