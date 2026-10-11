// Doorsturen van een website-aanvraag naar Offerteknop: POST naar het
// endpoint /api/aanvragen/website (contract van 11 oktober 2026), met een
// Bearer-sleutel die de tenant bepaalt. Dit is een ándere sleutel dan de
// HMAC-sleutels van lib/offerteknop.mjs (AANVRAAG_OFFERTEKNOP_SLEUTEL); hij
// staat alleen in de env en komt nooit in een logregel of een pagina.
//
// `stuur(body)` doet één poging en geeft terug wat de wachtrij moet weten:
//   { uitkomst: 'klaar',   offerteId, nummer, bestaand }
//   { uitkomst: 'herhaal', fout, wachtMs? }    5xx, 429 (Retry-After), netwerk
//   { uitkomst: 'stop',    fout }              400, 413, 415: niet opnieuw
//   { uitkomst: 'auth',    fout }              401, 403: sleutel of tenant
// Hij gooit nooit.

export const STANDAARD_URL = 'http://127.0.0.1:3100/api/aanvragen/website';
const SLEUTEL_RE = /^[0-9a-f]{64}$/i;

export function maakAanvraagKoppeling({ url = STANDAARD_URL, sleutel = '', fetch: fetchFn = globalThis.fetch, timeoutMs = 60000 } = {}) {
  const doel = String(url || STANDAARD_URL).trim();
  const geldig = SLEUTEL_RE.test(String(sleutel || '').trim());
  const beschikbaar = Boolean(doel && geldig);
  const ontbreekt = [
    !doel ? 'AANVRAAG_OFFERTEKNOP_URL' : null,
    !String(sleutel || '').trim() ? 'AANVRAAG_OFFERTEKNOP_SLEUTEL' : (!geldig ? 'AANVRAAG_OFFERTEKNOP_SLEUTEL (64 hex-tekens)' : null),
  ].filter(Boolean);

  async function stuur(body) {
    if (!beschikbaar) return { uitkomst: 'herhaal', fout: 'Offerteknop-aanvragen niet ingesteld (' + ontbreekt.join(', ') + ')' };
    let antwoord;
    try {
      antwoord = await fetchFn(doel, {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + String(sleutel).trim(),
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'dekoning-portaal/1.0 (aanvragen)',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (fout) {
      return { uitkomst: 'herhaal', fout: 'geen verbinding met Offerteknop: ' + fout.message };
    }
    const tekst = await antwoord.text().catch(() => '');
    let data = null;
    try { data = tekst ? JSON.parse(tekst) : null; } catch { data = null; }
    const melding = (data && data.error) ? String(data.error).slice(0, 200) + (data.veld ? ` (veld ${data.veld})` : '') : `Offerteknop gaf ${antwoord.status}`;

    if (antwoord.status === 200 || antwoord.status === 201) {
      return {
        uitkomst: 'klaar',
        offerteId: data && data.offerte_id != null ? Number(data.offerte_id) : null,
        nummer: data && data.nummer_str ? String(data.nummer_str) : null,
        bestaand: Boolean(data && data.bestaand),
        bijlagen: data && Array.isArray(data.bijlagen) ? data.bijlagen : [],
      };
    }
    if (antwoord.status === 401 || antwoord.status === 403) {
      return { uitkomst: 'auth', fout: `${antwoord.status}: ${melding}; controleer AANVRAAG_OFFERTEKNOP_SLEUTEL of de tenant in Offerteknop` };
    }
    if (antwoord.status === 400 || antwoord.status === 413 || antwoord.status === 415) {
      return { uitkomst: 'stop', fout: `${antwoord.status}: ${melding}` };
    }
    if (antwoord.status === 429) {
      const na = Number(antwoord.headers?.get?.('retry-after'));
      return { uitkomst: 'herhaal', fout: '429: te veel verzoeken', wachtMs: Number.isFinite(na) && na > 0 ? Math.min(na, 3600) * 1000 : null };
    }
    return { uitkomst: 'herhaal', fout: `${antwoord.status}: ${melding}` };
  }

  return { beschikbaar, ontbreekt, url: doel, stuur };
}
