// Interactietest in een echte (headless) browser: menu, filters, details,
// voor/na-slider, vertrouwenselementen en placeholders.
//
//   CHROME=/pad/naar/chrome-headless-shell BASIS=http://127.0.0.1:8099 node test/interactie.mjs
//
// Gebruikt alleen de lokale server; gegevens voor de vertrouwens-test worden
// via Fetch-interceptie in de browser vervangen, data/site.json blijft onaangeroerd.

import { readFileSync } from 'node:fs';
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

controleer('sticky balk heeft een offerteknop van minstens 48 px', await b.evalueer(`document.querySelector('.stickycta__offerte').getBoundingClientRect().height >= 48`));
controleer('header mobiel: alleen logo en menuknop zichtbaar', await b.evalueer(`[...document.querySelectorAll('.kop__acties > *')].filter(e=>getComputedStyle(e).display!=='none').every(e=>e.matches('[data-menu-open]'))`));

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

// -- lichtbak op de projectpagina -------------------------------------------------
await b.open(BASIS + '/projecten/voorbeeldproject-badkamer-grootformaat/');
const aantalFotos = await b.evalueer(`document.querySelectorAll('[data-lichtbak]').length`);
if (aantalFotos) {
  await b.evalueer(`document.querySelector('[data-lichtbak]').click()`);
  await wacht(200);
  controleer('klik op galerijfoto opent de lichtbak', await b.evalueer(`document.querySelector('.lichtbak').open && document.querySelector('.lichtbak__beeld').src.endsWith('.webp')`));
  if (aantalFotos > 1) {
    await b.toets('ArrowRight', 'ArrowRight', 39);
    controleer('pijl rechts toont de volgende foto', (await b.evalueer(`document.querySelector('.lichtbak__teller').textContent`)) === '2 / ' + aantalFotos);
  }
  await b.toets('Escape', 'Escape', 27);
  await wacht(200);
  controleer('Escape sluit de lichtbak', await b.evalueer(`!document.querySelector('.lichtbak').open`));
}
await b.open(BASIS + '/');

// -- placeholders zonder gegevens -------------------------------------------------
controleer('vertrouwenselementen weg zonder data', await b.evalueer(`document.querySelector('[data-vertrouwen]').hidden`));
// Hangt af van placeholdersTonen in de echte site.json (preview: aan, live: uit).
if (JSON.parse(readFileSync(new URL('../data/site.json', import.meta.url), 'utf8')).placeholdersTonen !== false) {
  controleer('placeholders zichtbaar in preview', await b.evalueer(`document.querySelectorAll('.ph').length > 5`));
  controleer('reviews-placeholder staat er', await b.evalueer(`!!document.querySelector('[data-reviews-placeholder]')`));
} else {
  controleer('productiemodus: geen reviewsectie zonder reviews', await b.evalueer(`!document.querySelector('[data-reviews-sectie]')`));
}

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

// -- offertewizard (mobiel, 390 px) ---------------------------------------------
// site.json is hier nog onderschept met testgegevens (WhatsApp, telefoon), dus de
// handmatige verzendroute moet die kanalen tonen. Er is geen data-endpoint: er mag
// niets als "verstuurd" verschijnen.
await b.viewport(390, 844, true);
try { await b.evalueer(`sessionStorage.clear()`); } catch { /* andere origin */ }
await b.open(BASIS + '/offerte/');
await b.evalueer(`sessionStorage.removeItem('dk-offerte')`);
await b.open(BASIS + '/offerte/');
const zichtbareStap = `[...document.querySelectorAll('.wizard__stap')].findIndex(s=>!s.hidden)+1`;
const klikVolgende = async () => { await b.evalueer(`document.querySelector('[data-volgende]').click()`); await wacht(150); };
controleer('wizard start op stap 1 van 6', (await b.evalueer(zichtbareStap)) === 1 && (await b.evalueer(`document.querySelector('[data-wizard-stapnr]').textContent`)) === 'Stap 1 van 6');
controleer('keuzekaarten minstens 48 px hoog', await b.evalueer(`[...document.querySelectorAll('.keuze')].filter(k=>k.offsetParent).every(k=>k.getBoundingClientRect().height>=48)`));
controleer('wizard: Terug/Volgende vast onderin op mobiel', await b.evalueer(`getComputedStyle(document.querySelector('.wizard__nav')).position==='sticky'`));
await klikVolgende();
controleer('zonder keuze niet door naar stap 2', (await b.evalueer(zichtbareStap)) === 1 && (await b.evalueer(`document.querySelector('.wizard__stap:not([hidden]) [data-fout]').textContent.length>0`)));
await b.evalueer(`document.querySelector('input[name=ruimte][value=badkamer]').click()`);
controleer('badkamer kiezen toont vervolgvragen', await b.evalueer(`!document.querySelector('.wizard__verdieping[data-voor=badkamer]').hidden`));
await b.evalueer(`document.querySelector('input[name="extra-badkamer"][value="Inloopdouche"]').click()`);
await klikVolgende();
controleer('stap 2 toont alleen het maatblok van de badkamer', (await b.evalueer(zichtbareStap)) === 2 && (await b.evalueer(`[...document.querySelectorAll('.maatblok')].filter(m=>!m.hidden).map(m=>m.dataset.voor).join()`)) === 'badkamer');
await klikVolgende();
controleer('zonder oppervlak niet door', (await b.evalueer(zichtbareStap)) === 2);
await b.evalueer(`(()=>{const l=document.querySelector('[data-lengte=badkamer]'),br=document.querySelector('[data-breedte=badkamer]');l.value='2,5';br.value='3,2';l.dispatchEvent(new Event('input',{bubbles:true}));br.dispatchEvent(new Event('input',{bubbles:true}))})()`);
controleer('lengte × breedte vult het oppervlak', (await b.evalueer(`document.querySelector('[name="m2-badkamer"]').value`)) === '8');
await b.evalueer(`(()=>{const w=document.querySelector('[name="wand-badkamer"]');w.value='31';w.dispatchEvent(new Event('input',{bubbles:true}))})()`);
await klikVolgende();
await b.evalueer(`document.querySelector('input[name=tegels][value=ja]').click()`);
controleer('tegels "ja" toont formaat en tegelfoto', await b.evalueer(`!document.querySelector('[data-tegels-meer]').hidden && !document.querySelector('[data-tegels-foto]').hidden`));
await b.evalueer(`document.querySelector('input[name=formaat][value="60 × 120 cm"]').click()`);
await klikVolgende();
controleer('stap 4: knop heet Overslaan zonder foto', (await b.evalueer(`document.querySelector('[data-volgende]').textContent.trim()`)) === 'Overslaan');
// foto toevoegen via het protocol (zoals een echte bestandskeuze)
const { root } = await b.s('DOM.getDocument', { depth: -1 });
const { nodeId } = await b.s('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-upload="fotos"] [data-upload-invoer]:not([capture])' });
await b.s('DOM.setFileInputFiles', { nodeId, files: [new URL('../assets/beelden/detail-voeg-480.webp', import.meta.url).pathname] });
await wacht(600);
controleer('foto-upload toont een miniatuur', await b.evalueer(`(document.querySelector('[data-upload="fotos"] .upload__item img')?.src||'').startsWith('data:image/jpeg')`));
controleer('stap 4: knop heet Volgende met foto', (await b.evalueer(`document.querySelector('[data-volgende]').textContent.trim()`)) === 'Volgende');
await klikVolgende();
await klikVolgende(); // plattegrond overslaan
controleer('stap 6 toont de verstuurknop', (await b.evalueer(zichtbareStap)) === 6 && await b.evalueer(`!document.querySelector('[data-verstuur]').hidden`));
await b.evalueer(`(()=>{const v={naam:'Test Persoon',telefoon:'0612345678',email:'test@example.nl',postcode:'1971ra'};for(const[k,w]of Object.entries(v)){const el=document.querySelector('[name='+k+']');el.value=w;el.dispatchEvent(new Event('input',{bubbles:true}))}const p=document.querySelector('[name=periode]');p.selectedIndex=2;p.dispatchEvent(new Event('change',{bubbles:true}))})()`);
await b.evalueer(`document.querySelector('[data-verstuur]').click()`);
await wacht(300);
controleer('zonder privacyvinkje niet versturen', await b.evalueer(`document.querySelector('[data-wizard-klaar]').hidden`));
await b.evalueer(`document.querySelector('[name=privacy]').click()`);
await b.evalueer(`document.querySelector('[data-verstuur]').click()`);
await wacht(600);
controleer('zonder backend: handmatige route, niets "verstuurd"', await b.evalueer(`!document.querySelector('[data-wizard-klaar]').hidden && document.querySelector('[data-klaar-verzonden]').hidden && !document.querySelector('[data-klaar-handmatig]').hidden`));
const svTekst = await b.evalueer(`document.querySelector('[data-wizard-klaar] .samenvatting').textContent`);
controleer('samenvatting: titel, maten, tegels en bijlagen', /Nieuwe aanvraag – Badkamer, 1971 RA/.test(svTekst) && /vloer ±8 m², wanden ±31 m² · Inloopdouche/.test(svTekst) && /60 × 120 cm · al aangeschaft/.test(svTekst) && /1 foto/.test(svTekst), svTekst.slice(0, 160));
controleer('WhatsApp-knop met vooraf ingevulde samenvatting', await b.evalueer(`(()=>{const a=document.querySelector('[data-stuur=whatsapp]');return !a.hidden && a.href.startsWith('https://wa.me/') && decodeURIComponent(a.href).includes('Nieuwe aanvraag')})()`));
controleer('wizard zonder horizontale overflow', await b.evalueer(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`));

if (b.fouten.length) { console.log('JS-fouten:\n  ' + [...new Set(b.fouten)].join('\n  ')); mislukt++; }
b.stop();
console.log(mislukt ? mislukt + ' controle(s) mislukt' : 'alle controles geslaagd');
process.exit(mislukt ? 1 : 0);
