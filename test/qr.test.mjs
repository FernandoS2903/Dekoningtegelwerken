/* lib/qr.js: bit-voor-bit gelijk aan npm qrcode (niveau M, bytemodus) voor
   acht teksten van versie 1 tot 14, inclusief de maskerkeuze; plus de
   bouwstenen (Reed-Solomon, formaat- en versiebits) tegen bekende waarden. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { maakQr, reedSolomon, formaatBits, versieBits, kiesVersie, capaciteit, strafpunten } from '../service/facturen/lib/qr.mjs';

const referentie = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'qr-referentie.json'), 'utf8'));
const bits = q => Array.from(q.modules).join('');

test('bouwstenen: Reed-Solomon, formaatinformatie en versie-informatie', () => {
  /* ISO 18004 bijlage: formaatbits voor niveau M, masker 0 = 101010000010010 */
  assert.equal(formaatBits(0b00, 0).toString(2).padStart(15, '0'), '101010000010010');
  /* versie 7 heeft versiebits 000111110010010100 */
  assert.equal(versieBits(7).toString(2).padStart(18, '0'), '000111110010010100');
  /* Reed-Solomon: data gevolgd door de eigen EC-codewoorden is deelbaar door
     de generator (rest nul); nullen geven nullen. De waarden zelf worden
     hieronder via de referentiematrices gecontroleerd. */
  const data = [0x20, 0x5B, 0x0B, 0x78, 0xD1, 0x72, 0xDC, 0x4D, 0x43, 0x40, 0xEC, 0x11, 0xEC, 0x11, 0xEC, 0x11];
  const ec = Array.from(reedSolomon(data, 10));
  assert.equal(ec.length, 10);
  assert.deepEqual(Array.from(reedSolomon([...data, ...ec], 10)), new Array(10).fill(0));
  assert.deepEqual(Array.from(reedSolomon(new Array(16).fill(0), 10)), new Array(10).fill(0));
  assert.equal(kiesVersie(14), 1); assert.equal(kiesVersie(15), 2); assert.equal(kiesVersie(331), 13);
  assert.equal(capaciteit(1), 14); assert.equal(capaciteit(10), 213); assert.equal(capaciteit(15), 412);
  assert.throws(() => maakQr('x'.repeat(413)), /te lang/);
});

for (const [naam, ref] of Object.entries(referentie.codes)) {
  test(`referentie ${naam}: versie ${ref.versie}, masker ${ref.masker}, alle acht maskers gelijk`, () => {
    const q = maakQr(ref.tekst);
    assert.equal(q.versie, ref.versie);
    assert.equal(q.maat, ref.maat);
    assert.equal(q.masker, ref.masker, 'maskerkeuze');
    assert.equal(bits(q), ref.auto);
    for (let m = 0; m < 8; m++) {
      const vast = maakQr(ref.tekst, { masker: m });
      assert.equal(bits(vast), ref.perMasker[m], `masker ${m}`);
    }
  });
}

test('strafpunten: het gekozen masker heeft nooit meer punten dan een ander', () => {
  for (const ref of Object.values(referentie.codes)) {
    const q = maakQr(ref.tekst);
    const punten = m => { const v = maakQr(ref.tekst, { masker: m }); return strafpunten(v.maat, v.modules); };
    const laagste = Math.min(...[0, 1, 2, 3, 4, 5, 6, 7].map(punten));
    assert.equal(punten(q.masker), laagste);
  }
});
