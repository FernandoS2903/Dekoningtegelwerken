// De sync-ronde: mail -> uitlezen -> bunq -> koppelen -> achterstand doorsturen.
//
// Elke stap is los afgevangen: valt Microsoft 365 weg, dan loopt het koppelen
// van bunq-betalingen gewoon door, en omgekeerd. Het resultaat per stap gaat
// als JSON naar de instelling `laatste_sync_resultaat`, zodat het overzicht
// kan laten zien wat er wel en niet lukte.
//
// Er draait nooit meer dan één ronde tegelijk; de knop in het scherm en de
// timer vallen op dezelfde vlag terug.

import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { MAX_PER_RONDE } from './claude.mjs';
import * as koppelen from './koppelen.mjs';
import { verwerkAchterstand } from './doorsturen.mjs';
import { datumPlusDagen, nuIso, vandaag, veiligeBestandsnaam } from './hulp.mjs';

export function maakSync({ opslag, graph, claude, bunq, pdfMap, instellingenLezer }) {
  let bezig = false;

  // -- stap 1: nieuwe mails ophalen -------------------------------------
  async function haalMails(inst) {
    if (!graph || !graph.beschikbaar) return { overgeslagen: 'Microsoft 365 niet ingesteld' };

    const vanafDatum = datumPlusDagen(vandaag(), -inst.terugkijkenDagen);
    const bekend = opslag.bekendeMessageIds();
    const mails = await graph.mails({ vanaf: vanafDatum + 'T00:00:00Z', bekend });

    let nieuweFacturen = 0;
    let zonderPdf = 0;

    for (const mail of mails) {
      const gemeen = {
        message_id: mail.id,
        ontvangen: mail.receivedDateTime || null,
        afzender_naam: mail.from?.emailAddress?.name || null,
        afzender_email: mail.from?.emailAddress?.address || null,
        onderwerp: mail.subject || null,
      };

      let bijlagen = [];
      if (mail.hasAttachments) bijlagen = await graph.pdfBijlagen(mail.id);

      if (bijlagen.length) {
        for (const bijlage of bijlagen) {
          const bestandsnaam = `${crypto.randomUUID()}-${veiligeBestandsnaam(bijlage.name)}`;
          writeFileSync(path.join(pdfMap, bestandsnaam), Buffer.from(bijlage.contentBytes, 'base64'), { mode: 0o600 });
          const { nieuw } = opslag.voegFactuurToe({
            ...gemeen,
            attachment_id: bijlage.id,
            bijlage_naam: bijlage.name || null,
            // Alleen de bestandsnaam, nooit een heel pad: de route die de PDF
            // uitlevert plakt hem aan de pdf-map en controleert het resultaat.
            pdf_pad: bestandsnaam,
          });
          if (nieuw) nieuweFacturen++;
        }
      } else {
        const tekst = await graph.mailTekst(mail.id);
        const { nieuw } = opslag.voegFactuurToe({ ...gemeen, attachment_id: '', mail_tekst: tekst });
        if (nieuw) { nieuweFacturen++; zonderPdf++; }
      }
    }

    return { mails: mails.length, nieuw: nieuweFacturen, zonderPdf };
  }

  // -- stap 2: laten uitlezen -------------------------------------------
  async function leesUit() {
    if (!claude || !claude.beschikbaar) return { overgeslagen: 'Claude-sleutel niet ingesteld' };

    const wachtend = opslag.teLezenFacturen(MAX_PER_RONDE);
    let gelukt = 0;
    let geenFactuur = 0;
    let mislukt = 0;

    for (const factuur of wachtend) {
      try {
        const pdf = factuur.pdf_pad ? await leesPdf(factuur.pdf_pad) : null;
        const uitkomst = await claude.leesFactuur({
          pdf,
          tekst: factuur.mail_tekst || '',
          afzender: [factuur.afzender_naam, factuur.afzender_email].filter(Boolean).join(' '),
          onderwerp: factuur.onderwerp || '',
        });

        if (!uitkomst.isFactuur) {
          opslag.zetUitgelezen(factuur.id, 'geen_factuur', uitkomst.velden);
          opslag.zetStatus(factuur.id, 'genegeerd');
          opslag.log('info', 'Geen factuur volgens het uitlezen; op genegeerd gezet.', factuur.id);
          geenFactuur++;
          continue;
        }

        opslag.zetUitgelezen(factuur.id, 'ok', uitkomst.velden);
        opslag.log('info', `Uitgelezen: ${uitkomst.velden.leverancier || 'onbekende leverancier'}`
          + `, factuur ${uitkomst.velden.factuurnummer || 'zonder nummer'}`, factuur.id);
        gelukt++;
      } catch (fout) {
        opslag.zetUitleesFout(factuur.id, fout.message);
        opslag.log('error', 'Uitlezen mislukt: ' + fout.message, factuur.id);
        mislukt++;
      }
    }

    return { bekeken: wachtend.length, gelukt, geenFactuur, mislukt };
  }

  async function leesPdf(bestandsnaam) {
    const { readFile } = await import('node:fs/promises');
    return readFile(path.join(pdfMap, path.basename(bestandsnaam)));
  }

  // -- stap 3: betalingen ophalen ---------------------------------------
  async function haalBetalingen(inst) {
    if (!bunq || !bunq.beschikbaar) return { overgeslagen: 'bunq niet ingesteld' };

    const vanafDatum = datumPlusDagen(vandaag(), -inst.terugkijkenDagen);
    const betalingen = await bunq.betalingen({ vanafDatum });
    for (const betaling of betalingen) opslag.voegBetalingToe(betaling);
    return { opgehaald: betalingen.length, totaal: opslag.aantalBetalingen() };
  }

  // -- de hele ronde -----------------------------------------------------
  async function draai({ aanleiding = 'timer' } = {}) {
    if (bezig) return { bezig: true };
    bezig = true;

    const resultaat = { gestart: nuIso(), aanleiding, stappen: {} };
    const stap = async (naam, fn) => {
      try {
        resultaat.stappen[naam] = await fn();
      } catch (fout) {
        resultaat.stappen[naam] = { fout: fout.message };
        opslag.log('error', `Sync-stap ${naam} mislukt: ${fout.message}`);
      }
    };

    try {
      let inst = instellingenLezer();
      await stap('mail', () => haalMails(inst));
      await stap('uitlezen', () => leesUit());
      await stap('bunq', () => haalBetalingen(inst));
      await stap('koppelen', async () => koppelen.verwerk(opslag, inst.matchDrempel));

      // Het koppelen kan facturen op betaald hebben gezet; de instellingen
      // opnieuw lezen, want de toggle kan tussendoor zijn veranderd.
      inst = instellingenLezer();
      await stap('doorsturen', () => verwerkAchterstand(opslag, graph, inst));

      resultaat.klaar = nuIso();
      opslag.zetInstelling('laatste_sync', resultaat.klaar);
      opslag.zetInstelling('laatste_sync_resultaat', JSON.stringify(resultaat));
      return resultaat;
    } finally {
      bezig = false;
    }
  }

  return {
    draai,
    bezig: () => bezig,
    // Losse stappen, handig voor de tests.
    _haalMails: haalMails,
    _leesUit: leesUit,
    _haalBetalingen: haalBetalingen,
  };
}

// Vat het opgeslagen resultaat samen in één regel voor het overzicht.
export function vatSamen(resultaatJson) {
  if (!resultaatJson) return '';
  let r;
  try {
    r = JSON.parse(resultaatJson);
  } catch {
    return '';
  }
  const delen = [];
  const s = r.stappen || {};
  if (s.mail) delen.push(s.mail.fout ? 'mail: ' + s.mail.fout : (s.mail.overgeslagen ? 'mail: ' + s.mail.overgeslagen : `${s.mail.nieuw} nieuw`));
  if (s.uitlezen) delen.push(s.uitlezen.fout ? 'uitlezen: ' + s.uitlezen.fout : (s.uitlezen.overgeslagen ? 'uitlezen: ' + s.uitlezen.overgeslagen : `${s.uitlezen.gelukt} uitgelezen${s.uitlezen.mislukt ? `, ${s.uitlezen.mislukt} mislukt` : ''}`));
  if (s.bunq) delen.push(s.bunq.fout ? 'bunq: ' + s.bunq.fout : (s.bunq.overgeslagen ? 'bunq: ' + s.bunq.overgeslagen : `${s.bunq.opgehaald} betalingen`));
  if (s.koppelen) delen.push(s.koppelen.fout ? 'koppelen: ' + s.koppelen.fout : `${s.koppelen.betaald} gekoppeld, ${s.koppelen.suggesties} suggestie(s)`);
  if (s.doorsturen) {
    delen.push(s.doorsturen.fout ? 'doorsturen: ' + s.doorsturen.fout
      : `${s.doorsturen.verstuurd} doorgestuurd${s.doorsturen.getest ? `, ${s.doorsturen.getest} in testmodus` : ''}`);
  }
  return delen.join(' · ');
}
