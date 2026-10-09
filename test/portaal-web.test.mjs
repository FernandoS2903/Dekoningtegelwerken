// Het portaal via een echte http-server: inloggen met (nagebootste)
// Microsoft, sessies, /auth/check, CSRF, alle pagina's, de webhook en de
// terugval op Basic Auth zonder SSO.
//   node --test test/portaal-web.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { maakFacturenApp, maakBasicAuth } from '../service/facturen/server.mjs';
import { maakPortaal, middernachtAmsterdam } from '../service/facturen/portaal.mjs';
import { maakMailApp } from '../service/facturen/mail.mjs';
import { maakSorteerOpslag } from '../service/facturen/lib/sorteer-opslag.mjs';
import { maakSorteerder } from '../service/facturen/lib/sorteren.mjs';
import { maakWebhook } from '../service/facturen/lib/webhook.mjs';
import { maakSessies } from '../service/facturen/lib/sessies.mjs';
import { maakOidc } from '../service/facturen/lib/oidc.mjs';
import * as instellingen from '../service/facturen/lib/instellingen.mjs';
import { BASIS, CLIENT, GEHEIM, TENANT, claims, nepEntra, tekenJwt } from './portaal-hulp.mjs';
import { bericht, nepClassificeerder, nepMailbox } from './mail-hulp.mjs';
import { nepGraph, ruimOp, tijdelijkeOpslag, voegFactuurToe } from './facturen-hulp.mjs';

const WEBHOOK_GEHEIM = 'webhook-geheim-voor-de-test-1234567890';

// Bouwt het hele portaal zoals start() in server.mjs, met nagebootste
// koppelingen. `modus` is 'sso' of 'basic'.
async function bouw({ modus = 'sso', toegestaan = ['bob@dekoningtegelwerken.nl'] } = {}) {
  const { opslag, pdfMap } = tijdelijkeOpslag();
  const sorteerOpslag = maakSorteerOpslag(opslag.db);
  // Ontvangen na het startpunt (dat op de echte klok staat).
  const ontvangen = new Date(Date.now() + 60 * 1000).toISOString();
  const mail = nepMailbox({ rondes: [[bericht({ id: 'w1', adres: 'jan@klant.nl', onderwerp: 'Badkamer', ontvangen })]] });
  mail.webhook = { async maak(o) { return { id: 'sub-1', verlooptOp: o.verlooptOp }; }, async verleng() {}, async verwijder() {} };
  const facturen = maakFacturenApp({ opslag, graph: nepGraph(), pdfMap, basisPad: '/facturen', nu: () => '2026-10-09' });
  const sorteerder = maakSorteerder({
    sorteerOpslag, mail, classificeerder: nepClassificeerder(), instellingenLezer: () => instellingen.lees(opslag),
  });
  const webhook = maakWebhook({
    mail, sorteerOpslag, sorteerder, geheim: WEBHOOK_GEHEIM, notificatieUrl: BASIS + '/graph/notify', actief: true,
  });
  const mailApp = maakMailApp({ opslag, sorteerOpslag, sorteerder, webhook, mail, classificeerder: nepClassificeerder(), basisPad: '/mail' });

  let auth;
  let entra = null;
  if (modus === 'sso') {
    entra = nepEntra();
    const sessies = maakSessies({ db: opslag.db, geheim: GEHEIM });
    const oidc = maakOidc({
      tenantId: TENANT, clientId: CLIENT, clientSecret: 's', baseUrl: BASIS, toegestaan,
      pogingen: sessies.pogingen, fetch: entra.fetch,
    });
    auth = { modus: 'sso', sessies, oidc };
  } else {
    auth = { modus: 'basic', basic: maakBasicAuth({ gebruiker: 'bob', wachtwoord: 'test-wachtwoord' }), geheim: GEHEIM };
  }

  const { server } = maakPortaal({ opslag, sorteerOpslag, facturen, mailApp, webhook, auth, offertesUrl: 'https://de-koning-tegelwerken.offerteknop.nl/offertes/' });
  await new Promise((klaar) => server.listen(0, '127.0.0.1', klaar));
  const adres = `http://127.0.0.1:${server.address().port}`;

  // Eerste sorteerronde (startpunt) en één mail in het logboek.
  await sorteerder.draai();
  await sorteerder.draai();

  return { server, adres, opslag, sorteerOpslag, sorteerder, mail, entra, auth, webhook };
}

const sluit = (server) => new Promise((klaar) => server.close(klaar));
const cookiesUit = (antwoord) => antwoord.headers.getSetCookie();
const csrfUit = (html) => (html.match(/name="_csrf" value="([^"]+)"/) || [])[1];

// Logt in via /auth/login en /auth/callback; geeft de Cookie-kop terug.
async function logIn(p) {
  const start = await fetch(p.adres + '/auth/login?terug=%2Fmail%2F', { redirect: 'manual' });
  assert.equal(start.status, 302);
  const naar = start.headers.get('location');
  const params = p.entra.onthoud(naar);
  const loginCookie = cookiesUit(start).find((c) => c.startsWith('__Host-dkt_login='));
  assert.ok(loginCookie, 'login-cookie gezet');

  const terug = await fetch(`${p.adres}/auth/callback?code=c&state=${encodeURIComponent(params.get('state'))}`, {
    redirect: 'manual', headers: { cookie: loginCookie.split(';')[0] },
  });
  return terug;
}

async function ingelogd(p) {
  const terug = await logIn(p);
  assert.equal(terug.status, 302);
  const sessie = cookiesUit(terug).find((c) => c.startsWith('__Host-dkt_sessie='));
  return sessie.split(';')[0];
}

let p;
before(async () => { p = await bouw(); });
after(async () => { await sluit(p.server); ruimOp(); });

test('zonder sessie: pagina\'s sturen naar de login, POST en /auth/check geven 401', async () => {
  for (const pad of ['/', '/facturen/', '/facturen/instellingen', '/mail/', '/mail/regels', '/mail/instellingen']) {
    const antwoord = await fetch(p.adres + pad, { redirect: 'manual' });
    assert.equal(antwoord.status, 302, pad);
    assert.equal(antwoord.headers.get('location'), '/auth/login?' + new URLSearchParams({ terug: pad }), pad);
  }
  const post = await fetch(p.adres + '/mail/sorteer', { method: 'POST', redirect: 'manual', headers: { 'sec-fetch-site': 'same-origin' } });
  assert.equal(post.status, 401);
  const check = await fetch(p.adres + '/auth/check');
  assert.equal(check.status, 401);
  assert.equal(check.headers.get('x-portal-user'), null);
});

test('/auth/login stuurt naar Microsoft met een browsergebonden state', async () => {
  const antwoord = await fetch(p.adres + '/auth/login', { redirect: 'manual' });
  assert.equal(antwoord.status, 302);
  assert.ok(antwoord.headers.get('location').startsWith(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize?`));
  const cookie = cookiesUit(antwoord).find((c) => c.startsWith('__Host-dkt_login='));
  for (const deel of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) assert.ok(cookie.includes(deel), deel);
});

test('een geldige login geeft een sessie met het juiste cookie en stuurt terug', async () => {
  const terug = await logIn(p);
  assert.equal(terug.status, 302);
  assert.equal(terug.headers.get('location'), '/mail/');
  const cookies = cookiesUit(terug);
  const sessie = cookies.find((c) => c.startsWith('__Host-dkt_sessie='));
  for (const deel of ['Secure', 'HttpOnly', 'SameSite=Lax', 'Path=/', 'Max-Age=28800']) assert.ok(sessie.includes(deel), deel);
  assert.ok(cookies.some((c) => c.startsWith('__Host-dkt_login=;') && c.includes('Max-Age=0')), 'login-cookie gewist');
});

test('/auth/check geeft 200 met X-Portal-User bij een geldige sessie', async () => {
  const cookie = await ingelogd(p);
  const check = await fetch(p.adres + '/auth/check', { headers: { cookie } });
  assert.equal(check.status, 200);
  assert.equal(check.headers.get('x-portal-user'), 'bob@dekoningtegelwerken.nl');
  const onzin = await fetch(p.adres + '/auth/check', { headers: { cookie: '__Host-dkt_sessie=verzonnen' } });
  assert.equal(onzin.status, 401);
});

test('een foute token of een account buiten de allowlist komt er niet in', async () => {
  p.entra.idToken = (nonce) => tekenJwt(claims({ nonce, aud: 'iets-anders' }), p.entra.privateKey);
  const fout = await logIn(p);
  assert.equal(fout.status, 400);
  assert.ok(!cookiesUit(fout).some((c) => c.startsWith('__Host-dkt_sessie=')), 'geen sessie');
  assert.match(await fout.text(), /Inloggen mislukt/);

  p.entra.idToken = (nonce) => tekenJwt(claims({ nonce, preferred_username: 'vreemde@dekoningtegelwerken.nl' }), p.entra.privateKey);
  const geenToegang = await logIn(p);
  assert.equal(geenToegang.status, 403);
  assert.match(await geenToegang.text(), /Geen toegang/);

  p.entra.idToken = (nonce) => tekenJwt(claims({ nonce }), p.entra.privateKey);
});

test('een callback zonder login-cookie wordt geweigerd', async () => {
  const start = await fetch(p.adres + '/auth/login', { redirect: 'manual' });
  const params = p.entra.onthoud(start.headers.get('location'));
  const terug = await fetch(`${p.adres}/auth/callback?code=c&state=${params.get('state')}`, { redirect: 'manual' });
  assert.equal(terug.status, 400);
});

test('met sessie geven alle pagina\'s 200, met noindex, CSP en een CSRF-veld in elk formulier', async () => {
  const cookie = await ingelogd(p);
  const factuur = voegFactuurToe(p.opslag, { message_id: 'portaal-1', attachment_id: 'a1' });
  const paden = ['/', '/facturen/', '/facturen/?filter=alle', '/facturen/instellingen', `/facturen/factuur/${factuur.id}`,
    '/mail/', '/mail/?map=Klanten+%26+projecten&bron=ai', '/mail/regels', '/mail/instellingen'];
  for (const pad of paden) {
    const antwoord = await fetch(p.adres + pad, { headers: { cookie }, redirect: 'manual' });
    assert.equal(antwoord.status, 200, pad);
    assert.match(antwoord.headers.get('x-robots-tag'), /noindex/, pad);
    assert.match(antwoord.headers.get('content-security-policy'), /default-src 'none'/, pad);
    const html = await antwoord.text();
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, pad + ': één h1');
    assert.ok(!/\sstyle="/.test(html), pad + ': geen style-attribuut');
    assert.ok(!/<script(?![^>]*\ssrc=)/.test(html), pad + ': geen inline script');
    assert.match(html, /bob@dekoningtegelwerken\.nl|Bob Schol/, pad + ': naam van de gebruiker');
    assert.match(html, /action="\/auth\/logout"/, pad + ': uitloggen');
    const formulieren = html.match(/<form\b[^>]*method="post"[^>]*>/g) || [];
    const metToken = html.match(/<form\b[^>]*method="post"[^>]*><input type="hidden" name="_csrf" value="[^"]+">/g) || [];
    assert.equal(metToken.length, formulieren.length, pad + ': elk POST-formulier heeft _csrf');
    assert.match(html, /href="\/dashboard\.css"/, pad);
  }
});

test('het dashboard toont de KPI-kaarten, mail, de sidebar en de link naar Offertes', async () => {
  const cookie = await ingelogd(p);
  const html = await (await fetch(p.adres + '/', { headers: { cookie } })).text();
  for (const tekst of ['Openstaand', 'Verlopen', 'Betaald deze maand', 'Nog door te sturen', 'Te controleren', 'Actie vereist', 'Factuurbedrag per maand', 'Grootste leveranciers']) {
    assert.match(html, new RegExp(tekst), tekst);
  }
  assert.match(html, /gesorteerd vandaag/);
  assert.match(html, /href="https:\/\/de-koning-tegelwerken\.offerteknop\.nl\/offertes\/" rel="noopener noreferrer"/);
  assert.match(html, /<aside class="sidebar">/);
  assert.match(html, /<img src="\/logo\.svg" alt="De Koning Tegelwerken"/);
  assert.match(html, /profiel__naam">Bob Schol</);
  for (const naam of ['Dashboard', 'Facturen', 'Leveranciers', 'Mail', 'Instellingen']) assert.match(html, new RegExp(`<span>${naam}</span>`), naam);
  assert.equal((await fetch(p.adres + '/logo.svg')).status, 200);
});

test('leveranciers en de sortering van de lijst', async () => {
  const cookie = await ingelogd(p);
  voegFactuurToe(p.opslag, { message_id: 'lev-1', attachment_id: 'a1', leverancier: 'Aannemer Zuid', bedrag: 10 });
  voegFactuurToe(p.opslag, { message_id: 'lev-2', attachment_id: 'a1', leverancier: 'Zand & Grind', bedrag: 999 });
  const lev = await (await fetch(p.adres + '/facturen/leveranciers', { headers: { cookie } })).text();
  assert.match(lev, /Aannemer Zuid/);
  assert.match(lev, /Zand &amp; Grind/);
  assert.match(lev, /href="\/facturen\/\?filter=alle&amp;zoek=Zand\+%26\+Grind"/);

  const op = await (await fetch(p.adres + '/facturen/?filter=alle&sorteer=bedrag-af', { headers: { cookie } })).text();
  assert.ok(op.indexOf('Zand &amp; Grind') < op.indexOf('Aannemer Zuid'), 'hoogste bedrag eerst');
  const af = await (await fetch(p.adres + '/facturen/?filter=alle&sorteer=bedrag', { headers: { cookie } })).text();
  assert.ok(af.indexOf('Aannemer Zuid') < af.indexOf('Zand &amp; Grind'), 'laagste bedrag eerst');
  assert.match(op, /tabelkop__bedrag tabelkop--recht tabelkop--af/);

  const onzin = await fetch(p.adres + '/facturen/?sorteer=drop+table', { headers: { cookie } });
  assert.equal(onzin.status, 200);
});

test('een factuur als paneel: alleen de inhoud, met CSRF-velden en zonder sidebar', async () => {
  const cookie = await ingelogd(p);
  const factuur = voegFactuurToe(p.opslag, { message_id: 'paneel-1', attachment_id: 'a1' });
  const html = await (await fetch(`${p.adres}/facturen/factuur/${factuur.id}?deel=paneel`, { headers: { cookie } })).text();
  assert.ok(!html.includes('<!doctype html>'), 'geen hele pagina');
  assert.ok(!html.includes('class="sidebar"'));
  assert.match(html, /data-paneel-sluit/);
  assert.match(html, /name="_csrf" value="/);
  assert.match(html, /action="\/facturen\/factuur\/\d+\/betaald"[^>]*data-bevestig=/);
});

test('CSRF: zonder of met een fout token 403, van een andere site 403, met het juiste token door', async () => {
  const cookie = await ingelogd(p);
  const html = await (await fetch(p.adres + '/mail/regels', { headers: { cookie } })).text();
  const token = csrfUit(html);
  assert.ok(token);
  const post = (velden, site = 'same-origin') => fetch(p.adres + '/mail/regels', {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': site },
    body: new URLSearchParams(velden).toString(),
  });
  const regel = { soort: 'domein', waarde: 'groothandel.nl', map: 'Leveranciers' };

  assert.equal((await post(regel)).status, 403, 'zonder token');
  assert.equal((await post({ ...regel, _csrf: 'verzonnen' })).status, 403, 'fout token');
  assert.equal((await post({ ...regel, _csrf: token }, 'cross-site')).status, 403, 'andere site');
  assert.equal(p.sorteerOpslag.regels().length, 0, 'er is niets opgeslagen');

  const goed = await post({ ...regel, _csrf: token });
  assert.equal(goed.status, 303);
  assert.equal(p.sorteerOpslag.regels()[0].waarde, 'groothandel.nl');
  assert.equal(p.sorteerOpslag.regels()[0].door, 'bob@dekoningtegelwerken.nl');
});

test('CSRF geldt ook voor het factuurdashboard binnen het portaal', async () => {
  const cookie = await ingelogd(p);
  const factuur = voegFactuurToe(p.opslag, { message_id: 'portaal-csrf', attachment_id: 'a1' });
  const zonder = await fetch(`${p.adres}/facturen/factuur/${factuur.id}/negeren`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: '',
  });
  assert.equal(zonder.status, 403);
  assert.equal(p.opslag.factuur(factuur.id).status, 'open');

  const token = csrfUit(await (await fetch(`${p.adres}/facturen/factuur/${factuur.id}`, { headers: { cookie } })).text());
  const met = await fetch(`${p.adres}/facturen/factuur/${factuur.id}/negeren`, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ _csrf: token }).toString(),
  });
  assert.equal(met.status, 303);
  assert.equal(met.headers.get('location'), `/facturen/factuur/${factuur.id}?m=negeren`);
  assert.equal(p.opslag.factuur(factuur.id).status, 'genegeerd');
});

test('Terugzetten en Andere map vanuit het logboek werken via het portaal', async () => {
  const cookie = await ingelogd(p);
  const rij = p.sorteerOpslag.logLijst({}).find((r) => r.status === 'verplaatst');
  assert.ok(rij, 'de testmail is gesorteerd');
  const token = csrfUit(await (await fetch(p.adres + '/mail/', { headers: { cookie } })).text());
  const verstuur = (pad, velden = {}) => fetch(p.adres + pad, {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ _csrf: token, ...velden }).toString(),
  });

  const anders = await verstuur(`/mail/log/${rij.id}/verplaats`, { naar: 'Offerteaanvragen', altijd: 'adres' });
  assert.equal(anders.status, 303);
  assert.match(anders.headers.get('location'), /m=verplaatst-regel/);
  assert.equal(p.sorteerOpslag.regelVoor('jan@klant.nl').map, 'Offerteaanvragen');

  const terug = await verstuur(`/mail/log/${rij.id}/terug`);
  assert.equal(terug.status, 303);
  assert.equal(p.sorteerOpslag.logRegel(rij.id).huidige_map, 'Inbox');
  assert.equal(p.mail.verplaatst.at(-1).mapId, 'inbox');
});

test('instellingen van de sorteerder opslaan en verbindingen testen', async () => {
  const cookie = await ingelogd(p);
  const token = csrfUit(await (await fetch(p.adres + '/mail/instellingen', { headers: { cookie } })).text());
  const opslaan = await fetch(p.adres + '/mail/instellingen', {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({
      _csrf: token, sorteren: '1', sorteer_drempel: '0.8', website_afzenders: 'formulier@offerteknop.nl',
      sorteer_map_facturen: '1', sorteer_map_offerteaanvragen: '1', sorteer_map_klanten: '1', sorteer_map_leveranciers: '1',
    }).toString(),
  });
  assert.equal(opslaan.status, 303);
  const inst = instellingen.lees(p.opslag);
  assert.equal(inst.sorteerDrempel, 0.8);
  assert.deepEqual(inst.websiteAfzenders, ['formulier@offerteknop.nl']);
  assert.equal(inst.sorteerMappen['Nieuwsbrieven & reclame'], false, 'niet aangevinkt = uit');

  const test2 = await fetch(p.adres + '/mail/instellingen/test', {
    method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ _csrf: token }).toString(),
  });
  assert.equal(test2.status, 200);
  const html = await test2.text();
  assert.match(html, /Map Offerteaanvragen/);
  assert.match(html, /Map Facturen<\/strong> — <span class="ja">in orde/);
});

test('uitloggen: sessie weg en door naar de logout van Microsoft', async () => {
  const cookie = await ingelogd(p);
  const token = csrfUit(await (await fetch(p.adres + '/', { headers: { cookie } })).text());
  const zonder = await fetch(p.adres + '/auth/logout', {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' }, body: '',
  });
  assert.equal(zonder.status, 403, 'ook uitloggen vraagt het CSRF-token');

  const uit = await fetch(p.adres + '/auth/logout', {
    method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
    body: new URLSearchParams({ _csrf: token }).toString(),
  });
  assert.equal(uit.status, 303);
  assert.ok(uit.headers.get('location').startsWith(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/logout?`));
  assert.ok(cookiesUit(uit).some((c) => c.startsWith('__Host-dkt_sessie=;') && c.includes('Max-Age=0')));
  assert.equal((await fetch(p.adres + '/auth/check', { headers: { cookie } })).status, 401);

  const bevestiging = await fetch(p.adres + '/auth/uitgelogd');
  assert.equal(bevestiging.status, 200);
  assert.match(await bevestiging.text(), /Je bent uitgelogd/);
});

test('/graph/notify: geen login nodig, wel de juiste clientState', async () => {
  const notify = (clientState) => fetch(p.adres + '/graph/notify', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ value: [{ clientState, subscriptionId: 'sub-1' }] }),
  });
  assert.equal((await notify('fout')).status, 401);
  assert.equal((await notify(WEBHOOK_GEHEIM)).status, 202);
  const validatie = await fetch(p.adres + '/graph/notify?validationToken=abc', { method: 'POST' });
  assert.equal(validatie.status, 400, 'alleen tijdens het aanmaken van een subscription');
});

test('de webhook geeft het validationToken letterlijk terug tijdens het aanmaken', async () => {
  const eigen = await bouw();
  try {
    let antwoord;
    // Graph valideert de notificatie-URL terwijl het aanmaken nog loopt.
    eigen.mail.webhook.maak = async (o) => {
      antwoord = await fetch(eigen.adres + '/graph/notify?validationToken=' + encodeURIComponent('Token 123 & zo'), { method: 'POST' });
      return { id: 'sub-9', verlooptOp: o.verlooptOp };
    };
    await eigen.webhook.onderhoud();
    assert.equal(antwoord.status, 200);
    assert.equal(await antwoord.text(), 'Token 123 & zo');
    assert.match(antwoord.headers.get('content-type'), /^text\/plain/);
    assert.equal(eigen.webhook.status().id, 'sub-9');
  } finally {
    await sluit(eigen.server);
  }
});

test('middernacht in Amsterdam, voor "vandaag gesorteerd"', () => {
  assert.equal(middernachtAmsterdam(new Date('2026-10-09T15:00:00Z')), '2026-10-08T22:00:00Z');
  assert.equal(middernachtAmsterdam(new Date('2026-12-09T15:00:00Z')), '2026-12-08T23:00:00Z');
  assert.equal(middernachtAmsterdam(new Date('2026-10-09T22:30:00Z')), '2026-10-09T22:00:00Z');
});

// -- zonder SSO: Basic Auth ------------------------------------------------
test('zonder SSO-instellingen: Basic Auth, en POST vraagt ook dan een CSRF-token', async () => {
  const b = await bouw({ modus: 'basic' });
  try {
    const zonder = await fetch(b.adres + '/', { redirect: 'manual' });
    assert.equal(zonder.status, 401);
    assert.match(zonder.headers.get('www-authenticate'), /^Basic realm=/);

    const inlog = { authorization: 'Basic ' + Buffer.from('bob:test-wachtwoord').toString('base64') };
    for (const pad of ['/', '/facturen/', '/mail/', '/mail/regels', '/mail/instellingen']) {
      const antwoord = await fetch(b.adres + pad, { headers: inlog });
      assert.equal(antwoord.status, 200, pad);
      const html = await antwoord.text();
      assert.match(html, /lokaal · Basic Auth/, pad);
      assert.ok(!/action="\/auth\/logout"/.test(html), pad + ': geen uitlogknop bij Basic Auth');
    }

    const check = await fetch(b.adres + '/auth/check', { headers: inlog });
    assert.equal(check.status, 200);
    assert.equal(check.headers.get('x-portal-user'), 'bob');

    const token = csrfUit(await (await fetch(b.adres + '/mail/regels', { headers: inlog })).text());
    const post = (velden) => fetch(b.adres + '/mail/regels', {
      method: 'POST', redirect: 'manual',
      headers: { ...inlog, 'content-type': 'application/x-www-form-urlencoded', 'sec-fetch-site': 'same-origin' },
      body: new URLSearchParams(velden).toString(),
    });
    assert.equal((await post({ soort: 'adres', waarde: 'a@b.nl', map: 'Inbox' })).status, 403);
    assert.equal((await post({ soort: 'adres', waarde: 'a@b.nl', map: 'Inbox', _csrf: token })).status, 303);

    assert.equal((await fetch(b.adres + '/auth/login', { redirect: 'manual' })).headers.get('location'), '/');
    assert.equal((await fetch(b.adres + '/auth/callback?code=x&state=y')).status, 404);
  } finally {
    await sluit(b.server);
  }
});
