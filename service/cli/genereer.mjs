// Generator voor de statische site. Geen build-step: de uitvoer is gewone
// HTML die in de repo staat en zonder deze stap direct te serveren is. Dit
// script houdt alleen de gedeelde delen gelijk en maakt pagina's uit data.
//
//   node service/cli/genereer.mjs              alles (opnieuw) schrijven
//   node service/cli/genereer.mjs --controleer niets schrijven; exit 1 als de
//                                              bestanden niet bij de data passen
//
// Wat het doet:
//  1. projecten/<slug>/index.html uit _sjablonen/project.html + data/projecten.json
//     (alleen projecten met pagina: true)
//  2. <slug>/index.html uit _sjablonen/dienst.html + data/diensten.json
//  3. In elke .html-pagina de gemarkeerde gebieden vervangen:
//       <!-- gen:head -->         charset, viewport, fonts, css, script
//       <!-- gen:header [over-hero] -->  header + mobiel menu (_sjablonen/header.html)
//       <!-- gen:footer -->       footer + sticky CTA (_sjablonen/footer.html)
//       <!-- gen:werkwijze -->    tijdlijn (_sjablonen/werkwijze.html)
//       <!-- gen:eind -->         contact-CTA-sectie (_sjablonen/eind.html)
//       <!-- gen:dienstkaarten --> de zes specialismen als kaarten
//       <!-- gen:projecten uitgelicht|alle|categorie=<c> [filters] -->
//     Alles tussen <!-- gen:x --> en <!-- /gen:x --> wordt overschreven:
//     daar niet met de hand in werken.
//  4. sitemap.xml
//
// In stap 4 (beheer) schrijft dezelfde logica de projectfragmenten naar de
// generatiemap buiten de werkkopie; zie docs/PLAN.md §1.7.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SITE_URL = 'https://dekoningtegelwerken.nl';
const controleer = process.argv.includes('--controleer');

const lees = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const leesJson = (rel) => JSON.parse(lees(rel));

// Mappen die nooit pagina's bevatten.
const UITGESLOTEN = new Set(['.git', '_sjablonen', 'docs', 'deploy', 'service', 'test', 'node_modules', 'assets', 'css', 'js', 'data']);

// -- hulpjes ---------------------------------------------------------------
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Een tekst die helemaal tussen [ ] staat, is een placeholder. */
const isPh = (s) => /^\[[^\]]*\]$/.test(String(s ?? '').trim());
const tekstOfPh = (s) => (isPh(s) ? `<span class="ph">${esc(s)}</span>` : esc(s));

/** {{veld}} wordt ge-escaped ingevuld, {{{veld}}} rauw. */
function vul(sjabloon, waarden) {
  return sjabloon
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, k) => {
      if (!(k in waarden)) throw new Error('sjabloonveld ontbreekt: ' + k);
      return waarden[k];
    })
    .replace(/\{\{(\w+)\}\}/g, (_, k) => {
      if (!(k in waarden)) throw new Error('sjabloonveld ontbreekt: ' + k);
      return esc(waarden[k]);
    });
}

const icoon = (naam) => `<svg class="icoon" aria-hidden="true"><use href="/assets/iconen/iconen.svg#${naam}"/></svg>`;

/** Fotoplaceholder; wordt later een <picture> met dezelfde verhouding. */
function foto(beoogd, { klasse = '', label = 'Foto volgt', donker = false } = {}) {
  const k = ['foto', 'foto--ph', donker ? 'foto--donker' : '', klasse].filter(Boolean).join(' ');
  return `<div class="${k}"><div class="foto__vlak" role="img" aria-label="Placeholder, beoogde foto: ${esc(beoogd)}">`
    + `<span class="foto__label">${esc(label)}</span><span class="foto__beoogd">${esc(beoogd)}</span></div></div>`;
}

const FILTERS = [
  ['alles', 'Alles'], ['badkamer', 'Badkamers'], ['vloer', 'Vloeren'], ['toilet', 'Toiletten'],
  ['xxl', 'XXL'], ['visgraat', 'Visgraat'], ['natuursteen', 'Natuursteen'],
];

/** Vormen voor het asymmetrische grid; spiegelt vormen() in js/site.js. */
function vormen(aantal) {
  const cyclus = ['groot', 'staand', 'staand-hoog', 'groot-laag'];
  const uit = Array.from({ length: aantal }, (_, i) => cyclus[i % cyclus.length]);
  if (aantal % 2 === 1) uit[aantal - 1] = 'breed';
  return uit;
}

// -- data ------------------------------------------------------------------
const { projecten } = leesJson('data/projecten.json');
const { diensten } = leesJson('data/diensten.json');
const dienstPerSlug = Object.fromEntries(diensten.map((d) => [d.slug, d]));

// -- blokken ---------------------------------------------------------------
function projectkaart(p, vorm) {
  const meta = [p.plaats, p.type].filter(Boolean).map(tekstOfPh).join(' · ');
  const inhoud = foto(p.kaartBeoogd || p.hero || p.naam, { label: 'Projectfoto volgt' })
    + `<div class="projectkaart__info">`
    + (p.placeholder ? `<span class="projectkaart__badge">Voorbeeldkaart</span>` : '')
    + `<h3 class="projectkaart__naam">${tekstOfPh(p.naam)}</h3>`
    + `<p class="projectkaart__meta">${meta}</p></div>`;
  const binnen = p.pagina
    ? `<a class="projectkaart__link" href="/projecten/${esc(p.slug)}/">${inhoud}</a>`
    : `<div class="projectkaart__link">${inhoud}</div>`;
  return `<li class="projectkaart reveal" data-vorm="${vorm}" data-categorie="${esc(p.categorieen.join(' '))}">${binnen}</li>`;
}

function projectenBlok(args) {
  const filters = args.includes('filters');
  const cat = (args.find((a) => a.startsWith('categorie=')) || '').split('=')[1];
  let lijst = projecten;
  if (args.includes('uitgelicht')) lijst = projecten.filter((p) => p.uitgelicht).slice(0, 6);
  if (cat) lijst = projecten.filter((p) => p.categorieen.includes(cat)).slice(0, 4);

  if (!lijst.length) {
    return `<p class="ph-blok">Projecten in deze categorie volgen zodra er echte projectfoto's zijn.</p>`;
  }
  const v = vormen(lijst.length);
  let html = '';
  if (filters) {
    html += `<div class="filters" role="group" aria-label="Filter projecten op soort">`
      + FILTERS.map(([k, label], i) => `<button class="filter" type="button" data-filter="${k}" aria-pressed="${i === 0}">${label}</button>`).join('')
      + `</div><p class="filters-status visueel-verborgen" role="status" data-filter-status></p>`;
  }
  html += `<ul class="projectgrid" role="list" data-projectgrid>${lijst.map((p, i) => projectkaart(p, v[i])).join('')}</ul>`;
  return html;
}

function dienstkaartenBlok() {
  // De zes specialismen uit §6, in die volgorde.
  const volgorde = ['badkamer-tegelen', 'vloer-betegelen', 'grootformaat-tegels', 'toilet-betegelen', 'visgraat-tegels', 'natuursteen'];
  return `<ul class="dienstkaarten" role="list">` + volgorde.map((slug, i) => {
    const d = dienstPerSlug[slug];
    return `<li class="dienstkaart reveal" data-vertraging="${i % 3}"><a href="/${slug}/">`
      + foto(d.hero, { label: 'Foto volgt' })
      + `<h3>${esc(d.kaartTitel)} ${icoon('pijl')}</h3><p>${esc(d.kaartTekst)}</p></a></li>`;
  }).join('') + `</ul>`;
}

const PARTIALS = {
  header: lees('_sjablonen/header.html'),
  footer: lees('_sjablonen/footer.html'),
  werkwijze: lees('_sjablonen/werkwijze.html'),
  eind: lees('_sjablonen/eind.html'),
};

const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f3eee6">
<link rel="preload" href="/assets/fonts/instrument-serif-latin-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/manrope-latin-wght.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<script type="module" src="/js/site.js"></script>`;

function blok(naam, args, paginaPad) {
  switch (naam) {
    case 'head': return HEAD;
    case 'header': {
      let h = vul(PARTIALS.header, { kopKlasse: args.includes('over-hero') ? ' kop--over-hero' : '' });
      // actieve pagina markeren; de Diensten-groep ook als je op een dienstpagina zit
      h = h.split(`href="${paginaPad}">`).join(`href="${paginaPad}" aria-current="page">`);
      if (dienstPerSlug[paginaPad.replace(/\//g, '')]) {
        h = h.replace('class="nav-groep"', 'class="nav-groep actief"');
      }
      return h;
    }
    case 'footer': return PARTIALS.footer;
    case 'werkwijze': return PARTIALS.werkwijze;
    case 'eind': return PARTIALS.eind;
    case 'dienstkaarten': return dienstkaartenBlok();
    case 'projecten': return projectenBlok(args);
    default: throw new Error('onbekend gen-blok: ' + naam);
  }
}

const GEN_RE = /<!-- gen:([\w-]+)((?: [^\s>]+)*) -->[\s\S]*?<!-- \/gen:\1 -->/g;

function vervangBlokken(html, paginaPad) {
  return html.replace(GEN_RE, (_, naam, argStr) => {
    const args = argStr.trim().split(/\s+/).filter(Boolean);
    return `<!-- gen:${naam}${argStr} -->\n${blok(naam, args, paginaPad)}\n<!-- /gen:${naam} -->`;
  });
}

// -- pagina's uit sjablonen -------------------------------------------------
const jsonld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const kruimel = (items) => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([naam, pad], i) => ({ '@type': 'ListItem', position: i + 1, name: naam, item: SITE_URL + pad })),
});
const kruimelHtml = (items) => `<nav aria-label="Kruimelpad"><ol class="kruimels" role="list">`
  + items.map(([naam, pad], i) => (i === items.length - 1
    ? `<li><span aria-current="page">${esc(naam)}</span></li>`
    : `<li><a href="${pad}">${esc(naam)}</a></li>`)).join('') + `</ol></nav>`;

function projectPagina(p) {
  const pad = `/projecten/${p.slug}/`;
  const items = [['Home', '/'], ['Projecten', '/projecten/'], [p.naam, pad]];
  const na = (p.na || []).map((b) => `<figure>${foto(b, { label: 'Projectfoto volgt' })}</figure>`).join('');
  const details = (p.details || []).map(([kop, b]) => `<figure>${foto(b, { label: 'Detailfoto volgt', klasse: 'foto--klein' })}<figcaption>${esc(kop)}</figcaption></figure>`).join('');
  const voorNa = p.voor ? `
  <section class="sectie sectie--compact" aria-labelledby="voorna-kop">
    <div class="wrap">
      <div class="subkop"><span class="eyebrow">Voor en na</span><h2 class="kop-3" id="voorna-kop">Van voorbereiding tot eindresultaat.</h2></div>
      ${voorNaSlider(p.voor, p.voorNa || p.hero)}
    </div>
  </section>` : '';
  return vul(lees('_sjablonen/project.html'), {
    titel: `${p.naam}${isPh(p.plaats) ? '' : ' in ' + p.plaats} | De Koning Tegelwerken`,
    omschrijving: p.metaOmschrijving || p.naam,
    canonical: SITE_URL + pad,
    robots: p.placeholder ? '<meta name="robots" content="noindex">' : '',
    jsonld: jsonld({ '@context': 'https://schema.org', ...kruimel(items) }),
    kruimels: kruimelHtml(items),
    naam: p.naam,
    plaats: tekstOfPh(p.plaats),
    voorbeeldmelding: p.placeholder
      ? `<p class="ph-blok"><strong>Voorbeeldpagina.</strong> Zo komt een project eruit te zien. Echte projectgegevens en foto's volgen via het project-CMS.</p>`
      : '',
    hero: foto(p.hero, { label: 'Projectfoto volgt' }),
    omschrijvingHtml: (p.omschrijving || []).map((t) => (isPh(t) ? `<p class="ph-blok">${esc(t)}</p>` : `<p>${esc(t)}</p>`)).join(''),
    specs: (p.info || []).map(([k, w]) => `<div><dt>${esc(k)}</dt><dd>${tekstOfPh(w)}</dd></div>`).join(''),
    na,
    voorNa,
    details,
  });
}

function voorNaSlider(voor, na) {
  return `<div class="voorna" data-voorna>
        <div class="voorna__voor">${foto(voor, { label: 'Voor' })}</div>
        <div class="voorna__na">${foto(na, { label: 'Na', donker: true })}</div>
        <span class="voorna__label voorna__label--voor" aria-hidden="true">Voor</span>
        <span class="voorna__label voorna__label--na" aria-hidden="true">Na</span>
        <input class="voorna__invoer visueel-verborgen" type="range" min="0" max="100" value="50" step="1" aria-label="Schuif tussen voor en na">
        <span class="voorna__lijn" aria-hidden="true"></span>
        <span class="voorna__greep" aria-hidden="true">${icoon('schuif')}</span>
      </div>`;
}

function dienstPagina(d) {
  const pad = `/${d.slug}/`;
  const items = d.slug === 'tegelzetter'
    ? [['Home', '/'], [d.titel, pad]]
    : [['Home', '/'], ['Diensten', '/tegelzetter/'], [d.titel, pad]];
  const service = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Service',
        name: d.titel,
        serviceType: d.serviceType,
        description: d.intro,
        url: SITE_URL + pad,
        provider: { '@type': 'Organization', name: 'De Koning Tegelwerken', url: SITE_URL + '/' },
      },
      kruimel(items),
    ],
  };
  const dienstkaarten = d.toonDienstkaarten ? `
  <section class="sectie sectie--diep" aria-labelledby="diensten-kop">
    <div class="wrap">
      <div class="sectiekop"><span class="eyebrow">Specialismen</span><h2 id="diensten-kop">Voor ieder oppervlak de juiste afwerking.</h2></div>
      <!-- gen:dienstkaarten -->
      <!-- /gen:dienstkaarten -->
    </div>
  </section>` : '';
  const werkArgs = d.categorie ? `categorie=${d.categorie}` : 'uitgelicht';
  return vul(lees('_sjablonen/dienst.html'), {
    titel: d.metaTitel,
    omschrijving: d.metaOmschrijving,
    canonical: SITE_URL + pad,
    jsonld: jsonld(service),
    kruimels: kruimelHtml(items),
    eyebrow: d.eyebrow,
    h1: d.h1,
    intro: d.intro,
    hero: foto(d.hero),
    dienstkaarten,
    puntenKop: d.puntenKop,
    punten: d.punten.map(([kop, tekst], i) => `<li class="punt reveal" data-vertraging="${i % 2}"><h3>${esc(kop)}</h3><p>${esc(tekst)}</p></li>`).join(''),
    werkArgs,
    verwant: (d.verwant || []).map((s) => `<li><a href="/${s}/">${esc(dienstPerSlug[s].titel)}</a></li>`).join(''),
  });
}

// -- alle pagina's verzamelen ----------------------------------------------
const teSchrijven = new Map(); // relatief pad -> inhoud

for (const p of projecten.filter((x) => x.pagina)) {
  teSchrijven.set(`projecten/${p.slug}/index.html`, projectPagina(p));
}
for (const d of diensten) {
  teSchrijven.set(`${d.slug}/index.html`, dienstPagina(d));
}

function zoekHtml(map, rel = '') {
  for (const naam of readdirSync(map)) {
    const vol = path.join(map, naam);
    const r = rel ? rel + '/' + naam : naam;
    if (statSync(vol).isDirectory()) {
      if (!rel && UITGESLOTEN.has(naam)) continue;
      zoekHtml(vol, r);
    } else if (naam.endsWith('.html') && !teSchrijven.has(r)) {
      teSchrijven.set(r, readFileSync(vol, 'utf8'));
    }
  }
}
zoekHtml(ROOT);

const paginaPad = (rel) => (rel === 'index.html' ? '/' : rel.endsWith('/index.html') ? '/' + rel.slice(0, -'index.html'.length) : '/' + rel);

for (const [rel, html] of teSchrijven) {
  teSchrijven.set(rel, vervangBlokken(html, paginaPad(rel)));
}

// -- sitemap ---------------------------------------------------------------
const indexeerbaar = [...teSchrijven.entries()]
  .filter(([rel, html]) => rel.endsWith('index.html') && !/name="robots" content="noindex/.test(html))
  .map(([rel]) => paginaPad(rel))
  .sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
teSchrijven.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexeerbaar.map((p) => `  <url><loc>${SITE_URL}${p}</loc></url>`).join('\n')}
</urlset>
`);

// -- schrijven of controleren ----------------------------------------------
let afwijkend = 0;
for (const [rel, inhoud] of teSchrijven) {
  const vol = path.join(ROOT, rel);
  const huidig = existsSync(vol) ? readFileSync(vol, 'utf8') : null;
  if (huidig === inhoud) continue;
  afwijkend++;
  if (controleer) {
    console.log('niet bijgewerkt: ' + rel);
  } else {
    mkdirSync(path.dirname(vol), { recursive: true });
    writeFileSync(vol, inhoud);
    console.log('geschreven: ' + rel);
  }
}
if (controleer && afwijkend) {
  console.error(afwijkend + ' bestand(en) wijken af; draai node service/cli/genereer.mjs');
  process.exit(1);
}
if (!afwijkend) console.log('alles is bijgewerkt (' + teSchrijven.size + ' bestanden gecontroleerd)');
