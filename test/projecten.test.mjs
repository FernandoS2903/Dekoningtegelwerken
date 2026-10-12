// Project-CMS: upload en beeldverwerking, opslag en volgorde, de projecten
// op de site (concept, voorbeeldlink, 301) en het beheer in het portaal
// (sessie, CSRF). Alle testbeelden worden hier gemaakt of komen uit de repo;
// er gaat niets naar buiten.
//   node --test test/projecten.test.mjs

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { openDatabase } from '../service/facturen/lib/db.mjs';
import { maakProjectenOpslag, controleerProject, maakSlug } from '../service/facturen/lib/projecten-opslag.mjs';
import {
  FotoFout, GELDIGE_NAAM, afmetingen, breedtesVoor, exifOrientatie, verwerkFoto,
} from '../service/facturen/lib/beeldverwerking.mjs';
import { maakSiteProjecten, maakVoorbeeldToken, leesVoorbeeldToken, voorbeeldSleutel } from '../service/facturen/site-projecten.mjs';
import { maakProjectenApp } from '../service/facturen/projecten.mjs';
import { maakPortaal } from '../service/facturen/portaal.mjs';
import { maakSessies, SESSIE_COOKIE } from '../service/facturen/lib/sessies.mjs';
import { maakOidc } from '../service/facturen/lib/oidc.mjs';
import { maakWeergave } from '../service/site/weergave.mjs';
import { migreer } from '../service/cli/migreer-projecten.mjs';
import { BASIS, CLIENT, GEHEIM, TENANT } from './portaal-hulp.mjs';

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const opruimen = [];
after(() => { for (const m of opruimen) rmSync(m, { recursive: true, force: true }); });
const tijdelijk = () => {
  const m = mkdtempSync(path.join(os.tmpdir(), 'dkt-projecten-test-'));
  opruimen.push(m);
  return m;
};

// -- testbeelden -------------------------------------------------------------------
// Een PNG van breedte x hoogte (effen kleur), zonder externe tools.
function png(breedte, hoogte) {
  const crc = (buf) => { const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(buf)); return c; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    return Buffer.concat([len, td, crc(td)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(breedte, 0);
  ihdr.writeUInt32BE(hoogte, 4);
  ihdr[8] = 8; ihdr[9] = 2;
  const rij = Buffer.concat([Buffer.from([0]), Buffer.alloc(breedte * 3, 0x9a)]);
  const ruw = Buffer.concat(Array.from({ length: hoogte }, () => rij));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(ruw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// De og-image uit de repo (1200 x 630) met een EXIF-blok erin: oriëntatie en
// een herkenbare tekst die voor GPS-gegevens staat.
const GPS_MERK = 'GPS-52.4612N-4.6031E-geheim';
function jpegMetExif(orientatie = 1) {
  const jpeg = readFileSync(path.join(REPO, 'assets/og-image.jpg'));
  const tekst = Buffer.from(GPS_MERK + '\0', 'ascii');
  const ifd = Buffer.alloc(2 + 2 * 12 + 4);
  ifd.writeUInt16BE(2, 0);
  // 0x0112 Orientation (SHORT), 0x010E ImageDescription (ASCII, met het merk)
  ifd.writeUInt16BE(0x0112, 2); ifd.writeUInt16BE(3, 4); ifd.writeUInt32BE(1, 6); ifd.writeUInt16BE(orientatie, 10);
  ifd.writeUInt16BE(0x010e, 14); ifd.writeUInt16BE(2, 16); ifd.writeUInt32BE(tekst.length, 18); ifd.writeUInt32BE(8 + ifd.length, 22);
  const tiff = Buffer.concat([Buffer.from([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8]), ifd, tekst]);
  const exif = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(exif.length + 2);
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, exif, jpeg.subarray(2)]);
}

function jpegtranPad() {
  if (process.env.JPEGTRAN) return process.env.JPEGTRAN;
  try { return execFileSync('sh', ['-c', 'command -v jpegtran'], { encoding: 'utf8' }).trim() || null; } catch { return null; }
}

// -- beeldverwerking ---------------------------------------------------------------
test('upload: verkeerd type, kapot en te groot worden geweigerd', async () => {
  const map = tijdelijk();
  const weiger = async (buf, code) => {
    await assert.rejects(verwerkFoto(buf, { map, slug: 'x' }), (f) => f instanceof FotoFout && f.code === code);
  };
  await weiger(Buffer.from('%PDF-1.7\n' + 'x'.repeat(100)), 'type');
  await weiger(Buffer.from('<?php echo "hallo"; ?>' + ' '.repeat(100)), 'type');
  await weiger(Buffer.from('GIF89a' + '\0'.repeat(100), 'binary'), 'type');
  // Een .jpg-naam helpt niet: het type komt uit de inhoud.
  const tekstAlsJpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40)]);
  await weiger(tekstAlsJpeg, 'kapot');
  const groot = Buffer.concat([png(10, 10), Buffer.alloc(15 * 1024 * 1024)]);
  await weiger(groot, 'te-groot');
  // Te veel pixels, al vóór het decoderen (alleen de header zegt 20000 x 20000).
  const reus = png(1, 1);
  reus.writeUInt32BE(20000, 16);
  reus.writeUInt32BE(20000, 20);
  await weiger(reus, 'te-groot');
  assert.deepEqual(readdirSync(map), [], 'er blijft niets achter');
});

test('upload: EXIF en GPS zijn weg, breedtes nooit groter dan het origineel', async () => {
  const map = tijdelijk();
  const r = await verwerkFoto(jpegMetExif(1), { map, slug: 'badkamer-haarlem' });
  assert.deepEqual(r.varianten, [600, 1200]);
  assert.equal(r.breedte, 1200);
  assert.equal(r.hoogte, 630);
  for (const w of r.varianten) {
    const uit = readFileSync(path.join(map, `${r.bestandsnaam}-${w}.webp`));
    assert.equal(uit.toString('ascii', 8, 12), 'WEBP');
    assert.ok(!uit.includes(GPS_MERK), 'geen GPS-tekst in de WebP');
    assert.ok(!uit.includes('Exif'), 'geen EXIF in de WebP');
    assert.ok(!uit.includes('EXIF'), 'geen EXIF-chunk in de WebP');
    assert.equal(afmetingen(uit).breedte, w);
  }
  assert.deepEqual(breedtesVoor(400), [400]);
  assert.deepEqual(breedtesVoor(1500), [600, 1200, 1500]);
  assert.deepEqual(breedtesVoor(4000), [600, 1200, 2000]);
  // PNG en WebP gaan ook.
  const p = await verwerkFoto(png(700, 300), { map, slug: 'p' });
  assert.deepEqual(p.varianten, [600, 700]);
  const w = await verwerkFoto(readFileSync(path.join(map, `${p.bestandsnaam}-700.webp`)), { map, slug: 'w' });
  assert.equal(w.breedte, 700);
});

test('upload: bestandsnaam hangt niet af van de invoer (geen path traversal)', async () => {
  const map = tijdelijk();
  const r = await verwerkFoto(png(50, 40), { map, slug: '../../etc/passwd' });
  assert.match(r.bestandsnaam, GELDIGE_NAAM);
  assert.ok(!r.bestandsnaam.includes('/') && !r.bestandsnaam.includes('..'));
  assert.deepEqual(readdirSync(map).sort(), [`${r.bestandsnaam}-50.webp`]);
  const r2 = await verwerkFoto(png(50, 40), { map, slug: '../../etc/passwd' });
  assert.notEqual(r.bestandsnaam, r2.bestandsnaam, 'elke upload een eigen naam');
});

test('upload: telefoonfoto met oriëntatie wordt rechtop gezet, of geweigerd zonder jpegtran', async (t) => {
  const map = tijdelijk();
  const foto = jpegMetExif(6);
  assert.equal(exifOrientatie(foto), 6);
  await assert.rejects(verwerkFoto(foto, { map, slug: 'x', jpegtran: '/bestaat/niet/jpegtran' }), (f) => f.code === 'draaien');
  assert.deepEqual(readdirSync(map), []);
  const jpegtran = jpegtranPad();
  if (!jpegtran) return t.skip('jpegtran staat niet op deze machine');
  const r = await verwerkFoto(foto, { map, slug: 'staand', jpegtran });
  assert.ok(r.hoogte > r.breedte, `staand na draaien (${r.breedte} x ${r.hoogte})`);
  const uit = readFileSync(path.join(map, `${r.bestandsnaam}-${r.varianten.at(-1)}.webp`));
  assert.ok(!uit.includes(GPS_MERK));
  return undefined;
});

// -- opslag ---------------------------------------------------------------------------
function opslagMetSite() {
  const map = tijdelijk();
  const opslag = maakProjectenOpslag(openDatabase(path.join(map, 'facturen.db')));
  const sleutel = voorbeeldSleutel(GEHEIM);
  let klok = Date.parse('2026-10-12T10:00:00Z');
  const site = maakSiteProjecten({ opslag, weergave: maakWeergave({ root: REPO }), sleutel, portaalHost: 'cms.dekoningtegelwerken.nl', nu: () => klok });
  return { map, opslag, site, sleutel, zetKlok: (t) => { klok = t; } };
}
const velden = (extra = {}) => controleerProject({ titel: 'Badkamer in Haarlem', plaats: 'Haarlem', ruimte: 'Badkamer', categorieen: ['badkamer'], ...extra }).velden;

test('opslag: aanmaken, slug uniek, volgorde en zacht verwijderen', () => {
  const { opslag } = opslagMetSite();
  const a = opslag.maak(velden());
  const b = opslag.maak(velden({ titel: 'Toilet', slug: 'toilet-velsen' }));
  const c = opslag.maak(velden({ titel: 'Vloer', slug: 'vloer' }));
  assert.equal(opslag.opId(a).slug, 'badkamer-in-haarlem');
  // Nieuw komt bovenaan.
  assert.deepEqual(opslag.lijst().map((p) => p.id), [c, b, a]);
  assert.ok(opslag.slugBezet('toilet-velsen', a));
  assert.ok(!opslag.slugBezet('toilet-velsen', b));
  assert.throws(() => opslag.maak(velden({ slug: 'vloer' })), /UNIQUE/);
  assert.ok(opslag.verplaats(a, 'omhoog'));
  assert.deepEqual(opslag.lijst().map((p) => p.id), [c, a, b]);
  assert.ok(!opslag.verplaats(c, 'omhoog'), 'de bovenste kan niet hoger');
  assert.ok(opslag.verwijder(c));
  assert.equal(opslag.opId(c), null);
  assert.deepEqual(opslag.lijst().map((p) => p.id), [a, b]);
  // De slug van een verwijderd project komt vrij.
  assert.ok(opslag.maak(velden({ slug: 'vloer' })));
});

test('opslag: controle van de velden', () => {
  assert.equal(maakSlug('Badkamer & toilet in IJmuiden!'), 'badkamer-en-toilet-in-ijmuiden');
  assert.equal(maakSlug('Ãfwérking'), 'afwerking');
  const { fouten } = controleerProject({ titel: '', plaats: 'Dorpsstraat 12, 1971 AB IJmuiden', slug: 'Niet Goed', categorieen: ['badkamer', 'zwembad'] });
  assert.ok(fouten.titel);
  assert.match(fouten.plaats, /zonder adres/);
  assert.ok(fouten.slug);
  assert.ok(fouten.categorieen);
  const goed = controleerProject({ titel: 'Vloer', plaats: 'Velsen-Zuid', status: 'gepubliceerd', uitgelicht: '1' });
  assert.deepEqual(goed.fouten, {});
  assert.equal(goed.velden.slug, 'vloer');
  assert.equal(goed.velden.status, 'gepubliceerd');
});

// -- de site --------------------------------------------------------------------------
function vraag(site, pad, { host = 'dekoningtegelwerken.nl', methode = 'GET' } = {}) {
  return new Promise((klaar) => {
    const res = {
      writeHead(status, koppen) { this.status = status; this.koppen = koppen; },
      end(body) { klaar({ status: this.status, koppen: this.koppen, body: String(body || '') }); },
    };
    site.handle({ method: methode, headers: { host } }, res, new URL(pad, 'http://x'));
  });
}

test('site: concept niet zichtbaar, gepubliceerd wel, cache geleegd na wijziging', async () => {
  const { opslag, site } = opslagMetSite();
  const id = opslag.maak(velden());
  assert.equal((await vraag(site, '/projecten/badkamer-in-haarlem/')).status, 404);
  assert.doesNotMatch((await vraag(site, '/_fragment/projecten/alle/filters')).body, /Badkamer in Haarlem/);
  assert.match((await vraag(site, '/_fragment/projecten/uitgelicht/filters')).body, /Hier komen binnenkort projecten/);

  opslag.zetStatus(id, 'gepubliceerd');
  assert.equal((await vraag(site, '/projecten/badkamer-in-haarlem/')).status, 404, 'nog uit de cache');
  site.leegCache();
  const pagina = await vraag(site, '/projecten/badkamer-in-haarlem/');
  assert.equal(pagina.status, 200);
  assert.match(pagina.body, /<h1 class="kop-2">Badkamer in Haarlem<\/h1>/);
  assert.match(pagina.body, /<title>Badkamer in Haarlem in Haarlem \| De Koning Tegelwerken<\/title>/);
  assert.doesNotMatch(pagina.body, /noindex/);
  assert.match((await vraag(site, '/_fragment/projecten/categorie=badkamer')).body, /href="\/projecten\/badkamer-in-haarlem\/"/);
  assert.doesNotMatch((await vraag(site, '/_fragment/projecten/categorie=toilet')).body, /badkamer-in-haarlem/);
  assert.match((await vraag(site, '/sitemap-projecten.xml')).body, /<loc>https:\/\/dekoningtegelwerken\.nl\/projecten\/badkamer-in-haarlem\/<\/loc>/);

  // Verwijderd: weer 404.
  opslag.verwijder(id);
  site.leegCache();
  assert.equal((await vraag(site, '/projecten/badkamer-in-haarlem/')).status, 404);
  assert.doesNotMatch((await vraag(site, '/sitemap-projecten.xml')).body, /badkamer-in-haarlem/);
  // Niet op het adres van het portaal, en niets dan lezen.
  assert.equal((await vraag(site, '/sitemap-projecten.xml', { host: 'cms.dekoningtegelwerken.nl' })).status, 404);
  assert.equal((await vraag(site, '/sitemap-projecten.xml', { methode: 'POST' })).status, 405);
  assert.equal((await vraag(site, '/_fragment/projecten/categorie=..%2Fetc')).status, 404);
});

test('site: 301 vanaf de oude slug, en zonder slash naar met slash', async () => {
  const { opslag, site } = opslagMetSite();
  const id = opslag.maak(velden({ status: 'gepubliceerd' }));
  opslag.werkBij(id, velden({ status: 'gepubliceerd', slug: 'badkamer-haarlem-noord' }));
  site.leegCache();
  const oud = await vraag(site, '/projecten/badkamer-in-haarlem/');
  assert.equal(oud.status, 301);
  assert.equal(oud.koppen.location, '/projecten/badkamer-haarlem-noord/');
  assert.equal((await vraag(site, '/projecten/badkamer-haarlem-noord/')).status, 200);
  const zonder = await vraag(site, '/projecten/badkamer-haarlem-noord');
  assert.equal(zonder.status, 301);
  assert.equal(zonder.koppen.location, '/projecten/badkamer-haarlem-noord/');
  // Een nieuw project mag de oude slug overnemen; dan geen 301 meer.
  opslag.maak(velden({ status: 'gepubliceerd' }));
  site.leegCache();
  assert.equal((await vraag(site, '/projecten/badkamer-in-haarlem/')).status, 200);
});

test('site: voorbeeldlink toont een concept, verlopen of vervalst niet', async () => {
  const { opslag, site, sleutel, zetKlok } = opslagMetSite();
  const id = opslag.maak(velden());
  const url = new URL(site.voorbeeldUrl(opslag.opId(id)));
  assert.equal(url.origin, 'https://dekoningtegelwerken.nl');
  const pad = url.pathname + url.search;
  const voorbeeld = await vraag(site, pad);
  assert.equal(voorbeeld.status, 200);
  assert.match(voorbeeld.body, /Voorbeeld\.<\/strong> Dit project is nog niet gepubliceerd/);
  assert.match(voorbeeld.body, /<meta name="robots" content="noindex">/);
  assert.equal(voorbeeld.koppen['x-robots-tag'], 'noindex, nofollow');
  assert.equal(voorbeeld.koppen['cache-control'], 'no-store');
  assert.equal((await vraag(site, '/projecten/badkamer-in-haarlem/')).status, 404, 'zonder link nog steeds niet');

  const token = url.searchParams.get('voorbeeld');
  assert.equal(leesVoorbeeldToken(token, { sleutel, nu: Date.parse('2026-10-12T10:00:00Z') }), id);
  const vervalst = token.replace(/^\d+/, String(id + 1));
  assert.equal((await vraag(site, `/projecten/x/?voorbeeld=${vervalst}`)).status, 404);
  const andereSleutel = maakVoorbeeldToken(id, { sleutel: voorbeeldSleutel('een-ander-geheim-van-minstens-32-tekens!!') });
  assert.equal((await vraag(site, `/projecten/x/?voorbeeld=${andereSleutel}`)).status, 404);

  zetKlok(Date.parse('2026-10-13T10:00:01Z'));
  assert.equal((await vraag(site, pad)).status, 404, 'na 24 uur verlopen');
});

test('site: foto\'s uit het CMS met srcset, width/height, lazy behalve de eerste, og:image', async () => {
  const { opslag, site, map } = opslagMetSite();
  const id = opslag.maak(velden({ status: 'gepubliceerd', korte_omschrijving: 'Strak gelegd.' }));
  const uploads = path.join(map, 'up');
  mkdirSync(uploads);
  for (const [i, maat] of [[2400, 1600], [800, 1200], [1300, 900]].entries()) {
    const r = await verwerkFoto(png(...maat), { map: uploads, slug: 'b' });
    opslag.voegFotoToe(id, { ...r, alt_tekst: i ? '' : 'Inloopdouche met nis', soort: i === 2 ? 'detail' : 'galerij', bijschrift: i === 2 ? 'Nis' : '' });
  }
  site.leegCache();
  const { body } = await vraag(site, '/projecten/badkamer-in-haarlem/');
  const imgs = body.match(/<img [^>]*src="\/uploads\/projecten\/[^>]*>/g);
  assert.equal(imgs.length, 3);
  assert.match(imgs[0], /srcset="\/uploads\/projecten\/b-[0-9a-f]{12}-600\.webp 600w, \/uploads\/projecten\/b-[0-9a-f]{12}-1200\.webp 1200w, \/uploads\/projecten\/b-[0-9a-f]{12}-2000\.webp 2000w"/);
  assert.match(imgs[0], /width="2000" height="1333"/);
  assert.match(imgs[0], /fetchpriority="high" loading="eager"/);
  assert.match(imgs[0], /alt="Inloopdouche met nis"/);
  assert.ok(imgs.slice(1).every((i) => /loading="lazy"/.test(i)));
  assert.match(imgs[1], /alt="Badkamer in Haarlem in Haarlem"/, 'zonder alt-tekst: titel en plaats');
  assert.doesNotMatch(body, /foto--sfeer/, 'echte foto\'s krijgen geen label Sfeerbeeld');
  assert.match(body, /<figcaption>Nis<\/figcaption>/);
  assert.match(body, /<p class="lead">Strak gelegd\.<\/p>/);
  assert.match(body, /<meta property="og:image" content="https:\/\/dekoningtegelwerken\.nl\/uploads\/projecten\/b-[0-9a-f]{12}-1200\.webp">/);
  assert.match(body, /<meta property="og:description" content="Strak gelegd\.">/);
  // Het grid op /projecten/ laadt de eerste kaart direct.
  const grid = (await vraag(site, '/_fragment/projecten/alle/filters')).body;
  assert.match(grid, /loading="eager"/);
});

// -- migratie --------------------------------------------------------------------------
test('migratie: twee keer draaien geeft geen dubbele projecten', async () => {
  const map = tijdelijk();
  const o = { db: path.join(map, 'f.db'), uploads: path.join(map, 'up'), beelden: path.join(REPO, 'assets/beelden'), bron: REPO, cwebp: 'cwebp', jpegtran: 'jpegtran' };
  mkdirSync(o.uploads);
  const stil = () => {};
  const droog = await migreer({ ...o, droog: true }, stil);
  assert.equal(droog.nieuw, 6);
  assert.ok(!existsSync(o.db) || readdirSync(o.uploads).length === 0, 'droog schrijft niets');
  const eerste = await migreer(o, stil);
  assert.equal(eerste.nieuw, 6);
  const bestanden = readdirSync(o.uploads).length;
  const tweede = await migreer(o, stil);
  assert.equal(tweede.nieuw, 0);
  assert.equal(tweede.overgeslagen, 6);
  assert.equal(readdirSync(o.uploads).length, bestanden, 'geen nieuwe bestanden');
  const opslag = maakProjectenOpslag(openDatabase(o.db));
  const lijst = opslag.lijst();
  assert.equal(lijst.length, 6);
  assert.ok(lijst.every((p) => p.status === 'concept' && p.voorbeeld === 1));
  assert.ok(lijst.flatMap((p) => p.fotos).every((f) => f.sfeerbeeld === 1 && /^Sfeerbeeld/.test(f.alt_tekst)));
  assert.equal(lijst[0].slug, 'voorbeeldproject-badkamer-grootformaat', 'volgorde uit projecten.json');
  assert.equal(lijst[0].fotos.filter((f) => f.is_cover).length, 1);
});

// -- het portaal -------------------------------------------------------------------------
async function bouwPortaal() {
  const map = tijdelijk();
  const db = openDatabase(path.join(map, 'facturen.db'));
  const opslag = maakProjectenOpslag(db);
  const uploadMap = path.join(map, 'up');
  mkdirSync(uploadMap);
  const site = maakSiteProjecten({ opslag, weergave: maakWeergave({ root: REPO }), sleutel: voorbeeldSleutel(GEHEIM), portaalHost: 'cms.dekoningtegelwerken.nl' });
  const projecten = maakProjectenApp({ opslag, site, uploadMap });
  const sessies = maakSessies({ db, geheim: GEHEIM });
  const oidc = maakOidc({ tenantId: TENANT, clientId: CLIENT, clientSecret: 's', baseUrl: BASIS, toegestaan: ['bob@dekoningtegelwerken.nl'], pogingen: sessies.pogingen, fetch: async () => { throw new Error('geen netwerk'); } });
  const { server } = maakPortaal({
    opslag: { log() {} }, sorteerOpslag: {}, facturen: {}, mailApp: {}, webhook: {},
    auth: { modus: 'sso', sessies, oidc }, site, projecten,
  });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  const adres = `http://127.0.0.1:${server.address().port}`;
  const { token } = sessies.maak({ email: 'bob@dekoningtegelwerken.nl', naam: 'Bob' });
  const cookie = `${SESSIE_COOKIE}=${token}`;
  return { server, adres, cookie, opslag, uploadMap, site };
}
const csrfUit = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

test('portaal: zonder sessie naar de login, zonder CSRF 403, met allebei werkt het', async () => {
  const p = await bouwPortaal();
  try {
    const zonder = await fetch(`${p.adres}/website/projecten/`, { redirect: 'manual' });
    assert.equal(zonder.status, 302);
    assert.match(zonder.headers.get('location'), /^\/auth\/login\?terug=%2Fwebsite%2Fprojecten%2F/);
    const postZonder = await fetch(`${p.adres}/website/projecten/nieuw`, { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, body: 'titel=x' });
    assert.equal(postZonder.status, 401);

    const kop = { cookie: p.cookie };
    const lijst = await fetch(`${p.adres}/website/projecten/`, { headers: kop });
    assert.equal(lijst.status, 200);
    const html = await lijst.text();
    assert.match(html, /<p class="menugroep__kop">Website<\/p>/);
    assert.match(html, /href="\/website\/projecten\/" aria-current="page"/);
    const nieuw = await (await fetch(`${p.adres}/website/projecten/nieuw`, { headers: kop })).text();
    const csrf = csrfUit(nieuw);
    assert.ok(csrf);
    const post = (pad, velden, extra = {}) => fetch(`${p.adres}${pad}`, {
      method: 'POST', redirect: 'manual',
      headers: { ...kop, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded', ...extra },
      body: new URLSearchParams(velden).toString(),
    });
    assert.equal((await post('/website/projecten/nieuw', { titel: 'Vloer in Velsen' })).status, 403, 'zonder token');
    assert.equal((await post('/website/projecten/nieuw', { titel: 'Vloer in Velsen', _csrf: 'verzonnen' })).status, 403);
    assert.equal((await post('/website/projecten/nieuw', { titel: 'Vloer in Velsen', _csrf: csrf }, { 'sec-fetch-site': 'cross-site' })).status, 403);

    const fout = await post('/website/projecten/nieuw', { titel: 'Vloer', plaats: 'Kerkstraat 4', _csrf: csrf });
    assert.equal(fout.status, 422);
    assert.match(await fout.text(), /Alleen de plaatsnaam/);

    const goed = await post('/website/projecten/nieuw', { titel: 'Vloer in Velsen', plaats: 'Velsen', categorieen: 'vloer', _csrf: csrf });
    assert.equal(goed.status, 303);
    const id = goed.headers.get('location').match(/\/website\/projecten\/(\d+)\?m=aangemaakt/)[1];
    const project = p.opslag.opId(id);
    assert.equal(project.slug, 'vloer-in-velsen');
    assert.equal(project.status, 'concept');

    const bewerk = await (await fetch(`${p.adres}/website/projecten/${id}`, { headers: kop })).text();
    assert.match(bewerk, /href="https:\/\/dekoningtegelwerken\.nl\/projecten\/vloer-in-velsen\/\?voorbeeld=\d+\.\d+\.[A-Za-z0-9_-]{32}"/);
    const metToken = bewerk.match(/<form\b[^>]*method="post"[^>]*>(<input type="hidden" name="_csrf" value="[^"]+">)?/g);
    assert.ok(metToken.every((f) => f.includes('_csrf')), 'elk POST-formulier heeft _csrf');

    // Slug al bezet door een ander project.
    p.opslag.maak(controleerProject({ titel: 'Bezet', slug: 'bezet' }).velden);
    const bezet = await post(`/website/projecten/${id}`, { titel: 'Vloer in Velsen', slug: 'bezet', _csrf: csrf });
    assert.equal(bezet.status, 422);
    assert.match(await bezet.text(), /al van een ander project/);

    // Publiceren: daarna op de site.
    assert.equal((await post(`/website/projecten/${id}`, { titel: 'Vloer in Velsen', plaats: 'Velsen', status: 'gepubliceerd', _csrf: csrf })).status, 303);
    const site = await fetch(`${p.adres}/projecten/vloer-in-velsen/`);
    assert.equal(site.status, 200, 'cache geleegd na opslaan');

    // Volgorde en zacht verwijderen.
    assert.equal((await post(`/website/projecten/${id}/omlaag`, { _csrf: csrf })).status, 303);
    assert.equal(p.opslag.lijst()[1].id, Number(id));
    assert.match(await (await fetch(`${p.adres}/website/projecten/${id}/verwijderen`, { headers: kop })).text(), /Ja, verwijderen/);
    assert.equal((await post(`/website/projecten/${id}/verwijderen`, { _csrf: csrf })).status, 303);
    assert.equal(p.opslag.opId(id), null);
    assert.equal((await fetch(`${p.adres}/projecten/vloer-in-velsen/`)).status, 404);
  } finally {
    p.server.close();
  }
});

function multipart(velden, bestanden) {
  const grens = '----dkt' + Math.random().toString(16).slice(2);
  const delen = [];
  for (const [k, v] of Object.entries(velden)) delen.push(Buffer.from(`--${grens}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const b of bestanden) {
    delen.push(Buffer.from(`--${grens}\r\nContent-Disposition: form-data; name="foto"; filename="${b.naam}"\r\nContent-Type: ${b.type || 'image/jpeg'}\r\n\r\n`));
    delen.push(b.inhoud, Buffer.from('\r\n'));
  }
  delen.push(Buffer.from(`--${grens}--\r\n`));
  return { body: Buffer.concat(delen), type: `multipart/form-data; boundary=${grens}` };
}

test('portaal: foto\'s uploaden met CSRF, cover, volgorde, alt-tekst en verwijderen', async () => {
  const p = await bouwPortaal();
  try {
    const id = p.opslag.maak(controleerProject({ titel: 'Badkamer', plaats: 'IJmuiden' }).velden);
    const kop = { cookie: p.cookie };
    const csrf = csrfUit(await (await fetch(`${p.adres}/website/projecten/${id}`, { headers: kop })).text());
    const upload = (velden, bestanden, extra = {}) => {
      const m = multipart(velden, bestanden);
      return fetch(`${p.adres}/website/projecten/${id}/fotos`, {
        method: 'POST', redirect: 'manual', body: m.body,
        headers: { ...kop, 'sec-fetch-site': 'same-origin', 'content-type': m.type, accept: 'application/json', ...extra },
      });
    };
    const foto = { naam: '../../../etc/passwd.jpg', inhoud: jpegMetExif(1) };
    assert.equal((await upload({}, [foto])).status, 403, 'zonder CSRF');
    assert.equal((await upload({ _csrf: 'nee' }, [foto])).status, 403);
    assert.equal(p.opslag.fotos(id).length, 0);

    const verkeerd = await upload({ _csrf: csrf }, [{ naam: 'x.jpg', inhoud: Buffer.from('%PDF-1.4 ' + 'x'.repeat(50)) }]);
    assert.equal(verkeerd.status, 422);
    assert.match((await verkeerd.json()).fouten[0].melding, /Alleen JPEG/);

    const goed = await upload({ _csrf: csrf }, [foto, { naam: 'b.png', type: 'image/png', inhoud: png(900, 600) }]);
    assert.equal(goed.status, 200);
    const antwoord = await goed.json();
    assert.equal(antwoord.fotos.length, 2);
    const fotos = p.opslag.fotos(id);
    assert.equal(fotos.length, 2);
    assert.equal(fotos[0].is_cover, 1, 'de eerste foto wordt cover');
    assert.ok(readdirSync(p.uploadMap).every((n) => /^badkamer-[0-9a-f]{12}-\d+\.webp$/.test(n)));
    assert.ok(readdirSync(p.uploadMap).every((n) => !readFileSync(path.join(p.uploadMap, n)).includes(GPS_MERK)));

    // Miniatuur in het portaal; een vreemde naam geeft 404.
    const mini = await fetch(`${p.adres}/website/projecten/beeld/${fotos[0].bestandsnaam}-600.webp`, { headers: kop });
    assert.equal(mini.status, 200);
    assert.equal(mini.headers.get('content-type'), 'image/webp');
    assert.equal((await fetch(`${p.adres}/website/projecten/beeld/..%2F..%2Ffacturen.db`, { headers: kop })).status, 404);
    assert.equal((await fetch(`${p.adres}/website/projecten/beeld/${fotos[0].bestandsnaam}-600.webp`, { redirect: 'manual' })).status, 302, 'niet zonder sessie');

    const post = (pad, velden) => fetch(`${p.adres}${pad}`, {
      method: 'POST', redirect: 'manual',
      headers: { ...kop, 'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ _csrf: csrf, ...velden }).toString(),
    });
    const [f1, f2] = fotos;
    assert.equal((await post(`/website/projecten/${id}/fotos/${f2.id}`, { alt_tekst: 'Vloer met tegels van 60 x 60', soort: 'detail', bijschrift: 'Plint' })).status, 303);
    assert.equal(p.opslag.foto(id, f2.id).alt_tekst, 'Vloer met tegels van 60 x 60');
    assert.equal(p.opslag.foto(id, f2.id).soort, 'detail');
    assert.equal((await post(`/website/projecten/${id}/fotos/${f2.id}/cover`, {})).status, 303);
    assert.deepEqual(p.opslag.fotos(id).map((f) => f.is_cover), [0, 1]);
    assert.equal((await post(`/website/projecten/${id}/fotos/${f2.id}/omhoog`, {})).status, 303);
    assert.deepEqual(p.opslag.fotos(id).map((f) => f.id), [f2.id, f1.id]);
    assert.equal((await post(`/website/projecten/${id}/fotos/${f2.id}/verwijder`, {})).status, 303);
    assert.deepEqual(p.opslag.fotos(id).map((f) => [f.id, f.is_cover]), [[f1.id, 1]], 'cover gaat naar de volgende');
    assert.ok(readdirSync(p.uploadMap).every((n) => n.startsWith(f1.bestandsnaam)), 'bestanden van de verwijderde foto zijn weg');

    // Te veel bestanden in één keer.
    const veel = Array.from({ length: 21 }, (_, i) => ({ naam: `${i}.png`, type: 'image/png', inhoud: png(8, 8) }));
    assert.equal((await upload({ _csrf: csrf }, veel)).status, 413);
  } finally {
    p.server.close();
  }
});
