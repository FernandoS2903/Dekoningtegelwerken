// Projectfoto's verwerken voor de website: controleren, rechtop zetten,
// EXIF weghalen en omzetten naar WebP in een paar breedtes.
//
//  - Het type komt uit de eerste bytes (JPEG, PNG of WebP), nooit uit de
//    bestandsnaam of het type dat de browser opgeeft.
//  - Afmetingen en EXIF-oriëntatie leest deze module zelf uit de header,
//    vóór er iets gedecodeerd wordt; te grote beelden (in pixels) worden
//    geweigerd voordat cwebp ze in het geheugen zet.
//  - cwebp past de EXIF-oriëntatie van een telefoonfoto niet toe. Een JPEG
//    met een andere oriëntatie dan 1 gaat daarom eerst door jpegtran
//    (pakket libjpeg-turbo-progs, zonder kwaliteitsverlies). Ontbreekt
//    jpegtran, dan wordt zo'n foto geweigerd in plaats van scheef geplaatst.
//  - jpegtran -copy none en cwebp -metadata none nemen geen EXIF, XMP of
//    ICC mee: GPS-locatie en camerags verdwijnen.
//  - De naam op schijf is <slug>-<12 willekeurige hextekens>-<breedte>.webp;
//    de originele naam wordt nergens gebruikt en het origineel niet bewaard.
//  - Eén foto tegelijk (een rij), met een tijdslimiet per aanroep.

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { typeUitInhoud } from './multipart.mjs';

export const MAX_BYTES = 15 * 1024 * 1024;
export const MAX_BESTANDEN = 20;
export const MAX_PIXELS = 80 * 1000 * 1000;
export const BREEDTES = [600, 1200, 2000];
export const TOEGESTAAN = ['image/jpeg', 'image/png', 'image/webp'];
const TIJDSLIMIET_MS = 90 * 1000;

export class FotoFout extends Error {
  constructor(code, melding) {
    super(melding);
    this.code = code;
  }
}

// -- header lezen -------------------------------------------------------------

/** Breedte en hoogte uit de header, zonder te decoderen; null als het niet lukt. */
export function afmetingen(buf, type = typeUitInhoud(buf)) {
  try {
    if (type === 'image/png') {
      if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
      return { breedte: buf.readUInt32BE(16), hoogte: buf.readUInt32BE(20) };
    }
    if (type === 'image/webp') return webpInfo(buf);
    if (type === 'image/jpeg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return null;
        const marker = buf[i + 1];
        if (marker === 0xff) { i++; continue; }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) { i += 2; continue; }
        const lengte = buf.readUInt16BE(i + 2);
        // SOF0..SOF15, behalve DHT (C4), JPG (C8) en DAC (CC).
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { hoogte: buf.readUInt16BE(i + 5), breedte: buf.readUInt16BE(i + 7) };
        }
        if (marker === 0xda) return null;
        i += 2 + lengte;
      }
    }
  } catch { /* afgekapt bestand */ }
  return null;
}

function webpInfo(buf) {
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { breedte: buf.readUInt16LE(26) & 0x3fff, hoogte: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { breedte: (b & 0x3fff) + 1, hoogte: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return {
      breedte: buf.readUIntLE(24, 3) + 1,
      hoogte: buf.readUIntLE(27, 3) + 1,
      geanimeerd: (buf[20] & 0x02) !== 0,
    };
  }
  return null;
}

/** De EXIF-oriëntatie (1 tot 8) van een JPEG, of 1 als die er niet is. */
export function exifOrientatie(buf) {
  try {
    let i = 2;
    while (i + 4 < buf.length && buf[i] === 0xff) {
      const marker = buf[i + 1];
      if (marker === 0xda || marker === 0xd9) break;
      const lengte = buf.readUInt16BE(i + 2);
      if (marker === 0xe1 && buf.toString('binary', i + 4, i + 10) === 'Exif\0\0') {
        const t = i + 10;
        const le = buf.toString('ascii', t, t + 2) === 'II';
        const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
        const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
        const ifd = t + u32(t + 4);
        const aantal = u16(ifd);
        for (let n = 0; n < aantal; n++) {
          const e = ifd + 2 + n * 12;
          if (u16(e) === 0x0112) {
            const w = u16(e + 8);
            return w >= 1 && w <= 8 ? w : 1;
          }
        }
        return 1;
      }
      i += 2 + lengte;
    }
  } catch { /* geen of kapotte EXIF: dan geldt de standaard */ }
  return 1;
}

// jpegtran-opties per EXIF-oriëntatie: wat er nodig is om de foto rechtop te zetten.
const DRAAI = {
  2: ['-flip', 'horizontal'],
  3: ['-rotate', '180'],
  4: ['-flip', 'vertical'],
  5: ['-transpose'],
  6: ['-rotate', '90'],
  7: ['-transverse'],
  8: ['-rotate', '270'],
};

/** De breedtes die we maken: nooit groter dan het origineel. */
export function breedtesVoor(breedte, standaard = BREEDTES) {
  const grootste = standaard[standaard.length - 1];
  if (breedte >= grootste) return [...standaard];
  return [...standaard.filter((w) => w < breedte), breedte];
}

// -- uitvoeren ------------------------------------------------------------------

function voerUit(programma, args) {
  return new Promise((klaar, mislukt) => {
    execFile(programma, args, { timeout: TIJDSLIMIET_MS, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 }, (fout, _uit, err) => {
      if (fout) {
        fout.stderr = String(err || '').slice(0, 300);
        return mislukt(fout);
      }
      return klaar();
    });
  });
}

// Eén verwerking tegelijk: cwebp op een foto van 50 megapixel gebruikt
// honderden MB's geheugen.
let rij = Promise.resolve();
function opRij(fn) {
  const volgende = rij.then(fn, fn);
  rij = volgende.catch(() => {});
  return volgende;
}

/** Een veilige basisnaam: de slug (ingekort) plus 12 willekeurige hextekens. */
export function basisnaam(slug) {
  const s = String(slug || 'project').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';
  return `${s}-${crypto.randomBytes(6).toString('hex')}`;
}
export const GELDIGE_NAAM = /^[a-z0-9-]{1,80}-[0-9a-f]{12}$/;
export const bestandVoor = (map, naam, breedte) => path.join(map, `${naam}-${breedte}.webp`);

/** Controleert een upload zonder iets te schrijven. Gooit FotoFout. */
export function controleer(buf) {
  if (!buf || !buf.length) throw new FotoFout('leeg', 'Het bestand is leeg.');
  if (buf.length > MAX_BYTES) throw new FotoFout('te-groot', 'Het bestand is groter dan 15 MB.');
  const type = typeUitInhoud(buf);
  if (!TOEGESTAAN.includes(type)) throw new FotoFout('type', 'Alleen JPEG-, PNG- en WebP-foto\'s.');
  const maat = afmetingen(buf, type);
  if (!maat || !maat.breedte || !maat.hoogte) throw new FotoFout('kapot', 'Dit bestand is geen leesbare foto.');
  if (maat.geanimeerd) throw new FotoFout('type', 'Bewegende beelden kunnen niet; kies een gewone foto.');
  if (maat.breedte * maat.hoogte > MAX_PIXELS) throw new FotoFout('te-groot', 'De foto heeft te veel pixels (meer dan 80 megapixel).');
  return { type, ...maat, orientatie: type === 'image/jpeg' ? exifOrientatie(buf) : 1 };
}

/**
 * Verwerkt één foto naar map. Geeft { bestandsnaam, varianten, breedte,
 * hoogte } terug. Bij een fout blijft er niets achter in map.
 */
export async function verwerkFoto(buf, {
  map, slug, cwebp = 'cwebp', jpegtran = 'jpegtran', breedtes = BREEDTES, kwaliteit = 80,
} = {}) {
  const info = controleer(buf);
  return opRij(async () => {
    const werk = mkdtempSync(path.join(os.tmpdir(), 'dkt-foto-'));
    const geschreven = [];
    try {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[info.type];
      let invoer = path.join(werk, 'in' + ext);
      writeFileSync(invoer, buf, { mode: 0o600 });
      let { breedte, hoogte } = info;

      if (info.orientatie !== 1) {
        const recht = path.join(werk, 'recht.jpg');
        try {
          await voerUit(jpegtran, ['-copy', 'none', '-trim', ...DRAAI[info.orientatie], '-outfile', recht, invoer]);
        } catch (fout) {
          if (fout.code === 'ENOENT') {
            throw new FotoFout('draaien', 'Deze foto moet gedraaid worden, maar jpegtran staat niet op de server. Vraag Bob om het pakket libjpeg-turbo-progs.');
          }
          throw new FotoFout('kapot', 'Deze foto kon niet rechtop gezet worden.');
        }
        invoer = recht;
        const maat = afmetingen(readFileSync(recht), 'image/jpeg');
        if (!maat) throw new FotoFout('kapot', 'Deze foto kon niet rechtop gezet worden.');
        ({ breedte, hoogte } = maat);
      }

      const naam = basisnaam(slug);
      const varianten = breedtesVoor(breedte, breedtes);
      for (const w of varianten) {
        const doel = bestandVoor(map, naam, w);
        const tijdelijk = path.join(werk, `uit-${w}.webp`);
        const args = ['-quiet', '-metadata', 'none', '-q', String(kwaliteit), '-m', '4'];
        if (w !== breedte) args.push('-resize', String(w), '0');
        try {
          await voerUit(cwebp, [...args, invoer, '-o', tijdelijk]);
        } catch (fout) {
          if (fout.code === 'ENOENT') throw new FotoFout('server', 'cwebp staat niet op de server.');
          throw new FotoFout('kapot', 'Deze foto kon niet omgezet worden.');
        }
        // Eerst in de werkmap, dan in één keer naar de uploadmap; leesbaar
        // voor nginx (groep www-data via de setgid-map).
        chmodSync(tijdelijk, 0o640);
        try {
          renameSync(tijdelijk, doel);
        } catch {
          writeFileSync(doel, readFileSync(tijdelijk), { mode: 0o640 });
          chmodSync(doel, 0o640);
        }
        geschreven.push(doel);
      }
      return { bestandsnaam: naam, varianten, breedte, hoogte };
    } catch (fout) {
      for (const b of geschreven) {
        try { unlinkSync(b); } catch { /* al weg */ }
      }
      throw fout;
    } finally {
      rmSync(werk, { recursive: true, force: true });
    }
  });
}

/** Verwijdert alle varianten van een foto. Een onbekende naam doet niets. */
export function verwijderBestanden(map, naam, varianten) {
  if (!GELDIGE_NAAM.test(String(naam))) return;
  for (const w of String(varianten).split(',').map(Number).filter(Boolean)) {
    try { unlinkSync(bestandVoor(map, naam, w)); } catch { /* al weg */ }
  }
}
