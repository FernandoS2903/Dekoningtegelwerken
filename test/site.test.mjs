// Statische controles op de gegenereerde site, zonder browser.
//   node --test test/*.test.mjs
// De browsertests (test/schermafdruk.mjs, test/interactie.mjs) draaien los,
// want die hebben een Chromium en een lokale server nodig.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UITGESLOTEN = new Set(['.git', '_sjablonen', 'docs', 'deploy', 'service', 'test', 'node_modules']);

function paginas(map = ROOT, rel = '') {
  const uit = [];
  for (const naam of readdirSync(map)) {
    const vol = path.join(map, naam);
    const r = rel ? rel + '/' + naam : naam;
    if (statSync(vol).isDirectory()) { if (!(rel === '' && UITGESLOTEN.has(naam))) uit.push(...paginas(vol, r)); }
    else if (naam.endsWith('.html')) uit.push(r);
  }
  return uit;
}
const alle = paginas().map((rel) => ({ rel, html: readFileSync(path.join(ROOT, rel), 'utf8') }));

test('gegenereerde bestanden passen bij data en sjablonen', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'service/cli/genereer.mjs'), '--controleer'], { stdio: 'pipe' });
});

test('elke pagina heeft lang="nl", een titel en precies één h1', () => {
  for (const { rel, html } of alle) {
    assert.match(html, /<html lang="nl">/, rel);
    assert.match(html, /<title>[^<]+<\/title>/, rel);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, rel + ': aantal h1');
  }
});

test('interne links en assets bestaan', () => {
  const ontbreekt = [];
  for (const { rel, html } of alle) {
    for (const [, url] of html.matchAll(/(?:href|src)="(\/[^"#?]*)/g)) {
      const doel = path.join(ROOT, url.endsWith('/') ? url + 'index.html' : url);
      if (!existsSync(doel)) ontbreekt.push(rel + ' -> ' + url);
    }
  }
  assert.deepEqual(ontbreekt, []);
});

test('elke srcset-variant bestaat', () => {
  const ontbreekt = [];
  for (const { rel, html } of alle) {
    for (const [, set] of html.matchAll(/srcset="([^"]+)"/g)) {
      for (const deel of set.split(',')) {
        const url = deel.trim().split(/\s+/)[0];
        if (!existsSync(path.join(ROOT, url))) ontbreekt.push(rel + ' -> ' + url);
      }
    }
  }
  assert.deepEqual(ontbreekt, []);
});

test('elke afbeelding heeft afmetingen; sfeerbeelden zeggen dat in de alt, het logo heet De Koning Tegelwerken', () => {
  // Zolang er alleen AI-sfeerbeelden zijn, moet dat ook in de alt-tekst staan.
  // Pas deze test aan zodra er echte projectfoto's van De Koning bij komen.
  for (const { rel, html } of alle) {
    for (const [tag] of html.matchAll(/<img\s[^>]*>/g)) {
      assert.match(tag, /\swidth="\d+" height="\d+"/, rel + ': ' + tag.slice(0, 80));
      if (/src="\/assets\/brand\//.test(tag)) {
        assert.match(tag, /\salt="De Koning Tegelwerken"/, rel + ': logo zonder juiste alt');
      } else {
        assert.match(tag, /\salt="Sfeerbeeld[^"]{10,}"/, rel + ': ' + tag.slice(0, 80));
      }
    }
  }
});

test('elk beeld in data/beelden.json is gemarkeerd als sfeerbeeld', () => {
  const { beelden } = JSON.parse(readFileSync(path.join(ROOT, 'data/beelden.json'), 'utf8'));
  for (const b of beelden) assert.equal(b.soort, 'sfeerbeeld', b.id);
});

test('ankers op de homepage bestaan', () => {
  const home = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const id of ['werk', 'werkwijze', 'over', 'inhoud']) assert.match(home, new RegExp(`id="${id}"`), id);
});

test('geen inline style-attributen of inline scripts (strikte CSP mogelijk)', () => {
  for (const { rel, html } of alle) {
    assert.doesNotMatch(html, /\sstyle="/, rel);
    for (const [tag] of html.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>/g)) {
      assert.fail(rel + ': inline script ' + tag);
    }
  }
});

test('elke fotoplaceholder heeft een beschrijvend aria-label', () => {
  for (const { rel, html } of alle) {
    for (const [tag] of html.matchAll(/<div class="foto__vlak"[^>]*>/g)) {
      assert.match(tag, /role="img" aria-label="Placeholder, beoogde foto: .{15,}"/, rel);
    }
  }
});

test('geen review-structured data (besluit Bob)', () => {
  for (const { rel, html } of alle) assert.doesNotMatch(html, /"@type":\s*"(Review|AggregateRating)"/, rel);
});

test('site.json bevat geen ingevulde bedrijfsgegevens zonder bron', () => {
  // Bewaakt dat er niet per ongeluk verzonnen gegevens in komen: alleen de
  // velden in AANGELEVERD zijn ingevuld, met precies die waarde; de rest blijft
  // leeg tot Bob ze aanlevert. Voeg een veld pas toe als het echt is aangeleverd.
  // KvK en adres: uittreksel Handelsregister, aangeleverd 3 okt 2026.
  const AANGELEVERD = { naam: 'De Koning Tegelwerken', kvk: '53284046', adres: 'Appelboomstraat 57, 1971 RA IJmuiden' };
  const d = JSON.parse(readFileSync(path.join(ROOT, 'data/site.json'), 'utf8'));
  for (const [k, v] of Object.entries(d.bedrijf)) assert.equal(v, AANGELEVERD[k] ?? '', 'bedrijf.' + k);
  for (const [k, v] of Object.entries(d.vertrouwen)) assert.ok(v === '' || v === null, 'vertrouwen.' + k);
  assert.deepEqual(d.reviews, []);
});
