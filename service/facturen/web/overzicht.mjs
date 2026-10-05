// Scherm 1: het overzicht. Tegels, grafiek, top-leveranciers en de lijst
// met filters.

import { datumTijdNl, escapeHtml as e, euro } from '../lib/hulp.mjs';
import { vatSamen } from '../lib/sync.mjs';
import { filterbalk, maandGrafiek, pagina, rij, tegel, topLeveranciers } from './opmaak.mjs';

export function overzicht({ basis, opslag, inst, filter, zoek, nu, meldingen = [], syncBezig = false }) {
  const t = opslag.tegels(nu);
  const regels = opslag.lijst(filter, zoek, nu);

  const stand = inst.testmodus ? 'testmodus: niets gaat echt weg'
    : inst.autoDoorsturen ? 'automatisch zodra betaald'
      : 'alleen met de knop';

  const tegels = [
    tegel({ naam: 'Openstaand', bedrag: t.open.som, bij: `${t.open.aantal} factuur${t.open.aantal === 1 ? '' : 'en'}` }),
    tegel({ naam: 'Verlopen', bedrag: t.verlopen.som, bij: `${t.verlopen.aantal} over de vervaldatum`, let: t.verlopen.aantal > 0 }),
    tegel({ naam: 'Betaald deze maand', bedrag: t.betaaldDezeMaand.som, bij: `${t.betaaldDezeMaand.aantal} betaald` }),
    tegel({ naam: 'Nog naar boekhouder', bedrag: t.nogDoorsturen.som, bij: `${t.nogDoorsturen.aantal} wachtend · ${stand}` }),
    tegel({ naam: 'Te controleren', bedrag: null, bij: `${t.controle.aantal} factu${t.controle.aantal === 1 ? 'ur' : 'ren'} met een vraag`, let: t.controle.aantal > 0 }),
  ].join('\n  ');

  const samenvatting = vatSamen(inst.laatsteSyncResultaat);

  const inhoud = `<h1>Overzicht</h1>

<ul class="tegels">
  ${tegels}
</ul>

<div class="panelen">
  <section class="paneel" aria-labelledby="kop-grafiek">
    <h2 id="kop-grafiek">Factuurbedrag per maand</h2>
    ${maandGrafiek(opslag.perMaand(nu))}
  </section>
  <section class="paneel" aria-labelledby="kop-top">
    <h2 id="kop-top">Grootste leveranciers</h2>
    <p class="tegel__bij">Laatste twaalf maanden.</p>
    ${topLeveranciers(opslag.topLeveranciers(nu, 6))}
  </section>
</div>

<section aria-labelledby="kop-sync">
  <h2 id="kop-sync">Synchroniseren</h2>
  <form method="post" action="${basis}/sync">
    <div class="knoppen">
      <button class="knop" type="submit"${syncBezig ? ' disabled' : ''}>Nu synchroniseren</button>
    </div>
  </form>
  <p class="tegel__bij">
    ${inst.laatsteSync ? `Laatste ronde: ${e(datumTijdNl(inst.laatsteSync))}.` : 'Er is nog niet gesynchroniseerd.'}
    ${samenvatting ? ' ' + e(samenvatting) + '.' : ''}
    ${syncBezig ? ' Er loopt nu een ronde.' : ''}
  </p>
</section>

<h2>Facturen</h2>
${filterbalk(basis, filter, zoek)}
${regels.length
    ? `<ul class="lijst">\n${regels.map((f) => rij(f, basis, nu)).join('\n')}\n</ul>`
    : `<p class="leeg">Geen facturen in deze selectie${zoek ? ` voor "${e(zoek)}"` : ''}.</p>`}
${regels.length >= 500 ? '<p class="tegel__bij">Alleen de eerste 500 regels worden getoond; verfijn met het zoekveld.</p>' : ''}
`;

  return pagina({ titel: 'Overzicht', basis, actief: '/', inhoud, meldingen });
}

// Alleen gebruikt in de tegel-tekst hierboven; los gehouden zodat de test
// hem kan controleren zonder een heel scherm op te bouwen.
export function openstaandTekst(t) {
  return `${euro(t.open.som)} openstaand in ${t.open.aantal} factuur${t.open.aantal === 1 ? '' : 'en'}`;
}
