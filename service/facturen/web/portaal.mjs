// Startpagina van het portaal en de pagina's rond inloggen.

import { escapeHtml as e } from '../lib/hulp.mjs';
import { pagina } from './opmaak.mjs';

function tegel({ naam, getal, bij, href, let: letOp = false, extern = false }) {
  return `<li class="tegel tegel--link${letOp ? ' tegel--let' : ''}">
  <a href="${e(href)}"${extern ? ' rel="noopener noreferrer" target="_blank"' : ''}>
    <span class="tegel__naam">${e(naam)}</span>
    <span class="tegel__bedrag">${e(getal)}</span>
    <span class="tegel__bij">${e(bij)}</span>
  </a>
</li>`;
}

export function startPagina({ kader, facturen, mail, offertesUrl }) {
  const inhoud = `<h1>Welkom${kader.naam ? ', ' + e(String(kader.naam).split(' ')[0]) : ''}</h1>
<ul class="tegels tegels--start">
  ${tegel({
    naam: 'Facturen',
    getal: `${facturen.open} open`,
    bij: facturen.verlopen ? `${facturen.verlopen} verlopen` : 'niets verlopen',
    let: facturen.verlopen > 0,
    href: '/facturen/',
  })}
  ${tegel({
    naam: 'Mail',
    getal: `${mail.gesorteerdVandaag} gesorteerd vandaag`,
    bij: mail.teControleren ? `${mail.teControleren} te controleren (7 dagen)` : 'niets te controleren',
    let: mail.teControleren > 0 || mail.fouten > 0,
    href: '/mail/',
  })}
  ${offertesUrl ? tegel({
    naam: 'Offertes',
    getal: `${mail.offertesWeek} nieuw`,
    bij: 'offerteaanvragen in de mail, laatste 7 dagen · beheer opent met een eigen login',
    href: offertesUrl,
    extern: true,
  }) : tegel({
    naam: 'Offertes',
    getal: `${mail.offertesWeek} nieuw`,
    bij: 'offerteaanvragen in de mail, laatste 7 dagen',
    href: '/mail/?map=Offerteaanvragen',
  })}
</ul>
<p class="uitleg">Het offertebeheer heeft voorlopig nog zijn eigen login; één login voor alles volgt later.</p>
`;
  return pagina({ titel: 'Start', basis: '', inhoud, kader, menu: [], onderdeel: 'Portaal' });
}

// Kale pagina's zonder portaalbalk (niet ingelogd).
export function losPagina({ titel, tekst, link = null }) {
  return pagina({
    titel,
    basis: '',
    kader: null,
    menu: [],
    onderdeel: 'Portaal',
    inhoud: `<h1>${e(titel)}</h1>\n<p>${e(tekst)}</p>\n${link ? `<p><a class="knop" href="${e(link.href)}">${e(link.tekst)}</a></p>` : ''}`,
  });
}
