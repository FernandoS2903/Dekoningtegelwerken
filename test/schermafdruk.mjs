// Visuele controle: schermafdrukken van hele pagina's op drie breedtes en een
// controle op horizontale overflow en JS-fouten.
//
//   CHROME=/pad/naar/chrome-headless-shell BASIS=http://127.0.0.1:8099 \
//     node test/schermafdruk.mjs [uitmap] [pad ...]
//
// Draai eerst een lokale server in de repo (python3 -m http.server 8099).
// Er wordt niets geïnstalleerd. Exit 1 bij overflow of JS-fouten.

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startBrowser, wacht } from './cdp.mjs';

const BASIS = process.env.BASIS || 'http://127.0.0.1:8099';
const [uit = '/tmp/schermafdrukken', ...paden] = process.argv.slice(2);
const PAGINAS = paden.length ? paden : ['/', '/projecten/', '/projecten/voorbeeldproject-badkamer-grootformaat/',
  '/badkamer-tegelen/', '/tegelzetter/', '/contact/', '/offerte/', '/privacy/', '/404.html'];
const BREEDTES = [{ naam: 'mobiel', w: 360, h: 780, mobiel: true }, { naam: 'mobiel390', w: 390, h: 844, mobiel: true }, { naam: 'mobiel430', w: 430, h: 932, mobiel: true }, { naam: 'tablet', w: 820, h: 1180, mobiel: true }, { naam: 'desktop', w: 1440, h: 900, mobiel: false }];

mkdirSync(uit, { recursive: true });
const b = await startBrowser(process.env.CHROME);

let overflow = 0;
for (const vp of BREEDTES) {
  await b.viewport(vp.w, vp.h, vp.mobiel);
  for (const pad of PAGINAS) {
    await b.open(BASIS + pad);
    // door de pagina scrollen (zonder smooth scroll) zodat reveals afgaan
    await b.evalueer(`(async()=>{for(let y=0;y<document.body.scrollHeight;y+=400){scrollTo({top:y,behavior:"instant"});await new Promise(r=>setTimeout(r,60))}scrollTo({top:0,behavior:"instant"})})()`);
    await wacht(1100);
    const r = await b.evalueer(`(()=>{const w=document.documentElement.clientWidth;const breed=[...document.querySelectorAll('body *')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&(r.right>w+1||r.left<-1)&&getComputedStyle(e).position!=='fixed'&&!e.closest('.visueel-verborgen,[hidden]')&&!(()=>{for(let p=e.parentElement;p&&p!==document.body;p=p.parentElement){if(/auto|scroll/.test(getComputedStyle(p).overflowX))return true}return false})()}).slice(0,5).map(e=>e.tagName.toLowerCase()+'.'+[...e.classList].join('.')+' '+Math.round(e.getBoundingClientRect().right));return{scroll:document.documentElement.scrollWidth,w,breed,hoogte:document.documentElement.scrollHeight}})()`);
    const naam = (pad === '/' ? 'home' : pad.replace(/^\/|\/$/g, '').replace(/[/.]/g, '_')) + '-' + vp.naam;
    // in stukken van ±1,5 viewport, zodat elke afdruk op ware grootte leesbaar is
    const stuk = Math.round(vp.h * 1.5);
    for (let y = 0, i = 0; y < Math.min(r.hoogte, 20000); y += stuk, i++) {
      const { data } = await b.s('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: vp.w, height: Math.min(stuk, r.hoogte - y), scale: 1 } });
      writeFileSync(path.join(uit, `${naam}-${i}.png`), Buffer.from(data, 'base64'));
    }
    const fout = r.scroll > r.w || r.breed.length > 0;
    if (fout) overflow++;
    console.log(`${fout ? 'OVERFLOW' : 'ok      '} ${vp.naam.padEnd(7)} ${pad}  (scrollWidth ${r.scroll} / ${r.w})${r.breed.length ? '  uitstekend: ' + r.breed.join(', ') : ''}`);
  }
}
if (b.fouten.length) console.log('JS-fouten:\n  ' + [...new Set(b.fouten)].join('\n  '));
b.stop();
process.exit(overflow || b.fouten.length ? 1 : 0);
