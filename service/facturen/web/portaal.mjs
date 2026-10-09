// De pagina's rond inloggen (zonder sidebar). Het dashboard zelf staat in
// web/overzicht.mjs.

import { escapeHtml as e } from '../lib/hulp.mjs';
import { pagina } from './opmaak.mjs';

// Kale pagina's zonder portaalbalk (niet ingelogd).
export function losPagina({ titel, tekst, link = null }) {
  return pagina({
    titel,
    basis: '',
    kader: null,
    menu: [],
    onderdeel: 'Portaal',
    inhoud: `<p>${e(tekst)}</p>\n${link ? `<p><a class="knop" href="${e(link.href)}">${e(link.tekst)}</a></p>` : ''}`,
  });
}
