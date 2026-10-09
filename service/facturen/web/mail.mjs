// Schermen van de mailsorteerder: logboek, regels en instellingen.
//
// Server-side HTML zoals de rest van het portaal: geen inline styles of
// scripts, alles werkt zonder JavaScript (Andere map staat in een
// <details>, bevestigen via data-bevestig in dashboard.js).

import { datumTijdNl, escapeHtml as e } from '../lib/hulp.mjs';
import { SORTEER_DREMPEL_MAX, SORTEER_DREMPEL_MIN, SORTEER_MAPPEN } from '../lib/instellingen.mjs';
import { domeinVan } from '../lib/sorteer-opslag.mjs';
import { INBOX_NAAM } from '../lib/classificeer.mjs';
import { pagina } from './opmaak.mjs';
import { schakel, uitslagRegel } from './instellingen.mjs';

export const MAIL_MENU = [
  { pad: '/', naam: 'Logboek' },
  { pad: '/regels', naam: 'Regels' },
  { pad: '/instellingen', naam: 'Instellingen' },
];

export const BRON_NAAM = {
  regel: 'regel',
  website: 'website',
  ai: 'Claude',
  overgeslagen: 'overgeslagen',
  handmatig: 'met de hand',
};

export const STATUS_NAAM = {
  verplaatst: 'verplaatst',
  controleren: 'controleren',
  inbox: 'in Inbox gelaten',
  'map uit': 'map staat uit',
  overgeslagen: 'overgeslagen',
  'niet beoordeeld': 'niet beoordeeld',
  fout: 'fout',
  teruggezet: 'teruggezet',
  gecorrigeerd: 'andere map',
};

const STATUS_KLASSE = {
  verplaatst: 'betaald', controleren: 'open', fout: 'let', teruggezet: 'genegeerd', gecorrigeerd: 'genegeerd',
};

const MAPNAMEN = SORTEER_MAPPEN.map((m) => m.naam);
const ALLE_DOELEN = [...MAPNAMEN, INBOX_NAAM];

const mailPagina = (opties) => pagina({
  ...opties, onderdeel: 'Mail', menu: [],
  subnav: MAIL_MENU.map((m) => ({ pad: opties.basis + (m.pad === '/' ? '/' : m.pad), naam: m.naam, actief: m.pad === opties.actief })),
});

function opties(waarden, gekozen, { leeg = null, namen = {} } = {}) {
  const regels = [];
  if (leeg !== null) regels.push(`<option value="">${e(leeg)}</option>`);
  for (const w of waarden) {
    regels.push(`<option value="${e(w)}"${w === gekozen ? ' selected' : ''}>${e(namen[w] || w)}</option>`);
  }
  return regels.join('');
}

const procent = (z) => (z === null || z === undefined ? '' : `${Math.round(Number(z) * 100)}%`);

// -- logboek ---------------------------------------------------------------
function rondeTekst(laatste) {
  if (!laatste) return 'Nog geen ronde gedraaid.';
  const wanneer = datumTijdNl(laatste.klaar || laatste.gestart);
  if (laatste.fout) return `Laatste ronde ${wanneer}: mislukt (${laatste.fout}).`;
  if (laatste.uit) return `Laatste ronde ${wanneer}: sorteren staat uit.`;
  if (laatste.overgeslagen) return `Laatste ronde ${wanneer}: ${laatste.overgeslagen}.`;
  if (laatste.startpunt) return `Laatste ronde ${wanneer}: startpunt vastgelegd; vanaf nu wordt nieuwe mail gesorteerd.`;
  return `Laatste ronde ${wanneer}: ${laatste.bekeken ?? 0} nieuw, ${laatste.verplaatst ?? 0} verplaatst, `
    + `${laatste.controleren ?? 0} te controleren, ${laatste.fouten ?? 0} fout.`;
}

function webhookTekst(w, minuten) {
  if (!w.actief) return `Microsoft geeft nog geen seintjes; er wordt elke ${minuten} minuten gekeken.`;
  if (w.fout) return `Seintjes van Microsoft: probleem (${w.fout}); er wordt elke ${minuten} minuten gekeken.`;
  return `Seintjes van Microsoft staan aan${w.verlooptOp ? `, geldig tot ${datumTijdNl(w.verlooptOp)}` : ''}; daarnaast elke ${minuten} minuten een controle.`;
}

function logRij(r, basis) {
  const afzender = r.afzender_naam ? `${r.afzender_naam} <${r.afzender || ''}>` : (r.afzender || '(onbekende afzender)');
  const onder = [
    datumTijdNl(r.tijd),
    `${r.van_map || INBOX_NAAM} → ${r.naar_map || '—'}`,
    `bron: ${BRON_NAAM[r.bron] || r.bron}`,
  ];
  if (r.zekerheid !== null && r.zekerheid !== undefined) onder.push(`zekerheid ${procent(r.zekerheid)}`);
  if (r.huidige_map && r.huidige_map !== r.naar_map) onder.push(`staat nu in ${r.huidige_map}`);

  const acties = [];
  if (r.bron !== 'handmatig') {
    if (r.huidige_map && r.huidige_map !== INBOX_NAAM) {
      acties.push(`<form method="post" action="${basis}/log/${r.id}/terug">
      <button class="knop knop--rustig knop--klein" type="submit">Terugzetten</button>
    </form>`);
    }
    if (r.afzender) {
      const domein = domeinVan(r.afzender);
      acties.push(`<details class="mailrij__anders">
      <summary>Andere map…</summary>
      <form method="post" action="${basis}/log/${r.id}/verplaats">
        <p><label for="naar-${r.id}">Naar</label>
          <select id="naar-${r.id}" name="naar">${opties(ALLE_DOELEN.filter((d) => d !== (r.huidige_map || INBOX_NAAM)), null)}</select></p>
        <fieldset class="keuze">
          <legend>Altijd zo voor deze afzender / dit domein?</legend>
          <label><input type="radio" name="altijd" value="" checked> Nee, alleen deze mail</label>
          <label><input type="radio" name="altijd" value="adres"> Ja, altijd voor ${e(r.afzender)}</label>
          <label><input type="radio" name="altijd" value="domein"> Ja, altijd voor alles van ${e(domein)}</label>
        </fieldset>
        <button class="knop knop--klein" type="submit">Verplaatsen</button>
      </form>
    </details>`);
    }
  }

  return `<li class="mailrij">
  <div class="mailrij__boven">
    <span class="mailrij__afzender">${e(afzender)}</span>
    <span class="vlag vlag--${STATUS_KLASSE[r.status] || 'genegeerd'}">${e(STATUS_NAAM[r.status] || r.status)}</span>
  </div>
  <p class="mailrij__onderwerp">${e(r.onderwerp || '(geen onderwerp)')}</p>
  <p class="mailrij__onder">${onder.map((t) => `<span>${e(t)}</span>`).join('')}</p>
  ${r.reden || r.fout ? `<p class="mailrij__reden">${e(r.reden || '')}${r.fout ? ` — <span class="nee">${e(r.fout)}</span>` : ''}</p>` : ''}
  ${acties.length ? `<div class="mailrij__acties">${acties.join('\n    ')}</div>` : ''}
</li>`;
}

export function logboekPagina({ basis, rijen, filter, status, webhook, minuten, meldingen = [], kader = null, bezig = false }) {
  const inhoud = `<p>Nieuwe mail in de Inbox wordt in de juiste map gezet. Twijfelgevallen blijven in de Inbox met de
  categorie <strong>Controleren</strong>. Er wordt nooit iets verwijderd of als gelezen gemarkeerd.</p>
<ul class="uitslag">
  <li>${e(rondeTekst(status.laatste))}</li>
  <li>${e(webhookTekst(webhook, minuten))}</li>
  ${status.model ? '' : '<li><span class="nee">Er is geen Claude-sleutel ingesteld:</span> alleen regels en website-afzenders worden gesorteerd, de rest blijft staan.</li>'}
</ul>
<form method="post" action="${basis}/sorteer">
  <div class="knoppen"><button class="knop" type="submit"${bezig ? ' disabled' : ''}>${bezig ? 'Ronde loopt…' : 'Nu sorteren'}</button></div>
</form>

<form class="filterformulier" method="get" action="${basis}/">
  <p><label for="f-map">Map</label><select id="f-map" name="map">${opties(ALLE_DOELEN, filter.map, { leeg: 'Alle mappen' })}</select></p>
  <p><label for="f-bron">Bron</label><select id="f-bron" name="bron">${opties(Object.keys(BRON_NAAM), filter.bron, { leeg: 'Alle bronnen', namen: BRON_NAAM })}</select></p>
  <p><label for="f-status">Stand</label><select id="f-status" name="status">${opties(Object.keys(STATUS_NAAM), filter.status, { leeg: 'Alles', namen: STATUS_NAAM })}</select></p>
  <p><button class="knop knop--rustig" type="submit">Filteren</button></p>
</form>

${rijen.length
    ? `<ul class="lijst">\n${rijen.map((r) => logRij(r, basis)).join('\n')}\n</ul>`
    : '<p class="leeg">Nog niets in het logboek' + (filter.map || filter.bron || filter.status ? ' met dit filter' : '') + '.</p>'}
`;
  return mailPagina({ titel: 'Mail', basis, actief: '/', inhoud, meldingen, kader });
}

// -- regels ----------------------------------------------------------------
export function regelsPagina({ basis, regels, meldingen = [], kader = null, invoer = {} }) {
  const inhoud = `<p>Een regel wint altijd, ook van Claude. Een regel op een adres wint van een regel op het domein.
  Een domeinregel geldt ook voor subdomeinen (mail.voorbeeld.nl valt onder voorbeeld.nl).
  Kies "Inbox" om mail van een afzender juist altijd te laten staan.</p>

${regels.length ? `<ul class="lijst">
${regels.map((r) => `<li class="mailrij">
  <div class="mailrij__boven">
    <span class="mailrij__afzender">${e(r.soort === 'domein' ? 'alles van ' + r.waarde : r.waarde)}</span>
    <span class="vlag">${e(r.map)}</span>
  </div>
  <p class="mailrij__onder"><span>${e(r.soort)}</span><span>${e(datumTijdNl(r.aangemaakt_op))}</span>${r.door ? `<span>${e(r.door)}</span>` : ''}</p>
  <form method="post" action="${basis}/regels/${r.id}/verwijder" data-bevestig="Deze regel verwijderen?">
    <button class="knop knop--rustig knop--klein" type="submit">Verwijderen</button>
  </form>
</li>`).join('\n')}
</ul>` : '<p class="leeg">Nog geen regels.</p>'}

<form method="post" action="${basis}/regels">
  <fieldset class="veldgroep">
    <legend>Regel toevoegen</legend>
    <p><label for="r-soort">Soort</label>
      <select id="r-soort" name="soort">${opties(['adres', 'domein'], invoer.soort || 'adres', { namen: { adres: 'Afzenderadres', domein: 'Domein' } })}</select></p>
    <p><label for="r-waarde">Adres of domein</label>
      <input type="text" id="r-waarde" name="waarde" value="${e(invoer.waarde || '')}" placeholder="naam@leverancier.nl of leverancier.nl" required></p>
    <p><label for="r-map">Naar map</label>
      <select id="r-map" name="map">${opties(ALLE_DOELEN, invoer.map || '', { namen: { [INBOX_NAAM]: 'Inbox (laten staan)' } })}</select></p>
    <div class="knoppen"><button class="knop" type="submit">Regel toevoegen</button></div>
  </fieldset>
</form>
`;
  return mailPagina({ titel: 'Regels', basis, actief: '/regels', inhoud, meldingen, kader });
}

// -- instellingen ----------------------------------------------------------
export function mailInstellingenPagina({ basis, inst, status, webhook, minuten, test = null, meldingen = [], kader = null }) {
  const inhoud = `<form method="post" action="${basis}/instellingen">
  <fieldset class="veldgroep">
    <legend>Sorteren</legend>
    ${schakel('sorteren', 'Nieuwe mail automatisch sorteren',
    'Uit betekent: de Inbox blijft zoals hij is. Het logboek, de regels en de knoppen blijven werken.', inst.sorteren)}
    <p>
      <label for="sorteer_drempel">Drempel</label>
      <input type="number" id="sorteer_drempel" name="sorteer_drempel" step="0.05"
        min="${SORTEER_DREMPEL_MIN}" max="${SORTEER_DREMPEL_MAX}" value="${e(inst.sorteerDrempel)}">
      <span class="uitleg">Vanaf deze zekerheid verplaatst Claude een mail. Daaronder blijft hij in de Inbox
        met de categorie Controleren. Regels en website-afzenders gelden altijd.</span>
    </p>
  </fieldset>

  <fieldset class="veldgroep">
    <legend>Mappen onder Inbox</legend>
    <p class="uitleg">Een map die uit staat, krijgt geen mail; die mail blijft in de Inbox. Een map die
      aan staat en nog ontbreekt, wordt bij de volgende ronde aangemaakt.</p>
    ${SORTEER_MAPPEN.map((m) => schakel('sorteer_map_' + m.sleutel, m.naam, e(m.uitleg), inst.sorteerMappen[m.naam])).join('\n    ')}
  </fieldset>

  <fieldset class="veldgroep">
    <legend>Website-afzenders</legend>
    <p>
      <label for="website_afzenders">Adressen of domeinen van het offerteformulier</label>
      <textarea id="website_afzenders" name="website_afzenders" placeholder="formulier@voorbeeld.nl">${e(inst.websiteAfzenders.join('\n'))}</textarea>
      <span class="uitleg">Mail van deze afzenders gaat zonder Claude naar Offerteaanvragen. Eén per regel;
        een domein (voorbeeld.nl) telt voor alle adressen daarop.</span>
    </p>
  </fieldset>

  <div class="knoppen"><button class="knop" type="submit">Instellingen opslaan</button></div>
</form>

<section aria-labelledby="kop-webhook">
  <h2 id="kop-webhook">Seintjes van Microsoft</h2>
  <ul class="uitslag">
    <li><strong>Webhook</strong> — ${webhook.actief ? '<span class="ja">aan</span>' : `<span class="nee">uit</span>: ${e(webhook.reden)}`}</li>
    ${webhook.actief ? `<li><strong>Subscription</strong> — ${webhook.id ? `geldig tot ${e(datumTijdNl(webhook.verlooptOp))}` : 'nog niet aangemaakt'}</li>` : ''}
    ${webhook.laatsteNotificatie ? `<li><strong>Laatste seintje</strong> — ${e(datumTijdNl(webhook.laatsteNotificatie))}</li>` : ''}
    ${webhook.fout ? `<li><strong>Laatste fout</strong> — <span class="nee">${e(webhook.fout)}</span></li>` : ''}
    <li><strong>Controle</strong> — elke ${e(minuten)} minuten, los van de seintjes</li>
    <li><strong>Gesorteerd vanaf</strong> — ${status.startmoment ? e(datumTijdNl(status.startmoment)) : 'nog geen startpunt'}</li>
    <li><strong>Model</strong> — ${status.model ? e(status.model) : 'geen Claude-sleutel'}</li>
  </ul>
</section>

<section aria-labelledby="kop-test">
  <h2 id="kop-test">Verbindingen testen</h2>
  <form method="post" action="${basis}/instellingen/test">
    <div class="knoppen"><button class="knop knop--rustig" type="submit">Verbindingen testen</button></div>
  </form>
  ${test ? `<ul class="uitslag">
    ${uitslagRegel('Mailbox', test.mailbox)}
    ${test.mappen.map((m) => uitslagRegel('Map ' + m.naam, { ok: m.bestaat, melding: m.bestaat ? 'bestaat' : (m.fout || 'ontbreekt; wordt aangemaakt als hij aan staat') })).join('\n    ')}
    ${uitslagRegel('Claude', test.claude)}
  </ul>` : '<p class="tegel__bij">Er wordt niets gewijzigd of aangemaakt; er wordt alleen gekeken.</p>'}
</section>
`;
  return mailPagina({ titel: 'Mailinstellingen', basis, actief: '/instellingen', inhoud, meldingen, kader });
}
