// Het raamwerk van de schermen: de pagina met sidebar, en de onderdelen die
// op meer dan één scherm terugkomen (kaarten, statuslabels, tabel, filters,
// grafiek).
//
// Alles komt als tekst uit de server. Geen inline styles en geen inline
// scripts: de dienst stuurt een strikte CSP mee. Dynamische breedtes gaan via
// data-deel (dashboard.js zet er een CSS-variabele van) en de grafiek is SVG
// met gewone attributen.

import { datumNl, datumTijdNl, escapeHtml as e, euro } from '../lib/hulp.mjs';
import { VERSIE } from './statisch.mjs';

export { e as escapeHtml };

// Het hoofdmenu in de sidebar. `onderdeel` is de naam waarmee een pagina
// zegt waar hij bij hoort.
export const HOOFDMENU = [
  { pad: '/', naam: 'Dashboard', onderdeel: 'Dashboard', icoon: 'dashboard' },
  { pad: '/facturen/', naam: 'Facturen', onderdeel: 'Facturen', icoon: 'facturen' },
  { pad: '/facturen/leveranciers', naam: 'Leveranciers', onderdeel: 'Leveranciers', icoon: 'leveranciers' },
  { pad: '/offertes/', naam: 'Offertes', onderdeel: 'Offertes', icoon: 'offertes' },
  { pad: '/mail/', naam: 'Mail', onderdeel: 'Mail', icoon: 'mail' },
  { pad: '/facturen/instellingen', naam: 'Instellingen', onderdeel: 'Instellingen', icoon: 'instellingen' },
];

// Oude naam, nog gebruikt door het losse dashboard (maakServer in de tests).
export const MENU = [
  { pad: '/', naam: 'Overzicht' },
  { pad: '/instellingen', naam: 'Instellingen' },
];

// Kleine, strakke iconen (24x24, lijn 1.5). Geen emoji.
const ICONEN = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  facturen: '<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  leveranciers: '<path d="M3 20h18"/><path d="M5 20V9l7-5 7 5v11"/><path d="M10 20v-6h4v6"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><path d="M3 7l9 6 9-6"/>',
  offertes: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h4"/><path d="M10 9.5h2"/>',
  instellingen: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sluit: '<path d="M6 6l12 12M18 6L6 18"/>',
  extern: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  zoek: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
  sync: '<path d="M20 12a8 8 0 0 1-14.5 4.6"/><path d="M4 12a8 8 0 0 1 14.5-4.6"/><path d="M4 18v-4h4"/><path d="M20 6v4h-4"/>',
};

export function icoon(naam, klasse = 'icoon') {
  return `<svg class="${klasse}" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${ICONEN[naam] || ''}</svg>`;
}

// `kader` is er binnen het portaal: {naam, email, modus, csrf}. Dan komen de
// sidebar en het gebruikersprofiel erbij, en krijgt elk POST-formulier het
// CSRF-token als verborgen veld. Zonder kader (het losse dashboard uit de
// tests) staat er een eenvoudige kop met `menu`.
//
// `subnav` zijn de tabbladen binnen een onderdeel (bijv. Logboek / Regels /
// Instellingen bij Mail); `kopActies` is wat rechts naast de paginatitel komt.
export function pagina({
  titel, basis = '', actief = '/', inhoud, meldingen = [], kader = null,
  menu = MENU, onderdeel = 'Facturen', subnav = null, kopActies = '', kopKlasse = '',
}) {
  const statisch = kader ? '' : basis;
  const sub = subnav || (!kader && menu.length ? menu.map((m) => ({ ...m, pad: basis + (m.pad === '/' ? '/' : m.pad), actief: m.pad === actief })) : null);

  const html = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${e(titel)} — ${e(onderdeel)} · De Koning Tegelwerken</title>
<link rel="stylesheet" href="${statisch}/dashboard.css?v=${VERSIE}">
<link rel="icon" href="${statisch}/logo.svg" type="image/svg+xml">
</head>
<body class="${kader ? 'met-sidebar' : 'los'}">
${kader ? sidebar(kader, onderdeel) : losseKop(onderdeel, statisch)}
<div class="inhoud">
<main id="inhoud">
<header class="paginakop${kopKlasse ? ' ' + kopKlasse : ''}">
  <div class="paginakop__titel"><h1>${e(titel)}</h1></div>
  ${kopActies ? `<div class="paginakop__acties">${kopActies}</div>` : ''}
</header>
${sub ? `<nav class="subnav" aria-label="${e(onderdeel)}">
  ${sub.map((m) => `<a href="${e(m.pad)}"${m.actief ? ' aria-current="page"' : ''}>${e(m.naam)}</a>`).join('\n  ')}
</nav>` : ''}
${meldingen.map(melding).join('\n')}
${inhoud}
</main>
<p class="voet">Intern ${kader ? 'portaal' : 'dashboard'} van De Koning Tegelwerken · Handsfree Digital</p>
</div>
<script src="${statisch}/dashboard.js?v=${VERSIE}" type="module"></script>
</body>
</html>
`;
  return kader ? metCsrf(html, kader.csrf) : html;
}

function initialen(naam) {
  const delen = String(naam || '').trim().split(/[\s@.]+/).filter(Boolean);
  return (delen.length >= 2 ? delen[0][0] + delen[1][0] : (delen[0] || '?').slice(0, 2)).toUpperCase();
}

// De sidebar: logo, hoofdmenu, en onderaan het profiel. Op mobiel wordt het
// een compacte balk met een menuknop; het menu zelf is een <details>, dus het
// werkt ook zonder JavaScript.
function sidebar(kader, onderdeel) {
  const items = HOOFDMENU.map((m) => `<a href="${m.pad}"${m.onderdeel === onderdeel ? ' aria-current="page"' : ''}>${icoon(m.icoon)}<span>${e(m.naam)}</span></a>`).join('\n      ');
  // Offerteknop zelf (eigen login) als externe link onder het menu.
  const offertes = kader.offertesUrl || kader.offertesOpen
    ? `<a class="sidebar__extern" href="${e(kader.offertesOpen || kader.offertesUrl)}" rel="noopener noreferrer" target="_blank">${icoon('extern')}<span>Offerteknop</span></a>`
    : '';
  const profiel = `<div class="profiel">
      <span class="profiel__initialen" aria-hidden="true">${e(initialen(kader.naam || kader.email))}</span>
      <span class="profiel__tekst">
        <span class="profiel__naam">${e(kader.naam || kader.email || '')}</span>
        <span class="profiel__sub">${kader.modus === 'sso' ? e(kader.email || '') : 'lokaal · Basic Auth'}</span>
      </span>
      ${kader.modus === 'sso'
    ? '<form method="post" action="/auth/logout"><button class="knop knop--rustig knop--klein" type="submit">Uitloggen</button></form>'
    : ''}
    </div>`;

  return `<a class="overslaan" href="#inhoud">Naar de inhoud</a>
<details class="mobielkop">
  <summary aria-label="Menu">
    <span class="mobielkop__logo"><img src="/logo.svg" alt="De Koning Tegelwerken" width="44" height="36"></span>
    <span class="mobielkop__titel">${e(onderdeel)}</span>
    <span class="mobielkop__knop">${icoon('menu', 'icoon icoon--menu')}${icoon('sluit', 'icoon icoon--sluit')}</span>
  </summary>
  <nav class="mobielmenu" aria-label="Hoofdmenu">
    ${items}
    ${offertes}
    ${profiel}
  </nav>
</details>
<aside class="sidebar">
  <a class="sidebar__logo" href="/"><img src="/logo.svg" alt="De Koning Tegelwerken" width="66" height="54"><span>Portaal</span></a>
  <nav class="sidebar__menu" aria-label="Hoofdmenu">
      ${items}
      ${offertes}
  </nav>
  <div class="sidebar__onder">
    ${profiel}
  </div>
</aside>
`;
}

function losseKop(onderdeel, statisch) {
  return `<header class="loskop">
  <div class="loskop__binnen">
    <img src="${statisch}/logo.svg" alt="De Koning Tegelwerken" width="44" height="36">
    <p class="loskop__naam">${e(onderdeel)} <span>De Koning Tegelwerken</span></p>
  </div>
</header>
`;
}

// Zet het CSRF-token als eerste veld in elk formulier met method="post".
export function metCsrf(html, token) {
  if (!token) return html;
  return html.replace(/<form\b[^>]*\bmethod="post"[^>]*>/gi,
    (tag) => `${tag}<input type="hidden" name="_csrf" value="${e(token)}">`);
}

export function melding({ soort = 'info', tekst }) {
  const klasse = soort === 'fout' ? ' melding--fout' : soort === 'goed' ? ' melding--goed' : '';
  const rol = soort === 'fout' ? ' role="alert"' : '';
  return `<div class="melding${klasse}"${rol}><p>${e(tekst)}</p></div>`;
}

// -- KPI-kaarten -----------------------------------------------------------
export function tegel({ naam, bedrag, bij, let: letOp = false, valuta = 'EUR', href = null, getal = null }) {
  const groot = getal !== null ? e(String(getal)) : (bedrag === null ? '—' : e(euro(bedrag, valuta)));
  const binnen = `<span class="tegel__naam">${e(naam)}</span>
  <span class="tegel__bedrag">${groot}</span>
  <span class="tegel__bij">${e(bij)}</span>`;
  return `<li class="tegel${letOp ? ' tegel--let' : ''}${href ? ' tegel--link' : ''}">
  ${href ? `<a href="${e(href)}">${binnen}</a>` : `<div>${binnen}</div>`}
</li>`;
}

// -- status ------------------------------------------------------------------
// Wat is de stand van deze factuur? Geeft {klasse, tekst} voor het labeltje.
export function stand(factuur, nu) {
  if (factuur.uitlees_status === 'mislukt') return { klasse: 'let', tekst: 'uitlezen mislukt' };
  if (factuur.status === 'genegeerd') return { klasse: 'genegeerd', tekst: 'genegeerd' };
  if (factuur.status === 'betaald') {
    return factuur.doorgestuurd_op
      ? { klasse: 'betaald', tekst: 'betaald · doorgestuurd' }
      : { klasse: 'betaald', tekst: 'betaald' };
  }
  if (factuur.vervaldatum && factuur.vervaldatum < nu) return { klasse: 'verlopen', tekst: 'verlopen' };
  return { klasse: 'open', tekst: 'open' };
}

export function vlag(factuur, nu) {
  const s = stand(factuur, nu);
  return `<span class="vlag vlag--${s.klasse}">${e(s.tekst)}</span>`;
}

export const factuurNaam = (f) => f.leverancier || f.afzender_naam || f.afzender_email || '(onbekende afzender)';

// -- de factuurlijst ---------------------------------------------------------
// Eén <ul>: op desktop als tabel (CSS grid), op mobiel als kaarten. De hele
// rij is één link; dashboard.js opent hem op desktop in het zijpaneel.
export const KOLOMMEN = [
  ['leverancier', 'Leverancier'],
  ['factuurnummer', 'Nummer', { sorteer: false }],
  ['datum', 'Datum'],
  ['vervaldatum', 'Vervalt'],
  ['bedrag', 'Bedrag', { recht: true }],
  ['status', 'Status'],
];

export function rij(factuur, basis, nu) {
  const sub = [];
  if (factuur.suggestie_betaling_id && factuur.status === 'open') sub.push('betaling gevonden');
  if (factuur.status === 'betaald' && !factuur.doorgestuurd_op) sub.push('nog doorsturen');
  if (factuur.uitlees_status === 'pending') sub.push('nog niet uitgelezen');
  const s = stand(factuur, nu);
  return `<li><a class="rij" href="${basis}/factuur/${factuur.id}" data-factuur="${factuur.id}">
  <span class="rij__naam"><span>${e(factuurNaam(factuur))}</span>${sub.length ? `<small>${e(sub.join(' · '))}</small>` : ''}</span>
  <span class="rij__nummer">${e(factuur.factuurnummer || '—')}</span>
  <span class="rij__datum"><small>datum</small>${e(datumNl(factuur.factuurdatum || factuur.ontvangen))}</span>
  <span class="rij__verval${s.klasse === 'verlopen' ? ' rij__verval--te-laat' : ''}"><small>vervalt</small>${e(datumNl(factuur.vervaldatum))}</span>
  <span class="rij__bedrag">${factuur.bedrag === null ? '—' : e(euro(factuur.bedrag, factuur.valuta))}</span>
  <span class="rij__status"><span class="vlag vlag--${s.klasse}">${e(s.tekst.replace('betaald · doorgestuurd', 'doorgestuurd'))}</span></span>
</a></li>`;
}

export function tabelKop(basis, { filter, zoek, sorteer }) {
  const link = (sleutel) => {
    const p = new URLSearchParams();
    if (filter && filter !== 'open') p.set('filter', filter);
    if (zoek) p.set('zoek', zoek);
    const nieuw = sorteer === sleutel ? sleutel + '-af' : sleutel;
    p.set('sorteer', nieuw);
    return `${basis}/?${p}`;
  };
  return `<li class="tabelkop" aria-hidden="true">
  ${KOLOMMEN.map(([sleutel, naam, o = {}]) => {
    const actief = sorteer === sleutel ? 'op' : sorteer === sleutel + '-af' ? 'af' : '';
    const klasse = `tabelkop__${sleutel}${o.recht ? ' tabelkop--recht' : ''}${actief ? ' tabelkop--' + actief : ''}`;
    return o.sorteer === false
      ? `<span class="${klasse}">${e(naam)}</span>`
      : `<a class="${klasse}" href="${link(sleutel)}">${e(naam)}<span class="tabelkop__pijl"></span></a>`;
  }).join('\n  ')}
</li>`;
}

export const FILTERS = [
  ['open', 'Open'],
  ['verlopen', 'Verlopen'],
  ['betaald', 'Betaald'],
  ['doorsturen', 'Nog doorsturen'],
  ['controle', 'Controle'],
  ['genegeerd', 'Genegeerd'],
  ['alle', 'Alle'],
];

export const SORTEER_KEUZES = [
  ['', 'Standaard (open eerst)'],
  ['vervaldatum', 'Vervaldatum ↑'], ['vervaldatum-af', 'Vervaldatum ↓'],
  ['datum-af', 'Datum nieuw → oud'], ['datum', 'Datum oud → nieuw'],
  ['bedrag-af', 'Bedrag hoog → laag'], ['bedrag', 'Bedrag laag → hoog'],
  ['leverancier', 'Leverancier A → Z'], ['leverancier-af', 'Leverancier Z → A'],
  ['status', 'Status'],
];

export function filterbalk(basis, actief, zoek, sorteer = '') {
  const link = (sleutel) => {
    const p = new URLSearchParams();
    if (sleutel !== 'open') p.set('filter', sleutel);
    if (zoek) p.set('zoek', zoek);
    if (sorteer) p.set('sorteer', sorteer);
    const vraag = p.toString();
    return `${basis}/${vraag ? '?' + vraag : ''}`;
  };
  return `<div class="werkbalk">
  <nav class="filters" aria-label="Filteren op status">
    ${FILTERS.map(([sleutel, naam]) => (
    `<a href="${link(sleutel)}"${sleutel === actief ? ' aria-current="true"' : ''}>${e(naam)}</a>`
  )).join('\n    ')}
  </nav>
  <form class="zoek" method="get" action="${basis}/" data-zoek>
    ${actief !== 'open' ? `<input type="hidden" name="filter" value="${e(actief)}">` : ''}
    <label class="verborgen" for="zoek">Zoeken</label>
    <span class="zoek__veld">${icoon('zoek')}<input type="search" id="zoek" name="zoek" value="${e(zoek || '')}" placeholder="Leverancier, nummer of onderwerp"></span>
    <label class="verborgen" for="sorteer">Sorteren</label>
    <select id="sorteer" name="sorteer" data-direct>
      ${SORTEER_KEUZES.map(([w, n]) => `<option value="${w}"${w === sorteer ? ' selected' : ''}>${e(n)}</option>`).join('')}
    </select>
    <button class="knop knop--rustig" type="submit">Toepassen</button>
  </form>
</div>`;
}

// -- grafiek ------------------------------------------------------------------
// Staafgrafiek van het factuurbedrag per maand, als SVG uit de server.
// Elke staaf is focusbaar en draagt zijn gegevens in data-attributen;
// dashboard.js maakt er een tooltip van. Negatieve maanden (creditnota's)
// worden onder de nullijn getekend.
export function maandGrafiek(maanden) {
  const breedte = 640;
  const hoogte = 200;
  const links = 56;
  const onder = 26;
  const boven = 12;
  const sommen = maanden.map((m) => Number(m.som) || 0);
  const max = Math.max(0, ...sommen);
  const min = Math.min(0, ...sommen);
  const bereik = (max - min) || 1;
  const vlak = hoogte - boven - onder;
  const y = (waarde) => boven + ((max - waarde) / bereik) * vlak;
  const staafBreedte = (breedte - links - 8) / maanden.length;

  const lijnen = (max > 0 ? [0.25, 0.5, 0.75, 1] : []).map((f) => {
    const waarde = max * f;
    return `<line class="raster" x1="${links}" y1="${y(waarde).toFixed(1)}" x2="${breedte - 4}" y2="${y(waarde).toFixed(1)}" />`;
  }).join('\n    ');

  const staven = maanden.map((m, i) => {
    const waarde = Number(m.som) || 0;
    const x = links + i * staafBreedte + staafBreedte * 0.18;
    const w = staafBreedte * 0.64;
    const top = y(Math.max(waarde, 0));
    const h = Math.max(waarde === 0 ? 0 : 1.5, Math.abs(y(waarde) - y(0)));
    const maandNaam = maandLabel(m.maand, true);
    return `<g class="staaf" tabindex="0" data-maand="${e(maandNaam)}" data-bedrag="${e(euro(waarde))}" data-aantal="${Number(m.aantal) || 0}" data-x="${Math.round(((x + w / 2) / breedte) * 1000) / 10}">
      <rect class="staaf__vlak" x="${(links + i * staafBreedte).toFixed(1)}" y="${boven}" width="${staafBreedte.toFixed(1)}" height="${vlak}" />
      <rect class="staaf__balk" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" />
      <title>${e(maandNaam)}: ${e(euro(waarde))} (${m.aantal})</title>
    </g>`;
  }).join('\n    ');

  const labels = maanden.map((m, i) => {
    if (i % 2 !== maanden.length % 2) return '';
    const x = links + i * staafBreedte + staafBreedte * 0.5;
    return `<text class="label" x="${x.toFixed(1)}" y="${hoogte - 8}" text-anchor="middle">${e(maandLabel(m.maand))}</text>`;
  }).filter(Boolean).join('\n    ');

  return `<div class="grafiekvak" data-grafiek>
  <svg class="grafiek" viewBox="0 0 ${breedte} ${hoogte}" role="img"
  aria-label="Factuurbedrag per maand over de laatste twaalf maanden">
    ${lijnen}
    <line class="as" x1="${links}" y1="${y(0).toFixed(1)}" x2="${breedte - 4}" y2="${y(0).toFixed(1)}" />
    ${max > 0 ? `<text class="label" x="${links - 6}" y="${(boven + 8).toFixed(1)}" text-anchor="end">${e(kortBedrag(max))}</text>` : ''}
    <text class="label" x="${links - 6}" y="${(y(0) + 3).toFixed(1)}" text-anchor="end">0</text>
    ${staven}
    ${labels}
  </svg>
  <div class="grafiek__tip" hidden aria-live="polite"></div>
</div>`;
}

function kortBedrag(n) {
  if (n >= 10000) return '€ ' + (n / 1000).toFixed(0) + 'k';
  if (n >= 1000) return '€ ' + (n / 1000).toFixed(1).replace('.', ',') + 'k';
  return euro(n);
}

const MAAND_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const MAAND_LANG = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

function maandLabel(maand, lang = false) {
  const [jaar, nr] = String(maand).split('-');
  const naam = (lang ? MAAND_LANG : MAAND_KORT)[Number(nr) - 1] || maand;
  if (lang) return `${naam} ${jaar}`;
  return nr === '01' ? `${naam} ${String(jaar).slice(2)}` : naam;
}

export function topLeveranciers(lijst, basis = '/facturen') {
  if (!lijst.length) return '<p class="leeg">Nog geen facturen met een bedrag.</p>';
  const hoogste = Math.max(...lijst.map((r) => Math.abs(Number(r.som) || 0)), 1);
  return `<ul class="top">
  ${lijst.map((r) => {
    const deel = Math.round((Math.abs(Number(r.som) || 0) / hoogste) * 100);
    const p = new URLSearchParams({ filter: 'alle', zoek: r.leverancier });
    return `<li>
    <a href="${e(`${basis}/?${p}`)}">${e(r.leverancier)}</a>
    <span class="top__bedrag">${e(euro(r.som))}</span>
    <span class="top__aantal">${r.aantal}×</span>
    <span class="top__balk" data-deel="${deel}"><span></span></span>
  </li>`;
  }).join('\n  ')}
</ul>`;
}

export function geschiedenis(regels) {
  if (!regels.length) return '<p class="leeg">Nog niets gebeurd.</p>';
  return `<ul class="geschiedenis">
  ${regels.map((r) => `<li>
    <span class="niveau-${e(r.niveau)}">${e(r.bericht)}</span>
    <time datetime="${e(r.tijd)}">${e(datumTijdNl(r.tijd))}</time>
  </li>`).join('\n  ')}
</ul>`;
}

// De synchronisatiestatus rechts in de paginakop: laatste ronde + knop.
export function syncStatus({ basis, inst, samenvatting, bezig }) {
  return `<div class="syncstatus">
  <span class="syncstatus__tekst">${inst.laatsteSync
    ? `<span class="syncstatus__label">Laatste synchronisatie</span>${e(datumTijdNl(inst.laatsteSync))}${samenvatting ? `<small>${e(samenvatting)}</small>` : ''}`
    : 'Nog niet gesynchroniseerd'}${bezig ? '<small>Er loopt nu een ronde.</small>' : ''}</span>
  <form method="post" action="${basis}/sync">
    <button class="knop knop--rustig" type="submit"${bezig ? ' disabled' : ''}>${icoon('sync')}<span>${bezig ? 'Bezig…' : 'Synchroniseren'}</span></button>
  </form>
</div>`;
}
