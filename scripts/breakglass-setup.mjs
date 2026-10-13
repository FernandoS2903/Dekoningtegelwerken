#!/usr/bin/env node
// Richt de noodtoegang (break-glass) van het portaal in: vraagt een
// wachtwoord, maakt de scrypt-hash en een TOTP-geheim, toont de otpauth-URI
// en een QR-code in de terminal, en schrijft BREAKGLASS_USER,
// BREAKGLASS_PASSWORD_HASH en BREAKGLASS_TOTP_SECRET naar het env-bestand
// (met back-up en bevestiging). Draaien als root:
//
//   node scripts/breakglass-setup.mjs [--gebruiker naam] [--env /etc/dekoning/facturen.env]
//
// Daarna: systemctl restart dekoning-facturen. Het geheim staat alleen in de
// env en in je authenticator-app; dit script bewaart niets anders.

import fs from 'node:fs';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { maakWachtwoordHash, base32Encode, otpauthUri, totpCode, totpStap, base32Decode } from '../service/facturen/lib/breakglass.mjs';
import { maakQr } from '../service/facturen/lib/qr.mjs';

const args = process.argv.slice(2);
const optie = (naam, standaard) => { const i = args.indexOf(naam); return i >= 0 && args[i + 1] ? args[i + 1] : standaard; };
const envPad = optie('--env', '/etc/dekoning/facturen.env');
const UITGEVER = 'DKT Portaal';
const SLEUTELS = ['BREAKGLASS_USER', 'BREAKGLASS_PASSWORD_HASH', 'BREAKGLASS_TOTP_SECRET'];

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
const vraag = (tekst) => new Promise((r) => rl.question(tekst, (a) => r(a.trim())));
function vraagVerborgen(tekst) {
  return new Promise((r) => {
    const uit = process.stdout;
    uit.write(tekst);
    const was = rl._writeToOutput;
    rl._writeToOutput = () => {};
    rl.question('', (a) => { rl._writeToOutput = was; uit.write('\n'); r(a); });
  });
}

// QR voor een donkere terminal: lichte modules als blokken, donkere als
// spaties, zodat de camera een zwarte code op een witte achtergrond ziet.
export function qrTekst(tekst) {
  const q = maakQr(tekst);
  const stil = 2;
  const regels = [];
  for (let r = -stil; r < q.maat + stil; r++) {
    let s = '';
    for (let c = -stil; c < q.maat + stil; c++) {
      const donker = r >= 0 && c >= 0 && r < q.maat && c < q.maat && q.modules[r * q.maat + c];
      s += donker ? '  ' : '██';
    }
    regels.push(s);
  }
  return regels.join('\n');
}

try {
  const gebruiker = optie('--gebruiker', '') || await vraag('Gebruikersnaam voor de noodtoegang: ');
  if (!/^[A-Za-z0-9@._-]{3,100}$/.test(gebruiker)) throw new Error('Gebruikersnaam: 3 tot 100 tekens, letters, cijfers, @ . _ -');
  const ww1 = await vraagVerborgen('Wachtwoord (minimaal 16 tekens): ');
  if (ww1.length < 16) throw new Error('Het wachtwoord moet minimaal 16 tekens hebben.');
  const ww2 = await vraagVerborgen('Nog een keer: ');
  if (ww1 !== ww2) throw new Error('De wachtwoorden zijn niet gelijk.');

  const hash = maakWachtwoordHash(ww1);
  const geheim = base32Encode(crypto.randomBytes(20));
  const uri = otpauthUri({ uitgever: UITGEVER, account: gebruiker, geheimB32: geheim });

  console.log('\nScan deze QR-code met je authenticator-app (of voer het geheim handmatig in):\n');
  console.log(qrTekst(uri));
  console.log(`\nGeheim (handmatig): ${geheim}`);
  console.log(`otpauth-URI: ${uri}\n`);
  const code = await vraag('Voer ter controle de code in die je app nu toont: ');
  const nu = totpStap(Date.now());
  const klopt = [nu - 1, nu, nu + 1].some((s) => totpCode(base32Decode(geheim), s) === code.replace(/\s+/g, ''));
  if (!klopt) throw new Error('Die code klopt niet met het geheim; er is niets weggeschreven. Scan opnieuw en probeer het nog eens.');

  let inhoud = '';
  try { inhoud = fs.readFileSync(envPad, 'utf8'); } catch { throw new Error(`Kan ${envPad} niet lezen (draai als root).`); }
  const bestaand = SLEUTELS.filter((k) => new RegExp(`^${k}=`, 'm').test(inhoud));
  const antwoord = await vraag(`${bestaand.length ? `Let op: ${bestaand.join(', ')} staan al in ${envPad} en worden overschreven. ` : ''}Wegschrijven naar ${envPad}? (ja/nee) `);
  if (antwoord.toLowerCase() !== 'ja') throw new Error('Niet weggeschreven.');

  const datum = new Date().toISOString().slice(0, 10);
  let backup = `${envPad}.bak-${datum}`;
  for (let n = 2; fs.existsSync(backup); n++) backup = `${envPad}.bak-${datum}-${n}`;
  fs.copyFileSync(envPad, backup);
  fs.chmodSync(backup, 0o600);

  const nieuw = { BREAKGLASS_USER: gebruiker, BREAKGLASS_PASSWORD_HASH: hash, BREAKGLASS_TOTP_SECRET: geheim };
  let uit = inhoud;
  for (const k of SLEUTELS) {
    const regel = `${k}=${nieuw[k]}`;
    uit = new RegExp(`^${k}=.*$`, 'm').test(uit) ? uit.replace(new RegExp(`^${k}=.*$`, 'm'), regel) : uit.replace(/\n?$/, '\n') + regel + '\n';
  }
  if (!/^BREAKGLASS_MELD_NAAR=/m.test(uit)) uit += '# Melding bij een geslaagde break-glass-login (leeg = M365_MAILBOX)\nBREAKGLASS_MELD_NAAR=\n';
  fs.writeFileSync(envPad, uit, { mode: 0o600 });
  fs.chmodSync(envPad, 0o600);
  console.log(`\nKlaar. Back-up: ${backup}. Herstart nu de dienst: systemctl restart dekoning-facturen`);
} catch (fout) {
  console.error('\n' + fout.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
