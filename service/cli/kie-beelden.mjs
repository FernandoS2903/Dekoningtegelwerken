// Genereert de sfeerbeelden uit data/beelden.json via KIE.AI en zet ze met
// cwebp om naar assets/beelden/<id>-<breedte>.webp. Zonder dependencies.
//
//   set -a; . /etc/dekoning/kie.env; set +a
//   node service/cli/kie-beelden.mjs                 alles wat nog ontbreekt
//   node service/cli/kie-beelden.mjs --alleen hero   alleen deze id('s), komma-gescheiden
//   node service/cli/kie-beelden.mjs --opnieuw ...   ook bestaande beelden opnieuw maken
//   node service/cli/kie-beelden.mjs --max 40        hoogstens zoveel generaties in deze run (standaard 40)
//   node service/cli/kie-beelden.mjs --parallel 6    zoveel taken tegelijk (standaard 1)
//   node service/cli/kie-beelden.mjs --webp          alleen opnieuw omzetten uit de ruwe downloads
//
// De API-sleutel komt uit KIE_API_KEY en wordt nooit gelogd of weggeschreven.
// Ruwe downloads gaan naar $KIE_RUW (standaard /tmp/dekoning-kie-ruw), buiten de repo.
// Stopt direct bij een autorisatie- of tegoedfout; een ander mislukt beeld
// wordt één keer opnieuw geprobeerd en daarna overgeslagen.
//
// Endpoints (docs: https://docs.kie.ai, schema via /api/v1/models/<model>/schema):
//   POST /api/v1/jobs/createTask             taak aanmaken
//   GET  /api/v1/jobs/recordInfo?taskId=...  status pollen
//   GET  /api/v1/chat/credit                 tegoed
//   POST https://kieai.redpandaai.co/api/file-stream-upload   referentiebeeld uploaden

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MANIFEST = path.join(ROOT, 'data/beelden.json');
const UIT = path.join(ROOT, 'assets/beelden');
const RUW = process.env.KIE_RUW || '/tmp/dekoning-kie-ruw';
const API = 'https://api.kie.ai';
const UPLOAD = 'https://kieai.redpandaai.co';
const POLL_MS = 4000;
const TIMEOUT_MS = 6 * 60 * 1000;
const PAUZE_MS = 2500;
const WEBP_KWALITEIT = 78;

const arg = (naam) => { const i = process.argv.indexOf(naam); return i > -1 ? process.argv[i + 1] : null; };
const vlag = (naam) => process.argv.includes(naam);
const alleen = arg('--alleen') ? new Set(arg('--alleen').split(',')) : null;
const opnieuw = vlag('--opnieuw');
const alleenWebp = vlag('--webp');
const maxGeneraties = Number(arg('--max') || 40);
const parallel = Number(arg('--parallel') || 1);

const SLEUTEL = process.env.KIE_API_KEY;
if (!SLEUTEL && !alleenWebp) {
  console.error('KIE_API_KEY ontbreekt. Laad hem met: set -a; . /etc/dekoning/kie.env; set +a');
  process.exit(2);
}

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const opslaan = () => writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');
mkdirSync(UIT, { recursive: true });
mkdirSync(RUW, { recursive: true });

class Fataal extends Error {}

/** Roept KIE aan en controleert de code in de body (HTTP 200 zegt niets). */
async function kie(url, opties = {}) {
  const antwoord = await fetch(url, {
    ...opties,
    headers: { authorization: 'Bearer ' + SLEUTEL, ...(opties.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  let body;
  try { body = await antwoord.json(); } catch { throw new Error('geen JSON van ' + new URL(url).pathname + ' (HTTP ' + antwoord.status + ')'); }
  const code = Number(body.code ?? antwoord.status);
  if ([401, 402, 433].includes(code) || [401, 403].includes(antwoord.status)) {
    throw new Fataal(`KIE weigert (${code}): ${String(body.msg || '').slice(0, 200)}`);
  }
  if (code !== 200) throw new Error(`KIE code ${code}: ${String(body.msg || '').slice(0, 200)}`);
  return body.data;
}

async function tegoed() {
  return Number(await kie(API + '/api/v1/chat/credit'));
}

async function uploadReferentie(bestand) {
  const vorm = new FormData();
  vorm.append('file', new Blob([readFileSync(bestand)], { type: 'image/jpeg' }), path.basename(bestand));
  vorm.append('uploadPath', 'images/dekoning-referentie');
  vorm.append('fileName', path.basename(bestand));
  const data = await kie(UPLOAD + '/api/file-stream-upload', { method: 'POST', body: vorm });
  return data.downloadUrl;
}

async function genereer(beeld) {
  const input = {
    prompt: beeld.prompt + '\n\n' + manifest.stijl,
    aspect_ratio: beeld.verhouding,
    resolution: manifest.resolutie,
    output_format: 'jpg',
  };
  if (beeld.referentie) {
    const ref = path.join(RUW, beeld.referentie + '.jpg');
    if (!existsSync(ref)) throw new Error('referentiebeeld ontbreekt: ' + beeld.referentie);
    input.image_input = [await uploadReferentie(ref)];
  }
  const { taskId } = await kie(API + '/api/v1/jobs/createTask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: manifest.model, input }),
  });
  const einde = Date.now() + TIMEOUT_MS;
  while (Date.now() < einde) {
    await wacht(POLL_MS);
    let d;
    try { d = await kie(API + '/api/v1/jobs/recordInfo?taskId=' + encodeURIComponent(taskId)); }
    catch (e) { if (e instanceof Fataal) throw e; continue; } // tijdelijke fout: gewoon verder pollen
    if (d.state === 'fail') throw new Error(`generatie mislukt: ${d.failCode || ''} ${String(d.failMsg || '').slice(0, 200)}`);
    if (d.state === 'success') {
      const resultaat = d.response || JSON.parse(d.resultJson || '{}');
      const url = resultaat.resultUrls?.[0];
      if (!url) throw new Error('geen resultaat-URL');
      return { url, taskId, credits: d.creditsConsumed ?? null };
    }
  }
  throw new Error('time-out na ' + TIMEOUT_MS / 1000 + ' s (taak ' + taskId + ')');
}

/** Breedte en hoogte uit een JPEG- of PNG-header, zonder dependencies. */
function afmeting(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return { breedte: buf.readUInt32BE(16), hoogte: buf.readUInt32BE(20) };
  let i = 2;
  while (i < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    const lengte = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { hoogte: buf.readUInt16BE(i + 5), breedte: buf.readUInt16BE(i + 7) };
    }
    i += 2 + lengte;
  }
  throw new Error('afmeting niet te lezen');
}

function naarWebp(beeld) {
  const bron = path.join(RUW, beeld.id + '.jpg');
  const maat = afmeting(readFileSync(bron));
  const varianten = [];
  for (const b of beeld.breedtes) {
    const breedte = Math.min(b, maat.breedte);
    if (varianten.includes(breedte)) continue;
    execFileSync('cwebp', ['-quiet', '-q', String(WEBP_KWALITEIT), '-m', '6', '-sharp_yuv', '-metadata', 'none',
      '-resize', String(breedte), '0', bron, '-o', path.join(UIT, `${beeld.id}-${breedte}.webp`)]);
    varianten.push(breedte);
  }
  beeld.afmeting = maat;
  beeld.varianten = varianten;
}

// -- hoofdprogramma ----------------------------------------------------------
const klaar = (b) => b.gegenereerd && b.varianten?.length
  && b.varianten.every((w) => existsSync(path.join(UIT, `${b.id}-${w}.webp`)));
const teDoen = manifest.beelden.filter((b) => (!alleen || alleen.has(b.id))
  && (alleenWebp || opnieuw || !klaar(b)));

if (alleenWebp) {
  for (const b of teDoen) {
    if (!existsSync(path.join(RUW, b.id + '.jpg'))) { console.log('geen ruwe download voor ' + b.id); continue; }
    naarWebp(b);
    console.log('webp: ' + b.id + ' ' + b.varianten.join('/'));
  }
  opslaan();
  process.exit(0);
}

const PRIJS = 18; // credits per beeld voor nano-banana-pro 1K/2K (pricingDesc van KIE)
const start = await tegoed();
console.log(`tegoed vooraf: ${start} credits; te maken: ${teDoen.length} beeld(en), geschat ${teDoen.length * PRIJS} credits`);
if (start < teDoen.length * PRIJS) {
  console.error('Onvoldoende tegoed voor deze reeks; niets gestart.');
  process.exit(1);
}

let generaties = 0;
let gestopt = null;
const gelukt = [];
const mislukt = [];

async function verwerk(beeld) {
  let laatsteFout = null;
  for (let poging = 1; poging <= 2 && !gestopt; poging++) {
    if (generaties >= maxGeneraties) { laatsteFout = new Error('maximum van ' + maxGeneraties + ' generaties bereikt'); break; }
    generaties++;
    try {
      const r = await genereer(beeld);
      const bestand = await fetch(r.url, { signal: AbortSignal.timeout(120000) });
      if (!bestand.ok) throw new Error('download HTTP ' + bestand.status);
      writeFileSync(path.join(RUW, beeld.id + '.jpg'), Buffer.from(await bestand.arrayBuffer()));
      naarWebp(beeld);
      beeld.gegenereerd = { datum: new Date().toISOString().slice(0, 10), model: manifest.model, taak: r.taskId, credits: r.credits };
      opslaan();
      console.log(`ok   ${beeld.id}  ${beeld.afmeting.breedte}×${beeld.afmeting.hoogte}  webp ${beeld.varianten.join('/')}  (${r.credits ?? '?'} credits)`);
      gelukt.push(beeld.id);
      return;
    } catch (e) {
      if (e instanceof Fataal) { gestopt = e; break; }
      laatsteFout = e;
      console.log(`fout ${beeld.id} (poging ${poging}): ${e.message}`);
    }
  }
  if (laatsteFout) mislukt.push(`${beeld.id}: ${laatsteFout.message}`);
}

// Een paar taken tegelijk (KIE staat 20 aanmaakverzoeken per 10 s toe); een
// beeld met een referentie wacht tot dat referentiebeeld klaar is.
const rij = [...teDoen];
const klaarIds = new Set(manifest.beelden.filter(klaar).map((b) => b.id));
async function werker(nr) {
  await wacht(nr * PAUZE_MS); // gespreid starten
  while (rij.length && !gestopt) {
    const i = rij.findIndex((b) => !b.referentie || klaarIds.has(b.referentie) || !rij.some((x) => x.id === b.referentie));
    const beeld = rij.splice(i < 0 ? 0 : i, 1)[0];
    if (beeld.referentie && !klaarIds.has(beeld.referentie)) {
      // referentie wordt nog door een andere werker gemaakt: even wachten
      const tot = Date.now() + TIMEOUT_MS;
      while (!klaarIds.has(beeld.referentie) && Date.now() < tot && !gestopt) await wacht(POLL_MS);
    }
    await verwerk(beeld);
    if (beeld.gegenereerd) klaarIds.add(beeld.id);
    await wacht(PAUZE_MS);
  }
}
await Promise.all(Array.from({ length: Math.max(1, parallel) }, (_, n) => werker(n)));
if (gestopt) {
  console.error('GESTOPT: ' + gestopt.message);
  mislukt.push('gestopt: ' + gestopt.message);
}

const eind = await tegoed().catch(() => null);
console.log(`\ngeneraties: ${generaties}, gelukt: ${gelukt.length}, mislukt: ${mislukt.length}`);
if (mislukt.length) console.log('mislukt:\n  ' + mislukt.join('\n  '));
if (eind !== null) console.log(`tegoed na afloop: ${eind} credits (verbruikt: ${Math.round((start - eind) * 10) / 10})`);
process.exit(mislukt.length ? 1 : 0);
