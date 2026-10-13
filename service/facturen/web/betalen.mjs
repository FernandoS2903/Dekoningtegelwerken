// Schermen voor betalen via bunq (lib/betalen.mjs):
//  - betaalBlok: het blok "Betalen" in het factuurpaneel;
//  - selectiePagina: open facturen aanvinken voor één conceptbetaling;
//  - bevestigPagina: alles op een rij vóór het klaarzetten, met de controles
//    op nieuwe en afwijkende IBAN's.
// Werkt zonder JavaScript; dashboard.js vraagt alleen nog een bevestiging.

import { datumNl, datumTijdNl, escapeHtml as e, euro, ibanLeesbaar } from '../lib/hulp.mjs';
import { draftTekst } from '../lib/betalen.mjs';
import { factuurNaam, pagina, vlag } from './opmaak.mjs';

const lijstUrl = (basis, ids) => `${basis}/betalen/bevestig?${ids.map((id) => 'id=' + encodeURIComponent(id)).join('&')}`;

function redenLijst(redenen) {
  return `<ul class="redenen">${redenen.map((r) => `<li>${e(r)}</li>`).join('')}</ul>`;
}

// In het factuurpaneel, onder "Behandelen". Toont de lopende draft, de knop,
// of waarom de knop er niet is.
export function betaalBlok({ basis, factuur, beoordeling, toegang, laatste }) {
  if (factuur.status !== 'open' && !beoordeling.actief) return '';
  const actief = beoordeling.actief;
  let inhoud;
  if (actief) {
    inhoud = `<p class="draftstand draftstand--${e(actief.status === 'ACCEPTED' ? 'goed' : 'loopt')}"><strong>${e(draftTekst(actief.status))}</strong></p>
    <ul class="gegevens">
      <li><span class="naam">Klaargezet</span><span>${e(datumTijdNl(actief.aangemaakt_op))} door ${e(actief.door)}</span></li>
      <li><span class="naam">Bedrag</span><span>${e(euro(actief.bedrag))}</span></li>
      <li><span class="naam">Naar</span><span class="iban">${e(ibanLeesbaar(actief.iban))}</span></li>
      ${actief.bunq_id ? `<li><span class="naam">Draft in bunq</span><span>${e(actief.bunq_id)}</span></li>` : ''}
    </ul>
    <p class="tegel__bij">${actief.status === 'ACCEPTED'
    ? 'Goedgekeurd in de app. Zodra de betaling bij de volgende synchronisatie binnenkomt, gaat deze factuur op betaald.'
    : 'Er is nog geen geld weg. Open de bunq-app om de betaling goed te keuren of te weigeren; intrekken kan alleen daar.'}</p>`;
  } else if (toegang) {
    inhoud = `<p class="tegel__bij">${e(toegang)}</p>`;
  } else if (!beoordeling.kan) {
    inhoud = `<p class="tegel__bij">Klaarzetten in bunq kan nog niet:</p>${redenLijst(beoordeling.redenen)}`;
  } else {
    inhoud = `<p class="knoppen"><a class="knop" href="${lijstUrl(basis, [factuur.id])}">Betalen via bunq</a></p>
    <p class="tegel__bij">Zet een conceptbetaling klaar in bunq. Je ziet eerst alles op een rij; daarna keur je hem goed in de bunq-app.</p>`;
  }
  const mislukt = !actief && laatste && ['mislukt', 'REJECTED', 'CANCELLED'].includes(laatste.status)
    ? `<p class="tegel__bij">Vorige poging (${e(datumTijdNl(laatste.bijgewerkt_op))}): ${e(draftTekst(laatste.status))}${laatste.fout ? ` — ${e(laatste.fout)}` : ''}.</p>`
    : '';
  return `<section class="paneel paneel--betalen" aria-labelledby="kop-betalen">
  <h2 id="kop-betalen">Betalen</h2>
  ${inhoud}
  ${mislukt}
</section>`;
}

// Alle open facturen; aanvinken wat in één conceptbetaling mag.
export function selectiePagina({ basis, beoordelingen, toegang, inst, nu, meldingen = [], kader = null }) {
  const kunnen = beoordelingen.filter((b) => b.kan);
  const rijen = beoordelingen.map((b) => {
    const f = b.factuur;
    const id = `kies-${f.id}`;
    return `<li class="kiesrij${b.kan ? '' : ' kiesrij--uit'}">
    ${b.kan ? `<input type="checkbox" name="id" value="${f.id}" id="${id}">` : '<span class="kiesrij__leeg" aria-hidden="true"></span>'}
    <label${b.kan ? ` for="${id}"` : ''} class="kiesrij__tekst">
      <span class="kiesrij__naam">${e(factuurNaam(f))}<small>${e(f.factuurnummer ? 'nr. ' + f.factuurnummer : '')}${f.vervaldatum ? ` · vervalt ${e(datumNl(f.vervaldatum))}` : ''}</small></span>
      <span class="kiesrij__bedrag">${f.bedrag === null ? '—' : e(euro(f.bedrag, f.valuta))}</span>
      ${vlag(f, nu)}
      ${b.kan ? '' : `<span class="kiesrij__reden">${e(b.redenen[0])}</span>`}
    </label>
  </li>`;
  }).join('\n');

  const inhoud = `<p><a class="terug" href="${basis}/">← Alle inkoopfacturen</a></p>
${toegang ? `<div class="melding melding--fout" role="alert"><p>${e(toegang)}</p></div>` : ''}
<p class="dashboard__uitleg">Vink de facturen aan die je in één keer wilt betalen. Ze komen samen in één conceptbetaling in bunq
  (hooguit ${e(euro(inst.betalenMax))} in totaal); die keur je daarna goed in de bunq-app.</p>
${beoordelingen.length ? `<form method="get" action="${basis}/betalen/bevestig" class="kieslijst">
  <ul class="kies">${rijen}</ul>
  <div class="knoppen knoppen--plak">
    <button class="knop" type="submit"${toegang || !kunnen.length ? ' disabled' : ''}>Geselecteerde controleren</button>
  </div>
</form>` : '<p class="leeg">Er zijn geen open inkoopfacturen.</p>'}`;

  return pagina({ titel: 'Betalen via bunq', basis, actief: '/', inhoud, meldingen, kader, onderdeel: 'Inkoopfacturen', menu: kader ? [] : undefined });
}

function ibanControle(b) {
  const id = b.regel.factuurId;
  const info = b.iban;
  if (!info || info.status === 'vertrouwd') {
    return '<p class="ibanstand ibanstand--goed">Bekend IBAN: eerder betaald en in de app goedgekeurd.</p>';
  }
  if (info.status === 'nieuw') {
    return `<div class="ibanstand ibanstand--nieuw">
      <p><strong>Nieuw IBAN</strong> voor deze leverancier. Controleer het met de factuur (en bij twijfel met de leverancier zelf).</p>
      <div class="schakel"><input type="checkbox" id="nieuw_${id}" name="nieuw_${id}" value="1">
        <label for="nieuw_${id}">Ik heb gecontroleerd dat ${e(ibanLeesbaar(b.regel.iban))} het IBAN van ${e(b.regel.naam)} is</label></div>
    </div>`;
  }
  return `<div class="ibanstand ibanstand--afwijkend" role="alert">
    <p><strong>Let op: dit IBAN wijkt af.</strong>
    ${info.vertrouwd.length ? `Eerder betaalde je ${e(b.factuur.leverancier || 'deze leverancier')} op ${info.vertrouwd.map((i) => `<span class="iban">${e(ibanLeesbaar(i))}</span>`).join(', ')}.` : ''}
    ${info.andereLeveranciers.length ? `Dit IBAN is bekend bij een andere leverancier: ${e(info.andereLeveranciers.join(', '))}.` : ''}
    Een gewijzigd rekeningnummer op een factuur is een bekende vorm van fraude. Bel bij twijfel de leverancier op een nummer dat je al had.</p>
    <div class="schakel"><input type="checkbox" id="afwijkend_${id}" name="afwijkend_${id}" value="1">
      <label for="afwijkend_${id}">Ik heb het nieuwe IBAN bij de leverancier nagevraagd en het klopt</label></div>
    <p><label for="laatste4_${id}">Typ de laatste vier tekens van het nieuwe IBAN</label>
      <input type="text" id="laatste4_${id}" name="laatste4_${id}" inputmode="text" autocomplete="off" maxlength="4" class="kort"></p>
  </div>`;
}

// Alles op een rij vóór het klaarzetten.
export function bevestigPagina({ basis, voorbereiding, sleutel, meldingen = [], kader = null }) {
  const v = voorbereiding;
  const ids = v.beoordelingen.map((b) => b.factuur.id);
  const regels = v.beoordelingen.map((b) => `<li class="betaalregel${b.kan ? '' : ' betaalregel--uit'}">
    <h2>${e(factuurNaam(b.factuur))}</h2>
    <ul class="gegevens">
      <li><span class="naam">Bedrag</span><span class="betaalregel__bedrag">${b.regel.bedrag === null ? '—' : e(euro(b.regel.bedrag))}</span></li>
      <li><span class="naam">Naar IBAN</span><span class="iban">${e(b.regel.iban ? ibanLeesbaar(b.regel.iban) : '—')}</span></li>
      <li><span class="naam">Tenaamstelling</span><span>${e(b.regel.naam || '—')}${b.factuur.iban_naam ? '' : ' <small>(niet op de factuur gevonden; de leveranciersnaam wordt gebruikt)</small>'}</span></li>
      <li><span class="naam">Omschrijving</span><span>${e(b.regel.omschrijving)}</span></li>
      <li><span class="naam">Factuur</span><span><a href="${basis}/factuur/${b.factuur.id}">${e(b.factuur.factuurnummer ? 'nr. ' + b.factuur.factuurnummer : 'bekijken')}</a>${b.factuur.vervaldatum ? ` · vervalt ${e(datumNl(b.factuur.vervaldatum))}` : ''}</span></li>
    </ul>
    ${b.kan ? ibanControle(b) : redenLijst(b.redenen)}
  </li>`).join('\n');

  const blokkade = v.toegang || v.problemen.length || !v.kan;
  const rekening = v.rekening
    ? `${e(v.rekening.naam || 'bunq-rekening')}${v.rekening.iban ? ` <span class="iban">${e(ibanLeesbaar(v.rekening.iban))}</span>` : ''}`
    : 'nog niet gekozen';

  const inhoud = `<p><a class="terug" href="${basis}/betalen">← Andere facturen kiezen</a></p>
${v.toegang ? `<div class="melding melding--fout" role="alert"><p>${e(v.toegang)}</p></div>` : ''}
${v.problemen.map((p) => `<div class="melding melding--fout" role="alert"><p>${e(p)}</p></div>`).join('')}
<div class="melding"><p>Er gaat nog geen geld weg. Het portaal zet een <strong>conceptbetaling</strong> klaar in bunq;
  pas als je die in de bunq-app goedkeurt wordt er betaald. Weigeren of intrekken doe je ook in de app.</p></div>
<form method="post" action="${basis}/betalen/bevestig" class="bevestig"
  data-bevestig="${e(`Conceptbetaling van ${euro(v.totaal)} klaarzetten in bunq? Daarna keur je hem goed in de bunq-app.`)}">
  <input type="hidden" name="sleutel" value="${e(sleutel)}">
  <input type="hidden" name="afdruk" value="${e(v.vingerafdruk)}">
  ${ids.map((id) => `<input type="hidden" name="id" value="${id}">`).join('')}
  <ul class="betaalregels">${regels}</ul>
  <section class="paneel betaaltotaal" aria-label="Samenvatting">
    <ul class="gegevens">
      <li><span class="naam">Van rekening</span><span>${rekening}</span></li>
      <li><span class="naam">Aantal</span><span>${v.beoordelingen.length} factu${v.beoordelingen.length === 1 ? 'ur' : 'ren'}</span></li>
      <li><span class="naam">Totaal</span><span class="betaalregel__bedrag">${e(euro(v.totaal))}</span></li>
    </ul>
  </section>
  <div class="knoppen knoppen--plak">
    <button class="knop" type="submit"${blokkade ? ' disabled' : ''}>Klaarzetten in bunq</button>
    <a class="knop knop--rustig" href="${basis}/">Annuleren</a>
  </div>
</form>`;

  return pagina({ titel: 'Betaling controleren', basis, actief: '/', inhoud, meldingen, kader, onderdeel: 'Inkoopfacturen', menu: kader ? [] : undefined });
}
