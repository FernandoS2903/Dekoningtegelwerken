// Doorsturen van betaalde facturen naar de boekhouder.
//
// Hier zitten de sloten die voorkomen dat er per ongeluk post de deur uit gaat:
//  - geen boekhouderadres        -> niets versturen, waarschuwing
//  - testmodus (standaard aan)   -> automatisch doorsturen wordt alleen gelogd
//  - auto_doorsturen_sinds       -> alleen wat ná het aanzetten betaald is,
//                                   anders zou de eerste sync de hele historie
//                                   naar de boekhouder sturen
//  - nooit twee keer             -> doorgestuurd_op is leidend
//  - één mail met meerdere PDF's -> die mail gaat één keer de deur uit
//
// De handmatige knop verstuurt altijd echt, ook opnieuw, ook in testmodus.

import { datumNl } from './hulp.mjs';

export const CATEGORIE_BETAALD = 'Betaald';
export const CATEGORIE_DOORGESTUURD = 'Doorgestuurd boekhouder';

// Mag deze factuur automatisch mee? Puur, dus los te testen.
export function magAutomatisch(factuur, inst) {
  if (!inst.autoDoorsturen) return { mag: false, reden: 'automatisch doorsturen staat uit' };
  if (!inst.boekhouderEmails.length) return { mag: false, reden: 'geen boekhouderadres ingesteld' };
  if (factuur.status !== 'betaald') return { mag: false, reden: 'nog niet betaald' };
  if (factuur.doorgestuurd_op) return { mag: false, reden: 'al doorgestuurd' };
  if (!factuur.betaald_op) return { mag: false, reden: 'geen betaaldatum bekend' };

  const sinds = String(inst.autoDoorsturenSinds || '').slice(0, 10);
  if (!sinds) return { mag: false, reden: 'startmoment van automatisch doorsturen ontbreekt' };
  if (String(factuur.betaald_op).slice(0, 10) < sinds) {
    return { mag: false, reden: `betaald op ${datumNl(factuur.betaald_op)}, vóór het aanzetten van automatisch doorsturen` };
  }
  return { mag: true, reden: '' };
}

// De begeleidende tekst van Bob, gevolgd door de kerngegevens.
export function berichtVoorBoekhouder(factuur, inst) {
  const regels = [];
  if (inst.doorstuurTekst) regels.push(inst.doorstuurTekst, '');
  regels.push(
    `Leverancier: ${factuur.leverancier || 'onbekend'}`,
    `Factuurnummer: ${factuur.factuurnummer || 'onbekend'}`,
    `Betaald op: ${datumNl(factuur.betaald_op)}`,
  );
  // Graph zet deze tekst in de body van de doorgestuurde mail. Gewone
  // regeleindes, geen HTML: bij een platte body zouden tags zichtbaar worden.
  return regels.join('\n');
}

// Stuurt één factuur door. `handmatig` omzeilt testmodus en de sindsdatum,
// maar nooit het ontbreken van een adres.
export async function stuurDoor(opslag, graph, factuur, { inst, handmatig = false }) {
  if (!inst.boekhouderEmails.length) {
    opslag.log('warn', 'Doorsturen overgeslagen: er is geen e-mailadres van de boekhouder ingesteld.', factuur.id);
    return { verstuurd: false, reden: 'geen boekhouderadres ingesteld' };
  }

  if (!handmatig && inst.testmodus) {
    opslag.log('info', `TESTMODUS: zou doorsturen naar ${inst.boekhouderEmails.join(', ')}`, factuur.id);
    return { verstuurd: false, testmodus: true, reden: 'testmodus staat aan' };
  }

  if (!graph || !graph.beschikbaar) {
    opslag.log('warn', 'Doorsturen overgeslagen: Microsoft 365 is niet ingesteld.', factuur.id);
    return { verstuurd: false, reden: 'Microsoft 365 is niet ingesteld' };
  }

  await graph.stuurDoor(factuur.message_id, {
    commentaar: berichtVoorBoekhouder(factuur, inst),
    naar: inst.boekhouderEmails,
  });

  const naar = inst.boekhouderEmails.join(', ');
  opslag.zetDoorgestuurd(factuur.id, naar);
  opslag.log('info', `Doorgestuurd naar ${naar}${handmatig ? ' (handmatig)' : ''}`, factuur.id);

  // De originele mail ging als geheel de deur uit. Zat er meer dan één PDF in,
  // dan heeft de boekhouder die ook gekregen; die regels blijven dus niet als
  // achterstand staan.
  for (const andere of opslag.facturenVanMail(factuur.message_id)) {
    if (andere.id === factuur.id || andere.doorgestuurd_op) continue;
    opslag.zetDoorgestuurd(andere.id, naar);
    opslag.log('info', `Meegestuurd in de doorgestuurde mail van factuur #${factuur.id}`, andere.id);
  }

  if (inst.outlookCategorie) {
    try {
      await graph.voegCategorieToe(factuur.message_id, CATEGORIE_DOORGESTUURD);
    } catch (fout) {
      opslag.log('warn', 'Categorie "Doorgestuurd boekhouder" zetten mislukt: ' + fout.message, factuur.id);
    }
  }

  return { verstuurd: true, naar };
}

// Alles wat betaald is en nog niet doorgestuurd, langs de regels. Dit draait
// aan het eind van elke sync-ronde.
export async function verwerkAchterstand(opslag, graph, inst) {
  const wachtend = opslag.lijst('doorsturen', '', '9999-12-31');
  let verstuurd = 0;
  let overgeslagen = 0;
  let getest = 0;

  for (const factuur of wachtend) {
    const { mag } = magAutomatisch(factuur, inst);
    if (!mag) { overgeslagen++; continue; }

    // Kan in deze ronde al meegegaan zijn als bijlage van dezelfde mail.
    const vers = opslag.factuur(factuur.id);
    if (!vers || vers.doorgestuurd_op) { overgeslagen++; continue; }

    try {
      const uitkomst = await stuurDoor(opslag, graph, vers, { inst, handmatig: false });
      if (uitkomst.verstuurd) verstuurd++;
      else if (uitkomst.testmodus) getest++;
      else overgeslagen++;
    } catch (fout) {
      opslag.log('error', 'Doorsturen mislukt: ' + fout.message, factuur.id);
      overgeslagen++;
    }
  }

  return { verstuurd, overgeslagen, getest, wachtend: wachtend.length };
}
