// Graph change notifications voor de Inbox: /graph/notify.
//
// Een notificatie is alleen een seintje: we draaien dan de delta-ronde en
// vertrouwen de inhoud van de payload niet. Twee controles:
//  - validationToken: Graph stuurt die bij het aanmaken van een subscription
//    en verwacht hem binnen 10 seconden letterlijk terug (text/plain). We
//    antwoorden alleen terwijl we zelf een subscription aan het aanmaken zijn.
//  - clientState: elk item in de notificatie moet ons geheim
//    (GRAPH_WEBHOOK_SECRET) dragen, anders 401.
//
// Zolang cms. niet publiek is (geen PORTAL_BASE_URL, geen SSO of geen geheim)
// maken we geen subscription aan; dan pollt de sorteerder alleen.
//
// De subscription loopt 3 dagen en wordt verlengd zodra er minder dan een
// dag over is. Dat gebeurt bij elke timer-ronde (elke SORT_INTERVAL_MIN).

import crypto from 'node:crypto';
import { HttpFout } from './http.mjs';
import { SUBSCRIPTION_MINUTEN } from './graph.mjs';

export const VERLENG_ONDER_MS = 24 * 60 * 60 * 1000;
export const VALIDATIE_VENSTER_MS = 60 * 1000;
export const MAX_TOKEN = 1024;

const afdruk = (s) => crypto.createHash('sha256').update(String(s)).digest();
export function zelfdeGeheim(a, b) {
  if (!a || !b) return false;
  return crypto.timingSafeEqual(afdruk(a), afdruk(b));
}

export function maakWebhook({
  mail,
  sorteerOpslag,
  sorteerder,
  geheim = '',
  notificatieUrl = '',
  actief = false,
  log = () => {},
  nu = () => Date.now(),
}) {
  const kan = Boolean(actief && geheim && notificatieUrl && mail && mail.beschikbaar && mail.webhook);
  let validatieTot = 0;
  let laatsteNotificatie = null;

  const staat = (k) => sorteerOpslag.staat(k);
  const zet = (k, v) => sorteerOpslag.zetStaat(k, v);

  function nieuwVerloop() {
    return new Date(nu() + SUBSCRIPTION_MINUTEN * 60 * 1000).toISOString();
  }

  async function maak() {
    validatieTot = nu() + VALIDATIE_VENSTER_MS;
    try {
      const uit = await mail.webhook.maak({ notificatieUrl, clientState: geheim, verlooptOp: nieuwVerloop() });
      zet('sub_id', uit.id);
      zet('sub_verloopt', uit.verlooptOp);
      zet('sub_fout', '');
      log('info', 'Webhook: subscription aangemaakt, geldig tot ' + uit.verlooptOp + '.');
      return uit;
    } finally {
      validatieTot = 0;
    }
  }

  // Aanmaken als er geen is, verlengen als hij bijna verloopt. Een mislukte
  // poging is niet erg: de polling vangt het op en de volgende ronde probeert
  // het opnieuw.
  async function onderhoud() {
    if (!kan) return { actief: false };
    try {
      const id = staat('sub_id');
      const verloopt = Date.parse(staat('sub_verloopt') || '') || 0;
      if (!id || verloopt <= nu()) return { gemaakt: await maak() };
      if (verloopt - nu() > VERLENG_ONDER_MS) return { ok: true };
      try {
        const uit = await mail.webhook.verleng(id, nieuwVerloop());
        zet('sub_verloopt', uit.verlooptOp);
        zet('sub_fout', '');
        return { verlengd: uit };
      } catch (fout) {
        // Weg aan de kant van Microsoft: opnieuw aanmaken.
        if (fout instanceof HttpFout && fout.status === 404) return { gemaakt: await maak() };
        throw fout;
      }
    } catch (fout) {
      zet('sub_fout', fout.message.slice(0, 300));
      log('warn', 'Webhook: subscription aanmaken of verlengen mislukt: ' + fout.message);
      return { fout: fout.message };
    }
  }

  // Verwerkt één verzoek op /graph/notify. Geeft {status, tekst?} terug;
  // de server schrijft het antwoord.
  function verwerk({ methode, zoekparams, body }) {
    if (!kan) return { status: 404, tekst: 'Niet gevonden.' };

    const token = zoekparams.get('validationToken');
    if (token !== null) {
      if (methode !== 'POST' && methode !== 'GET') return { status: 405, tekst: 'Niet toegestaan.' };
      if (nu() > validatieTot) return { status: 400, tekst: 'Geen validatie verwacht.' };
      if (!token || token.length > MAX_TOKEN) return { status: 400, tekst: 'Ongeldig.' };
      return { status: 200, tekst: token, letterlijk: true };
    }

    if (methode !== 'POST') return { status: 405, tekst: 'Niet toegestaan.' };

    let data;
    try {
      data = JSON.parse(body || '');
    } catch {
      return { status: 400, tekst: 'Geen JSON.' };
    }
    const items = Array.isArray(data?.value) ? data.value : [];
    if (!items.length) return { status: 400, tekst: 'Leeg.' };
    if (!items.every((i) => zelfdeGeheim(i?.clientState, geheim))) {
      log('warn', 'Webhook: notificatie met een verkeerde clientState geweigerd.');
      return { status: 401, tekst: 'Geweigerd.' };
    }

    laatsteNotificatie = new Date(nu()).toISOString();
    // Niet wachten: Graph wil binnen een paar seconden een 202.
    sorteerder.draai({ aanleiding: 'webhook' }).catch(() => {});
    return { status: 202, tekst: '' };
  }

  return {
    actief: kan,
    onderhoud,
    verwerk,
    status() {
      return {
        actief: kan,
        reden: kan ? '' : 'nog niet publiek: alleen polling (PORTAL_BASE_URL, SSO en GRAPH_WEBHOOK_SECRET nodig)',
        id: staat('sub_id') || null,
        verlooptOp: staat('sub_verloopt') || null,
        fout: staat('sub_fout') || null,
        laatsteNotificatie,
      };
    },
  };
}
