// Opslag van het factuurdashboard: schema, migraties en alle queries.
//
// SQLite via node:sqlite (ingebouwd, geen dependency). Het bestand staat in
// DATA_DIR, dus buiten de git-werkkopie. Schemaversie via PRAGMA user_version;
// migraties draaien bij het opstarten.
//
// node:sqlite weigert undefined en booleans als parameter. Daarom gaat elke
// optionele waarde door `w()` en elke vlag als 0/1 naar binnen.

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { nuIso } from './hulp.mjs';

export const SCHEMA_VERSIE = 2;

// undefined -> null, en getallen/strings blijven zoals ze zijn.
const w = (v) => (v === undefined || v === '' ? null : v);
const vlag = (v) => (v ? 1 : 0);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS facturen (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id            TEXT NOT NULL,
    attachment_id         TEXT NOT NULL DEFAULT '',
    bijlage_naam          TEXT,
    pdf_pad               TEXT,
    mail_tekst            TEXT,
    ontvangen             TEXT,
    afzender_naam         TEXT,
    afzender_email        TEXT,
    onderwerp             TEXT,
    leverancier           TEXT,
    factuurnummer         TEXT,
    factuurdatum          TEXT,
    vervaldatum           TEXT,
    bedrag                REAL,
    valuta                TEXT,
    iban                  TEXT,
    betalingskenmerk      TEXT,
    omschrijving          TEXT,
    uitlees_status        TEXT NOT NULL DEFAULT 'pending',
    uitlees_fout          TEXT,
    status                TEXT NOT NULL DEFAULT 'open',
    betaald_op            TEXT,
    betaald_via           TEXT,
    bunq_betaling_id      TEXT,
    match_score           REAL,
    suggestie_betaling_id TEXT,
    suggestie_score       REAL,
    doorgestuurd_op       TEXT,
    doorgestuurd_naar     TEXT,
    notitie               TEXT,
    aangemaakt_op         TEXT NOT NULL,
    UNIQUE (message_id, attachment_id)
  );

  CREATE INDEX IF NOT EXISTS facturen_status    ON facturen (status);
  CREATE INDEX IF NOT EXISTS facturen_vervaldag ON facturen (vervaldatum);

  CREATE TABLE IF NOT EXISTS bunq_betalingen (
    id                    TEXT PRIMARY KEY,
    rekening_id           TEXT,
    rekening_iban         TEXT,
    datum                 TEXT,
    bedrag                REAL,
    valuta                TEXT,
    tegenrekening_iban    TEXT,
    tegenpartij_naam      TEXT,
    omschrijving          TEXT,
    gekoppelde_factuur_id INTEGER
  );

  CREATE INDEX IF NOT EXISTS betalingen_datum ON bunq_betalingen (datum);

  CREATE TABLE IF NOT EXISTS instellingen (
    sleutel TEXT PRIMARY KEY,
    waarde  TEXT
  );

  CREATE TABLE IF NOT EXISTS logboek (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tijd       TEXT NOT NULL,
    factuur_id INTEGER,
    niveau     TEXT NOT NULL,
    bericht    TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS logboek_factuur ON logboek (factuur_id, id);

  -- Versie 2: mailsorteerder en portaal.

  -- Eén regel per beslissing over een mail. message_id is het id bij
  -- binnenkomst, huidig_id het id na de laatste verplaatsing (Graph geeft na
  -- een move een nieuw id). internet_id blijft bij verplaatsen gelijk; daaraan
  -- herkennen we een mail die al eens langs is geweest.
  CREATE TABLE IF NOT EXISTS sorteer_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    tijd          TEXT NOT NULL,
    message_id    TEXT,
    huidig_id     TEXT,
    internet_id   TEXT,
    ontvangen     TEXT,
    afzender_naam TEXT,
    afzender      TEXT,
    onderwerp     TEXT,
    van_map       TEXT,
    naar_map      TEXT,
    huidige_map   TEXT,
    bron          TEXT NOT NULL,
    zekerheid     REAL,
    reden         TEXT,
    status        TEXT NOT NULL,
    fout          TEXT
  );

  CREATE INDEX IF NOT EXISTS sorteer_log_internet ON sorteer_log (internet_id);
  CREATE INDEX IF NOT EXISTS sorteer_log_tijd     ON sorteer_log (tijd);

  -- Vaste regels: afzenderadres of domein -> map. Een regel wint altijd.
  CREATE TABLE IF NOT EXISTS sorteer_regels (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    soort         TEXT NOT NULL CHECK (soort IN ('adres', 'domein')),
    waarde        TEXT NOT NULL,
    map           TEXT NOT NULL,
    door          TEXT,
    aangemaakt_op TEXT NOT NULL,
    UNIQUE (soort, waarde)
  );

  -- Toestand van de sorteerder en de webhook (deltaLink, startmoment,
  -- subscription). Geen instellingen: die staan in de tabel instellingen.
  CREATE TABLE IF NOT EXISTS sorteer_staat (
    sleutel TEXT PRIMARY KEY,
    waarde  TEXT
  );

  -- Portaalsessies. id is een HMAC van het cookie, dus met alleen de
  -- database kun je niet inloggen.
  CREATE TABLE IF NOT EXISTS sessies (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    naam          TEXT,
    csrf          TEXT NOT NULL,
    aangemaakt_op TEXT NOT NULL,
    verloopt_op   INTEGER NOT NULL,
    bijgewerkt_op INTEGER NOT NULL
  );

  -- Lopende inlogpogingen (state, nonce en PKCE-verifier), tien minuten geldig.
  CREATE TABLE IF NOT EXISTS oidc_pogingen (
    state       TEXT PRIMARY KEY,
    nonce       TEXT NOT NULL,
    verifier    TEXT NOT NULL,
    terug       TEXT,
    verloopt_op INTEGER NOT NULL
  );
`;

// Velden die het bewerkformulier en het uitlezen mogen zetten.
export const UITGELEZEN_VELDEN = [
  'leverancier', 'factuurnummer', 'factuurdatum', 'vervaldatum',
  'bedrag', 'valuta', 'iban', 'betalingskenmerk', 'omschrijving',
];

export function openDatabase(pad) {
  mkdirSync(path.dirname(pad), { recursive: true });
  const db = new DatabaseSync(pad);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);

  const versie = db.prepare('PRAGMA user_version').get().user_version;
  if (versie < SCHEMA_VERSIE) {
    // Versie 1 is het eerste schema. Versie 2 voegt alleen nieuwe tabellen
    // toe (mailsorteerder, portaal); die maakt SCHEMA hierboven al aan.
    // Latere migraties komen hier als losse stappen bij
    // (if (versie < 3) { db.exec('ALTER TABLE ...') }).
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSIE}`);
  }
  return db;
}

// Maakt een verzameling functies rond één database. Elke functie is klein en
// kent maar één query, zodat de rest van de dienst geen SQL hoeft te schrijven.
export function maakOpslag(db) {
  const q = (sql) => db.prepare(sql);

  const sInsert = q(`
    INSERT OR IGNORE INTO facturen
      (message_id, attachment_id, bijlage_naam, pdf_pad, mail_tekst, ontvangen,
       afzender_naam, afzender_email, onderwerp, aangemaakt_op)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const sBekend = q('SELECT message_id FROM facturen');
  const sHaal = q('SELECT * FROM facturen WHERE id = ?');
  const sHaalPerMail = q('SELECT * FROM facturen WHERE message_id = ?');
  const sPending = q("SELECT * FROM facturen WHERE uitlees_status = 'pending' ORDER BY id LIMIT ?");
  const sUitlezenOk = q(`
    UPDATE facturen SET uitlees_status = ?, uitlees_fout = NULL,
      leverancier = ?, factuurnummer = ?, factuurdatum = ?, vervaldatum = ?,
      bedrag = ?, valuta = ?, iban = ?, betalingskenmerk = ?, omschrijving = ?
    WHERE id = ?`);
  const sUitlezenFout = q("UPDATE facturen SET uitlees_status = 'mislukt', uitlees_fout = ? WHERE id = ?");
  const sUitlezenOpnieuw = q("UPDATE facturen SET uitlees_status = 'pending', uitlees_fout = NULL WHERE id = ?");
  const sStatus = q('UPDATE facturen SET status = ? WHERE id = ?');
  const sBetaald = q(`
    UPDATE facturen SET status = 'betaald', betaald_op = ?, betaald_via = ?,
      bunq_betaling_id = ?, match_score = ?, suggestie_betaling_id = NULL, suggestie_score = NULL
    WHERE id = ?`);
  const sOpen = q(`
    UPDATE facturen SET status = 'open', betaald_op = NULL, betaald_via = NULL,
      bunq_betaling_id = NULL, match_score = NULL
    WHERE id = ?`);
  const sSuggestie = q('UPDATE facturen SET suggestie_betaling_id = ?, suggestie_score = ? WHERE id = ?');
  const sWisSuggesties = q('UPDATE facturen SET suggestie_betaling_id = NULL, suggestie_score = NULL');
  const sDoorgestuurd = q('UPDATE facturen SET doorgestuurd_op = ?, doorgestuurd_naar = ? WHERE id = ?');
  const sNotitie = q('UPDATE facturen SET notitie = ? WHERE id = ?');

  const sBetalingUpsert = q(`
    INSERT INTO bunq_betalingen
      (id, rekening_id, rekening_iban, datum, bedrag, valuta,
       tegenrekening_iban, tegenpartij_naam, omschrijving)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET
      rekening_id = excluded.rekening_id, rekening_iban = excluded.rekening_iban,
      datum = excluded.datum, bedrag = excluded.bedrag, valuta = excluded.valuta,
      tegenrekening_iban = excluded.tegenrekening_iban,
      tegenpartij_naam = excluded.tegenpartij_naam, omschrijving = excluded.omschrijving`);
  const sBetaling = q('SELECT * FROM bunq_betalingen WHERE id = ?');
  const sBetalingKoppel = q('UPDATE bunq_betalingen SET gekoppelde_factuur_id = ? WHERE id = ?');
  const sBetalingOntkoppel = q('UPDATE bunq_betalingen SET gekoppelde_factuur_id = NULL WHERE gekoppelde_factuur_id = ?');
  const sBetalingenVrij = q(`
    SELECT * FROM bunq_betalingen
    WHERE bedrag < 0 AND gekoppelde_factuur_id IS NULL
    ORDER BY datum DESC, id DESC`);
  const sBetalingenAantal = q('SELECT count(*) AS n FROM bunq_betalingen');

  const sInstellingen = q('SELECT sleutel, waarde FROM instellingen');
  const sInstelling = q('SELECT waarde FROM instellingen WHERE sleutel = ?');
  const sZetInstelling = q(`
    INSERT INTO instellingen (sleutel, waarde) VALUES (?, ?)
    ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde`);

  const sLog = q('INSERT INTO logboek (tijd, factuur_id, niveau, bericht) VALUES (?, ?, ?, ?)');
  const sLogVanFactuur = q('SELECT * FROM logboek WHERE factuur_id = ? ORDER BY id DESC LIMIT ?');
  const sLogAlles = q('SELECT * FROM logboek ORDER BY id DESC LIMIT ?');

  return {
    db,

    // -- facturen --------------------------------------------------------
    // Geeft het id terug, ook als de regel al bestond (uniek op mail+bijlage).
    voegFactuurToe(f) {
      const r = sInsert.run(
        f.message_id, f.attachment_id || '', w(f.bijlage_naam), w(f.pdf_pad), w(f.mail_tekst),
        w(f.ontvangen), w(f.afzender_naam), w(f.afzender_email), w(f.onderwerp), nuIso(),
      );
      if (r.changes > 0) return { id: Number(r.lastInsertRowid), nieuw: true };
      const bestaand = db.prepare('SELECT id FROM facturen WHERE message_id = ? AND attachment_id = ?')
        .get(f.message_id, f.attachment_id || '');
      return { id: bestaand ? bestaand.id : null, nieuw: false };
    },

    bekendeMessageIds() {
      return new Set(sBekend.all().map((r) => r.message_id));
    },

    factuur(id) { return sHaal.get(Number(id)) ?? null; },
    facturenVanMail(messageId) { return sHaalPerMail.all(messageId); },
    teLezenFacturen(max) { return sPending.all(Number(max)); },

    zetUitgelezen(id, status, velden) {
      sUitlezenOk.run(
        status,
        w(velden.leverancier), w(velden.factuurnummer), w(velden.factuurdatum), w(velden.vervaldatum),
        velden.bedrag === null || velden.bedrag === undefined ? null : Number(velden.bedrag),
        w(velden.valuta), w(velden.iban), w(velden.betalingskenmerk), w(velden.omschrijving),
        Number(id),
      );
    },
    zetUitleesFout(id, fout) { sUitlezenFout.run(String(fout).slice(0, 500), Number(id)); },
    zetOpnieuwUitlezen(id) { sUitlezenOpnieuw.run(Number(id)); },
    zetStatus(id, status) { sStatus.run(status, Number(id)); },

    zetBetaald(id, { betaald_op, betaald_via, bunq_betaling_id = null, match_score = null }) {
      sBetaald.run(
        w(betaald_op), betaald_via, w(bunq_betaling_id),
        match_score === null ? null : Number(match_score), Number(id),
      );
      if (bunq_betaling_id) sBetalingKoppel.run(Number(id), String(bunq_betaling_id));
    },

    zetOpen(id) {
      sBetalingOntkoppel.run(Number(id));
      sOpen.run(Number(id));
    },

    zetSuggestie(id, betalingId, score) {
      sSuggestie.run(w(betalingId), score === null ? null : Number(score), Number(id));
    },
    wisSuggesties() { sWisSuggesties.run(); },
    zetDoorgestuurd(id, naar, op = nuIso()) { sDoorgestuurd.run(op, naar, Number(id)); },
    zetNotitie(id, notitie) { sNotitie.run(w(notitie), Number(id)); },

    // Open facturen met een bedrag: de kandidaten om te koppelen.
    openFacturenMetBedrag() {
      return db.prepare(`
        SELECT * FROM facturen
        WHERE status = 'open' AND bedrag IS NOT NULL
          AND uitlees_status IN ('ok', 'handmatig')
        ORDER BY id`).all();
    },

    // -- lijst en tegels -------------------------------------------------
    lijst(filter, zoek, nu) {
      const waarden = [];
      let waar = '1 = 1';
      if (filter === 'open') waar = "status = 'open'";
      else if (filter === 'verlopen') { waar = "status = 'open' AND vervaldatum IS NOT NULL AND vervaldatum < ?"; waarden.push(nu); }
      else if (filter === 'betaald') waar = "status = 'betaald'";
      else if (filter === 'doorsturen') waar = "status = 'betaald' AND doorgestuurd_op IS NULL";
      else if (filter === 'controle') waar = "uitlees_status = 'mislukt' OR (status = 'open' AND suggestie_betaling_id IS NOT NULL)";
      else if (filter === 'genegeerd') waar = "status = 'genegeerd'";

      if (zoek) {
        const p = '%' + zoek.toLowerCase() + '%';
        waar += ` AND (lower(coalesce(leverancier, '')) LIKE ?
                   OR lower(coalesce(factuurnummer, '')) LIKE ?
                   OR lower(coalesce(onderwerp, '')) LIKE ?
                   OR lower(coalesce(afzender_email, '')) LIKE ?
                   OR lower(coalesce(omschrijving, '')) LIKE ?)`;
        waarden.push(p, p, p, p, p);
      }

      // Open facturen eerst op vervaldatum (zonder datum achteraan), de rest
      // op wat er het laatst gebeurde.
      return db.prepare(`
        SELECT * FROM facturen WHERE ${waar}
        ORDER BY
          CASE WHEN status = 'open' THEN 0 ELSE 1 END,
          CASE WHEN status = 'open' AND vervaldatum IS NULL THEN 1 ELSE 0 END,
          CASE WHEN status = 'open' THEN vervaldatum END ASC,
          coalesce(betaald_op, ontvangen, aangemaakt_op) DESC,
          id DESC
        LIMIT 500`).all(...waarden);
    },

    tegels(nu) {
      const maand = nu.slice(0, 7);
      const een = (sql, ...p) => db.prepare(sql).get(...p);
      return {
        open: een("SELECT count(*) AS aantal, coalesce(sum(bedrag), 0) AS som FROM facturen WHERE status = 'open'"),
        verlopen: een(`SELECT count(*) AS aantal, coalesce(sum(bedrag), 0) AS som FROM facturen
                       WHERE status = 'open' AND vervaldatum IS NOT NULL AND vervaldatum < ?`, nu),
        betaaldDezeMaand: een(`SELECT count(*) AS aantal, coalesce(sum(bedrag), 0) AS som FROM facturen
                               WHERE status = 'betaald' AND substr(betaald_op, 1, 7) = ?`, maand),
        nogDoorsturen: een(`SELECT count(*) AS aantal, coalesce(sum(bedrag), 0) AS som FROM facturen
                            WHERE status = 'betaald' AND doorgestuurd_op IS NULL`),
        controle: een(`SELECT count(*) AS aantal, coalesce(sum(bedrag), 0) AS som FROM facturen
                       WHERE uitlees_status = 'mislukt'
                          OR (status = 'open' AND suggestie_betaling_id IS NOT NULL)`),
      };
    },

    // Factuurbedrag per maand over de laatste twaalf maanden, oudste eerst.
    perMaand(nu) {
      const rijen = db.prepare(`
        SELECT substr(coalesce(factuurdatum, ontvangen), 1, 7) AS maand,
               coalesce(sum(bedrag), 0) AS som, count(*) AS aantal
        FROM facturen
        WHERE status != 'genegeerd' AND bedrag IS NOT NULL
          AND substr(coalesce(factuurdatum, ontvangen), 1, 7) >= ?
        GROUP BY maand ORDER BY maand`).all(maandenTerug(nu, 11));
      const index = new Map(rijen.map((r) => [r.maand, r]));
      const uit = [];
      for (let i = 11; i >= 0; i--) {
        const maand = maandenTerug(nu, i);
        const r = index.get(maand);
        uit.push({ maand, som: r ? r.som : 0, aantal: r ? r.aantal : 0 });
      }
      return uit;
    },

    topLeveranciers(nu, hoeveel = 6) {
      return db.prepare(`
        SELECT coalesce(nullif(leverancier, ''), '(onbekend)') AS leverancier,
               coalesce(sum(bedrag), 0) AS som, count(*) AS aantal
        FROM facturen
        WHERE status != 'genegeerd' AND bedrag IS NOT NULL
          AND coalesce(factuurdatum, ontvangen) >= ?
        GROUP BY leverancier ORDER BY som DESC, leverancier LIMIT ?`)
        .all(maandenTerug(nu, 11) + '-01', Number(hoeveel));
    },

    // -- bunq ------------------------------------------------------------
    voegBetalingToe(b) {
      sBetalingUpsert.run(
        String(b.id), w(b.rekening_id), w(b.rekening_iban), w(b.datum),
        b.bedrag === null || b.bedrag === undefined ? null : Number(b.bedrag),
        w(b.valuta), w(b.tegenrekening_iban), w(b.tegenpartij_naam), w(b.omschrijving),
      );
    },
    betaling(id) { return id ? (sBetaling.get(String(id)) ?? null) : null; },
    vrijeBetalingen() { return sBetalingenVrij.all(); },
    aantalBetalingen() { return sBetalingenAantal.get().n; },
    koppelBetaling(factuurId, betalingId) { sBetalingKoppel.run(Number(factuurId), String(betalingId)); },

    // -- instellingen ----------------------------------------------------
    alleInstellingen() {
      const uit = {};
      for (const r of sInstellingen.all()) uit[r.sleutel] = r.waarde;
      return uit;
    },
    instelling(sleutel) {
      const r = sInstelling.get(sleutel);
      return r ? r.waarde : null;
    },
    zetInstelling(sleutel, waarde) {
      sZetInstelling.run(sleutel, waarde === null || waarde === undefined ? null : String(waarde));
    },

    // -- logboek ---------------------------------------------------------
    log(niveau, bericht, factuurId = null) {
      sLog.run(nuIso(), factuurId === null ? null : Number(factuurId), niveau, String(bericht).slice(0, 1000));
    },
    logboekVanFactuur(id, max = 50) { return sLogVanFactuur.all(Number(id), Number(max)); },
    logboek(max = 100) { return sLogAlles.all(Number(max)); },

    _hulp: { vlag },
  };
}

// "2026-10-05" en 11 -> "2025-11": de maand n maanden terug, als YYYY-MM.
function maandenTerug(datum, n) {
  const jaar = Number(datum.slice(0, 4));
  const maand = Number(datum.slice(5, 7));
  const totaal = jaar * 12 + (maand - 1) - n;
  return `${Math.floor(totaal / 12)}-${String((totaal % 12) + 1).padStart(2, '0')}`;
}

export { maandenTerug };
