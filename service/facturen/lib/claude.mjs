// Factuurgegevens uit een PDF of uit de mailtekst halen met de Claude API.
//
// Direct via fetch naar https://api.anthropic.com/v1/messages, zonder SDK
// (deze repo is dependency-vrij). De PDF gaat mee als `document`-blok met
// base64, vóór het tekstblok; daar is geen beta-header voor nodig.
//
// Drie dingen die dit model anders doet dan oudere:
//  - een prefill ("begin je antwoord met {") geeft een 400, dus we vragen om
//    JSON en parsen robuust;
//  - `thinking: {type:"disabled"}` geeft een 400, dus dat veld sturen we niet;
//  - een weigering komt terug als HTTP 200 met stop_reason "refusal", dus die
//    controleren we vóór we het antwoord lezen.
//
// `parseerAntwoord()` is puur en wordt los getest.

import { naarBedrag, naarDatum, naarIban } from './hulp.mjs';
import { HttpFout, jsonOfFout, vraag } from './http.mjs';

export const API_URL = 'https://api.anthropic.com/v1/messages';
export const API_VERSIE = '2023-06-01';
export const STANDAARD_MODEL = 'claude-sonnet-5-5';
export const MAX_PER_RONDE = 25;

// Grens op de PDF die we versturen. Base64 maakt een bestand ongeveer een
// derde groter en het verzoek mag 32 MB zijn; 20 MB ruwe PDF is de veilige kant.
export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_TEKST_TEKENS = 60000;

const SYSTEEM = [
  'Je bent de boekhoudassistent van De Koning Tegelwerken, een tegelzettersbedrijf.',
  'Je leest inkomende facturen en haalt daar de gegevens uit.',
  'Antwoord uitsluitend met JSON, zonder uitleg en zonder code-blok eromheen.',
  'Wat je niet zeker uit het document kunt lezen, geef je als null. Verzin nooit een',
  'bedrag, een datum, een nummer of een naam.',
].join(' ');

const OPDRACHT = `Geef de gegevens van deze factuur als JSON met precies deze sleutels:

{
  "is_invoice": true of false,
  "supplier": naam van de leverancier die de factuur stuurt,
  "invoice_number": factuurnummer,
  "invoice_date": factuurdatum als YYYY-MM-DD,
  "due_date": vervaldatum als YYYY-MM-DD (staat er alleen een betaaltermijn, reken die dan uit vanaf de factuurdatum),
  "amount": totaalbedrag inclusief btw als getal; een creditnota is negatief,
  "currency": valutacode zoals EUR,
  "iban": IBAN waar het bedrag naartoe moet,
  "payment_reference": betalingskenmerk of referentie,
  "description": korte omschrijving van waar het over gaat, maximaal 80 tekens
}

is_invoice is false als dit geen factuur is, bijvoorbeeld een offerte, een
orderbevestiging, een aanmaning zonder bedrag, een nieuwsbrief of een reclamemail.`;

// -- parsen --------------------------------------------------------------
// Haalt het eerste complete JSON-object uit een tekst. Een model kan er
// ondanks de instructie een inleidende regel of een code-blok om zetten.
export function eersteJsonObject(tekst) {
  const s = String(tekst ?? '');
  const begin = s.indexOf('{');
  if (begin === -1) return null;

  let diepte = 0;
  let inTekst = false;
  let ontsnapt = false;
  for (let i = begin; i < s.length; i++) {
    const c = s[i];
    if (inTekst) {
      if (ontsnapt) ontsnapt = false;
      else if (c === '\\') ontsnapt = true;
      else if (c === '"') inTekst = false;
      continue;
    }
    if (c === '"') inTekst = true;
    else if (c === '{') diepte++;
    else if (c === '}') {
      diepte--;
      if (diepte === 0) return s.slice(begin, i + 1);
    }
  }
  return null;
}

function tekstOfNull(waarde, maxLengte = 200) {
  if (waarde === null || waarde === undefined) return null;
  const s = String(waarde).trim();
  if (!s || s.toLowerCase() === 'null' || s.toLowerCase() === 'onbekend') return null;
  return s.slice(0, maxLengte);
}

function naarValuta(waarde) {
  const s = tekstOfNull(waarde, 20);
  if (!s) return null;
  const op = s.toUpperCase();
  if (op === '€' || op.startsWith('EUR')) return 'EUR';
  if (op === '$' || op.startsWith('USD')) return 'USD';
  if (op === '£' || op.startsWith('GBP')) return 'GBP';
  return /^[A-Z]{3}$/.test(op) ? op : null;
}

function waarheid(waarde) {
  if (typeof waarde === 'boolean') return waarde;
  const s = String(waarde ?? '').trim().toLowerCase();
  return s === 'true' || s === 'ja' || s === '1' || s === 'yes';
}

// Zet een modelantwoord om in onze velden. Gooit als er geen JSON in zit.
export function parseerAntwoord(tekst) {
  const stuk = eersteJsonObject(tekst);
  if (!stuk) throw new Error('geen JSON in het antwoord van het model');

  let ruw;
  try {
    ruw = JSON.parse(stuk);
  } catch (fout) {
    throw new Error('antwoord van het model is geen geldige JSON: ' + fout.message);
  }
  if (!ruw || typeof ruw !== 'object' || Array.isArray(ruw)) {
    throw new Error('antwoord van het model is geen JSON-object');
  }

  const factuurdatum = naarDatum(ruw.invoice_date);
  return {
    isFactuur: waarheid(ruw.is_invoice),
    velden: {
      leverancier: tekstOfNull(ruw.supplier, 200),
      factuurnummer: tekstOfNull(ruw.invoice_number, 80),
      factuurdatum,
      vervaldatum: naarDatum(ruw.due_date),
      bedrag: naarBedrag(ruw.amount),
      valuta: naarValuta(ruw.currency),
      iban: naarIban(ruw.iban),
      betalingskenmerk: tekstOfNull(ruw.payment_reference, 80),
      omschrijving: tekstOfNull(ruw.description, 80),
    },
  };
}

// Plakt de tekstblokken van een Messages-antwoord aan elkaar.
export function tekstUitAntwoord(data) {
  if (!data || !Array.isArray(data.content)) return '';
  return data.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n').trim();
}

// -- aanroep -------------------------------------------------------------
export function maakClaude({
  apiKey,
  model = STANDAARD_MODEL,
  fetch: fetchFn = globalThis.fetch,
  log = () => {},
} = {}) {
  const beschikbaar = Boolean(apiKey);

  function lichaam({ pdf, tekst, afzender, onderwerp, metEffort }) {
    const context = [
      'Context uit de e-mail waarin dit binnenkwam:',
      `- afzender: ${afzender || 'onbekend'}`,
      `- onderwerp: ${onderwerp || 'onbekend'}`,
      '',
      OPDRACHT,
    ];

    const inhoud = [];
    if (pdf) {
      inhoud.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') },
      });
    } else {
      context.push('', 'Er zat geen PDF bij. Dit is de tekst van de e-mail:', '', String(tekst || '').slice(0, MAX_TEKST_TEKENS));
    }
    inhoud.push({ type: 'text', text: context.join('\n') });

    const body = {
      model,
      max_tokens: 1024,
      system: SYSTEEM,
      messages: [{ role: 'user', content: inhoud }],
    };
    // Dit is eenvoudig opzoekwerk; lage effort scheelt tijd en geld. Oudere
    // modellen kennen output_config niet, vandaar de terugval hieronder.
    if (metEffort) body.output_config = { effort: 'low' };
    return body;
  }

  async function verstuur(body) {
    const antwoord = await vraag(fetchFn, API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSIE,
      },
      body: JSON.stringify(body),
    }, { timeoutMs: 120000 });
    return antwoord;
  }

  return {
    beschikbaar,
    model,

    // Geeft { isFactuur, velden } terug, of gooit met een melding die in het
    // dashboard te lezen is.
    async leesFactuur({ pdf = null, tekst = '', afzender = '', onderwerp = '' }) {
      if (!beschikbaar) throw new Error('geen ANTHROPIC_API_KEY ingesteld');
      if (!pdf && !String(tekst || '').trim()) throw new Error('geen PDF en geen mailtekst om te lezen');
      if (pdf && pdf.length > MAX_PDF_BYTES) {
        throw new Error(`PDF is te groot om te laten lezen (${Math.round(pdf.length / 1048576)} MB)`);
      }

      let antwoord = await verstuur(lichaam({ pdf, tekst, afzender, onderwerp, metEffort: true }));

      // Kent dit model output_config niet, dan één keer opnieuw zonder.
      if (antwoord && antwoord.status === 400) {
        const melding = await antwoord.clone().text().catch(() => '');
        if (/output_config|effort/i.test(melding)) {
          log('info', `Model ${model} kent output_config niet; opnieuw zonder effort.`);
          antwoord = await verstuur(lichaam({ pdf, tekst, afzender, onderwerp, metEffort: false }));
        }
      }

      const data = await jsonOfFout(antwoord, API_URL).catch((fout) => {
        if (fout instanceof HttpFout && fout.status === 401) throw new Error('Claude-sleutel wordt geweigerd (401)');
        if (fout instanceof HttpFout && fout.status === 429) throw new Error('Claude-limiet bereikt (429), later opnieuw proberen');
        throw fout;
      });

      // Een weigering is een geslaagd verzoek met een lege inhoud.
      if (data.stop_reason === 'refusal') {
        const uitleg = data.stop_details?.explanation || data.stop_details?.category || 'geen reden gegeven';
        throw new Error('het model weigerde dit document te lezen: ' + uitleg);
      }

      const tekstAntwoord = tekstUitAntwoord(data);
      if (!tekstAntwoord) throw new Error('leeg antwoord van het model');
      return parseerAntwoord(tekstAntwoord);
    },
  };
}
