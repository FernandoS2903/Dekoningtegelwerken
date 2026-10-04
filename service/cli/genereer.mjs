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
//       <!-- gen:wizard -->       de stappen van de offertewizard (data/wizard.json)
//       <!-- gen:beeld id=<id> [maat=<preset>] [klasse=a+b] [mobiel=<id>] [prioriteit] [donker] [sfeer] [label=Tekst_met_underscores] -->
//                                 één beeld uit data/beelden.json (of een placeholdervlak als het ontbreekt)
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

/** Fotoplaceholder: neutraal vlak met de beoogde foto-inhoud. */
function foto(beoogd, { klasse = '', label = 'Foto volgt', donker = false } = {}) {
  const k = ['foto', 'foto--ph', donker ? 'foto--donker' : '', klasse].filter(Boolean).join(' ');
  return `<div class="${k}"><div class="foto__vlak" role="img" aria-label="Placeholder, beoogde foto: ${esc(beoogd)}">`
    + `<span class="foto__label">${esc(label)}</span><span class="foto__beoogd">${esc(beoogd)}</span></div></div>`;
}

// -- beelden ----------------------------------------------------------------
// Sfeerbeelden uit data/beelden.json (AI-gegenereerd, soort: sfeerbeeld). Een
// beeld telt alleen als de WebP-varianten echt in assets/beelden/ staan; anders
// valt de generator terug op het placeholdervlak, zodat er nooit een 404 ontstaat.
const BEELDEN = Object.fromEntries(leesJson('data/beelden.json').beelden.map((b) => [b.id, b]));
const beeldPad = (id, w) => `/assets/beelden/${id}-${w}.webp`;
const beschikbaar = (id) => {
  const b = BEELDEN[id];
  return !!(b && b.afmeting && b.varianten?.length
    && b.varianten.every((w) => existsSync(path.join(ROOT, beeldPad(id, w).slice(1)))));
};

/** sizes per plek in de layout; houd ze gelijk met de breakpoints in css/site.css. */
const MATEN = {
  vol: '100vw',
  wrap: '(min-width: 90em) 84rem, calc(100vw - 2.5rem)',
  kaart: '(min-width: 60em) 55vw, (min-width: 40em) 50vw, 100vw',
  dienstkaart: '(min-width: 64em) 30vw, (min-width: 40em) 50vw, 100vw',
  half: '(min-width: 60em) 45vw, 100vw',
  galerij: '(min-width: 40em) 50vw, 100vw',
  kwart: '(min-width: 60em) 22vw, (min-width: 40em) 50vw, 100vw',
};

function srcset(b) {
  return b.varianten.map((w) => `${beeldPad(b.id, w)} ${w}w`).join(', ');
}

/** Hoogte van een variant, afgeleid van de echte afmeting van het bronbeeld. */
const hoogteBij = (b, w) => Math.round((w * b.afmeting.hoogte) / b.afmeting.breedte);

/**
 * Eén beeld als <img> met srcset/sizes in een .foto-container, of een
 * placeholdervlak als het beeld (nog) niet bestaat. Met mobiel wordt het een
 * <picture> met een eigen uitsnede onder 40em (art direction).
 */
function beeld(id, { maat = 'vol', klasse = '', prioriteit = false, mobiel = null, donker = false, sfeer = false, label = 'Foto volgt' } = {}) {
  const b = BEELDEN[id];
  if (!beschikbaar(id)) {
    const beoogd = b ? b.alt.replace(/^Sfeerbeeld[^:]*:\s*/, '') : id;
    return foto(beoogd.charAt(0).toUpperCase() + beoogd.slice(1), { klasse, label, donker });
  }
  const groot = b.varianten[b.varianten.length - 1];
  const standaard = b.varianten[Math.min(1, b.varianten.length - 1)];
  const laden = prioriteit ? 'fetchpriority="high" loading="eager"' : 'loading="lazy"';
  const k = ['foto', donker ? 'foto--donker' : '', sfeer ? 'foto--sfeer' : '', klasse].filter(Boolean).join(' ');
  let img;
  if (mobiel && beschikbaar(mobiel)) {
    const m = BEELDEN[mobiel];
    const mGroot = m.varianten[m.varianten.length - 1];
    img = `<picture><source media="(min-width: 40em)" srcset="${srcset(b)}" sizes="${MATEN[maat]}" width="${groot}" height="${hoogteBij(b, groot)}">`
      + `<img src="${beeldPad(m.id, m.varianten[Math.min(1, m.varianten.length - 1)])}" srcset="${srcset(m)}" sizes="100vw" width="${mGroot}" height="${hoogteBij(m, mGroot)}" alt="${esc(b.alt)}" ${laden} decoding="async"></picture>`;
  } else {
    img = `<img src="${beeldPad(id, standaard)}" srcset="${srcset(b)}" sizes="${MATEN[maat]}" width="${groot}" height="${hoogteBij(b, groot)}" alt="${esc(b.alt)}" ${laden} decoding="async">`;
  }
  return `<div class="${k}" data-soort="${esc(b.soort)}">${img}</div>`;
}

function beeldBlok(args) {
  const opties = {};
  for (const a of args) {
    const [k, v] = a.split('=');
    opties[k] = v === undefined ? true : v;
  }
  if (!opties.id) throw new Error('gen:beeld zonder id');
  return beeld(opties.id, {
    maat: opties.maat || 'vol',
    klasse: (opties.klasse || '').replace(/\+/g, ' '),
    prioriteit: !!opties.prioriteit,
    mobiel: opties.mobiel || null,
    donker: !!opties.donker,
    sfeer: !!opties.sfeer,
    label: (opties.label || 'Foto volgt').replace(/_/g, ' '),
  });
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
  const inhoud = beeld(p.kaartBeeld, { maat: 'kaart', sfeer: true, label: 'Projectfoto volgt' })
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
      + beeld(d.beeld, { maat: 'dienstkaart' })
      + `<h3>${esc(d.kaartTitel)} ${icoon('pijl')}</h3><p>${esc(d.kaartTekst)}</p></a></li>`;
  }).join('') + `</ul>`;
}

// -- offertewizard (plan stap 2) ---------------------------------------------
// Alle stappen staan als gewone HTML in de pagina; js/wizard.js toont er één
// tegelijk, regelt de vervolgvragen per ruimte (data-voor) en de uploads.
function wizardBlok() {
  const w = leesJson('data/wizard.json');
  const stap = (nr, kop, inhoud, hulp = '') => `<fieldset class="wizard__stap" data-stap="${nr}">`
    + `<legend class="wizard__legend"><span class="wizard__kop" tabindex="-1">${esc(kop)}</span></legend>`
    + (hulp ? `<p class="wizard__hulp">${hulp}</p>` : '') + inhoud + `<p class="wizard__fout" role="alert" data-fout></p></fieldset>`;
  const chip = (naam, waarde, label, type = 'checkbox') => `<label class="chip"><input type="${type}" name="${esc(naam)}" value="${esc(waarde)}"><span>${esc(label)}</span></label>`;
  const veld = (id, label, attrs, hint = '') => `<div class="veld"><label for="${id}">${label}</label>${hint ? `<span class="veld__hint" id="${id}-hint">${hint}</span>` : ''}<input id="${id}" ${attrs}${hint ? ` aria-describedby="${id}-hint"` : ''}></div>`;
  const upload = (naam, { accept, capture = false, meerdere = true, knoppen }) => `<div class="upload" data-upload="${naam}" data-accept="${accept}">`
    + `<div class="upload__knoppen">${knoppen.map(([label, ico, extra]) => `<label class="knop knop--lijn upload__knop">${icoon(ico)} ${esc(label)}<input class="visueel-verborgen" type="file" accept="${accept}"${meerdere ? ' multiple' : ''}${extra || ''} data-upload-invoer></label>`).join('')}</div>`
    + `<ul class="upload__lijst" role="list" data-upload-lijst></ul><p class="upload__status" aria-live="polite" data-upload-status></p></div>`;

  const s1 = `<div class="keuzekaarten">${w.ruimtes.map((r) => `<label class="keuze"><input type="checkbox" name="ruimte" value="${esc(r.id)}"><span class="keuze__label">${esc(r.label)}</span><span class="keuze__sub">${esc(r.omschrijving)}</span><span class="keuze__vink" aria-hidden="true">${icoon('vink')}</span></label>`).join('')}</div>`
    + w.ruimtes.map((r) => {
      if (r.vrij) return `<div class="wizard__verdieping" data-voor="${esc(r.id)}" hidden><label class="wizard__subvraag" for="anders-tekst">Wat wil je laten tegelen?</label><textarea id="anders-tekst" name="anders" rows="3" maxlength="600"></textarea></div>`;
      if (!r.extra?.length) return '';
      return `<div class="wizard__verdieping" data-voor="${esc(r.id)}" hidden><p class="wizard__subvraag">${esc(r.label)}: wat komt erbij? <span class="wizard__optioneel">(optioneel)</span></p><div class="chips">${r.extra.map((e) => chip(`extra-${r.id}`, e, e)).join('')}</div></div>`;
    }).join('');

  const s2 = w.ruimtes.filter((r) => !r.vrij).map((r) => `<div class="maatblok" data-voor="${esc(r.id)}" hidden>`
    + `<p class="maatblok__kop">${esc(r.label)}</p>`
    + `<div class="maatblok__velden">`
    + veld(`m2-${r.id}`, 'Vloer', `name="m2-${r.id}" type="text" inputmode="decimal" autocomplete="off" placeholder="bijv. 8" data-m2`, 'in m²')
    + (r.wand ? veld(`wand-${r.id}`, 'Wanden', `name="wand-${r.id}" type="text" inputmode="decimal" autocomplete="off" placeholder="als je het weet" data-m2`, 'in m², optioneel') : '')
    + `</div>`
    + `<details class="maatblok__reken"><summary>Reken uit met lengte × breedte</summary><div class="maatblok__velden">`
    + veld(`l-${r.id}`, 'Lengte', `type="text" inputmode="decimal" autocomplete="off" data-lengte="${esc(r.id)}"`, 'in meter')
    + veld(`b-${r.id}`, 'Breedte', `type="text" inputmode="decimal" autocomplete="off" data-breedte="${esc(r.id)}"`, 'in meter')
    + `</div></details>`
    + `<label class="vink"><input type="checkbox" name="onbekend-${r.id}" value="ja" data-onbekend><span>Weet ik nog niet</span></label>`
    + `</div>`).join('')
    + `<p class="wizard__tip">Weet je het niet precies? Geen probleem. In stap 5 kun je een plattegrond meesturen; dan rekenen wij het na.</p>`;

  const s3 = `<div class="keuzelijst">${w.tegelStatus.map(([k, l]) => `<label class="keuze keuze--rij"><input type="radio" name="tegels" value="${k}"><span class="keuze__label">${esc(l)}</span><span class="keuze__vink" aria-hidden="true">${icoon('vink')}</span></label>`).join('')}</div>`
    + `<div class="wizard__verdieping" data-tegels-meer hidden><p class="wizard__subvraag">Welk formaat of soort? <span class="wizard__optioneel">(optioneel, meerdere keuzes)</span></p><div class="chips">${w.tegelFormaten.map((f) => chip('formaat', f, f)).join('')}</div></div>`
    + `<div class="wizard__verdieping" data-tegels-foto hidden><p class="wizard__subvraag">Foto van de tegel <span class="wizard__optioneel">(optioneel)</span></p>${upload('tegelfoto', { accept: 'image/*', meerdere: false, knoppen: [['Foto toevoegen', 'camera']] })}</div>`;

  const s4 = upload('fotos', { accept: 'image/*', knoppen: [['Maak foto', 'camera', ' capture="environment"'], ['Kies uit foto\'s', 'foto']] })
    + `<div class="wizard__tips"><p>Handig om te laten zien:</p><ul role="list">${w.fotoTips.map((t) => `<li>${icoon('vink')}${esc(t)}</li>`).join('')}</ul></div>`;

  const s5 = upload('plattegrond', { accept: 'image/*,application/pdf', meerdere: false, knoppen: [['Plattegrond toevoegen', 'plattegrond']] })
    + `<p class="wizard__privacy">${icoon('afspraak')}<span>Je plattegrond gebruiken we alleen om deze aanvraag te beoordelen. Aanvragen waar geen opdracht uit volgt, verwijderen we na 12 maanden. Zie de <a href="/privacy/">privacyverklaring</a>.</span></p>`;

  const s6 = `<div class="velden">`
    + veld('naam', 'Naam', 'name="naam" type="text" autocomplete="name" required')
    + `<p class="wizard__hulp wizard__hulp--klein">Telefoon of e-mail is genoeg; allebei mag ook.</p>`
    + veld('telefoon', 'Telefoonnummer', 'name="telefoon" type="tel" autocomplete="tel" inputmode="tel"')
    + veld('email', 'E-mailadres', 'name="email" type="email" autocomplete="email" inputmode="email"')
    + veld('postcode', 'Postcode', 'name="postcode" type="text" autocomplete="postal-code" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="next" maxlength="7" placeholder="1234 AB" required')
    + `<div class="veld"><label for="periode">Wanneer wil je het laten uitvoeren?</label><select id="periode" name="periode" data-periode><option value="">Kies een periode</option><option>Zo snel mogelijk</option><option>Nog niet bekend</option></select></div>`
    + `<div class="veld"><label for="toelichting">Toelichting <span class="wizard__optioneel">(optioneel)</span></label><textarea id="toelichting" name="toelichting" rows="3" maxlength="1500"></textarea></div>`
    + `</div><label class="vink vink--privacy"><input type="checkbox" name="privacy" value="ja" required><span>Ik ga akkoord met de <a href="/privacy/">privacyverklaring</a>.</span></label>`
    + `<input class="wizard__honing" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">`;

  return `<form class="wizard" data-wizard data-max-fotos="${Number(w.maxFotos) || 12}" novalidate>
  <div class="wizard__voortgang"><p class="wizard__stapnr" aria-live="polite" data-wizard-stapnr>Stap 1 van 6</p><div class="wizard__balk" aria-hidden="true"><span data-wizard-balk></span></div></div>
  ${stap(1, 'Wat wil je laten tegelen?', s1, 'Meerdere keuzes mogelijk.')}
  ${stap(2, 'Hoe groot is de ruimte?', s2, 'Een schatting is genoeg.')}
  ${stap(3, 'Heb je al tegels?', s3)}
  ${stap(4, 'Laat de huidige situatie zien.', s4, 'Met een paar foto\'s kunnen we veel beter inschatten wat er nodig is.')}
  ${stap(5, 'Heb je een plattegrond?', s5, 'Een foto, PDF of bouwtekening. Dit is optioneel.')}
  ${stap(6, 'Waar kunnen we je bereiken?', s6, 'Alleen wat we nodig hebben om contact op te nemen.')}
  <div class="wizard__nav">
    <button class="knop knop--lijn wizard__terug" type="button" data-terug>Terug</button>
    <button class="knop wizard__verder" type="button" data-volgende>Volgende ${icoon('pijl')}</button>
    <button class="knop wizard__verder" type="submit" data-verstuur hidden>Verstuur mijn aanvraag ${icoon('pijl')}</button>
  </div>
</form>`;
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
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<meta property="og:image" content="${SITE_URL}/assets/og-image.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Logo van De Koning Tegelwerken met de tekst Tegelwerk tot in detail, op een sfeerbeeld van een badkamer">
<script type="module" src="/js/site.js"></script>`;

function blok(naam, args, paginaPad) {
  switch (naam) {
    case 'head': return HEAD;
    case 'header': {
      const overHero = args.includes('over-hero');
      // Het logo is overal hetzelfde: het paarse origineel (besluit Bob, 4 okt 2026).
      let h = vul(PARTIALS.header, {
        kopKlasse: overHero ? ' kop--over-hero' : '',
      });
      // actieve pagina markeren; de Diensten-groep ook als je op een dienstpagina zit
      h = h.split(`href="${paginaPad}">`).join(`href="${paginaPad}" aria-current="page">`);
      if (dienstPerSlug[paginaPad.replace(/\//g, '')]) {
        h = h.replace('class="nav-groep"', 'class="nav-groep actief"');
        h = h.replace('<details class="mobielmenu__groep">', '<details class="mobielmenu__groep" open>');
      }
      return h;
    }
    case 'footer': return PARTIALS.footer;
    case 'werkwijze': return PARTIALS.werkwijze;
    case 'eind': return PARTIALS.eind;
    case 'dienstkaarten': return dienstkaartenBlok();
    case 'projecten': return projectenBlok(args);
    case 'beeld': return beeldBlok(args);
    case 'wizard': return wizardBlok();
    case 'voorna': {
      const o = Object.fromEntries(args.map((a) => a.split('=')));
      return voorNaSlider(o.voor, o.na);
    }
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
  // Galerij: 6–12 foto's, elk een link naar de grootste variant (zonder JS opent
  // de foto gewoon; met JS in een lichtbak, zie initLichtbak in js/site.js).
  const fotos = (p.fotos || []).slice(0, 12).map((id) => {
    const f = beeld(id, { maat: 'galerij', sfeer: true, label: 'Projectfoto volgt' });
    if (!beschikbaar(id)) return `<figure>${f}</figure>`;
    const b = BEELDEN[id];
    const groot = b.varianten[b.varianten.length - 1];
    return `<figure><a class="galerij__link" href="${beeldPad(id, groot)}" data-lichtbak aria-label="Foto groot bekijken">${f}</a></figure>`;
  }).join('');
  const details = (p.details || []).map(([kop, id]) => `<figure>${beeld(id, { maat: 'kwart', sfeer: true, label: 'Detailfoto volgt', klasse: 'foto--klein' })}<figcaption>${esc(kop)}</figcaption></figure>`).join('');
  const voorNa = p.voorBeeld ? `
  <section class="sectie sectie--compact" aria-labelledby="voorna-kop">
    <div class="wrap">
      <div class="subkop"><span class="eyebrow">Voor en na</span><h2 class="kop-3" id="voorna-kop">Van voorbereiding tot eindresultaat.</h2></div>
      ${voorNaSlider(p.voorBeeld, p.naBeeld)}
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
    plaats: [p.plaats, p.type].filter(Boolean).map(tekstOfPh).join(' · '),
    voorbeeldmelding: p.placeholder
      ? `<p class="ph-blok"><strong>Voorbeeldpagina.</strong> Zo komt een project eruit te zien. Echte projectgegevens en foto's volgen via het project-CMS.</p>`
      : '',
    hero: beeld(p.heroBeeld, { maat: 'wrap', sfeer: true, prioriteit: true, label: 'Projectfoto volgt' }),
    omschrijvingHtml: (p.omschrijving || []).map((t) => (isPh(t) ? `<p class="ph-blok">${esc(t)}</p>` : `<p>${esc(t)}</p>`)).join(''),
    specs: [['Plaats', p.plaats], ...(p.info || [])].map(([k, w]) => `<div><dt>${esc(k)}</dt><dd>${tekstOfPh(w)}</dd></div>`).join(''),
    fotos,
    voorNa,
    details,
  });
}

/** Voor/na-slider; de toelichting zegt eerlijk dat het (nog) sfeerbeelden zijn. */
function voorNaSlider(voor, na) {
  const sfeer = beschikbaar(voor) || beschikbaar(na);
  return `<div class="voorna" data-voorna>
        <div class="voorna__voor">${beeld(voor, { maat: 'wrap', label: 'Voor' })}</div>
        <div class="voorna__na">${beeld(na, { maat: 'wrap', label: 'Na', donker: true })}</div>
        <span class="voorna__label voorna__label--voor" aria-hidden="true">Voor</span>
        <span class="voorna__label voorna__label--na" aria-hidden="true">Na</span>
        <input class="voorna__invoer visueel-verborgen" type="range" min="0" max="100" value="50" step="1" aria-label="Schuif tussen voor en na">
        <span class="voorna__lijn" aria-hidden="true"></span>
        <span class="voorna__greep" aria-hidden="true">${icoon('schuif')}</span>
      </div>
      <p class="voorna__toelichting">${sfeer
    ? 'Sfeerbeelden ter illustratie, geen werk van De Koning Tegelwerken. Hier komt een echte badkamer- of toiletrenovatie.'
    : 'Voorbeeld met placeholders. Hier komt een echte badkamer- of toiletrenovatie van De Koning.'}</p>`;
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
    hero: beeld(d.beeld, { maat: 'half', prioriteit: true }),
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
