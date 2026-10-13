#!/usr/bin/env node
// Eenmalig: tenaamstelling en betaalwijze nalezen voor open inkoopfacturen
// die zijn uitgelezen vóór schema versie 7 (betalen via bunq). Alleen die
// twee velden worden bijgewerkt; bedrag, IBAN en wat met de hand is
// gecorrigeerd blijven staan.
//
// Zonder --uitvoeren is het een droge run: hij telt alleen wat hij zou doen
// en roept Claude niet aan.
//
//   node service/cli/betaalgegevens-nalezen.mjs              # droog: welke facturen
//   node service/cli/betaalgegevens-nalezen.mjs --uitvoeren  # echt nalezen
//   ... --max 5                                               # hooguit 5 facturen
//
// Leest DATA_DIR (standaard /var/lib/dekoning-facturen), ANTHROPIC_API_KEY
// en CLAUDE_MODEL uit de omgeving, net als de dienst. In productie als de
// dienstgebruiker, met de env van de dienst (zie deploy/CMS-INSTALLATIE.md §11).

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { maakOpslag, openDatabase } from '../facturen/lib/db.mjs';
import { maakClaude } from '../facturen/lib/claude.mjs';
import { uitEnv } from '../facturen/server.mjs';

const args = process.argv.slice(2);
const uitvoeren = args.includes('--uitvoeren');
const maxIndex = args.indexOf('--max');
const max = maxIndex >= 0 ? Math.max(1, Number(args[maxIndex + 1]) || 0) : 25;

const cfg = uitEnv();
const opslag = maakOpslag(openDatabase(cfg.dbPad));
const kandidaten = opslag.openZonderTenaamstelling().slice(0, max);

console.log(`${kandidaten.length} open factu${kandidaten.length === 1 ? 'ur' : 'ren'} zonder tenaamstelling${uitvoeren ? '' : ' (droge run; niets aangeroepen)'}.`);
for (const f of kandidaten) console.log(`  #${f.id} ${f.leverancier || f.afzender_email || '(onbekend)'} ${f.factuurnummer || ''}`);
if (!uitvoeren || !kandidaten.length) process.exit(0);

const claude = maakClaude({ ...cfg.claude, log: (niveau, tekst) => opslag.log(niveau, tekst) });
if (!claude.beschikbaar) {
  console.error('Geen ANTHROPIC_API_KEY in de omgeving; er is niets gedaan.');
  process.exit(1);
}

let gelukt = 0;
let mislukt = 0;
for (const f of kandidaten) {
  try {
    const pdf = f.pdf_pad ? await readFile(path.join(cfg.pdfMap, path.basename(f.pdf_pad))) : null;
    const { velden } = await claude.leesFactuur({
      pdf,
      tekst: f.mail_tekst || '',
      afzender: [f.afzender_naam, f.afzender_email].filter(Boolean).join(' '),
      onderwerp: f.onderwerp || '',
    });
    opslag.zetBetaalgegevens(f.id, { iban_naam: velden.iban_naam, betaalwijze: velden.betaalwijze });
    // Wijkt het IBAN van het nalezen af van wat er staat, dan alleen melden:
    // het IBAN zelf passen we hier niet aan.
    const anders = velden.iban && f.iban && velden.iban !== f.iban ? ` Let op: het nalezen vond IBAN ${velden.iban}, opgeslagen is ${f.iban}.` : '';
    opslag.log(anders ? 'warn' : 'info', `Tenaamstelling en betaalwijze nagelezen: ${velden.iban_naam || 'geen tenaamstelling'}, `
      + `${velden.betaalwijze || 'betaalwijze onbekend'}.${anders}`, f.id, 'nalezen (cli)');
    console.log(`  #${f.id} ok: ${velden.iban_naam || '—'} · ${velden.betaalwijze || '—'}${anders ? ' · IBAN wijkt af!' : ''}`);
    gelukt++;
  } catch (fout) {
    opslag.log('error', 'Nalezen van tenaamstelling en betaalwijze mislukt: ' + fout.message, f.id, 'nalezen (cli)');
    console.log(`  #${f.id} mislukt: ${fout.message}`);
    mislukt++;
  }
}
console.log(`Klaar: ${gelukt} nagelezen, ${mislukt} mislukt.`);
process.exit(mislukt ? 1 : 0);
