// Eenmalig: de projecten uit data/projecten.json naar het project-CMS.
//
//   node service/cli/migreer-projecten.mjs --droog     alleen laten zien wat er zou gebeuren
//   node service/cli/migreer-projecten.mjs             overzetten (als concept)
//   node service/cli/migreer-projecten.mjs --publiceer overzetten en meteen publiceren
//
// Opties: --db <pad> (standaard $DATA_DIR/facturen.db of
// /var/lib/dekoning-facturen/facturen.db), --uploads <map> (standaard
// $PROJECTEN_UPLOADS of /var/lib/dekoning/uploads/projecten), --beelden <map>
// (de WebP-bestanden van data/beelden.json; standaard assets/beelden in de
// repo, op de server /var/www/dekoningtegelwerken/assets/beelden).
//
// Idempotent: een project waarvan de slug al bestaat (of ooit bestond, ook
// verwijderd of als oude slug) wordt overgeslagen. Twee keer draaien geeft
// dus geen dubbele projecten. Draai het als de gebruiker van de dienst
// (sudo -u dekoning-facturen), na een back-up van de database.
//
// De huidige projecten zijn voorbeeldprojecten met AI-sfeerbeelden: ze
// krijgen voorbeeld = 1 (label "Voorbeeldkaart", noindex) en elke foto
// sfeerbeeld = 1 (label "Sfeerbeeld"), zoals nu op de site.

import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../facturen/lib/db.mjs';
import { maakProjectenOpslag } from '../facturen/lib/projecten-opslag.mjs';
import { verwerkFoto, verwijderBestanden } from '../facturen/lib/beeldverwerking.mjs';
import { CATEGORIEEN } from '../site/weergave.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function optiesUit(argv, env = process.env) {
  const waarde = (naam, standaard) => {
    const i = argv.indexOf(naam);
    return i !== -1 && argv[i + 1] ? argv[i + 1] : standaard;
  };
  return {
    droog: argv.includes('--droog'),
    publiceer: argv.includes('--publiceer'),
    db: waarde('--db', path.join(env.DATA_DIR || '/var/lib/dekoning-facturen', 'facturen.db')),
    uploads: waarde('--uploads', env.PROJECTEN_UPLOADS || '/var/lib/dekoning/uploads/projecten'),
    beelden: waarde('--beelden', path.join(REPO, 'assets/beelden')),
    bron: waarde('--bron', REPO),
    cwebp: env.CWEBP || 'cwebp',
    jpegtran: env.JPEGTRAN || 'jpegtran',
  };
}

/** De velden van een JSON-project voor het CMS. */
export function veldenUit(p, { volgorde, publiceer }) {
  const info = Object.fromEntries(p.info || []);
  return {
    slug: p.slug,
    titel: p.naam,
    plaats: p.plaats || '',
    ruimte: info.Ruimte || p.type || '',
    categorieen: (p.categorieen || []).filter((c) => CATEGORIEEN.includes(c)),
    korte_omschrijving: '',
    beschrijving: (p.omschrijving || []).join('\n\n'),
    meta_description: p.metaOmschrijving || '',
    soort_tegel: info['Soort tegel'] || '',
    formaat: info.Formaat || '',
    werkzaamheden: info.Werkzaamheden || '',
    bijzonderheden: info.Bijzonderheden || '',
    uitgelicht: p.uitgelicht ? 1 : 0,
    voorbeeld: p.placeholder ? 1 : 0,
    status: publiceer ? 'gepubliceerd' : 'concept',
    volgorde,
    datum: null,
  };
}

/** Welke beelden met welke rol: eerst de cover, dan galerij, details, voor en na. */
export function fotoPlan(p) {
  const plan = [];
  const gezien = new Set();
  const voeg = (id, soort, bijschrift = '') => {
    if (!id) return;
    const sleutel = soort === 'voor' || soort === 'na' ? `${soort}:${id}` : id;
    if (gezien.has(sleutel)) return;
    gezien.add(sleutel);
    plan.push({ id, soort, bijschrift });
  };
  voeg(p.heroBeeld || p.kaartBeeld, 'galerij');
  voeg(p.kaartBeeld, 'galerij');
  for (const id of p.fotos || []) voeg(id, 'galerij');
  for (const [kop, id] of p.details || []) voeg(id, 'detail', kop);
  voeg(p.voorBeeld, 'voor');
  voeg(p.naBeeld, 'na');
  return plan;
}

export async function migreer(o, uit = console.log) {
  const bron = JSON.parse(readFileSync(path.join(o.bron, 'data/projecten.json'), 'utf8')).projecten;
  const manifest = Object.fromEntries(JSON.parse(readFileSync(path.join(o.bron, 'data/beelden.json'), 'utf8')).beelden.map((b) => [b.id, b]));
  const bronBestand = (id) => {
    const b = manifest[id];
    if (!b?.varianten?.length) return null;
    const pad = path.join(o.beelden, `${id}-${b.varianten[b.varianten.length - 1]}.webp`);
    return existsSync(pad) ? pad : null;
  };

  // Droog: alleen lezen, ook als de tabellen er nog niet zijn.
  let opslag = null;
  let bestaat;
  if (o.droog) {
    const db = existsSync(o.db) ? new DatabaseSync(o.db, { readOnly: true }) : null;
    const heeft = db && db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'projecten'").get();
    bestaat = (slug) => !!(heeft && (db.prepare('SELECT 1 FROM projecten WHERE slug = ?').get(slug)
      || db.prepare('SELECT 1 FROM project_slugs WHERE slug = ?').get(slug)));
  } else {
    opslag = maakProjectenOpslag(openDatabase(o.db));
    bestaat = (slug) => opslag.slugOoitGebruikt(slug);
  }

  const telling = { nieuw: 0, overgeslagen: 0, fotos: 0, zonderBestand: 0 };
  for (const [i, p] of bron.entries()) {
    if (bestaat(p.slug)) {
      uit(`overgeslagen: ${p.slug} (bestaat al)`);
      telling.overgeslagen++;
      continue;
    }
    const plan = fotoPlan(p);
    const metBestand = plan.filter((f) => bronBestand(f.id));
    telling.zonderBestand += plan.length - metBestand.length;
    if (o.droog) {
      uit(`zou overzetten: ${p.slug} (${metBestand.length} foto's${plan.length > metBestand.length ? `, ${plan.length - metBestand.length} zonder bestand` : ''}) als ${o.publiceer ? 'gepubliceerd' : 'concept'}`);
      telling.nieuw++;
      telling.fotos += metBestand.length;
      continue;
    }

    // Eerst de foto's, dan pas het project: mislukt een foto, dan blijft er
    // niets half achter en pakt een volgende run het project opnieuw op.
    const klaar = [];
    try {
      for (const f of metBestand) {
        const r = await verwerkFoto(readFileSync(bronBestand(f.id)), { map: o.uploads, slug: p.slug, cwebp: o.cwebp, jpegtran: o.jpegtran });
        klaar.push({ ...r, soort: f.soort, bijschrift: f.bijschrift, alt_tekst: manifest[f.id].alt, sfeerbeeld: manifest[f.id].soort === 'sfeerbeeld' });
      }
    } catch (fout) {
      for (const r of klaar) verwijderBestanden(o.uploads, r.bestandsnaam, r.varianten.join(','));
      throw new Error(`${p.slug}: foto omzetten mislukt (${fout.message})`);
    }
    const id = opslag.maak(veldenUit(p, { volgorde: i + 1, publiceer: o.publiceer }));
    klaar.forEach((r, n) => opslag.voegFotoToe(id, { ...r, is_cover: n === 0 }));
    uit(`overgezet: ${p.slug} (${klaar.length} foto's) als ${o.publiceer ? 'gepubliceerd' : 'concept'}`);
    telling.nieuw++;
    telling.fotos += klaar.length;
  }
  uit(`${o.droog ? 'Droog: ' : ''}${telling.nieuw} nieuw, ${telling.overgeslagen} overgeslagen, ${telling.fotos} foto's`
    + (telling.zonderBestand ? `, ${telling.zonderBestand} beeld(en) zonder bestand overgeslagen` : ''));
  return telling;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migreer(optiesUit(process.argv.slice(2))).catch((fout) => {
    console.error('Migratie gestopt: ' + fout.message);
    process.exit(1);
  });
}
