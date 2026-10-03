// Interactietest in een echte (headless) browser: menu, filters, details,
// voor/na-slider, vertrouwenselementen en placeholders.
//
//   CHROME=/pad/naar/chrome-headless-shell BASIS=http://127.0.0.1:8099 node test/interactie.mjs
//
// Gebruikt alleen de lokale server; gegevens voor de vertrouwens-test worden
// via Fetch-interceptie in de browser vervangen, data/site.json blijft onaangeroerd.

import { startBrowser, wacht } from './cdp.mjs';

const BASIS = process.env.BASIS || 'http://127.0.0.1:8099';
const b = await startBrowser(process.env.CHROME);
let mislukt = 0;
const controleer = (naam, ok, extra = '') => {
  console.log((ok ? 'ok    ' : 'FOUT  ') + naam + (extra ? '  (' + extra + ')' : ''));
  if (!ok) mislukt++;
};

// -- mobiel: menu en sticky CTA ----------------------------------------------
await b.viewport(360, 780, true);
await b.open(BASIS + '/');
controleer('menu is dicht bij laden', await b.evalueer(`document.getElementById('mobielmenu').hidden`));
await b.evalueer(`document.querySelector('[data-menu-open]').click()`);
controleer('menu opent', await b.evalueer(`!document.getElementById('mobielmenu').hidden && document.querySelector('[data-menu-open]').getAttribute('aria-expanded')==='true'`));
controleer('focus staat in het menu', await b.evalueer(`document.getElementById('mobielmenu').contains(document.activeElement)`));
await b.toets('Escape', 'Escape', 27);
controleer('Escape sluit het menu', await b.evalueer(`document.getElementById('mobielmenu').hidden`));
controleer('sticky CTA verborgen in de hero', await b.evalueer(`!document.querySelector('[data-stickycta]').classList.contains('zichtbaar')`));
await b.evalueer(`scrollTo({top:1200,behavior:'instant'})`);
await wacht(300);
controleer('sticky CTA zichtbaar na de hero', await b.evalueer(`document.querySelector('[data-stickycta]').classList.contains('zichtbaar')`));

// -- filters -------------------------------------------------------------------
const zichtbaar = `[...document.querySelectorAll('[data-projectgrid] .projectkaart')].filter(k=>!k.hidden).length`;
const totaal = await b.evalueer(zichtbaar);
await b.evalueer(`document.querySelector('[data-filter="toilet"]').click()`);
const n = await b.evalueer(zichtbaar);
controleer('filter Toiletten toont alleen toiletkaarten', n >= 1 && n < totaal, n + ' van ' + totaal);
controleer('filterknop krijgt aria-pressed', await b.evalueer(`document.querySelector('[data-filter="toilet"]').getAttribute('aria-pressed')==='true'`));
controleer('asymmetrie opnieuw verdeeld', await b.evalueer(`[...document.querySelectorAll('[data-projectgrid] .projectkaart')].filter(k=>!k.hidden).every(k=>k.dataset.vorm)`));
await b.evalueer(`document.querySelector('[data-filter="alles"]').click()`);
controleer('Alles toont weer alles', (await b.evalueer(zichtbaar)) === totaal);

// -- details ---------------------------------------------------------------------
controleer('eerste detail open, rest dicht', await b.evalueer(`(()=>{const t=[...document.querySelectorAll('.details__tab')];return t[0].getAttribute('aria-expanded')==='true'&&t.slice(1).every(x=>document.getElementById(x.getAttribute('aria-controls')).hidden)})()`));
await b.evalueer(`document.querySelectorAll('.details__tab')[2].click()`);
controleer('klik opent Nissen en sluit verstek', await b.evalueer(`(()=>{const t=document.querySelectorAll('.details__tab');return t[2].getAttribute('aria-expanded')==='true'&&document.getElementById(t[0].getAttribute('aria-controls')).hidden})()`));

// -- voor/na ---------------------------------------------------------------------
await b.evalueer(`(()=>{const i=document.querySelector('.voorna__invoer');i.value='20';i.dispatchEvent(new Event('input'))})()`);
controleer('slider via invoer verschuift de lijn', (await b.evalueer(`document.querySelector('[data-voorna]').style.getPropertyValue('--pos')`)) === '20%');

// -- placeholders zonder gegevens -------------------------------------------------
controleer('vertrouwenselementen weg zonder data', await b.evalueer(`document.querySelector('[data-vertrouwen]').hidden`));
controleer('placeholders zichtbaar in preview', await b.evalueer(`document.querySelectorAll('.ph').length > 5`));
controleer('reviews-placeholder staat er', await b.evalueer(`!!document.querySelector('[data-reviews-placeholder]')`));

// -- met gegevens (onderschept, niet op schijf) -----------------------------------
await b.s('Fetch.enable', { patterns: [{ urlPattern: '*/data/site.json*' }] });
const nep = {
  placeholdersTonen: false,
  bedrijf: { naam: 'De Koning Tegelwerken', telefoon: '+31600000000', telefoonWeergave: '06 00 00 00 00', whatsapp: '+31600000000', email: 'test@example.invalid', werkgebied: '', kvk: '' },
  vertrouwen: { jarenErvaring: 7, googleScore: 4.8, googleAantalReviews: 10, regio: 'Testregio', googleProfielUrl: '' },
  whatsappTekst: 'Hallo De Koning Tegelwerken, ik heb een vraag over tegelwerk.',
  reviews: [],
};
b.opEvent('Fetch.requestPaused', (p) => b.s('Fetch.fulfillRequest', {
  requestId: p.requestId,
  responseCode: 200,
  responseHeaders: [{ name: 'content-type', value: 'application/json' }],
  body: Buffer.from(JSON.stringify(nep)).toString('base64'),
}));
await b.open(BASIS + '/');
await wacht(1500);
const tekst = await b.evalueer(`document.querySelector('[data-vertrouwen]').textContent`);
controleer('vertrouwenselementen gevuld', /\d\+ jaar/.test(tekst) && /Testregio/.test(tekst), tekst.replace(/\s+/g, ' ').trim());
controleer('Google-score met komma', /4,8 op Google/.test(tekst));
controleer('WhatsApp-link met vooraf ingevulde tekst', await b.evalueer(`document.querySelector('.kop__whatsapp').href.startsWith('https://wa.me/31600000000?text=Hallo')`));
controleer('telefoonlink gevuld', await b.evalueer(`document.querySelector('[data-veld="telefoon"]').getAttribute('href')==='tel:+31600000000'`));
controleer('lege velden weg in productiemodus', await b.evalueer(`!document.querySelector('[data-veld-blok="werkgebied"]') && !document.querySelector('[data-veld-blok="kvk"]')`));
controleer('reviewsectie weg zonder reviews in productiemodus', await b.evalueer(`!document.querySelector('[data-reviews-sectie]')`));
// Projectkaarten tellen niet mee: die placeholders komen uit data/projecten.json, niet uit site.json.
const resterend = `[...document.querySelectorAll('.ph')].filter(e=>!e.closest('[data-projectgrid]'))`;
controleer('geen site.json-placeholders meer in productiemodus', await b.evalueer(`${resterend}.length === 0`), String(await b.evalueer(`${resterend}.map(e=>e.textContent).join(', ')`)));

if (b.fouten.length) { console.log('JS-fouten:\n  ' + [...new Set(b.fouten)].join('\n  ')); mislukt++; }
b.stop();
console.log(mislukt ? mislukt + ' controle(s) mislukt' : 'alle controles geslaagd');
process.exit(mislukt ? 1 : 0);
