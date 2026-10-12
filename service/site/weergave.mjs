// De opmaak van de site als bibliotheek: dezelfde HTML voor de generator
// (service/cli/genereer.mjs, statische pagina's in de repo) en voor het
// portaal (service/facturen/site-projecten.mjs, projecten uit de database).
//
//   const w = maakWeergave({ root });
//   w.vervangBlokken(html, '/pad/')        alle <!-- gen:x -->-gebieden invullen
//   w.projectPagina(project)               een projectpagina uit _sjablonen/project.html
//   w.projectenBlok(args, { projecten })   een projectgrid (uitgelicht, alle, categorie=<c>)
//
// Een project is een gewoon object (zie projectPagina). Beelden zijn óf een
// id uit data/beelden.json (de sfeerbeelden in assets/beelden/), óf een
// object { url(breedte), varianten, breedte, hoogte, alt, soort } voor een
// foto uit het project-CMS. Ontbreekt een beeld, dan komt er een
// placeholdervlak, dus nooit een 404.
//
// In de statische pagina's staat het projectgrid tussen SSI-opdrachten
// (zie ssiProjecten): op de live site vult nginx het in met de projecten uit
// het CMS, zonder SSI (preview, lokaal) blijft de statische versie staan.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const SITE_URL = 'https://dekoningtegelwerken.nl';

export const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Een tekst die helemaal tussen [ ] staat, is een placeholder. */
export const isPh = (s) => /^\[[^\]]*\]$/.test(String(s ?? '').trim());
export const tekstOfPh = (s) => (isPh(s) ? `<span class="ph">${esc(s)}</span>` : esc(s));

/** {{veld}} wordt ge-escaped ingevuld, {{{veld}}} rauw. */
export function vul(sjabloon, waarden) {
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

export const icoon = (naam) => `<svg class="icoon" aria-hidden="true"><use href="/assets/iconen/iconen.svg#${naam}"/></svg>`;

/** Fotoplaceholder: neutraal vlak met de beoogde foto-inhoud. */
function foto(beoogd, { klasse = '', label = 'Foto volgt', donker = false } = {}) {
  const k = ['foto', 'foto--ph', donker ? 'foto--donker' : '', klasse].filter(Boolean).join(' ');
  return `<div class="${k}"><div class="foto__vlak" role="img" aria-label="Placeholder, beoogde foto: ${esc(beoogd)}">`
    + `<span class="foto__label">${esc(label)}</span><span class="foto__beoogd">${esc(beoogd)}</span></div></div>`;
}

/** sizes per plek in de layout; houd ze gelijk met de breakpoints in css/site.css. */
export const MATEN = {
  vol: '100vw',
  wrap: '(min-width: 90em) 84rem, calc(100vw - 2.5rem)',
  kaart: '(min-width: 60em) 55vw, (min-width: 40em) 50vw, 100vw',
  dienstkaart: '(min-width: 64em) 30vw, (min-width: 40em) 50vw, 100vw',
  half: '(min-width: 60em) 45vw, 100vw',
  galerij: '(min-width: 40em) 50vw, 100vw',
  kwart: '(min-width: 60em) 22vw, (min-width: 40em) 50vw, 100vw',
};

export const FILTERS = [
  ['alles', 'Alles'], ['badkamer', 'Badkamers'], ['vloer', 'Vloeren'], ['toilet', 'Toiletten'],
  ['xxl', 'XXL'], ['visgraat', 'Visgraat'], ['natuursteen', 'Natuursteen'],
];
export const CATEGORIEEN = FILTERS.slice(1).map(([k]) => k);

/** Vormen voor het asymmetrische grid; spiegelt vormen() in js/site.js. */
export function vormen(aantal) {
  const cyclus = ['groot', 'staand', 'staand-hoog', 'groot-laag'];
  const uit = Array.from({ length: aantal }, (_, i) => cyclus[i % cyclus.length]);
  if (aantal % 2 === 1) uit[aantal - 1] = 'breed';
  return uit;
}

/**
 * Het projectgrid in een statische pagina, met de SSI-opdrachten eromheen:
 * met SSI (live) haalt nginx het grid uit het CMS (/_fragment/projecten/...)
 * en valt bij een storing terug op het blok; zonder SSI is alles hier
 * commentaar behalve het statische grid zelf.
 */
export function ssiProjecten(args, statisch) {
  return `<!--# block name="projecten" -->${statisch}<!--# endblock -->`
    + `<!--# include virtual="/_fragment/projecten/${args.map(esc).join('/')}" stub="projecten" -->`;
}

const jsonld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, '\\u003c')}</script>`;
const kruimel = (items) => ({
  '@type': 'BreadcrumbList',
  itemListElement: items.map(([naam, pad], i) => ({ '@type': 'ListItem', position: i + 1, name: naam, item: SITE_URL + pad })),
});
const kruimelHtml = (items) => `<nav aria-label="Kruimelpad"><ol class="kruimels" role="list">`
  + items.map(([naam, pad], i) => (i === items.length - 1
    ? `<li><span aria-current="page">${esc(naam)}</span></li>`
    : `<li><a href="${pad}">${esc(naam)}</a></li>`)).join('') + `</ol></nav>`;

export const HEAD = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f3eee6">
<link rel="preload" href="/assets/fonts/fraunces-latin-opsz-wght.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/assets/fonts/inter-latin-wght.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/css/site.css">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
<meta property="og:image" content="${SITE_URL}/assets/og-image.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Logo van De Koning Tegelwerken met de tekst Tegelwerk tot in detail, op een sfeerbeeld van een badkamer">
<script type="module" src="/js/site.js"></script>`;

/**
 * @param {object} o
 * @param {string} o.root     map met _sjablonen/ en data/ (de repo of de kopie in /opt)
 * @param {boolean} o.ssi     projectgrids in statische pagina's met SSI omhullen
 * @param {Array}  o.projecten projecten voor de statische grids (standaard data/projecten.json)
 */
export function maakWeergave({ root, ssi = false, projecten = null } = {}) {
  const lees = (rel) => readFileSync(path.join(root, rel), 'utf8');
  const leesJson = (rel) => JSON.parse(lees(rel));

  // -- beelden ----------------------------------------------------------------
  // Sfeerbeelden uit data/beelden.json (AI-gegenereerd, soort: sfeerbeeld). Een
  // beeld telt alleen als de WebP-varianten echt in assets/beelden/ staan.
  const BEELDEN = Object.fromEntries(leesJson('data/beelden.json').beelden.map((b) => [b.id, b]));
  const beeldPad = (id, w) => `/assets/beelden/${id}-${w}.webp`;
  const beschikbaar = (id) => {
    const b = BEELDEN[id];
    return !!(b && b.afmeting && b.varianten?.length
      && b.varianten.every((w) => existsSync(path.join(root, beeldPad(id, w).slice(1)))));
  };

  /** Een beeld-id of CMS-foto als { url, varianten, breedte, hoogte, alt, soort }, of null. */
  function bron(b) {
    if (!b) return null;
    if (typeof b === 'object') return b.varianten?.length ? b : null;
    if (!beschikbaar(b)) return null;
    const m = BEELDEN[b];
    return { url: (w) => beeldPad(b, w), varianten: m.varianten, breedte: m.afmeting.breedte, hoogte: m.afmeting.hoogte, alt: m.alt, soort: m.soort };
  }
  /** De beschrijving op het placeholdervlak als het beeld er niet is. */
  function beoogdBij(b) {
    if (b && typeof b === 'object') return b.alt || 'Foto';
    const m = BEELDEN[b];
    const beoogd = m ? m.alt.replace(/^Sfeerbeeld[^:]*:\s*/, '') : String(b || 'Foto');
    return beoogd.charAt(0).toUpperCase() + beoogd.slice(1);
  }

  const srcset = (f) => f.varianten.map((w) => `${f.url(w)} ${w}w`).join(', ');
  /** Hoogte van een variant, afgeleid van de echte afmeting van het bronbeeld. */
  const hoogteBij = (f, w) => Math.round((w * f.hoogte) / f.breedte);

  /**
   * Eén beeld als <img> met srcset/sizes in een .foto-container, of een
   * placeholdervlak als het beeld (nog) niet bestaat. Met mobiel wordt het een
   * <picture> met een eigen uitsnede onder 40em (art direction). Het label
   * "Sfeerbeeld" (sfeer) komt alleen op beelden die echt een sfeerbeeld zijn.
   * Met laden: 'eager' wordt het beeld direct geladen, zonder voorrang.
   */
  function beeld(b, { maat = 'vol', klasse = '', prioriteit = false, laden = 'lazy', mobiel = null, donker = false, sfeer = false, label = 'Foto volgt' } = {}) {
    const f = bron(b);
    if (!f) return foto(beoogdBij(b), { klasse, label, donker });
    const groot = f.varianten[f.varianten.length - 1];
    const standaard = f.varianten[Math.min(1, f.varianten.length - 1)];
    const laad = prioriteit ? 'fetchpriority="high" loading="eager"' : laden === 'eager' ? 'loading="eager"' : 'loading="lazy"';
    const k = ['foto', donker ? 'foto--donker' : '', sfeer && f.soort === 'sfeerbeeld' ? 'foto--sfeer' : '', klasse].filter(Boolean).join(' ');
    let img;
    const m = mobiel ? bron(mobiel) : null;
    if (m) {
      const mGroot = m.varianten[m.varianten.length - 1];
      img = `<picture><source media="(min-width: 40em)" srcset="${srcset(f)}" sizes="${MATEN[maat]}" width="${groot}" height="${hoogteBij(f, groot)}">`
        + `<img src="${m.url(m.varianten[Math.min(1, m.varianten.length - 1)])}" srcset="${srcset(m)}" sizes="100vw" width="${mGroot}" height="${hoogteBij(m, mGroot)}" alt="${esc(f.alt)}" ${laad} decoding="async"></picture>`;
    } else {
      img = `<img src="${f.url(standaard)}" srcset="${srcset(f)}" sizes="${MATEN[maat]}" width="${groot}" height="${hoogteBij(f, groot)}" alt="${esc(f.alt)}" ${laad} decoding="async">`;
    }
    return `<div class="${k}" data-soort="${esc(f.soort)}">${img}</div>`;
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

  // -- data ------------------------------------------------------------------
  const statischeProjecten = projecten || leesJson('data/projecten.json').projecten;
  const { diensten } = leesJson('data/diensten.json');
  const dienstPerSlug = Object.fromEntries(diensten.map((d) => [d.slug, d]));

  // -- blokken ---------------------------------------------------------------
  function projectkaart(p, vorm, { laden = 'lazy' } = {}) {
    const meta = [p.plaats, p.type].filter(Boolean).map(tekstOfPh).join(' · ');
    const inhoud = beeld(p.kaartBeeld, { maat: 'kaart', sfeer: true, laden, label: 'Projectfoto volgt' })
      + `<div class="projectkaart__info">`
      + (p.placeholder ? `<span class="projectkaart__badge">Voorbeeldkaart</span>` : '')
      + `<h3 class="projectkaart__naam">${tekstOfPh(p.naam)}</h3>`
      + `<p class="projectkaart__meta">${meta}</p></div>`;
    const binnen = p.pagina
      ? `<a class="projectkaart__link" href="/projecten/${esc(p.slug)}/">${inhoud}</a>`
      : `<div class="projectkaart__link">${inhoud}</div>`;
    return `<li class="projectkaart reveal" data-vorm="${vorm}" data-categorie="${esc(p.categorieen.join(' '))}">${binnen}</li>`;
  }

  /**
   * Het projectgrid voor een lijst projecten (in volgorde). args zoals in
   * <!-- gen:projecten ... -->: uitgelicht | alle | categorie=<c>, plus filters.
   * Op /projecten/ (alle) laadt de eerste kaart direct.
   */
  function projectenBlok(args, { projecten: lijstIn = statischeProjecten } = {}) {
    const filters = args.includes('filters');
    const cat = (args.find((a) => a.startsWith('categorie=')) || '').split('=')[1];
    let lijst = lijstIn;
    if (args.includes('uitgelicht')) lijst = lijstIn.filter((p) => p.uitgelicht).slice(0, 6);
    if (cat) lijst = lijstIn.filter((p) => p.categorieen.includes(cat)).slice(0, 4);

    if (!lijst.length) {
      return cat
        ? `<p class="ph-blok">Projecten in deze categorie volgen zodra er echte projectfoto's zijn.</p>`
        : `<p class="ph-blok">Hier komen binnenkort projecten van De Koning Tegelwerken.</p>`;
    }
    const v = vormen(lijst.length);
    const eersteDirect = args.includes('alle');
    let html = '';
    if (filters) {
      html += `<div class="filters" role="group" aria-label="Filter projecten op soort">`
        + FILTERS.map(([k, label], i) => `<button class="filter" type="button" data-filter="${k}" aria-pressed="${i === 0}">${label}</button>`).join('')
        + `</div><p class="filters-status visueel-verborgen" role="status" data-filter-status></p>`;
    }
    html += `<ul class="projectgrid" role="list" data-projectgrid>${lijst.map((p, i) => projectkaart(p, v[i], { laden: eersteDirect && i === 0 ? 'eager' : 'lazy' })).join('')}</ul>`;
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

  let partials = null;
  const PARTIALS = () => partials || (partials = {
    header: lees('_sjablonen/header.html'),
    footer: lees('_sjablonen/footer.html'),
    werkwijze: lees('_sjablonen/werkwijze.html'),
    eind: lees('_sjablonen/eind.html'),
  });

  // Extra gen-blokken die alleen de generator kent (de offertewizard).
  const extra = {};

  function blok(naam, args, paginaPad) {
    switch (naam) {
      case 'head': return HEAD;
      case 'header': {
        const overHero = args.includes('over-hero');
        // Het logo is overal hetzelfde: het paarse origineel (besluit Bob, 4 okt 2026).
        let h = vul(PARTIALS().header, {
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
      case 'footer': return PARTIALS().footer;
      case 'werkwijze': return PARTIALS().werkwijze;
      case 'eind': return PARTIALS().eind;
      case 'dienstkaarten': return dienstkaartenBlok();
      case 'projecten': {
        const html = projectenBlok(args);
        return ssi ? ssiProjecten(args, html) : html;
      }
      case 'beeld': return beeldBlok(args);
      case 'voorna': {
        const o = Object.fromEntries(args.map((a) => a.split('=')));
        return voorNaSlider(o.voor, o.na);
      }
      default:
        if (extra[naam]) return extra[naam](args, paginaPad);
        throw new Error('onbekend gen-blok: ' + naam);
    }
  }

  const GEN_RE = /<!-- gen:([\w-]+)((?: [^\s>]+)*) -->[\s\S]*?<!-- \/gen:\1 -->/g;

  function vervangBlokken(html, paginaPad) {
    return html.replace(GEN_RE, (_, naam, argStr) => {
      const args = argStr.trim().split(/\s+/).filter(Boolean);
      return `<!-- gen:${naam}${argStr} -->\n${blok(naam, args, paginaPad)}\n<!-- /gen:${naam} -->`;
    });
  }

  /**
   * Projectpagina. Velden van p: slug, naam, plaats, type, placeholder,
   * metaOmschrijving, lead (korte omschrijving onder de titel), omschrijving
   * (alinea's), info ([kop, waarde]), heroBeeld, fotos, details ([kop, beeld]),
   * voorBeeld, naBeeld. Met voorbeeldmelding (html) komt er een eigen melding
   * boven "Over dit project", bijvoorbeeld voor een preview.
   */
  function projectPagina(p, { voorbeeldmelding = null, noindex = false } = {}) {
    const pad = `/projecten/${p.slug}/`;
    const items = [['Home', '/'], ['Projecten', '/projecten/'], [p.naam, pad]];
    // Galerij: 6 tot 12 foto's, elk een link naar de grootste variant (zonder JS opent
    // de foto gewoon; met JS in een lichtbak, zie initLichtbak in js/site.js).
    const fotos = (p.fotos || []).slice(0, 12).map((id) => {
      const f = beeld(id, { maat: 'galerij', sfeer: true, label: 'Projectfoto volgt' });
      const b = bron(id);
      if (!b) return `<figure>${f}</figure>`;
      const groot = b.varianten[b.varianten.length - 1];
      return `<figure><a class="galerij__link" href="${b.url(groot)}" data-lichtbak aria-label="Foto groot bekijken">${f}</a></figure>`;
    }).join('');
    const details = (p.details || []).map(([kop, id]) => `<figure>${beeld(id, { maat: 'kwart', sfeer: true, label: 'Detailfoto volgt', klasse: 'foto--klein' })}<figcaption>${esc(kop)}</figcaption></figure>`).join('');
    const voorNa = p.voorBeeld ? `
  <section class="sectie sectie--compact" aria-labelledby="voorna-kop">
    <div class="wrap">
      <div class="subkop"><span class="eyebrow">Voor en na</span><h2 class="kop-3" id="voorna-kop">Van voorbereiding tot eindresultaat.</h2></div>
      ${voorNaSlider(p.voorBeeld, p.naBeeld)}
    </div>
  </section>` : '';
    const detailSectie = details ? `
  <section class="sectie sectie--compact" aria-labelledby="details-kop">
    <div class="wrap">
      <div class="subkop"><span class="eyebrow">In detail</span><h2 class="kop-3" id="details-kop">Hoeken, voegen en aansluitingen.</h2></div>
      <div class="galerij galerij--details">${details}</div>
    </div>
  </section>` : '';
    return vul(lees('_sjablonen/project.html'), {
      titel: `${p.naam}${isPh(p.plaats) || !p.plaats ? '' : ' in ' + p.plaats} | De Koning Tegelwerken`,
      omschrijving: p.metaOmschrijving || p.naam,
      canonical: SITE_URL + pad,
      robots: p.placeholder || noindex ? '<meta name="robots" content="noindex">' : '',
      jsonld: jsonld({ '@context': 'https://schema.org', ...kruimel(items) }),
      kruimels: kruimelHtml(items),
      naam: p.naam,
      plaats: [p.plaats, p.type].filter(Boolean).map(tekstOfPh).join(' · '),
      lead: p.lead ? `<p class="lead">${esc(p.lead)}</p>` : '',
      voorbeeldmelding: voorbeeldmelding ?? (p.placeholder
        ? `<p class="ph-blok"><strong>Voorbeeldpagina.</strong> Zo komt een project eruit te zien. Echte projectgegevens en foto's volgen via het project-CMS.</p>`
        : ''),
      hero: beeld(p.heroBeeld, { maat: 'wrap', sfeer: true, prioriteit: true, label: 'Projectfoto volgt' }),
      omschrijvingHtml: (p.omschrijving || []).map((t) => (isPh(t) ? `<p class="ph-blok">${esc(t)}</p>` : `<p>${esc(t)}</p>`)).join(''),
      specs: [['Plaats', p.plaats], ...(p.info || [])].filter(([, w]) => w).map(([k, w]) => `<div><dt>${esc(k)}</dt><dd>${tekstOfPh(w)}</dd></div>`).join(''),
      fotos,
      voorNa,
      detailSectie,
    });
  }

  /** Voor/na-slider; de toelichting zegt eerlijk wanneer het sfeerbeelden of placeholders zijn. */
  function voorNaSlider(voor, na) {
    const v = bron(voor);
    const n = bron(na);
    const sfeer = (v && v.soort === 'sfeerbeeld') || (n && n.soort === 'sfeerbeeld');
    const echt = v && n && !sfeer;
    return `<div class="voorna" data-voorna>
        <div class="voorna__voor">${beeld(voor, { maat: 'wrap', label: 'Voor' })}</div>
        <div class="voorna__na">${beeld(na, { maat: 'wrap', label: 'Na', donker: true })}</div>
        <span class="voorna__label voorna__label--voor" aria-hidden="true">Voor</span>
        <span class="voorna__label voorna__label--na" aria-hidden="true">Na</span>
        <input class="voorna__invoer visueel-verborgen" type="range" min="0" max="100" value="50" step="1" aria-label="Schuif tussen voor en na">
        <span class="voorna__lijn" aria-hidden="true"></span>
        <span class="voorna__greep" aria-hidden="true">${icoon('schuif')}</span>
      </div>${echt ? '' : `
      <p class="voorna__toelichting">${sfeer
    ? 'Sfeerbeelden ter illustratie, geen werk van De Koning Tegelwerken. Hier komt een echte badkamer- of toiletrenovatie.'
    : 'Voorbeeld met placeholders. Hier komt een echte badkamer- of toiletrenovatie van De Koning.'}</p>`}`;
  }

  /** Vervangt de og:image van de site door een projectfoto (alleen echte foto's). */
  function metOgBeeld(html, b) {
    const f = bron(b);
    if (!f || f.soort === 'sfeerbeeld') return html;
    const w = f.varianten.find((x) => x >= 1200) || f.varianten[f.varianten.length - 1];
    return html
      .replace(/<meta property="og:image" content="[^"]*">/, `<meta property="og:image" content="${SITE_URL}${esc(f.url(w))}">`)
      .replace(/<meta property="og:image:width" content="\d+">/, `<meta property="og:image:width" content="${w}">`)
      .replace(/<meta property="og:image:height" content="\d+">/, `<meta property="og:image:height" content="${hoogteBij(f, w)}">`)
      .replace(/<meta property="og:image:alt" content="[^"]*">/, `<meta property="og:image:alt" content="${esc(f.alt)}">`);
  }

  return {
    root, lees, leesJson, BEELDEN, beschikbaar, beeld, bron, voorNaSlider, projectkaart, projectenBlok,
    projectPagina, metOgBeeld, vervangBlokken, dienstPerSlug, diensten, statischeProjecten, extra,
    jsonld, kruimel, kruimelHtml,
  };
}
