// Opslag van het project-CMS: projecten, hun foto's en oude slugs (voor een
// 301 na een slugwijziging). De tabellen staan in lib/db.mjs (schema 5).
//
// Velden komen hier al gecontroleerd binnen (zie controleerProject); deze
// module doet alleen SQL en houdt slug, volgorde en cover consistent.
// Verwijderen is zacht: verwijderd_op wordt gezet, de rij en de foto's
// blijven, de slug komt vrij.

import { nuIso } from './hulp.mjs';
import { CATEGORIEEN } from '../../site/weergave.mjs';

export const STATUSSEN = ['concept', 'gepubliceerd'];
export const FOTO_SOORTEN = [
  ['galerij', 'Galerij'],
  ['detail', 'Detail (met bijschrift)'],
  ['voor', 'Voor (voor/na)'],
  ['na', 'Na (voor/na)'],
];

export const GRENZEN = {
  titel: 120, plaats: 80, ruimte: 80, korte_omschrijving: 300, beschrijving: 5000,
  meta_description: 200, soort_tegel: 120, formaat: 120, werkzaamheden: 300, bijzonderheden: 300,
  slug: 80, alt_tekst: 250, bijschrift: 80,
};

const TEKSTVELDEN = ['titel', 'plaats', 'ruimte', 'korte_omschrijving', 'beschrijving', 'meta_description',
  'soort_tegel', 'formaat', 'werkzaamheden', 'bijzonderheden'];

/** Een slug uit vrije tekst: kleine letters, cijfers en streepjes. */
export function maakSlug(tekst) {
  return String(tekst || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' en ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, GRENZEN.slug)
    .replace(/-+$/g, '');
}
export const geldigeSlug = (s) => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s) && s.length <= GRENZEN.slug;

/**
 * Controleert de velden uit het formulier. Geeft { velden, fouten } terug;
 * fouten is { veld: melding }. Een plaats is alleen een plaatsnaam: een
 * cijfer (huisnummer, postcode) wordt geweigerd, want het adres van een
 * klant hoort niet op de site.
 */
export function controleerProject(invoer) {
  const fouten = {};
  const velden = {};
  for (const k of TEKSTVELDEN) {
    const w = String(invoer[k] ?? '').replace(/\r\n/g, '\n').trim();
    if (w.length > GRENZEN[k]) fouten[k] = `Maximaal ${GRENZEN[k]} tekens.`;
    velden[k] = w;
  }
  if (!velden.titel) fouten.titel = 'Vul een titel in.';
  if (/\d/.test(velden.plaats)) fouten.plaats = 'Alleen de plaatsnaam, zonder adres, huisnummer of postcode.';

  const slugIn = String(invoer.slug ?? '').trim().toLowerCase();
  velden.slug = slugIn ? slugIn : maakSlug(velden.titel);
  if (!geldigeSlug(velden.slug)) fouten.slug = 'Alleen kleine letters, cijfers en streepjes (bijvoorbeeld badkamer-haarlem).';

  const cats = [].concat(invoer.categorieen ?? []).map(String);
  velden.categorieen = CATEGORIEEN.filter((c) => cats.includes(c));
  if (cats.some((c) => !CATEGORIEEN.includes(c))) fouten.categorieen = 'Onbekende categorie.';

  velden.uitgelicht = invoer.uitgelicht ? 1 : 0;
  velden.voorbeeld = invoer.voorbeeld ? 1 : 0;
  velden.status = STATUSSEN.includes(invoer.status) ? invoer.status : 'concept';

  const datum = String(invoer.datum ?? '').trim();
  if (datum && !/^\d{4}-\d{2}-\d{2}$/.test(datum)) fouten.datum = 'Gebruik een datum als 2026-10-12.';
  velden.datum = datum || null;
  return { velden, fouten };
}

export function maakProjectenOpslag(db, { nu = nuIso } = {}) {
  const q = (sql) => db.prepare(sql);
  const transactie = (fn) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const uit = fn(...args);
      db.exec('COMMIT');
      return uit;
    } catch (fout) {
      db.exec('ROLLBACK');
      throw fout;
    }
  };

  const sOpId = q('SELECT * FROM projecten WHERE id = ? AND verwijderd_op IS NULL');
  const sOpSlug = q('SELECT * FROM projecten WHERE slug = ? AND verwijderd_op IS NULL');
  const sOudeSlug = q(`SELECT p.* FROM project_slugs s JOIN projecten p ON p.id = s.project_id
    WHERE s.slug = ? AND p.verwijderd_op IS NULL`);
  const sFotos = q('SELECT * FROM project_fotos WHERE project_id = ? ORDER BY volgorde, id');
  const sAlleFotos = q(`SELECT f.* FROM project_fotos f JOIN projecten p ON p.id = f.project_id
    WHERE p.verwijderd_op IS NULL ORDER BY f.project_id, f.volgorde, f.id`);

  function lijst({ status = null } = {}) {
    const rijen = status
      ? q('SELECT * FROM projecten WHERE verwijderd_op IS NULL AND status = ? ORDER BY volgorde, id').all(status)
      : q('SELECT * FROM projecten WHERE verwijderd_op IS NULL ORDER BY volgorde, id').all();
    return metFotos(rijen);
  }

  function metFotos(rijen) {
    if (!rijen.length) return rijen;
    const perProject = new Map();
    for (const f of sAlleFotos.all()) {
      if (!perProject.has(f.project_id)) perProject.set(f.project_id, []);
      perProject.get(f.project_id).push(f);
    }
    return rijen.map((p) => ({ ...p, fotos: perProject.get(p.id) || [] }));
  }

  const metFotosEen = (p) => (p ? { ...p, fotos: sFotos.all(p.id) } : null);
  const opId = (id) => metFotosEen(sOpId.get(Number(id)));
  const opSlug = (slug) => metFotosEen(sOpSlug.get(String(slug)));
  /** Het project dat deze slug vroeger had (voor de 301), of null. */
  const opOudeSlug = (slug) => metFotosEen(sOudeSlug.get(String(slug)));

  /** Is deze slug al van een ander (niet verwijderd) project? */
  function slugBezet(slug, behalveId = null) {
    const rij = sOpSlug.get(slug);
    return !!rij && rij.id !== Number(behalveId);
  }

  // Nieuwe projecten komen bovenaan.
  const maak = transactie((velden) => {
    const { laagste } = q('SELECT MIN(volgorde) AS laagste FROM projecten WHERE verwijderd_op IS NULL').get();
    const volgorde = velden.volgorde ?? (laagste === null ? 1 : laagste - 1);
    const t = nu();
    const { lastInsertRowid } = q(`INSERT INTO projecten
      (slug, titel, plaats, ruimte, categorieen, korte_omschrijving, beschrijving, meta_description,
       soort_tegel, formaat, werkzaamheden, bijzonderheden, uitgelicht, voorbeeld, status, volgorde, datum,
       aangemaakt_op, gewijzigd_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      velden.slug, velden.titel, velden.plaats || '', velden.ruimte || '', (velden.categorieen || []).join(' '),
      velden.korte_omschrijving || '', velden.beschrijving || '', velden.meta_description || '',
      velden.soort_tegel || '', velden.formaat || '', velden.werkzaamheden || '', velden.bijzonderheden || '',
      velden.uitgelicht ? 1 : 0, velden.voorbeeld ? 1 : 0, velden.status || 'concept', volgorde, velden.datum ?? null, t, t,
    );
    // Wie deze slug nu krijgt, neemt hem over van een eventuele oude verwijzing.
    q('DELETE FROM project_slugs WHERE slug = ?').run(velden.slug);
    return Number(lastInsertRowid);
  });

  // Bij een andere slug blijft de oude als verwijzing (301) bewaard.
  const werkBij = transactie((id, velden) => {
    const huidig = sOpId.get(Number(id));
    if (!huidig) return false;
    if (velden.slug !== huidig.slug) {
      q('INSERT OR REPLACE INTO project_slugs (slug, project_id) VALUES (?, ?)').run(huidig.slug, huidig.id);
      q('DELETE FROM project_slugs WHERE slug = ?').run(velden.slug);
    }
    q(`UPDATE projecten SET slug = ?, titel = ?, plaats = ?, ruimte = ?, categorieen = ?, korte_omschrijving = ?,
      beschrijving = ?, meta_description = ?, soort_tegel = ?, formaat = ?, werkzaamheden = ?, bijzonderheden = ?,
      uitgelicht = ?, voorbeeld = ?, status = ?, datum = ?, gewijzigd_op = ? WHERE id = ?`).run(
      velden.slug, velden.titel, velden.plaats, velden.ruimte, velden.categorieen.join(' '), velden.korte_omschrijving,
      velden.beschrijving, velden.meta_description, velden.soort_tegel, velden.formaat, velden.werkzaamheden,
      velden.bijzonderheden, velden.uitgelicht, velden.voorbeeld, velden.status, velden.datum, nu(), huidig.id,
    );
    return true;
  });

  const zetStatus = (id, status) => q('UPDATE projecten SET status = ?, gewijzigd_op = ? WHERE id = ? AND verwijderd_op IS NULL')
    .run(status, nu(), Number(id)).changes > 0;

  // Omhoog of omlaag: van plek wisselen met de buur in de getoonde volgorde.
  // Daarna krijgt de hele lijst opnieuw 1..n, zodat gelijke waarden verdwijnen.
  const verplaats = transactie((id, richting) => {
    const ids = q('SELECT id FROM projecten WHERE verwijderd_op IS NULL ORDER BY volgorde, id').all().map((r) => r.id);
    const i = ids.indexOf(Number(id));
    const j = richting === 'omhoog' ? i - 1 : i + 1;
    if (i === -1 || j < 0 || j >= ids.length) return false;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const zet = q('UPDATE projecten SET volgorde = ? WHERE id = ?');
    ids.forEach((pid, n) => zet.run(n + 1, pid));
    return true;
  });

  const verwijder = (id) => q('UPDATE projecten SET verwijderd_op = ?, gewijzigd_op = ? WHERE id = ? AND verwijderd_op IS NULL')
    .run(nu(), nu(), Number(id)).changes > 0;

  // -- foto's ------------------------------------------------------------------
  // De eerste foto van een project wordt automatisch de cover.
  const voegFotoToe = transactie((projectId, f) => {
    const { hoogste, aantal, covers } = q(`SELECT MAX(volgorde) AS hoogste, COUNT(*) AS aantal, SUM(is_cover) AS covers
      FROM project_fotos WHERE project_id = ?`).get(Number(projectId));
    const { lastInsertRowid } = q(`INSERT INTO project_fotos
      (project_id, bestandsnaam, varianten, breedte, hoogte, alt_tekst, soort, bijschrift, sfeerbeeld, volgorde, is_cover, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Number(projectId), f.bestandsnaam, f.varianten.join(','), f.breedte, f.hoogte, f.alt_tekst || '',
      f.soort || 'galerij', f.bijschrift || '', f.sfeerbeeld ? 1 : 0, (hoogste ?? 0) + 1,
      f.is_cover || !aantal || !covers ? 1 : 0, nu(),
    );
    const fid = Number(lastInsertRowid);
    if (f.is_cover) q('UPDATE project_fotos SET is_cover = 0 WHERE project_id = ? AND id <> ?').run(Number(projectId), fid);
    q('UPDATE projecten SET gewijzigd_op = ? WHERE id = ?').run(nu(), Number(projectId));
    return fid;
  });

  const foto = (projectId, fotoId) => q('SELECT * FROM project_fotos WHERE id = ? AND project_id = ?').get(Number(fotoId), Number(projectId)) || null;
  const fotos = (projectId) => sFotos.all(Number(projectId));

  const werkFotoBij = (projectId, fotoId, { alt_tekst, soort, bijschrift }) => q(`UPDATE project_fotos
    SET alt_tekst = ?, soort = ?, bijschrift = ? WHERE id = ? AND project_id = ?`)
    .run(alt_tekst, soort, bijschrift, Number(fotoId), Number(projectId)).changes > 0;

  const zetCover = transactie((projectId, fotoId) => {
    if (!foto(projectId, fotoId)) return false;
    q('UPDATE project_fotos SET is_cover = (id = ?) WHERE project_id = ?').run(Number(fotoId), Number(projectId));
    return true;
  });

  const verplaatsFoto = transactie((projectId, fotoId, richting) => {
    const ids = sFotos.all(Number(projectId)).map((r) => r.id);
    const i = ids.indexOf(Number(fotoId));
    const j = richting === 'omhoog' ? i - 1 : i + 1;
    if (i === -1 || j < 0 || j >= ids.length) return false;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    const zet = q('UPDATE project_fotos SET volgorde = ? WHERE id = ?');
    ids.forEach((fid, n) => zet.run(n + 1, fid));
    return true;
  });

  // Geeft de verwijderde rij terug (voor het opruimen van de bestanden). Was
  // het de cover, dan wordt de eerstvolgende foto de cover.
  const verwijderFoto = transactie((projectId, fotoId) => {
    const rij = foto(projectId, fotoId);
    if (!rij) return null;
    q('DELETE FROM project_fotos WHERE id = ?').run(rij.id);
    if (rij.is_cover) {
      const volgende = sFotos.all(Number(projectId))[0];
      if (volgende) q('UPDATE project_fotos SET is_cover = 1 WHERE id = ?').run(volgende.id);
    }
    return rij;
  });

  /** Bestaat deze slug, of was hij ooit van een project (ook verwijderd)? Voor de migratie. */
  const slugOoitGebruikt = (slug) => !!(q('SELECT 1 FROM projecten WHERE slug = ?').get(slug)
    || q('SELECT 1 FROM project_slugs WHERE slug = ?').get(slug));

  return {
    db, lijst, opId, opSlug, opOudeSlug, slugBezet, slugOoitGebruikt, maak, werkBij, zetStatus, verplaats, verwijder,
    voegFotoToe, foto, fotos, werkFotoBij, zetCover, verplaatsFoto, verwijderFoto, transactie,
  };
}
