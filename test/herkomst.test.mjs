// De herkomstcontrole op POST-formulieren (lib/web.mjs zelfdeHerkomst),
// met de koppen zoals verschillende browsers ze sturen. Aanleiding: Safari
// 17.6 kreeg 403 bij "Betalen via bunq" (15 okt 2026).
//   node --test test/herkomst.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zelfdeHerkomst, herkomstUitleg, CSP, kop } from '../service/facturen/lib/web.mjs';

const H = 'cms.dekoningtegelwerken.nl';
const verzoek = (koppen) => ({ headers: { host: H, ...koppen } });

test('toegestaan: Chrome, Safari zonder fetch-metadata, Safari met Origin null maar eigen Referer, opnieuw verzenden', () => {
  assert.equal(zelfdeHerkomst(verzoek({ 'sec-fetch-site': 'same-origin', origin: `https://${H}` })), true);
  assert.equal(zelfdeHerkomst(verzoek({ origin: `https://${H}` })), true);
  assert.equal(zelfdeHerkomst(verzoek({ origin: 'null', referer: `https://${H}/facturen/betalen/bevestig?id=1` })), true);
  assert.equal(zelfdeHerkomst(verzoek({ 'sec-fetch-site': 'none', origin: `https://${H}` })), true);
  assert.equal(zelfdeHerkomst(verzoek({ 'sec-fetch-site': 'none', origin: 'null', referer: `https://${H}/facturen/` })), true);
});

test('geweigerd: andere site, zelfde site maar ander subdomein, geen enkel bewijs, Origin null zonder Referer', () => {
  assert.equal(zelfdeHerkomst(verzoek({ 'sec-fetch-site': 'cross-site', origin: 'https://kwaad.example' })), false);
  assert.equal(zelfdeHerkomst(verzoek({ 'sec-fetch-site': 'same-site', origin: 'https://dekoningtegelwerken.nl' })), false);
  assert.equal(zelfdeHerkomst(verzoek({ origin: 'https://kwaad.example', referer: `https://${H}/` })), false, 'Origin gaat voor Referer');
  assert.equal(zelfdeHerkomst(verzoek({ referer: 'https://kwaad.example/x' })), false);
  assert.equal(zelfdeHerkomst(verzoek({})), false);
  assert.equal(zelfdeHerkomst(verzoek({ origin: 'null' })), false);
  assert.equal(zelfdeHerkomst(verzoek({ 'sec-fetch-site': 'none' })), false);
});

test('uitleg voor het logboek: alleen hosts, geen paden of queries', () => {
  const u = herkomstUitleg(verzoek({ 'sec-fetch-site': 'none', origin: 'null', referer: `https://${H}/facturen/betalen/bevestig?id=7` }));
  assert.equal(u, `sec-fetch-site=none origin=null referer=${H} host=${H}`);
});

test('referrer-policy same-origin, zodat Safari binnen het portaal Origin en Referer meestuurt', () => {
  let koppen;
  kop({ writeHead: (_s, h) => { koppen = h; } }, 200, 'text/html');
  assert.equal(koppen['referrer-policy'], 'same-origin');
  assert.match(CSP, /frame-ancestors 'none'/);
});
