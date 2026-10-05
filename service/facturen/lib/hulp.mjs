// Pure hulpfuncties voor het factuurdashboard: opmaak, normaliseren van wat
// een model of een bank aanlevert, en de gelijkenismaat voor namen.
//
// Alles hier is zonder i/o en zonder toestand, zodat het los te testen is.
// De regels voor bedragen en datums staan hier bewust op één plek: ze worden
// zowel op Claude-antwoorden als op handmatig ingevulde formulieren gebruikt.

// -- tijd ----------------------------------------------------------------
export const nuIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

// Datum van vandaag in Amsterdamse tijd, als YYYY-MM-DD. Voor "verlopen" en
// "betaald deze maand" wil je de dag zoals De Koning hem ziet, niet in UTC.
export function vandaag(nu = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(nu);
}

// -- opmaak --------------------------------------------------------------
const EURO = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' });

export function euro(bedrag, valuta = 'EUR') {
  if (bedrag === null || bedrag === undefined || !Number.isFinite(Number(bedrag))) return '—';
  const n = Number(bedrag);
  if (valuta && valuta !== 'EUR') {
    try {
      return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: valuta }).format(n);
    } catch { /* onbekende valutacode: val terug op euro-opmaak met code erachter */ }
    return EURO.format(n).replace('€', '') + ' ' + valuta;
  }
  // Intl zet in nl-NL een non-breaking space na het euroteken; die houden we.
  return EURO.format(n);
}

const DATUM_NL = new Intl.DateTimeFormat('nl-NL', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Amsterdam',
});

// "2026-10-04" -> "4 okt 2026". Een ongeldige of lege datum geeft een streepje.
export function datumNl(waarde) {
  if (!waarde) return '—';
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(waarde) ? waarde + 'T12:00:00Z' : waarde);
  if (Number.isNaN(d.getTime())) return '—';
  return DATUM_NL.format(d).replace(/\.$/, '');
}

export function datumTijdNl(waarde) {
  if (!waarde) return '—';
  const d = new Date(waarde);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('nl-NL', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam',
  }).format(d).replace(/\.(?=\s)/, '');
}

export function escapeHtml(waarde) {
  if (waarde === null || waarde === undefined) return '';
  return String(waarde)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// -- bedragen ------------------------------------------------------------
// Accepteert zowel een getal (zoals Claude het hoort te geven) als de
// schrijfwijzen die in facturen voorkomen: "1.234,56", "1,234.56", "€ 90,-",
// "1234", "-45,00", "45,00-" en "(45,00)".
export function naarBedrag(waarde) {
  if (waarde === null || waarde === undefined || waarde === '') return null;
  if (typeof waarde === 'number') return Number.isFinite(waarde) ? waarde : null;

  let s = String(waarde).trim();
  if (!s) return null;

  // "90,-" betekent hele euro's en is dus géén minteken: eerst wegwerken,
  // anders leest de controle hieronder het als een negatief bedrag.
  s = s.replace(/([.,])-\s*$/, '$100');

  // Negatief kan vooraan, achteraan of met haakjes genoteerd staan.
  let negatief = false;
  if (/^\(.*\)$/.test(s)) { negatief = true; s = s.slice(1, -1); }
  if (/-\s*$/.test(s) && /\d/.test(s)) { negatief = true; s = s.replace(/-\s*$/, ''); }
  if (/^\s*-/.test(s)) { negatief = true; }

  // Valutatekens en codes eruit.
  s = s.replace(/[€$£]|\b(eur|euro|usd|gbp)\b/gi, '');
  s = s.replace(/[^\d.,]/g, '');
  if (!/\d/.test(s)) return null;

  const laatstePunt = s.lastIndexOf('.');
  const laatsteKomma = s.lastIndexOf(',');

  if (laatstePunt !== -1 && laatsteKomma !== -1) {
    // Beide aanwezig: de laatste van de twee is de decimale scheiding.
    const decimaal = laatstePunt > laatsteKomma ? '.' : ',';
    const duizend = decimaal === '.' ? ',' : '.';
    s = s.split(duizend).join('');
    s = s.replace(decimaal, '.');
  } else if (laatsteKomma !== -1) {
    // Alleen komma's: in Nederland de decimale scheiding. Meerdere komma's of
    // precies drie cijfers erachter bij een lang getal is duizendscheiding.
    const na = s.length - laatsteKomma - 1;
    const aantal = (s.match(/,/g) || []).length;
    s = aantal > 1 || (na === 3 && s.replace(/,/g, '').length > 3) ? s.split(',').join('') : s.replace(',', '.');
  } else if (laatstePunt !== -1) {
    const na = s.length - laatstePunt - 1;
    const aantal = (s.match(/\./g) || []).length;
    s = aantal > 1 || (na === 3 && s.replace(/\./g, '').length > 3) ? s.split('.').join('') : s;
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negatief ? -Math.abs(n) : n;
}

// -- IBAN ----------------------------------------------------------------
export function naarIban(waarde) {
  if (!waarde) return null;
  const s = String(waarde).replace(/\s+/g, '').toUpperCase();
  return /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(s) ? s : null;
}

// -- datums --------------------------------------------------------------
const MAANDEN = {
  jan: 1, januari: 1, feb: 2, februari: 2, mrt: 3, maart: 3, apr: 4, april: 4,
  mei: 5, jun: 6, juni: 6, jul: 7, juli: 7, aug: 8, augustus: 8,
  sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, nov: 11, november: 11,
  dec: 12, december: 12,
};

const tweeCijfers = (n) => String(n).padStart(2, '0');

function samen(jaar, maand, dag) {
  if (!(maand >= 1 && maand <= 12) || !(dag >= 1 && dag <= 31)) return null;
  if (jaar < 100) jaar += jaar < 70 ? 2000 : 1900;
  if (jaar < 1900 || jaar > 2200) return null;
  return `${jaar}-${tweeCijfers(maand)}-${tweeCijfers(dag)}`;
}

// Normaliseert naar YYYY-MM-DD, of null als er geen datum in zit.
export function naarDatum(waarde) {
  if (!waarde) return null;
  const s = String(waarde).trim();
  if (!s) return null;

  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return samen(+m[1], +m[2], +m[3]);

  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/);
  if (m) return samen(+m[3], +m[2], +m[1]);

  m = s.match(/^(\d{1,2})\s+([a-zéû.]+)\s+(\d{2,4})$/i);
  if (m) {
    const maand = MAANDEN[m[2].toLowerCase().replace(/\.$/, '')];
    if (maand) return samen(+m[3], maand, +m[1]);
  }

  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) {
    return `${d.getUTCFullYear()}-${tweeCijfers(d.getUTCMonth() + 1)}-${tweeCijfers(d.getUTCDate())}`;
  }
  return null;
}

// Verschil in dagen tussen twee YYYY-MM-DD-datums (a - b).
export function dagenVerschil(a, b) {
  const da = Date.parse(a + 'T00:00:00Z');
  const db = Date.parse(b + 'T00:00:00Z');
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.round((da - db) / 86400000);
}

export function datumPlusDagen(datum, dagen) {
  const d = new Date(datum + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + dagen);
  return `${d.getUTCFullYear()}-${tweeCijfers(d.getUTCMonth() + 1)}-${tweeCijfers(d.getUTCDate())}`;
}

// -- namen en kenmerken --------------------------------------------------
const RECHTSVORMEN = /\b(b\.?v\.?|v\.?o\.?f\.?|n\.?v\.?|holding|beheer|gmbh|ltd|b2b|cv|c\.v\.)\b/g;

// Naam klaarmaken om te vergelijken: kleine letters, rechtsvorm eraf,
// alles wat geen letter of cijfer is eruit.
export function normaliseerNaam(waarde) {
  if (!waarde) return '';
  return String(waarde).toLowerCase()
    .replace(/[^a-z0-9\s.]/g, ' ')
    .replace(RECHTSVORMEN, ' ')
    .replace(/[^a-z0-9]/g, '');
}

// Alleen letters en cijfers, kleine letters. Zo vinden we factuurnummer
// "2026-0123" ook terug in een omschrijving die "20260123" schrijft.
export function alleenAlfanumeriek(waarde) {
  if (!waarde) return '';
  return String(waarde).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let vorige = Array.from({ length: b.length + 1 }, (_, i) => i);
  let huidige = new Array(b.length + 1);
  for (let i = 0; i < a.length; i++) {
    huidige[0] = i + 1;
    for (let j = 0; j < b.length; j++) {
      const kosten = a[i] === b[j] ? 0 : 1;
      huidige[j + 1] = Math.min(huidige[j] + 1, vorige[j + 1] + 1, vorige[j] + kosten);
    }
    [vorige, huidige] = [huidige, vorige];
  }
  return vorige[b.length];
}

// Genormaliseerde Levenshtein: 1 is gelijk, 0 is niets gemeen.
// Wijkt bewust af van difflib.SequenceMatcher uit het Python-prototype
// (besluit Bob, 5 okt 2026); grensgevallen rond 0,75 kunnen anders uitvallen.
export function gelijkenis(a, b) {
  const x = normaliseerNaam(a);
  const y = normaliseerNaam(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const langste = Math.max(x.length, y.length);
  return (langste - levenshtein(x, y)) / langste;
}

// -- bestanden -----------------------------------------------------------
// Bestandsnaam uit een mailbijlage is invoer van buiten: alles wat op een pad
// lijkt gaat eruit, de extensie wordt afgedwongen op .pdf.
export function veiligeBestandsnaam(naam, terugval = 'bijlage.pdf') {
  const kaal = String(naam || '').split(/[\\/]/).pop() || '';
  const schoon = kaal.normalize('NFKD')
    .replace(/[^\w.\- ]/g, '_').replace(/\s+/g, '_')
    .replace(/_{2,}/g, '_').replace(/^[._]+/, '').slice(-120);
  if (!schoon || schoon === '.pdf') return terugval;
  return /\.pdf$/i.test(schoon) ? schoon : schoon + '.pdf';
}
