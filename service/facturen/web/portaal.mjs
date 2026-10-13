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

// Het formulier van de noodtoegang (lib/breakglass.mjs): gebruikersnaam,
// wachtwoord en TOTP-code. Geen CSRF-token (er is nog geen sessie); de
// herkomstcontrole (Sec-Fetch-Site/Origin) en de tailnet-eis vangen dat op.
export function breakglassPagina({ fout = '', gebruiker = '', geblokkeerd = false } = {}) {
  const formulier = geblokkeerd ? '' : `<form method="post" action="/breakglass" class="velden" autocomplete="off">
  <div class="veldgroep">
    <label for="gebruiker">Gebruikersnaam</label>
    <input id="gebruiker" name="gebruiker" type="text" value="${e(gebruiker)}" required autocomplete="username" autofocus>
  </div>
  <div class="veldgroep">
    <label for="wachtwoord">Wachtwoord</label>
    <input id="wachtwoord" name="wachtwoord" type="password" required autocomplete="current-password">
  </div>
  <div class="veldgroep">
    <label for="code">Code uit je authenticator-app</label>
    <input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code">
  </div>
  <p><button class="knop" type="submit">Inloggen</button></p>
</form>`;
  return pagina({
    titel: 'Noodtoegang',
    basis: '',
    kader: null,
    menu: [],
    onderdeel: 'Portaal',
    inhoud: `<p>Dit is de noodtoegang (break-glass) tot het portaal, alleen via de tailnet. Gebruik hem als inloggen met Microsoft niet werkt.</p>
${fout ? `<div class="melding melding--fout" role="alert"><p>${e(fout)}</p></div>` : ''}
${formulier}`,
  });
}
