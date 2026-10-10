// De pagina Offertes: de lijst uit Offerteknop (spiegel), met filters op
// status en zoeken, en per offerte de knop naar de editor in Offerteknop.
// Zelfde opmaak als de facturenlijst; een rij opent in een nieuw tabblad,
// want de offerte zelf leeft in Offerteknop (eigen login).

import { datumNl, datumTijdNl, escapeHtml as e, euro } from '../lib/hulp.mjs';
import { OFFERTE_FILTERS, STATUS_NAAM } from '../lib/offerte-opslag.mjs';
import { icoon, pagina } from './opmaak.mjs';

const STATUS_KLASSE = {
  concept: 'genegeerd', verstuurd: 'open', bekeken: 'open', geaccepteerd: 'betaald',
  afgewezen: 'let', verlopen: 'let', ingetrokken: 'genegeerd',
};

const centen = (c) => (c === null || c === undefined ? '—' : euro(Number(c) / 100));

export function offerteVlag(o) {
  return `<span class="vlag vlag--${STATUS_KLASSE[o.status] || 'genegeerd'}">${e(STATUS_NAAM[o.status] || o.status)}</span>`;
}

function offerteRij(o) {
  const sub = [];
  if (o.projectadres) sub.push(o.projectadres);
  if (o.klanttype === 'zakelijk') sub.push('zakelijk');
  if (o.bron && o.bron !== 'handmatig') sub.push('via ' + o.bron.replace('portaal-mail', 'mail'));
  const wanneer = o.beslist_op || o.verstuurd_op || o.gewijzigd_op;
  return `<li><a class="rij rij--offerte" href="${e(o.bewerk_url || '#')}" target="_blank" rel="noopener noreferrer">
  <span class="rij__naam"><span>${e(o.klant_naam || '(geen klant)')}</span>${sub.length ? `<small>${e(sub.join(' · '))}</small>` : ''}</span>
  <span class="rij__nummer">${e(o.nummer_str || '—')}</span>
  <span class="rij__datum"><small>aangemaakt</small>${e(datumNl(o.datum || o.aangemaakt_op))}</span>
  <span class="rij__verval"><small>${o.beslist_op ? 'beslist' : o.verstuurd_op ? 'verstuurd' : 'gewijzigd'}</small>${e(datumNl(wanneer))}</span>
  <span class="rij__bedrag">${e(centen(o.bedrag_incl_cent))}</span>
  <span class="rij__status">${offerteVlag(o)}</span>
</a></li>`;
}

function filterbalk(basis, actief, zoek) {
  const link = (sleutel) => {
    const p = new URLSearchParams();
    if (sleutel !== 'open') p.set('filter', sleutel);
    if (zoek) p.set('zoek', zoek);
    const vraag = p.toString();
    return `${basis}/${vraag ? '?' + vraag : ''}`;
  };
  return `<div class="werkbalk">
  <nav class="filters" aria-label="Filteren op status">
    ${OFFERTE_FILTERS.map(([sleutel, naam]) => `<a href="${link(sleutel)}"${sleutel === actief ? ' aria-current="true"' : ''}>${e(naam)}</a>`).join('\n    ')}
  </nav>
  <form class="zoek" method="get" action="${basis}/" data-zoek>
    ${actief !== 'open' ? `<input type="hidden" name="filter" value="${e(actief)}">` : ''}
    <label class="verborgen" for="zoek">Zoeken</label>
    <span class="zoek__veld">${icoon('zoek')}<input type="search" id="zoek" name="zoek" value="${e(zoek)}" placeholder="Klant, nummer of adres"></span>
    <button class="knop knop--rustig" type="submit">Zoek</button>
  </form>
</div>`;
}

export function offertesPagina({ basis, offerteOpslag, offerteknop, filter, zoek, meldingen = [], kader = null, laatsteSync = null }) {
  const regels = offerteOpslag.lijst({ filter, zoek });
  const totaal = regels.reduce((som, o) => som + (Number(o.bedrag_incl_cent) || 0), 0);
  const nieuwUrl = offerteknop.beschikbaar && kader?.offertesUrl ? kader.offertesUrl.replace(/\/?$/, '/?nieuw=offerte') : '';

  const inhoud = `${offerteknop.beschikbaar ? '' : `<p class="melding melding--fout">De koppeling met Offerteknop is niet ingesteld (${e(offerteknop.ontbreekt.join(', '))}). De lijst hieronder is wat er eerder is opgehaald.</p>`}
${filterbalk(basis, filter, zoek)}
<div class="lijstvak">
  <p class="lijst__telling">${regels.length} offerte${regels.length === 1 ? '' : 's'}${regels.length ? ` · ${e(euro(totaal / 100))} incl. btw` : ''}${zoek ? ` · zoekterm "${e(zoek)}"` : ''}
    · ${laatsteSync ? `bijgewerkt ${e(datumTijdNl(laatsteSync))}` : 'nog niet opgehaald'}</p>
  ${regels.length
    ? `<ul class="lijst lijst--tabel">
  <li class="tabelkop" aria-hidden="true">
    <span class="tabelkop__leverancier">Klant</span>
    <span class="tabelkop__factuurnummer">Nummer</span>
    <span class="tabelkop__datum">Aangemaakt</span>
    <span class="tabelkop__vervaldatum">Verstuurd / beslist</span>
    <span class="tabelkop__bedrag tabelkop--recht">Bedrag incl.</span>
    <span class="tabelkop__status">Status</span>
  </li>
${regels.map(offerteRij).join('\n')}
</ul>`
    : `<p class="leeg">Geen offertes in deze selectie${zoek ? ` voor "${e(zoek)}"` : ''}.</p>`}
</div>
<p class="tegel__bij">Een offerte opent in Offerteknop, in een nieuw tabblad (eigen login). Wijzigingen daar komen binnen seconden hier terug.</p>
`;

  const kopActies = `<div class="syncstatus">
  ${nieuwUrl ? `<a class="knop" href="${e(nieuwUrl)}" target="_blank" rel="noopener noreferrer">${icoon('extern')}<span>Nieuwe offerte</span></a>` : ''}
  <form method="post" action="${basis}/sync">
    <button class="knop knop--rustig" type="submit"${offerteknop.beschikbaar ? '' : ' disabled'}>${icoon('sync')}<span>Bijwerken</span></button>
  </form>
</div>`;

  return pagina({
    titel: 'Offertes', basis, actief: '/', inhoud, meldingen, kader, onderdeel: 'Offertes', menu: [], kopActies, kopKlasse: 'paginakop--lijst',
  });
}

// Het blok op het dashboard.
export function offertesPaneel(t, basis, offertesUrl = '') {
  const regel = (href, aantal, tekst, { som = null, letOp = false } = {}) => `<li><a href="${e(href)}"${letOp ? ' class="let"' : ''}><strong>${aantal}</strong> ${e(tekst)}${som !== null && som > 0 ? ` <small>· ${e(euro(som / 100))}</small>` : ''}</a></li>`;
  return `<section class="paneel" aria-labelledby="kop-offertes">
    <h2 id="kop-offertes">Offertes</h2>
    <ul class="kerncijfers">
      ${regel(`${basis}/?filter=concept`, t.concepten.n, t.concepten.n === 1 ? 'concept' : 'concepten')}
      ${regel(`${basis}/?filter=wacht`, t.wachtOpAkkoord.n, 'wacht op akkoord', { som: t.wachtOpAkkoord.som })}
      ${regel(`${basis}/?filter=geaccepteerd`, t.geaccepteerdDezeMaand.n, 'geaccepteerd deze maand', { som: t.geaccepteerdDezeMaand.som })}
      ${t.verlopen.n ? regel(`${basis}/?filter=afgewezen`, t.verlopen.n, 'verlopen zonder reactie', { letOp: true }) : ''}
    </ul>
    ${offertesUrl ? `<p class="tegel__bij"><a href="${e(offertesUrl)}" rel="noopener noreferrer" target="_blank">Offerteknop openen ↗</a> (eigen login)</p>` : ''}
  </section>`;
}
