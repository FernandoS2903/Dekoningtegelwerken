// Scherm 2: één factuur behandelen. Links het document, rechts de gegevens,
// de acties en de geschiedenis.

import { datumNl, escapeHtml as e, euro, vandaag } from '../lib/hulp.mjs';
import { magAutomatisch } from '../lib/doorsturen.mjs';
import { geschiedenis, pagina, vlag } from './opmaak.mjs';

const veld = (naam, label, waarde, { type = 'text', hint = '' } = {}) => `<p>
  <label for="v-${naam}">${e(label)}</label>
  <input type="${type}" id="v-${naam}" name="${naam}" value="${e(waarde ?? '')}"${hint ? ` placeholder="${e(hint)}"` : ''}>
</p>`;

function betalingBlok(betaling, { score, basis, factuurId, voorstel }) {
  if (!betaling) return '';
  const procent = Math.round(Number(score || 0) * 100);
  return `<section class="paneel" aria-labelledby="kop-betaling">
  <h2 id="kop-betaling">${voorstel ? 'Voorgestelde bunq-betaling' : 'Gekoppelde bunq-betaling'}</h2>
  <ul class="gegevens">
    <li><span class="naam">Datum</span><span>${e(datumNl(betaling.datum))}</span></li>
    <li><span class="naam">Bedrag</span><span>${e(euro(betaling.bedrag, betaling.valuta))}</span></li>
    <li><span class="naam">Tegenpartij</span><span>${e(betaling.tegenpartij_naam || '—')}</span></li>
    <li><span class="naam">Tegenrekening</span><span>${e(betaling.tegenrekening_iban || '—')}</span></li>
    <li><span class="naam">Omschrijving</span><span>${e(betaling.omschrijving || '—')}</span></li>
  </ul>
  <p class="tegel__bij">Zekerheid ${procent}%</p>
  <div class="zekerheid" role="img" aria-label="Zekerheid ${procent} procent"><span data-deel="${procent}"></span></div>
  ${voorstel ? `<form method="post" action="${basis}/factuur/${factuurId}/koppel">
    <input type="hidden" name="betaling_id" value="${e(betaling.id)}">
    <div class="knoppen"><button class="knop" type="submit">Klopt, koppel deze betaling</button></div>
  </form>` : ''}
</section>`;
}

export function factuurPagina({ basis, opslag, inst, factuur, nu = vandaag(), meldingen = [], kader = null }) {
  const naam = factuur.leverancier || factuur.afzender_naam || factuur.afzender_email || '(onbekende afzender)';
  const gekoppeld = opslag.betaling(factuur.bunq_betaling_id);
  const voorstel = factuur.status === 'open' ? opslag.betaling(factuur.suggestie_betaling_id) : null;
  const heeftAdres = inst.boekhouderEmails.length > 0;

  const document = factuur.pdf_pad
    ? `<object class="pdf" type="application/pdf" data="${basis}/factuur/${factuur.id}/pdf">
    <p>Je browser kan de PDF niet in de pagina tonen.
      <a href="${basis}/factuur/${factuur.id}/pdf">Open ${e(factuur.bijlage_naam || 'de PDF')}</a>.</p>
  </object>`
    : `<h2>Tekst van de e-mail</h2>
  <div class="maildump">${e(factuur.mail_tekst || 'Geen PDF en geen mailtekst opgeslagen.')}</div>`;

  const automatisch = magAutomatisch(factuur, inst);
  const doorstuurUitleg = factuur.doorgestuurd_op
    ? `Doorgestuurd op ${datumNl(factuur.doorgestuurd_op)} naar ${factuur.doorgestuurd_naar || 'de boekhouder'}. Opnieuw sturen mag.`
    : !heeftAdres
        ? 'Er is nog geen e-mailadres van de boekhouder ingesteld, dus doorsturen kan niet.'
        : factuur.status !== 'betaald'
          ? 'Nog niet betaald. Doorsturen kan al wel, maar meestal wacht je daarmee.'
          : automatisch.mag
            ? 'Gaat ook automatisch mee met de volgende ronde.'
            : `Gaat niet automatisch mee: ${automatisch.reden}.`;

  const inhoud = `<p><a class="terug" href="${basis}/">← Terug naar het overzicht</a></p>
<h1>${e(naam)}</h1>
<p>${vlag(factuur, nu)} ${factuur.factuurnummer ? e('factuur ' + factuur.factuurnummer) : ''}
  ${factuur.bedrag === null ? '' : '· ' + e(euro(factuur.bedrag, factuur.valuta))}</p>

${factuur.uitlees_status === 'mislukt'
    ? `<div class="melding melding--fout" role="alert"><p>Uitlezen mislukt: ${e(factuur.uitlees_fout || 'onbekende fout')}</p></div>`
    : ''}
${factuur.uitlees_status === 'pending' ? '<div class="melding"><p>Deze factuur is nog niet uitgelezen.</p></div>' : ''}
${factuur.uitlees_status === 'handmatig' ? '<div class="melding"><p>De gegevens zijn met de hand ingevuld of gecorrigeerd.</p></div>' : ''}
${factuur.uitlees_status === 'geen_factuur' ? '<div class="melding"><p>Volgens het uitlezen is dit geen factuur.</p></div>' : ''}

<div class="factuur">
  <div>
    ${document}
  </div>

  <div>
    <section aria-labelledby="kop-acties">
      <h2 id="kop-acties">Behandelen</h2>
      ${factuur.status === 'betaald'
    ? `<form method="post" action="${basis}/factuur/${factuur.id}/open">
        <div class="knoppen"><button class="knop knop--rustig" type="submit">Terug naar open</button></div>
      </form>`
    : `<form method="post" action="${basis}/factuur/${factuur.id}/betaald">
        <p>
          <label for="betaald_op">Betaald op</label>
          <input type="date" id="betaald_op" name="betaald_op" value="${e(nu)}">
        </p>
        <div class="knoppen"><button class="knop" type="submit">Markeer als betaald</button></div>
      </form>`}

      <form method="post" action="${basis}/factuur/${factuur.id}/doorsturen"
        data-bevestig="Nu echt een mail met deze factuur naar de boekhouder sturen?">
        <div class="knoppen">
          <button class="knop${heeftAdres ? '' : ' knop--rustig'}" type="submit"${heeftAdres ? '' : ' disabled'}>
            Doorsturen naar boekhouder</button>
        </div>
      </form>
      <p class="tegel__bij">${e(doorstuurUitleg)}</p>

      <div class="knoppen">
        ${factuur.status === 'genegeerd'
    ? `<form method="post" action="${basis}/factuur/${factuur.id}/open"><button class="knop knop--rustig" type="submit">Niet meer negeren</button></form>`
    : `<form method="post" action="${basis}/factuur/${factuur.id}/negeren"><button class="knop knop--rustig" type="submit">Negeren</button></form>`}
        <form method="post" action="${basis}/factuur/${factuur.id}/opnieuw"><button class="knop knop--rustig" type="submit">Opnieuw uitlezen</button></form>
      </div>
    </section>

    ${betalingBlok(gekoppeld, { score: factuur.match_score, basis, factuurId: factuur.id, voorstel: false })}
    ${betalingBlok(voorstel, { score: factuur.suggestie_score, basis, factuurId: factuur.id, voorstel: true })}

    <section aria-labelledby="kop-mail">
      <h2 id="kop-mail">Uit de e-mail</h2>
      <ul class="gegevens">
        <li><span class="naam">Afzender</span><span>${e(factuur.afzender_naam || '—')}${factuur.afzender_email ? ` &lt;${e(factuur.afzender_email)}&gt;` : ''}</span></li>
        <li><span class="naam">Onderwerp</span><span>${e(factuur.onderwerp || '—')}</span></li>
        <li><span class="naam">Ontvangen</span><span>${e(datumNl(factuur.ontvangen))}</span></li>
        <li><span class="naam">Bijlage</span><span>${e(factuur.bijlage_naam || 'geen PDF')}</span></li>
      </ul>
    </section>

    <section aria-labelledby="kop-bewerken">
      <h2 id="kop-bewerken">Gegevens corrigeren</h2>
      <form method="post" action="${basis}/factuur/${factuur.id}/bewerken">
        <div class="velden">
          ${veld('leverancier', 'Leverancier', factuur.leverancier)}
          ${veld('factuurnummer', 'Factuurnummer', factuur.factuurnummer)}
          ${veld('factuurdatum', 'Factuurdatum', factuur.factuurdatum, { type: 'date' })}
          ${veld('vervaldatum', 'Vervaldatum', factuur.vervaldatum, { type: 'date' })}
          ${veld('bedrag', 'Bedrag incl. btw', factuur.bedrag === null ? '' : Number(factuur.bedrag).toFixed(2).replace('.', ','), { hint: '1.234,56' })}
          ${veld('valuta', 'Valuta', factuur.valuta, { hint: 'EUR' })}
          ${veld('iban', 'IBAN leverancier', factuur.iban)}
          ${veld('betalingskenmerk', 'Betalingskenmerk', factuur.betalingskenmerk)}
        </div>
        ${veld('omschrijving', 'Omschrijving', factuur.omschrijving)}
        <p>
          <label for="v-notitie">Notitie</label>
          <textarea id="v-notitie" name="notitie">${e(factuur.notitie || '')}</textarea>
        </p>
        <div class="knoppen"><button class="knop" type="submit">Opslaan</button></div>
      </form>
    </section>

    <section aria-labelledby="kop-historie">
      <h2 id="kop-historie">Geschiedenis</h2>
      ${geschiedenis(opslag.logboekVanFactuur(factuur.id, 50))}
    </section>
  </div>
</div>
`;

  return pagina({ titel: naam, basis, actief: '/', inhoud, meldingen, kader });
}
