// Scherm 3: instellingen, verbindingen testen en het logboek.

import { escapeHtml as e, euro, ibanLeesbaar } from '../lib/hulp.mjs';
import {
  BETALEN_MAX_MAX, BETALEN_MAX_MIN, DREMPEL_MAX, DREMPEL_MIN, TERUGKIJKEN_MAX, TERUGKIJKEN_MIN,
} from '../lib/instellingen.mjs';
import { geschiedenis, pagina } from './opmaak.mjs';

export function schakel(naam, label, uitleg, aan) {
  return `<div class="schakel">
  <input type="checkbox" id="s-${naam}" name="${naam}" value="1"${aan ? ' checked' : ''}>
  <label for="s-${naam}">${e(label)}<span class="uitleg">${uitleg}</span></label>
</div>`;
}

export function uitslagRegel(naam, uitslag) {
  if (!uitslag) return `<li><strong>${e(naam)}</strong> — nog niet getest</li>`;
  return `<li><strong>${e(naam)}</strong> — <span class="${uitslag.ok ? 'ja' : 'nee'}">${uitslag.ok ? 'in orde' : 'werkt niet'}</span>: ${e(uitslag.melding)}</li>`;
}

// De keuze van de van-rekening: alleen bankrekeningen uit bunq, zonder
// voorkeuze. `rekeningen` = {lijst, fout} (null als bunq niet is ingesteld).
function betalenVeldgroep(inst, rekeningen) {
  const gekozen = inst.betalenRekening;
  const lijst = rekeningen?.lijst || [];
  const opties = lijst.map((r) => `<option value="${e(r.id)}"${gekozen && gekozen.id === r.id ? ' selected' : ''}>`
    + `${e(r.naam || 'Rekening')} — ${e(r.iban ? ibanLeesbaar(r.iban) : 'geen IBAN')}</option>`).join('');
  // Een gekozen rekening die (nu) niet in de lijst staat, blijft zichtbaar.
  const losGekozen = gekozen && !lijst.some((r) => r.id === gekozen.id)
    ? `<option value="${e(gekozen.id)}" selected>${e(gekozen.naam || 'Rekening')} — ${e(gekozen.iban ? ibanLeesbaar(gekozen.iban) : gekozen.id)}</option>`
    : '';
  const melding = !rekeningen
    ? 'bunq is niet ingesteld in de env; er is niets te kiezen.'
    : rekeningen.fout
      ? `De rekeningen konden niet bij bunq worden opgehaald: ${rekeningen.fout}`
      : 'Alleen bankrekeningen, geen spaarrekeningen. Kies de zakelijke rekening.';
  return `<fieldset class="veldgroep">
    <legend>Betalen via bunq</legend>
    <p class="tegel__bij">Het portaal zet alleen <strong>conceptbetalingen</strong> klaar. Er gaat pas geld weg
      als je die in de bunq-app goedkeurt. Alleen met inloggen via Microsoft, niet via de noodtoegang.</p>
    <p>
      <label for="betalen_rekening_id">Betalen vanaf rekening</label>
      <select id="betalen_rekening_id" name="betalen_rekening_id"${rekeningen ? '' : ' disabled'}>
        <option value=""${gekozen ? '' : ' selected'}>— kies een rekening —</option>
        ${losGekozen}${opties}
      </select>
      <span class="uitleg">${e(melding)}</span>
    </p>
    ${schakel('betalen_aan', 'Betalen via bunq',
    'Toont de knop "Betalen via bunq" bij open facturen. Kan pas aan als er hierboven een rekening is gekozen.', inst.ruw.betalen_aan === '1')}
    <p>
      <label for="betalen_max">Maximumbedrag per conceptbetaling (€)</label>
      <input type="number" id="betalen_max" name="betalen_max" step="1"
        min="${BETALEN_MAX_MIN}" max="${BETALEN_MAX_MAX}" value="${e(inst.betalenMax)}">
      <span class="uitleg">Geldt voor het totaal van één conceptbetaling, ook als je meerdere facturen
        tegelijk betaalt. Nu ${e(euro(inst.betalenMax))}.</span>
    </p>
  </fieldset>`;
}

export function instellingenPagina({ basis, opslag, inst, test = null, meldingen = [], kader = null, rekeningen = null }) {
  const inhoud = `<form method="post" action="${basis}/instellingen">
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

  ${betalenVeldgroep(inst, rekeningen)}

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

  return pagina({
    titel: 'Instellingen', basis, actief: '/instellingen', inhoud, meldingen, kader, onderdeel: 'Instellingen',
    subnav: kader ? [{ pad: `${basis}/instellingen`, naam: 'Inkoopfacturen', actief: true }, { pad: '/mail/instellingen', naam: 'Mail' }] : null,
  });
}
