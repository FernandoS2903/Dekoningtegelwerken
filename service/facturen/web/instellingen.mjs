// Scherm 3: instellingen, verbindingen testen en het logboek.

import { escapeHtml as e } from '../lib/hulp.mjs';
import { DREMPEL_MAX, DREMPEL_MIN, TERUGKIJKEN_MAX, TERUGKIJKEN_MIN } from '../lib/instellingen.mjs';
import { geschiedenis, pagina } from './opmaak.mjs';

function schakel(naam, label, uitleg, aan) {
  return `<div class="schakel">
  <input type="checkbox" id="s-${naam}" name="${naam}" value="1"${aan ? ' checked' : ''}>
  <label for="s-${naam}">${e(label)}<span class="uitleg">${uitleg}</span></label>
</div>`;
}

function uitslagRegel(naam, uitslag) {
  if (!uitslag) return `<li><strong>${e(naam)}</strong> — nog niet getest</li>`;
  return `<li><strong>${e(naam)}</strong> — <span class="${uitslag.ok ? 'ja' : 'nee'}">${uitslag.ok ? 'in orde' : 'werkt niet'}</span>: ${e(uitslag.melding)}</li>`;
}

export function instellingenPagina({ basis, opslag, inst, test = null, meldingen = [] }) {
  const inhoud = `<h1>Instellingen</h1>

<form method="post" action="${basis}/instellingen">
  <fieldset class="veldgroep">
    <legend>Boekhouder</legend>
    <p>
      <label for="boekhouder_email">E-mailadres(sen) van de boekhouder</label>
      <input type="text" id="boekhouder_email" name="boekhouder_email"
        value="${e(inst.ruw.boekhouder_email || '')}"
        placeholder="naam@kantoor.nl, tweede@kantoor.nl">
      <span class="uitleg">Meerdere adressen scheiden met een komma. Staat hier niets, dan wordt
        er niets doorgestuurd — ook niet automatisch.</span>
    </p>
    <p>
      <label for="doorstuur_tekst">Begeleidende tekst</label>
      <textarea id="doorstuur_tekst" name="doorstuur_tekst">${e(inst.doorstuurTekst)}</textarea>
      <span class="uitleg">Komt boven de doorgestuurde mail te staan. Leverancier,
        factuurnummer en betaaldatum worden er automatisch onder gezet.</span>
    </p>
  </fieldset>

  <fieldset class="veldgroep">
    <legend>Doorsturen</legend>
    ${schakel('auto_doorsturen', 'Automatisch doorsturen zodra betaald',
    'Alleen facturen die ná het aanzetten van deze schakelaar betaald zijn. Zo gaat de hele '
    + 'historie niet in één keer de deur uit. Oudere betaalde facturen blijven onder "Nog naar '
    + 'boekhouder" staan en gaan alleen met de knop.', inst.autoDoorsturen)}
    ${schakel('testmodus', 'Testmodus',
    'Aan betekent: automatisch doorsturen wordt alleen in het logboek gezet, er gaat niets echt '
    + 'weg. De knop op een factuur verstuurt wél altijd echt. Laat dit aanstaan tot je de '
    + 'eerste rondes hebt nagekeken.', inst.testmodus)}
    ${schakel('outlook_categorie', 'Categorie zetten in Outlook',
    'Zet "Betaald" en "Doorgestuurd boekhouder" als categorie op de oorspronkelijke mail in de '
    + 'mailbox.', inst.outlookCategorie)}
  </fieldset>

  <fieldset class="veldgroep">
    <legend>Koppelen en terugkijken</legend>
    <p>
      <label for="match_drempel">Matchdrempel</label>
      <input type="number" id="match_drempel" name="match_drempel" step="0.05"
        min="${DREMPEL_MIN}" max="${DREMPEL_MAX}" value="${e(inst.matchDrempel)}">
      <span class="uitleg">Vanaf deze zekerheid wordt een bunq-betaling automatisch aan een
        factuur gekoppeld en gaat de factuur op betaald. Daaronder wordt het een voorstel dat je
        zelf bevestigt. Een exact gelijk bedrag is altijd verplicht; bedrag plus IBAN komt op
        0,80, bedrag plus kenmerk op 0,70. Lager dan ${DREMPEL_MIN} kan niet.</span>
    </p>
    <p>
      <label for="terugkijken_dagen">Terugkijkperiode in dagen</label>
      <input type="number" id="terugkijken_dagen" name="terugkijken_dagen" step="1"
        min="${TERUGKIJKEN_MIN}" max="${TERUGKIJKEN_MAX}" value="${e(inst.terugkijkenDagen)}">
      <span class="uitleg">Hoe ver elke ronde terugkijkt in de mailbox en in de bunq-betalingen.
        Groter betekent een langzamere ronde en meer verzoeken naar Microsoft en bunq.</span>
    </p>
  </fieldset>

  <div class="knoppen"><button class="knop" type="submit">Instellingen opslaan</button></div>
</form>

<section aria-labelledby="kop-test">
  <h2 id="kop-test">Verbindingen testen</h2>
  <form method="post" action="${basis}/instellingen/test">
    <div class="knoppen"><button class="knop knop--rustig" type="submit">Verbindingen testen</button></div>
  </form>
  ${test ? `<ul class="uitslag">
    ${uitslagRegel('Microsoft 365', test.graph)}
    ${uitslagRegel('bunq', test.bunq)}
    ${uitslagRegel('Claude', test.claude)}
  </ul>` : '<p class="tegel__bij">Er wordt niets gewijzigd; er wordt alleen gekeken of de koppelingen werken.</p>'}
</section>

<section aria-labelledby="kop-logboek">
  <h2 id="kop-logboek">Logboek</h2>
  ${geschiedenis(opslag.logboek(100))}
</section>
`;

  return pagina({ titel: 'Instellingen', basis, actief: '/instellingen', inhoud, meldingen });
}
