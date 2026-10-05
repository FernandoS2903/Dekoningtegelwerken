// Instellingen van het dashboard: standaardwaarden, validatie en het
// vastleggen van elke wijziging in het logboek (oud -> nieuw).
//
// De waarden staan als tekst in de tabel `instellingen`; deze module is de
// enige plek die weet hoe ze eruit horen te zien.

export const STANDAARD = {
  boekhouder_email: '',
  auto_doorsturen: '0',
  auto_doorsturen_sinds: '',
  testmodus: '1',
  doorstuur_tekst: '',
  outlook_categorie: '0',
  match_drempel: '0.7',
  terugkijken_dagen: '365',
  laatste_sync: '',
  laatste_sync_resultaat: '',
};

export const DREMPEL_MIN = 0.4;
export const DREMPEL_MAX = 1.0;
export const TERUGKIJKEN_MIN = 1;
export const TERUGKIJKEN_MAX = 3650;

const IS_EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/;

// Alle instellingen met standaardwaarden erin, en de getypeerde vorm erbij.
export function lees(opslag) {
  const ruw = { ...STANDAARD, ...opslag.alleInstellingen() };
  return {
    ruw,
    boekhouderEmails: splitsEmails(ruw.boekhouder_email),
    autoDoorsturen: ruw.auto_doorsturen === '1',
    autoDoorsturenSinds: ruw.auto_doorsturen_sinds || '',
    testmodus: ruw.testmodus === '1',
    doorstuurTekst: ruw.doorstuur_tekst || '',
    outlookCategorie: ruw.outlook_categorie === '1',
    matchDrempel: begrens(Number(ruw.match_drempel), DREMPEL_MIN, DREMPEL_MAX, 0.7),
    terugkijkenDagen: Math.round(begrens(Number(ruw.terugkijken_dagen), TERUGKIJKEN_MIN, TERUGKIJKEN_MAX, 365)),
    laatsteSync: ruw.laatste_sync || '',
    laatsteSyncResultaat: ruw.laatste_sync_resultaat || '',
  };
}

export function splitsEmails(waarde) {
  return String(waarde || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function begrens(n, min, max, terugval) {
  if (!Number.isFinite(n)) return terugval;
  return Math.min(max, Math.max(min, n));
}

// Slaat alleen de sleutels op die in `nieuw` staan en echt veranderen.
// Geeft {fouten, gewijzigd} terug; bij fouten wordt niets opgeslagen.
export function bewaar(opslag, nieuw, { nu = new Date().toISOString() } = {}) {
  const fouten = [];
  const schoon = {};

  if ('boekhouder_email' in nieuw) {
    const lijst = splitsEmails(nieuw.boekhouder_email);
    const slecht = lijst.filter((e) => !IS_EMAIL.test(e));
    if (slecht.length) fouten.push('Geen geldig e-mailadres: ' + slecht.join(', '));
    else schoon.boekhouder_email = lijst.join(', ');
  }

  if ('doorstuur_tekst' in nieuw) {
    schoon.doorstuur_tekst = String(nieuw.doorstuur_tekst || '').slice(0, 2000);
  }

  for (const sleutel of ['auto_doorsturen', 'testmodus', 'outlook_categorie']) {
    if (sleutel in nieuw) schoon[sleutel] = waarheid(nieuw[sleutel]) ? '1' : '0';
  }

  if ('match_drempel' in nieuw) {
    const n = Number(String(nieuw.match_drempel).replace(',', '.'));
    if (!Number.isFinite(n) || n < DREMPEL_MIN || n > DREMPEL_MAX) {
      fouten.push(`Matchdrempel moet tussen ${DREMPEL_MIN} en ${DREMPEL_MAX} liggen.`);
    } else {
      schoon.match_drempel = String(Math.round(n * 100) / 100);
    }
  }

  if ('terugkijken_dagen' in nieuw) {
    const n = Number(nieuw.terugkijken_dagen);
    if (!Number.isInteger(n) || n < TERUGKIJKEN_MIN || n > TERUGKIJKEN_MAX) {
      fouten.push(`Terugkijkperiode moet tussen ${TERUGKIJKEN_MIN} en ${TERUGKIJKEN_MAX} dagen liggen.`);
    } else {
      schoon.terugkijken_dagen = String(n);
    }
  }

  if (fouten.length) return { fouten, gewijzigd: [] };

  const oud = { ...STANDAARD, ...opslag.alleInstellingen() };

  // De toggle "automatisch doorsturen" zet zijn eigen startmoment. Zonder dat
  // moment zou de eerste sync de hele historie naar de boekhouder sturen.
  if (schoon.auto_doorsturen === '1' && oud.auto_doorsturen !== '1') {
    schoon.auto_doorsturen_sinds = nu;
  }

  const gewijzigd = [];
  for (const [sleutel, waarde] of Object.entries(schoon)) {
    if (String(oud[sleutel] ?? '') === String(waarde)) continue;
    opslag.zetInstelling(sleutel, waarde);
    gewijzigd.push({ sleutel, oud: oud[sleutel] ?? '', nieuw: waarde });
    opslag.log('info', `Instelling ${sleutel}: "${oud[sleutel] ?? ''}" -> "${waarde}"`);
  }

  return { fouten: [], gewijzigd };
}

function waarheid(v) {
  const s = String(v).toLowerCase();
  return s === '1' || s === 'aan' || s === 'on' || s === 'true' || s === 'ja';
}
