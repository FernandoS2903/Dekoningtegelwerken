// Het raamwerk van de schermen: de pagina eromheen en de onderdelen die op
// meer dan één scherm terugkomen.
//
// Alles komt als tekst uit de server. Geen inline styles en geen inline
// scripts: de dienst stuurt een strikte CSP mee. Dynamische breedtes gaan via
// data-deel (dashboard.js zet er een CSS-variabele van) en de grafiek is SVG
// met gewone attributen.

import { datumNl, datumTijdNl, escapeHtml as e, euro } from '../lib/hulp.mjs';

export { e as escapeHtml };

export const MENU = [
  { pad: '/', naam: 'Overzicht' },
  { pad: '/instellingen', naam: 'Instellingen' },
];

export function pagina({ titel, basis = '', actief = '/', inhoud, meldingen = [] }) {
  const b = basis;
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${e(titel)} — Facturen De Koning Tegelwerken</title>
<link rel="stylesheet" href="${b}/dashboard.css">
</head>
<body>
<header class="kop">
  <div class="kop__binnen">
    <p class="kop__naam">Facturen <span>De Koning Tegelwerken</span></p>
    <nav aria-label="Hoofdmenu">
      ${MENU.map((m) => `<a href="${b}${m.pad === '/' ? '/' : m.pad}"${m.pad === actief ? ' aria-current="page"' : ''}>${e(m.naam)}</a>`).join('\n      ')}
    </nav>
  </div>
</header>
<main>
${meldingen.map(melding).join('\n')}
${inhoud}
</main>
<p class="voet">Intern dashboard, alleen via het tailnet. Gebouwd door Handsfree Digital.</p>
<script src="${b}/dashboard.js" type="module"></script>
</body>
</html>
`;
}

export function melding({ soort = 'info', tekst }) {
  const klasse = soort === 'fout' ? ' melding--fout' : soort === 'goed' ? ' melding--goed' : '';
  const rol = soort === 'fout' ? ' role="alert"' : '';
  return `<div class="melding${klasse}"${rol}><p>${e(tekst)}</p></div>`;
}

export function tegel({ naam, bedrag, bij, let: letOp = false, valuta = 'EUR' }) {
  return `<li class="tegel${letOp ? ' tegel--let' : ''}">
  <p class="tegel__naam">${e(naam)}</p>
  <p class="tegel__bedrag">${bedrag === null ? '—' : e(euro(bedrag, valuta))}</p>
  <p class="tegel__bij">${e(bij)}</p>
</li>`;
}

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

// Eén regel in de lijst. De hele regel is een link naar de factuurpagina.
export function rij(factuur, basis, nu) {
  const onder = [];
  if (factuur.factuurnummer) onder.push('nr. ' + factuur.factuurnummer);
  if (factuur.status === 'betaald') onder.push('betaald ' + datumNl(factuur.betaald_op));
  else if (factuur.vervaldatum) onder.push('vervalt ' + datumNl(factuur.vervaldatum));
  else onder.push('ontvangen ' + datumNl(factuur.ontvangen));
  if (factuur.suggestie_betaling_id && factuur.status === 'open') {
    onder.push(`voorstel: betaling gevonden (${Math.round(Number(factuur.suggestie_score || 0) * 100)}%)`);
  }
  if (factuur.status === 'betaald' && !factuur.doorgestuurd_op) onder.push('nog niet doorgestuurd');
  if (factuur.uitlees_status === 'pending') onder.push('nog niet uitgelezen');

  const naam = factuur.leverancier || factuur.afzender_naam || factuur.afzender_email || '(onbekende afzender)';
  return `<li><a class="rij" href="${basis}/factuur/${factuur.id}">
  <span class="rij__boven">
    <span class="rij__naam">${e(naam)}</span>
    ${vlag(factuur, nu)}
  </span>
  <span class="rij__bedrag">${factuur.bedrag === null ? '—' : e(euro(factuur.bedrag, factuur.valuta))}</span>
  <span class="rij__onder">${onder.map((t) => `<span>${e(t)}</span>`).join('')}</span>
</a></li>`;
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

export function filterbalk(basis, actief, zoek) {
  const link = (sleutel) => {
    const p = new URLSearchParams();
    if (sleutel !== 'open') p.set('filter', sleutel);
    if (zoek) p.set('zoek', zoek);
    const vraag = p.toString();
    return `${basis}/${vraag ? '?' + vraag : ''}`;
  };
  return `<div class="werkbalk">
  <nav class="filters" aria-label="Filteren">
    ${FILTERS.map(([sleutel, naam]) => (
    `<a href="${link(sleutel)}"${sleutel === actief ? ' aria-current="true"' : ''}>${e(naam)}</a>`
  )).join('\n    ')}
  </nav>
  <form class="zoek" method="get" action="${basis}/" data-zoek>
    ${actief !== 'open' ? `<input type="hidden" name="filter" value="${e(actief)}">` : ''}
    <label class="verborgen" for="zoek">Zoeken</label>
    <input type="search" id="zoek" name="zoek" value="${e(zoek || '')}" placeholder="Leverancier of nummer">
    <button class="knop knop--rustig" type="submit">Zoek</button>
  </form>
</div>`;
}

// Staafgrafiek van het factuurbedrag per maand, als SVG uit de server.
// Negatieve maanden (creditnota's) worden onder de nullijn getekend.
export function maandGrafiek(maanden) {
  const breedte = 640;
  const hoogte = 180;
  const links = 56;
  const onder = 24;
  const boven = 10;
  const sommen = maanden.map((m) => Number(m.som) || 0);
  const max = Math.max(0, ...sommen);
  const min = Math.min(0, ...sommen);
  const bereik = (max - min) || 1;
  const vlak = hoogte - boven - onder;
  const y = (waarde) => boven + ((max - waarde) / bereik) * vlak;
  const staafBreedte = (breedte - links - 8) / maanden.length;

  const staven = maanden.map((m, i) => {
    const waarde = Number(m.som) || 0;
    const x = links + i * staafBreedte + staafBreedte * 0.15;
    const w = staafBreedte * 0.7;
    const top = y(Math.max(waarde, 0));
    const h = Math.max(waarde === 0 ? 0 : 1, Math.abs(y(waarde) - y(0)));
    const maandNaam = maandLabel(m.maand);
    return `<rect class="staaf" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}"><title>${e(maandNaam)}: ${e(euro(waarde))} (${m.aantal})</title></rect>`;
  }).join('\n    ');

  const labels = maanden.map((m, i) => {
    if (i % 2 !== maanden.length % 2) return '';
    const x = links + i * staafBreedte + staafBreedte * 0.5;
    return `<text class="label" x="${x.toFixed(1)}" y="${hoogte - 8}" text-anchor="middle">${e(maandLabel(m.maand))}</text>`;
  }).filter(Boolean).join('\n    ');

  return `<svg class="grafiek" viewBox="0 0 ${breedte} ${hoogte}" role="img"
  aria-label="Factuurbedrag per maand over de laatste twaalf maanden">
    <line class="as" x1="${links}" y1="${y(0).toFixed(1)}" x2="${breedte - 4}" y2="${y(0).toFixed(1)}" />
    <text class="label" x="${links - 6}" y="${(boven + 8).toFixed(1)}" text-anchor="end">${e(euro(max))}</text>
    <text class="label" x="${links - 6}" y="${(y(0) + 3).toFixed(1)}" text-anchor="end">0</text>
    ${staven}
    ${labels}
</svg>`;
}

const MAAND_KORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

function maandLabel(maand) {
  const [jaar, nr] = String(maand).split('-');
  const naam = MAAND_KORT[Number(nr) - 1] || maand;
  return nr === '01' ? `${naam} ${String(jaar).slice(2)}` : naam;
}

export function topLeveranciers(lijst) {
  if (!lijst.length) return '<p class="leeg">Nog geen facturen met een bedrag.</p>';
  const hoogste = Math.max(...lijst.map((r) => Math.abs(Number(r.som) || 0)), 1);
  return `<ul class="top">
  ${lijst.map((r) => {
    const deel = Math.round((Math.abs(Number(r.som) || 0) / hoogste) * 100);
    return `<li>
    <span>${e(r.leverancier)}</span>
    <span>${e(euro(r.som))}</span>
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
