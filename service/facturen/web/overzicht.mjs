// Het dashboard (KPI-kaarten van de inkoop, grafiek, grootste leveranciers,
// actie vereist, verkoop via Offerteknop, mail) en het overzicht van de
// inkoopfacturen (tabel met zoeken, filters en sortering).

import { datumNl, escapeHtml as e, euro } from '../lib/hulp.mjs';
import { vatSamen } from '../lib/sync.mjs';
import {
  filterbalk, icoon, maandGrafiek, offerteknopLink, pagina, rij, syncStatus, tabelKop, tegel, topLeveranciers, vlag, factuurNaam,
} from './opmaak.mjs';

function kpiKaarten(t, inst, basis) {
  const stand = inst.testmodus ? 'testmodus' : inst.autoDoorsturen ? 'automatisch' : 'met de knop';
  return `<ul class="tegels tegels--kpi" aria-label="Inkoop">
  ${[
    tegel({ naam: 'Te betalen', bedrag: t.open.som, bij: `${t.open.aantal} inkoopfactu${t.open.aantal === 1 ? 'ur' : 'ren'} open`, href: `${basis}/` }),
    tegel({ naam: 'Verlopen', bedrag: t.verlopen.som, bij: `${t.verlopen.aantal} over de vervaldatum`, let: t.verlopen.aantal > 0, href: `${basis}/?filter=verlopen` }),
    tegel({ naam: 'Betaald deze maand', bedrag: t.betaaldDezeMaand.som, bij: `${t.betaaldDezeMaand.aantal} betaald`, href: `${basis}/?filter=betaald` }),
    tegel({ naam: 'Nog door te sturen', bedrag: t.nogDoorsturen.som, bij: `${t.nogDoorsturen.aantal} wachtend · ${stand}`, href: `${basis}/?filter=doorsturen` }),
    tegel({ naam: 'Te controleren', getal: t.controle.aantal, bij: t.controle.aantal === 1 ? 'inkoopfactuur met een vraag' : 'inkoopfacturen met een vraag', let: t.controle.aantal > 0, href: `${basis}/?filter=controle` }),
  ].join('\n  ')}
</ul>`;
}

// Het blok Verkoop: offertes en aanvragen leven in Offerteknop. Alleen de
// stand van de website-aanvragen die nog niet zijn doorgestuurd (wachtrij)
// staat hier, zodat een haperende koppeling niet onzichtbaar blijft.
export function verkoopPaneel(link, aanvragen = null) {
  const wacht = aanvragen && aanvragen.wacht ? `<li><span class="let"><strong>${aanvragen.wacht}</strong> website-aanvra${aanvragen.wacht === 1 ? 'ag wacht' : 'gen wachten'} op doorsturen naar Offerteknop</span></li>` : '';
  const gestopt = aanvragen && aanvragen.gestopt ? `<li><span class="let"><strong>${aanvragen.gestopt}</strong> website-aanvra${aanvragen.gestopt === 1 ? 'ag' : 'gen'} niet doorgestuurd; zie het logboek</span></li>` : '';
  return `<section class="paneel paneel--verkoop" aria-labelledby="kop-verkoop">
    <h2 id="kop-verkoop">Verkoop</h2>
    <p class="tegel__bij">Offertes en aanvragen van de website beheer je in Offerteknop. Nieuwe aanvragen van het formulier komen daar als "Nieuwe aanvraag" binnen; een kopie gaat naar de mailbox.</p>
    ${wacht || gestopt ? `<ul class="kerncijfers">${wacht}${gestopt}</ul>` : ''}
    ${link ? `<p class="knoppen"><a class="knop" href="${e(link)}" rel="noopener noreferrer" target="_blank">${icoon('extern')}<span>Offerteknop openen</span></a></p>` : '<p class="tegel__bij">De link naar Offerteknop is niet ingesteld (OFFERTES_URL).</p>'}
  </section>`;
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

// Het dashboard: op het portaal de startpagina (/), met de inkoopfacturen
// onder `basis` (/facturen). `mail` is optioneel: de tellingen van de
// sorteerder; `aanvragen` de stand van de wachtrij van website-aanvragen.
export function dashboardPagina({ basis, opslag, inst, nu, meldingen = [], syncBezig = false, kader = null, mail = null, aanvragen = null }) {
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
  </section>` : '';
  const verkoopBlok = verkoopPaneel(offerteknopLink(kader), aanvragen);

  const inhoud = `<p class="dashboard__uitleg">De cijfers hieronder zijn de <strong>inkoopkant</strong>: facturen van leveranciers uit de mailbox. De verkoopkant (offertes en aanvragen) staat in Offerteknop.</p>
${kpiKaarten(t, inst, basis)}

<div class="panelen panelen--dashboard">
  <section class="paneel paneel--grafiek" aria-labelledby="kop-grafiek">
    <h2 id="kop-grafiek">Inkoop per maand</h2>
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
  ${verkoopBlok}
  ${mailBlok}
</div>
`;

  return pagina({
    titel: 'Dashboard', basis, actief: '/', inhoud, meldingen, kader,
    onderdeel: 'Dashboard', menu: [], kopActies: syncStatus({ basis, inst, samenvatting, bezig: syncBezig }),
  });
}

// Het overzicht van de inkoopfacturen: zoeken, statusfilters, sortering en de tabel.
// `betalen`: toon de link naar "Betalen via bunq" (selectie van open facturen).
export function overzicht({ basis, opslag, inst, filter, zoek, sorteer = '', nu, meldingen = [], syncBezig = false, kader = null, betalen = false }) {
  const regels = opslag.lijst(filter, zoek, nu, sorteer);
  const samenvatting = vatSamen(inst.laatsteSyncResultaat);
  const totaal = regels.reduce((som, f) => som + (Number(f.bedrag) || 0), 0);

  const inhoud = `${filterbalk(basis, filter, zoek, sorteer)}
<div data-splits>
<div class="lijstvak" data-lijst>
  <div class="lijst__balk">
    <p class="lijst__telling">${regels.length} inkoopfactu${regels.length === 1 ? 'ur' : 'ren'}${regels.length ? ` · ${e(euro(totaal))}` : ''}${zoek ? ` · zoekterm "${e(zoek)}"` : ''}</p>
    ${betalen ? `<a class="knop knop--rustig knop--klein" href="${basis}/betalen">Meerdere betalen via bunq</a>` : ''}
  </div>
  ${regels.length
    ? `<ul class="lijst lijst--tabel">\n${tabelKop(basis, { filter, zoek, sorteer })}\n${regels.map((f) => rij(f, basis, nu)).join('\n')}\n</ul>`
    : `<p class="leeg">Geen inkoopfacturen in deze selectie${zoek ? ` voor "${e(zoek)}"` : ''}.</p>`}
  ${regels.length >= 500 ? '<p class="tegel__bij">Alleen de eerste 500 regels worden getoond; verfijn met het zoekveld.</p>' : ''}
</div>
<aside class="zijpaneel" data-zijpaneel hidden aria-label="Factuur"></aside>
</div>
`;

  return pagina({
    titel: 'Inkoopfacturen', basis, actief: '/', inhoud, meldingen, kader, onderdeel: 'Inkoopfacturen',
    menu: kader ? [] : undefined, kopActies: syncStatus({ basis, inst, samenvatting, bezig: syncBezig }), kopKlasse: 'paginakop--lijst',
  });
}

// Alleen gebruikt in de tegel-tekst hierboven; los gehouden zodat de test
// hem kan controleren zonder een heel scherm op te bouwen.
export function openstaandTekst(t) {
  return `${euro(t.open.som)} openstaand in ${t.open.aantal} factuur${t.open.aantal === 1 ? '' : 'en'}`;
}
