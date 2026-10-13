/* QR-code (ISO/IEC 18004) zonder afhankelijkheid (kopie van lib/qr.js in Offerteknop): bytemodus (UTF-8),
   foutcorrectieniveau M, versie 1 tot en met 15 (tot 412 bytes). Genoeg voor
   een EPC-betaalcode (maximaal 331 bytes) en een betaallink.

   De uitkomst is bit voor bit gelijk aan die van de npm-module qrcode
   (zie tests/qr.test.js met tests/fixtures/qr-referentie.json); ook de
   maskerkeuze volgt dezelfde strafpunten, zodat de vergelijking sluit.

   Gebruik: maakQr('tekst') geeft { versie, maat, masker, modules }, waarbij
   modules een Uint8Array van maat × maat is (1 = donker), rij voor rij. */

/* Per versie bij niveau M: totaal codewoorden, EC-codewoorden per blok en de
   blokgroepen [aantal, datacodewoorden per blok]. */
const NIVEAU_M = {
  1: [26, 10, [1, 16]], 2: [44, 16, [1, 28]], 3: [70, 26, [1, 44]], 4: [100, 18, [2, 32]], 5: [134, 24, [2, 43]],
  6: [172, 16, [4, 27]], 7: [196, 18, [4, 31]], 8: [242, 22, [2, 38], [2, 39]], 9: [292, 22, [3, 36], [2, 37]],
  10: [346, 26, [4, 43], [1, 44]], 11: [404, 30, [1, 50], [4, 51]], 12: [466, 22, [6, 36], [2, 37]],
  13: [532, 22, [8, 37], [1, 38]], 14: [581, 24, [4, 40], [5, 41]], 15: [655, 24, [5, 41], [5, 42]],
};
const UITLIJNING = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46],
  10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70],
};
export const MAX_VERSIE = 15;
const EC_BITS_M = 0b00;

/* ---------- GF(256) en Reed-Solomon ---------- */
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11D : 0); }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gfMul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

function generator(graad) {
  let g = [1];
  for (let i = 0; i < graad; i++) {
    const volgende = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      volgende[j] ^= g[j];
      volgende[j + 1] ^= gfMul(g[j], EXP[i]);
    }
    g = volgende;
  }
  return g;
}

export function reedSolomon(data, graad) {
  const g = generator(graad);
  const rest = new Uint8Array(graad);
  for (const d of data) {
    const factor = d ^ rest[0];
    rest.copyWithin(0, 1);
    rest[graad - 1] = 0;
    for (let j = 0; j < graad; j++) rest[j] ^= gfMul(g[j + 1], factor);
  }
  return rest;
}

/* ---------- bits ---------- */
class Bits {
  constructor() { this.bits = []; }
  zet(waarde, aantal) { for (let i = aantal - 1; i >= 0; i--) this.bits.push((waarde >>> i) & 1); }
  get lengte() { return this.bits.length; }
}

export function kiesVersie(aantalBytes) {
  for (let v = 1; v <= MAX_VERSIE; v++) {
    const [, , ...groepen] = NIVEAU_M[v];
    const dataCodewoorden = groepen.reduce((s, [n, d]) => s + n * d, 0);
    const telbits = v <= 9 ? 8 : 16;
    if (dataCodewoorden * 8 >= 4 + telbits + aantalBytes * 8) return v;
  }
  throw new Error(`Tekst te lang voor een QR-code (maximaal ${capaciteit(MAX_VERSIE)} bytes).`);
}
export function capaciteit(versie) {
  const [, , ...groepen] = NIVEAU_M[versie];
  const dataCodewoorden = groepen.reduce((s, [n, d]) => s + n * d, 0);
  return Math.floor((dataCodewoorden * 8 - 4 - (versie <= 9 ? 8 : 16)) / 8);
}

function codewoorden(bytes, versie) {
  const [totaal, ecPerBlok, ...groepen] = NIVEAU_M[versie];
  const dataCodewoorden = groepen.reduce((s, [n, d]) => s + n * d, 0);
  const b = new Bits();
  b.zet(0b0100, 4);
  b.zet(bytes.length, versie <= 9 ? 8 : 16);
  for (const x of bytes) b.zet(x, 8);
  const cap = dataCodewoorden * 8;
  b.zet(0, Math.min(4, cap - b.lengte));
  while (b.lengte % 8) b.zet(0, 1);
  for (let pad = 0xEC; b.lengte < cap; pad ^= 0xEC ^ 0x11) b.zet(pad, 8);
  const data = new Uint8Array(dataCodewoorden);
  for (let i = 0; i < data.length; i++) for (let j = 0; j < 8; j++) data[i] |= b.bits[i * 8 + j] << (7 - j);

  /* blokken, elk met eigen EC; daarna per positie door elkaar */
  const blokken = [];
  let p = 0;
  for (const [aantal, lengte] of groepen) {
    for (let i = 0; i < aantal; i++) { const d = data.subarray(p, p + lengte); blokken.push({ d, ec: reedSolomon(d, ecPerBlok) }); p += lengte; }
  }
  const uit = new Uint8Array(totaal);
  let k = 0;
  const maxData = Math.max(...blokken.map(x => x.d.length));
  for (let i = 0; i < maxData; i++) for (const blok of blokken) if (i < blok.d.length) uit[k++] = blok.d[i];
  for (let i = 0; i < ecPerBlok; i++) for (const blok of blokken) uit[k++] = blok.ec[i];
  return uit;
}

/* ---------- matrix ---------- */
function bchRest(waarde, bits, poly) {
  let rest = waarde;
  for (let i = 0; i < bits; i++) rest = (rest << 1) ^ ((rest >>> (bits - 1)) * poly);
  return rest;
}
export const formaatBits = (ecBits, masker) => {
  const data = (ecBits << 3) | masker;
  return ((data << 10) | bchRest(data, 10, 0x537)) ^ 0x5412;
};
export const versieBits = versie => (versie << 12) | bchRest(versie, 12, 0x1F25);

function maakRaster(versie) {
  const maat = versie * 4 + 17;
  const modules = new Uint8Array(maat * maat);
  const functie = new Uint8Array(maat * maat);
  const zet = (r, c, donker) => { modules[r * maat + c] = donker ? 1 : 0; functie[r * maat + c] = 1; };

  const zoeker = (r0, c0) => {
    for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
      const r = r0 + dr, c = c0 + dc;
      if (r < 0 || c < 0 || r >= maat || c >= maat) continue;
      const afstand = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      zet(r, c, afstand !== 2 && afstand !== 4);
    }
  };
  zoeker(0, 0); zoeker(0, maat - 7); zoeker(maat - 7, 0);
  for (let i = 8; i < maat - 8; i++) { zet(6, i, i % 2 === 0); zet(i, 6, i % 2 === 0); }

  const pos = UITLIJNING[versie];
  const laatste = pos.length - 1;
  for (let i = 0; i <= laatste; i++) for (let j = 0; j <= laatste; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === laatste) || (i === laatste && j === 0)) continue;
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) zet(pos[i] + dr, pos[j] + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
  }

  /* formaatgebieden reserveren (worden na de maskerkeuze gevuld) */
  for (let i = 0; i <= 8; i++) { if (i === 6) continue; zet(8, i, 0); zet(i, 8, 0); }
  for (let i = 0; i < 8; i++) { zet(8, maat - 1 - i, 0); zet(maat - 1 - i, 8, 0); }
  zet(maat - 8, 8, 1);

  if (versie >= 7) {
    const bits = versieBits(versie);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = maat - 11 + (i % 3), b = Math.floor(i / 3);
      zet(b, a, bit); zet(a, b, bit);
    }
  }
  return { maat, modules, functie };
}

function plaatsData(raster, data) {
  const { maat, modules, functie } = raster;
  const totaalBits = data.length * 8;
  let i = 0;
  for (let rechts = maat - 1; rechts >= 1; rechts -= 2) {
    if (rechts === 6) rechts = 5;
    for (let vert = 0; vert < maat; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = rechts - j;
        const omhoog = ((rechts + 1) & 2) === 0;
        const r = omhoog ? maat - 1 - vert : vert;
        const k = r * maat + c;
        if (!functie[k] && i < totaalBits) {
          modules[k] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
          i++;
        }
      }
    }
  }
}

const MASKERS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
  (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
  (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
];

function pasMaskerToe(raster, masker) {
  const { maat, modules, functie } = raster;
  const f = MASKERS[masker];
  for (let r = 0; r < maat; r++) for (let c = 0; c < maat; c++) {
    const k = r * maat + c;
    if (!functie[k] && f(r, c)) modules[k] ^= 1;
  }
}

function schrijfFormaat(raster, masker) {
  const { maat, modules } = raster;
  const bits = formaatBits(EC_BITS_M, masker);
  const bit = i => (bits >>> i) & 1;
  const zet = (r, c, v) => { modules[r * maat + c] = v; };
  for (let i = 0; i <= 5; i++) zet(i, 8, bit(i));
  zet(7, 8, bit(6)); zet(8, 8, bit(7)); zet(8, 7, bit(8));
  for (let i = 9; i < 15; i++) zet(8, 14 - i, bit(i));
  for (let i = 0; i < 8; i++) zet(8, maat - 1 - i, bit(i));
  for (let i = 8; i < 15; i++) zet(maat - 15 + i, 8, bit(i));
  zet(maat - 8, 8, 1);
}

/* Strafpunten (ISO 18004 §7.8.3.1), met dezelfde telwijze als npm qrcode. */
export function strafpunten(maat, modules) {
  const m = (r, c) => modules[r * maat + c];
  let punten = 0;
  /* 1: reeksen van vijf of meer gelijke modules, en 3: zoekerachtig patroon */
  for (let r = 0; r < maat; r++) {
    let reeksRij = 0, reeksKol = 0, vorigRij = null, vorigKol = null, vensterRij = 0, vensterKol = 0;
    for (let c = 0; c < maat; c++) {
      const h = m(r, c), v = m(c, r);
      if (h === vorigRij) reeksRij++; else { if (reeksRij >= 5) punten += 3 + (reeksRij - 5); reeksRij = 1; vorigRij = h; }
      if (v === vorigKol) reeksKol++; else { if (reeksKol >= 5) punten += 3 + (reeksKol - 5); reeksKol = 1; vorigKol = v; }
      vensterRij = ((vensterRij << 1) & 0x7FF) | h;
      vensterKol = ((vensterKol << 1) & 0x7FF) | v;
      if (c >= 10) {
        if (vensterRij === 0x5D0 || vensterRij === 0x05D) punten += 40;
        if (vensterKol === 0x5D0 || vensterKol === 0x05D) punten += 40;
      }
    }
    if (reeksRij >= 5) punten += 3 + (reeksRij - 5);
    if (reeksKol >= 5) punten += 3 + (reeksKol - 5);
  }
  /* 2: blokken van 2 × 2 in één kleur */
  for (let r = 0; r < maat - 1; r++) for (let c = 0; c < maat - 1; c++) {
    const s = m(r, c) + m(r, c + 1) + m(r + 1, c) + m(r + 1, c + 1);
    if (s === 0 || s === 4) punten += 3;
  }
  /* 4: verhouding donker/licht */
  let donker = 0;
  for (let k = 0; k < modules.length; k++) donker += modules[k];
  punten += Math.abs(Math.ceil((donker * 100) / modules.length / 5) - 10) * 10;
  return punten;
}

export function maakQr(tekst, { masker = null } = {}) {
  const bytes = Buffer.from(String(tekst), 'utf8');
  const versie = kiesVersie(bytes.length);
  const data = codewoorden(bytes, versie);
  let beste = null;
  const kandidaten = masker === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [masker];
  for (const k of kandidaten) {
    const raster = maakRaster(versie);
    plaatsData(raster, data);
    pasMaskerToe(raster, k);
    schrijfFormaat(raster, k);
    const punten = kandidaten.length === 1 ? 0 : strafpunten(raster.maat, raster.modules);
    if (!beste || punten < beste.punten) beste = { punten, masker: k, raster };
  }
  return { versie, maat: beste.raster.maat, masker: beste.masker, modules: beste.raster.modules };
}

/* Voor in een log of test: elke module als blokje, witruimte eromheen. */
export function naarTekst({ maat, modules }) {
  const regels = [];
  for (let r = 0; r < maat; r++) {
    let s = '';
    for (let c = 0; c < maat; c++) s += modules[r * maat + c] ? '██' : '  ';
    regels.push(s);
  }
  return regels.join('\n');
}
