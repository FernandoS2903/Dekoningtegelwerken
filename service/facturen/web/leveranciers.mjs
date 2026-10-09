// Leveranciers: één regel per leverancier met aantal, totaal, open en
// verlopen, en de laatste factuur. Klikken opent de factuurlijst gefilterd op
// die leverancier. Geen eigen gegevens: alles komt uit de facturen zelf.

import { datumNl, escapeHtml as e, euro } from '../lib/hulp.mjs';
import { pagina } from './opmaak.mjs';

export function leveranciersPagina({ basis, opslag, nu, zoek = '', meldingen = [], kader = null }) {
  const alles = opslag.leveranciers(nu);
  const term = zoek.trim().toLowerCase();
  const lijst = term ? alles.filter((r) => r.leverancier.toLowerCase().includes(term)) : alles;
  const link = (naam) => `${basis}/?${new URLSearchParams({ filter: 'alle', zoek: naam })}`;

  const inhoud = `<form class="zoek zoek--los" method="get" action="${basis}/leveranciers" data-zoek>
  <label class="verborgen" for="zoek">Zoeken</label>
  <span class="zoek__veld"><input type="search" id="zoek" name="zoek" value="${e(zoek)}" placeholder="Naam van de leverancier"></span>
  <button class="knop knop--rustig" type="submit">Zoek</button>
</form>
<p class="lijst__telling">${lijst.length} leverancier${lijst.length === 1 ? '' : 's'}</p>
${lijst.length ? `<ul class="lijst lijst--tabel lijst--leveranciers">
  <li class="tabelkop" aria-hidden="true">
    <span class="tabelkop__leverancier">Leverancier</span>
    <span class="tabelkop__aantal tabelkop--recht">Facturen</span>
    <span class="tabelkop__open tabelkop--recht">Open</span>
    <span class="tabelkop__som tabelkop--recht">Totaal</span>
    <span class="tabelkop__laatste">Laatste</span>
  </li>
  ${lijst.map((r) => `<li><a class="rij rij--leverancier" href="${e(link(r.leverancier))}">
    <span class="rij__naam"><span>${e(r.leverancier)}</span>${r.verlopen_aantal ? `<small class="let">${r.verlopen_aantal} verlopen</small>` : ''}</span>
    <span class="rij__aantal"><small>facturen</small>${r.aantal}</span>
    <span class="rij__open${r.open_aantal ? '' : ' rij__open--leeg'}"><small>open</small>${r.open_aantal ? e(euro(r.open_som)) : '—'}</span>
    <span class="rij__bedrag"><small>totaal</small>${e(euro(r.som))}</span>
    <span class="rij__datum"><small>laatste</small>${e(datumNl(r.laatste))}</span>
  </a></li>`).join('\n  ')}
</ul>` : `<p class="leeg">Geen leveranciers${term ? ` voor "${e(zoek)}"` : ' met facturen'}.</p>`}
`;

  return pagina({ titel: 'Leveranciers', basis, inhoud, meldingen, kader, onderdeel: 'Leveranciers', menu: kader ? [] : undefined });
}
