// Het dashboard (KPI-kaarten, grafiek, grootste leveranciers, actie vereist)
// en het facturenoverzicht (tabel met zoeken, filters en sortering).

import { datumNl, escapeHtml as e, euro } from '../lib/hulp.mjs';
import { vatSamen } from '../lib/sync.mjs';
import {
  filterbalk, maandGrafiek, pagina, rij, syncStatus, tabelKop, tegel, topLeveranciers, vlag, factuurNaam,
} from './opmaak.mjs';

function kpiKaarten(t, inst, basis) {
  const stand = inst.testmodus ? 'testmodus' : inst.autoDoorsturen ? 'automatisch' : 'met de knop';
  return `<ul class="tegels tegels--kpi">
  ${[
    tegel({ naam: 'Openstaand', bedrag: t.open.som, bij: `${t.open.aantal} factuur${t.open.aantal === 1 ? '' : 'en'}`, href: `${basis}/` }),
    tegel({ naam: 'Verlopen', bedrag: t.verlopen.som, bij: `${t.verlopen.aantal} over de vervaldatum`, let: t.verlopen.aantal > 0, href: `${basis}/?filter=verlopen` }),
    tegel({ naam: 'Betaald deze maand', bedrag: t.betaaldDezeMaand.som, bij: `${t.betaaldDezeMaand.aantal} betaald`, href: `${basis}/?filter=betaald` }),
    tegel({ naam: 'Nog door te sturen', bedrag: t.nogDoorsturen.som, bij: `${t.nogDoorsturen.aantal} wachtend · ${stand}`, href: `${basis}/?filter=doorsturen` }),
    tegel({ naam: 'Te controleren', getal: t.controle.aantal, bij: t.controle.aantal === 1 ? 'factuur met een vraag' : 'facturen met een vraag', let: t.controle.aantal > 0, href: `${basis}/?filter=controle` }),
  ].join('\n  ')}
</ul>`;
}

function actieVereist(lijst, basis, nu) {
  if (!lijst.length) return '<p class="leeg leeg--rustig">Niets dat aandacht vraagt.</p>';
  return `<ul class="acties">
  ${lijst.map((f) => `<li><a class="actie" href="${basis}/factuur/${f.id}" data-factuur="${f.id}">
    <span class="actie__naam">${e(factuurNaam(f))}<small>${e(f.factuurnummer ? 'nr. ' + f.factuurnummer : (f.onderwerp || ''))}</small></span>
    <span class="actie__reden">${e(f.actie)}${f.actie === 'verlopen' && f.vervaldatum ? ` sinds ${e(datumNl(f.vervaldatum))}` : ''}</span>
    <span class="actie__bedrag">${f.bedrag === null ? '—' : e(euro(f.bedrag, f.valuta))}</span>
    ${vlag(f, nu)}
  </a></li>`).join('\n  ')}
</ul>`;
}

// Het dashboard: op het portaal de startpagina (/), met de facturen onder
// `basis` (/facturen). `mail` is optioneel: de tellingen van de sorteerder.
export function dashboardPagina({ basis, opslag, inst, nu, meldingen = [], syncBezig = false, kader = null, mail = null, offertesUrl = '' }) {
  const t = opslag.tegels(nu);
  const samenvatting = vatSamen(inst.laatsteSyncResultaat);
  const acties = opslag.actieVereist(nu, 8);

  const mailBlok = mail ? `<section class="paneel" aria-labelledby="kop-mail">
    <h2 id="kop-mail">Mail</h2>
    <ul class="kerncijfers">
      <li><a href="/mail/"><strong>${mail.gesorteerdVandaag}</strong> gesorteerd vandaag</a></li>
      <li><a href="/mail/?status=controleren"${mail.teControleren ? ' class="let"' : ''}><strong>${mail.teControleren}</strong> te controleren (7 dagen)</a></li>
      <li><a href="/mail/?map=Offerteaanvragen"><strong>${mail.offertesWeek}</strong> offerteaanvragen (7 dagen)</a></li>
      ${mail.fouten ? `<li><a href="/mail/?status=fout" class="let"><strong>${mail.fouten}</strong> fout${mail.fouten === 1 ? '' : 'en'} bij het sorteren</a></li>` : ''}
    </ul>
    ${offertesUrl ? `<p class="tegel__bij"><a href="${e(offertesUrl)}" rel="noopener noreferrer" target="_blank">Offertebeheer openen ↗</a> (eigen login)</p>` : ''}
  </section>` : '';

  const inhoud = `${kpiKaarten(t, inst, basis)}

<div class="panelen panelen--dashboard">
  <section class="paneel paneel--grafiek" aria-labelledby="kop-grafiek">
    <h2 id="kop-grafiek">Factuurbedrag per maand</h2>
    ${maandGrafiek(opslag.perMaand(nu))}
  </section>
  <section class="paneel" aria-labelledby="kop-top">
    <h2 id="kop-top">Grootste leveranciers</h2>
    <p class="tegel__bij">Laatste twaalf maanden · <a href="${basis}/leveranciers">alle leveranciers</a></p>
    ${topLeveranciers(opslag.topLeveranciers(nu, 6), basis)}
  </section>
  <section class="paneel paneel--acties" aria-labelledby="kop-acties">
    <h2 id="kop-acties">Actie vereist${acties.length ? ` <span class="telling">${acties.length}</span>` : ''}</h2>
    ${actieVereist(acties, basis, nu)}
  </section>
  ${mailBlok}
</div>
`;

  return pagina({
    titel: 'Dashboard', basis, actief: '/', inhoud, meldingen, kader,
    onderdeel: 'Dashboard', menu: [], kopActies: syncStatus({ basis, inst, samenvatting, bezig: syncBezig }),
  });
}

// Het facturenoverzicht: zoeken, statusfilters, sortering en de tabel.
export function overzicht({ basis, opslag, inst, filter, zoek, sorteer = '', nu, meldingen = [], syncBezig = false, kader = null }) {
  const regels = opslag.lijst(filter, zoek, nu, sorteer);
  const samenvatting = vatSamen(inst.laatsteSyncResultaat);
  const totaal = regels.reduce((som, f) => som + (Number(f.bedrag) || 0), 0);

  const inhoud = `${filterbalk(basis, filter, zoek, sorteer)}
<div data-splits>
<div class="lijstvak" data-lijst>
  <p class="lijst__telling">${regels.length} factuur${regels.length === 1 ? '' : 'en'}${regels.length ? ` · ${e(euro(totaal))}` : ''}${zoek ? ` · zoekterm "${e(zoek)}"` : ''}</p>
  ${regels.length
    ? `<ul class="lijst lijst--tabel">\n${tabelKop(basis, { filter, zoek, sorteer })}\n${regels.map((f) => rij(f, basis, nu)).join('\n')}\n</ul>`
    : `<p class="leeg">Geen facturen in deze selectie${zoek ? ` voor "${e(zoek)}"` : ''}.</p>`}
  ${regels.length >= 500 ? '<p class="tegel__bij">Alleen de eerste 500 regels worden getoond; verfijn met het zoekveld.</p>' : ''}
</div>
<aside class="zijpaneel" data-zijpaneel hidden aria-label="Factuur"></aside>
</div>
`;

  return pagina({
    titel: 'Facturen', basis, actief: '/', inhoud, meldingen, kader, onderdeel: 'Facturen',
    menu: kader ? [] : undefined, kopActies: syncStatus({ basis, inst, samenvatting, bezig: syncBezig }), kopKlasse: 'paginakop--lijst',
  });
}

// Alleen gebruikt in de tegel-tekst hierboven; los gehouden zodat de test
// hem kan controleren zonder een heel scherm op te bouwen.
export function openstaandTekst(t) {
  return `${euro(t.open.som)} openstaand in ${t.open.aantal} factuur${t.open.aantal === 1 ? '' : 'en'}`;
}
