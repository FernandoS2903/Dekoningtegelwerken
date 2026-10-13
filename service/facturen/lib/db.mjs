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

export const SCHEMA_VERSIE = 7;

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
    bijgewerkt_op INTEGER NOT NULL,
    -- 'sso' (Microsoft) of 'breakglass' (noodtoegang via de tailnet).
    auth_method   TEXT NOT NULL DEFAULT 'sso'
  );

  -- Versie 5: elke poging op de noodtoegang (lib/breakglass.mjs); ook de
  -- bron voor de limiet per IP en voor de replaycontrole van TOTP-stappen.
  CREATE TABLE IF NOT EXISTS breakglass_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    tijd      TEXT NOT NULL,
    tijd_ms   INTEGER NOT NULL,
    ip        TEXT NOT NULL,
    gebruiker TEXT,
    geslaagd  INTEGER NOT NULL,
    reden     TEXT,
    totp_stap INTEGER
  );
  CREATE INDEX IF NOT EXISTS breakglass_log_ip ON breakglass_log (ip, tijd_ms);

  -- Lopende inlogpogingen (state, nonce en PKCE-verifier), tien minuten geldig.
  CREATE TABLE IF NOT EXISTS oidc_pogingen (
    state       TEXT PRIMARY KEY,
    nonce       TEXT NOT NULL,
    verifier    TEXT NOT NULL,
    terug       TEXT,
    verloopt_op INTEGER NOT NULL
  );

  -- Versie 3: koppeling met Offerteknop (lib/offerte-opslag.mjs).

  -- Kopie van de offertelijst uit de tenant-API van Offerteknop. id is het
  -- id van de offerte daar; status is de klantstatus (concept, verstuurd,
  -- bekeken, geaccepteerd, afgewezen, verlopen, ingetrokken).
  CREATE TABLE IF NOT EXISTS offertes_spiegel (
    id               INTEGER PRIMARY KEY,
    nummer           TEXT,
    nummer_str       TEXT,
    versie           INTEGER NOT NULL DEFAULT 1,
    status           TEXT NOT NULL,
    status_intern    TEXT,
    gearchiveerd     INTEGER NOT NULL DEFAULT 0,
    klant_naam       TEXT,
    klant_email      TEXT,
    klant_telefoon   TEXT,
    klanttype        TEXT,
    projectadres     TEXT,
    bedrag_excl_cent INTEGER,
    bedrag_incl_cent INTEGER,
    btw_pct          REAL,
    datum            TEXT,
    aangemaakt_op    TEXT,
    gewijzigd_op     TEXT,
    verstuurd_op     TEXT,
    bekeken_op       TEXT,
    beslist_op       TEXT,
    geldig_tot       TEXT,
    verlopen_op      TEXT,
    ingetrokken_op   TEXT,
    bron             TEXT,
    referentie       TEXT,
    bewerk_url       TEXT,
    bijgewerkt_op    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS offertes_spiegel_status ON offertes_spiegel (status, gearchiveerd);

  -- Welke mail (sorteer_log) of website-aanvraag welk concept werd.
  CREATE TABLE IF NOT EXISTS offerte_concepten (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    bron           TEXT NOT NULL,
    referentie     TEXT,
    sorteer_log_id INTEGER,
    aanvraag_id    INTEGER,
    offerte_id     INTEGER NOT NULL,
    bewerk_url     TEXT,
    door           TEXT,
    tijd           TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS offerte_concepten_ref ON offerte_concepten (referentie);
  CREATE INDEX IF NOT EXISTS offerte_concepten_log ON offerte_concepten (sorteer_log_id);

  -- Ontvangen webhook-gebeurtenissen (id van Offerteknop), tegen dubbele aflevering.
  CREATE TABLE IF NOT EXISTS webhook_gebeurtenissen (
    id          TEXT PRIMARY KEY,
    gebeurtenis TEXT NOT NULL,
    offerte_id  INTEGER,
    tijd        TEXT NOT NULL
  );

  -- Replaycache van de ondertekende verzoeken op /intern/.
  CREATE TABLE IF NOT EXISTS intern_replay (
    handtekening TEXT PRIMARY KEY,
    verloopt     INTEGER NOT NULL
  );

  -- Mails die Offerteknop via onze mailbox verstuurde (limiet en logboek).
  CREATE TABLE IF NOT EXISTS mail_relay_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    tijd       TEXT NOT NULL,
    offerte_id INTEGER,
    aan        TEXT NOT NULL,
    onderwerp  TEXT,
    status     TEXT NOT NULL,
    fout       TEXT
  );
  CREATE INDEX IF NOT EXISTS mail_relay_tijd ON mail_relay_log (tijd);

  -- Website-aanvragen van de offertewizard (lib/aanvraag-opslag.mjs). Elke
  -- aanvraag heeft twee uitgangen met elk een eigen stand: de mail naar de
  -- mailbox (vangnet) en het doorsturen naar Offerteknop (wachtrij met
  -- herkansingen). Versie 4 voegde de kolommen vanaf referentie toe
  -- (AANVRAAG_KOLOMMEN hieronder, ook de migratie voor bestaande databases).
  CREATE TABLE IF NOT EXISTS aanvragen (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    tijd              TEXT NOT NULL,
    bron              TEXT NOT NULL,
    velden            TEXT NOT NULL,
    bestanden         TEXT,
    status            TEXT NOT NULL DEFAULT 'nieuw',
    offerte_id        INTEGER,
    referentie        TEXT,
    bestandsmap       TEXT,
    mail_status       TEXT NOT NULL DEFAULT 'wacht',
    mail_fout         TEXT,
    mail_op           TEXT,
    koppeling_status  TEXT NOT NULL DEFAULT 'wacht',
    koppeling_fout    TEXT,
    koppeling_op      TEXT,
    offerte_nummer    TEXT,
    pogingen          INTEGER NOT NULL DEFAULT 0,
    volgende_poging   TEXT,
    laatste_poging    TEXT
  );

  -- Project-CMS (versie 6): de projecten op dekoningtegelwerken.nl, beheerd
  -- onder WEBSITE > Projecten. Zie lib/projecten-opslag.mjs.
  CREATE TABLE IF NOT EXISTS projecten (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    slug               TEXT NOT NULL,
    titel              TEXT NOT NULL,
    plaats             TEXT NOT NULL DEFAULT '',
    ruimte             TEXT NOT NULL DEFAULT '',
    categorieen        TEXT NOT NULL DEFAULT '',
    korte_omschrijving TEXT NOT NULL DEFAULT '',
    beschrijving       TEXT NOT NULL DEFAULT '',
    meta_description   TEXT NOT NULL DEFAULT '',
    soort_tegel        TEXT NOT NULL DEFAULT '',
    formaat            TEXT NOT NULL DEFAULT '',
    werkzaamheden      TEXT NOT NULL DEFAULT '',
    bijzonderheden     TEXT NOT NULL DEFAULT '',
    uitgelicht         INTEGER NOT NULL DEFAULT 0,
    voorbeeld          INTEGER NOT NULL DEFAULT 0,
    status             TEXT NOT NULL DEFAULT 'concept',
    volgorde           INTEGER NOT NULL DEFAULT 0,
    datum              TEXT,
    aangemaakt_op      TEXT NOT NULL,
    gewijzigd_op       TEXT NOT NULL,
    verwijderd_op      TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS projecten_slug ON projecten (slug) WHERE verwijderd_op IS NULL;
  CREATE INDEX IF NOT EXISTS projecten_volgorde ON projecten (volgorde, id);

  -- Eerdere slugs, voor een 301 naar de huidige.
  CREATE TABLE IF NOT EXISTS project_slugs (
    slug       TEXT PRIMARY KEY,
    project_id INTEGER NOT NULL REFERENCES projecten (id) ON DELETE CASCADE
  );

  -- Foto's: bestandsnaam is de basis (<slug>-<willekeurig>); op schijf staan
  -- <bestandsnaam>-<breedte>.webp voor elke breedte in varianten.
  CREATE TABLE IF NOT EXISTS project_fotos (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL REFERENCES projecten (id) ON DELETE CASCADE,
    bestandsnaam TEXT NOT NULL UNIQUE,
    varianten   TEXT NOT NULL,
    breedte     INTEGER NOT NULL,
    hoogte      INTEGER NOT NULL,
    alt_tekst   TEXT NOT NULL DEFAULT '',
    soort       TEXT NOT NULL DEFAULT 'galerij',
    bijschrift  TEXT NOT NULL DEFAULT '',
    sfeerbeeld  INTEGER NOT NULL DEFAULT 0,
    volgorde    INTEGER NOT NULL DEFAULT 0,
    is_cover    INTEGER NOT NULL DEFAULT 0,
    aangemaakt_op TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS project_fotos_project ON project_fotos (project_id, volgorde, id);

  -- Versie 7: inkoopfacturen betalen via bunq (lib/betalen.mjs,
  -- lib/betalen-opslag.mjs). Het portaal maakt alleen conceptbetalingen
  -- (DraftPayment) die de eigenaar in de bunq-app goedkeurt.

  -- Eén regel per poging om een conceptbetaling klaar te zetten. sleutel komt
  -- uit het bevestigingsformulier: twee keer versturen geeft één draft.
  -- status: bezig (nog niet bij bunq), onzeker (antwoord kwijt), PENDING,
  -- ACCEPTED, REJECTED, CANCELLED, mislukt, of wat bunq verder teruggeeft.
  CREATE TABLE IF NOT EXISTS bunq_drafts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sleutel         TEXT NOT NULL UNIQUE,
    bunq_id         TEXT,
    rekening_id     TEXT NOT NULL,
    rekening_iban   TEXT,
    status          TEXT NOT NULL,
    totaal          REAL NOT NULL,
    aantal          INTEGER NOT NULL,
    door            TEXT NOT NULL,
    aangemaakt_op   TEXT NOT NULL,
    bijgewerkt_op   TEXT NOT NULL,
    bunq_bijgewerkt TEXT,
    fout            TEXT
  );
  CREATE INDEX IF NOT EXISTS bunq_drafts_status ON bunq_drafts (status);

  -- De regels van een draft (één per factuur). actief = 1 zolang de draft
  -- loopt of is goedgekeurd; de unieke index maakt een tweede actieve draft
  -- voor dezelfde factuur onmogelijk, ook bij twee verzoeken tegelijk.
  CREATE TABLE IF NOT EXISTS bunq_draft_regels (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id     INTEGER NOT NULL REFERENCES bunq_drafts (id),
    factuur_id   INTEGER NOT NULL,
    leverancier  TEXT NOT NULL,
    bedrag       REAL NOT NULL,
    iban         TEXT NOT NULL,
    naam         TEXT NOT NULL,
    omschrijving TEXT NOT NULL,
    betaling_id  TEXT,
    actief       INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX IF NOT EXISTS bunq_draft_regels_draft ON bunq_draft_regels (draft_id);
  CREATE UNIQUE INDEX IF NOT EXISTS bunq_draft_regels_actief ON bunq_draft_regels (factuur_id) WHERE actief = 1;

  -- Bekende IBAN's per leverancier (sleutel = genormaliseerde naam). Een
  -- IBAN wordt 'voorlopig' zodra iemand hem bij het klaarzetten bevestigt, en
  -- pas 'vertrouwd' als bunq meldt dat die draft is goedgekeurd.
  CREATE TABLE IF NOT EXISTS leverancier_ibans (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    leverancier    TEXT NOT NULL,
    naam           TEXT,
    iban           TEXT NOT NULL,
    iban_naam      TEXT,
    status         TEXT NOT NULL,
    bevestigd_door TEXT NOT NULL,
    bevestigd_op   TEXT NOT NULL,
    vertrouwd_op   TEXT,
    UNIQUE (leverancier, iban)
  );
  CREATE INDEX IF NOT EXISTS leverancier_ibans_iban ON leverancier_ibans (iban);
`;

// Kolommen die versie 7 toevoegde aan bestaande tabellen.
const VERSIE_7_KOLOMMEN = [
  ['facturen', 'iban_naam', 'TEXT'],
  ['facturen', 'betaalwijze', 'TEXT'],
  ['logboek', 'door', 'TEXT'],
];

// Kolommen die versie 4 aan `aanvragen` toevoegde; voor een database van
// versie 3 komen ze er met ALTER TABLE bij (rijen blijven staan).
const AANVRAAG_KOLOMMEN = [
  ['referentie', 'TEXT'],
  ['bestandsmap', 'TEXT'],
  ['mail_status', "TEXT NOT NULL DEFAULT 'wacht'"],
  ['mail_fout', 'TEXT'],
  ['mail_op', 'TEXT'],
  ['koppeling_status', "TEXT NOT NULL DEFAULT 'wacht'"],
  ['koppeling_fout', 'TEXT'],
  ['koppeling_op', 'TEXT'],
  ['offerte_nummer', 'TEXT'],
  ['pogingen', 'INTEGER NOT NULL DEFAULT 0'],
  ['volgende_poging', 'TEXT'],
  ['laatste_poging', 'TEXT'],
];

// Velden die het bewerkformulier en het uitlezen mogen zetten.
export const UITGELEZEN_VELDEN = [
  'leverancier', 'factuurnummer', 'factuurdatum', 'vervaldatum',
  'bedrag', 'valuta', 'iban', 'iban_naam', 'betalingskenmerk', 'betaalwijze', 'omschrijving',
];

export const BETAALWIJZEN = ['overboeking', 'incasso', 'al_betaald'];

// Sorteringen van de factuurlijst: sleutel in de URL -> ORDER BY.
export const SORTERINGEN = {
  'leverancier': "lower(coalesce(leverancier, afzender_naam, afzender_email, '')) ASC, id DESC",
  'leverancier-af': "lower(coalesce(leverancier, afzender_naam, afzender_email, '')) DESC, id DESC",
  'datum': 'coalesce(factuurdatum, substr(ontvangen, 1, 10)) ASC, id ASC',
  'datum-af': 'coalesce(factuurdatum, substr(ontvangen, 1, 10)) DESC, id DESC',
  'vervaldatum': 'vervaldatum IS NULL, vervaldatum ASC, id DESC',
  'vervaldatum-af': 'vervaldatum IS NULL, vervaldatum DESC, id DESC',
  'bedrag': 'bedrag IS NULL, bedrag ASC, id DESC',
  'bedrag-af': 'bedrag IS NULL, bedrag DESC, id DESC',
  'status': "CASE status WHEN 'open' THEN 0 WHEN 'betaald' THEN 1 ELSE 2 END, id DESC",
  'status-af': "CASE status WHEN 'open' THEN 2 WHEN 'betaald' THEN 1 ELSE 0 END, id DESC",
};

export function openDatabase(pad) {
  mkdirSync(path.dirname(pad), { recursive: true });
  const db = new DatabaseSync(pad);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Een tweede proces (of een test) kan tegelijk schrijven: even wachten in
  // plaats van direct "database is locked".
  db.exec('PRAGMA busy_timeout = 5000');
  // De tabel aanvragen van versie 3 bestaat mogelijk al zonder de nieuwe
  // kolommen; CREATE TABLE IF NOT EXISTS laat hem dan staan en de migratie
  // hieronder vult de kolommen aan. De unieke index komt daarom pas daarna.
  db.exec(SCHEMA);

  const versie = db.prepare('PRAGMA user_version').get().user_version;
  if (versie < SCHEMA_VERSIE) {
    // Versie 1 is het eerste schema. Versie 2 (mailsorteerder, portaal) en
    // versie 3 (koppeling Offerteknop) voegen alleen nieuwe tabellen toe;
    // die maakt SCHEMA hierboven al aan.
    // Versie 4: de wachtrij-kolommen op aanvragen (website-aanvragen).
    const aanwezig = new Set(db.prepare('PRAGMA table_info(aanvragen)').all().map((k) => k.name));
    for (const [naam, definitie] of AANVRAAG_KOLOMMEN) {
      if (!aanwezig.has(naam)) db.exec(`ALTER TABLE aanvragen ADD COLUMN ${naam} ${definitie}`);
    }
    // Versie 5: auth_method op sessies (break-glass) en de tabel breakglass_log (via SCHEMA).
    // Versie 6 (project-CMS) voegt alleen nieuwe tabellen toe; die maakt SCHEMA al aan.
    const sessieKolommen = new Set(db.prepare('PRAGMA table_info(sessies)').all().map((k) => k.name));
    if (!sessieKolommen.has('auth_method')) db.exec("ALTER TABLE sessies ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'sso'");
    // Versie 7: tenaamstelling en betaalwijze op facturen, wie iets deed in het
    // logboek; de tabellen voor betalen via bunq maakt SCHEMA al aan.
    for (const [tabel, naam, definitie] of VERSIE_7_KOLOMMEN) {
      const kolommen = new Set(db.prepare(`PRAGMA table_info(${tabel})`).all().map((k) => k.name));
      if (!kolommen.has(naam)) db.exec(`ALTER TABLE ${tabel} ADD COLUMN ${naam} ${definitie}`);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSIE}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS aanvragen_referentie ON aanvragen (referentie)');
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
      bedrag = ?, valuta = ?, iban = ?, iban_naam = ?, betalingskenmerk = ?, betaalwijze = ?, omschrijving = ?
    WHERE id = ?`);
  const sBetaalgegevens = q('UPDATE facturen SET iban_naam = ?, betaalwijze = ? WHERE id = ?');
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

  const sLog = q('INSERT INTO logboek (tijd, factuur_id, niveau, bericht, door) VALUES (?, ?, ?, ?, ?)');
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
        w(velden.valuta), w(velden.iban), w(velden.iban_naam), w(velden.betalingskenmerk),
        BETAALWIJZEN.includes(velden.betaalwijze) ? velden.betaalwijze : null, w(velden.omschrijving),
        Number(id),
      );
    },
    // Alleen tenaamstelling en betaalwijze (het eenmalig nalezen in fase C);
    // de rest van de factuur, ook wat met de hand is gecorrigeerd, blijft staan.
    zetBetaalgegevens(id, { iban_naam = null, betaalwijze = null }) {
      sBetaalgegevens.run(w(iban_naam), BETAALWIJZEN.includes(betaalwijze) ? betaalwijze : null, Number(id));
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

    // Open, uitgelezen facturen zonder tenaamstelling: voor het eenmalig
    // nalezen (service/cli/betaalgegevens-nalezen.mjs).
    openZonderTenaamstelling() {
      return db.prepare(`
        SELECT * FROM facturen
        WHERE status = 'open' AND uitlees_status IN ('ok', 'handmatig') AND iban_naam IS NULL
        ORDER BY id`).all();
    },

    // Open facturen met een bedrag: de kandidaten om te koppelen.
    openFacturenMetBedrag() {
      return db.prepare(`
        SELECT * FROM facturen
        WHERE status = 'open' AND bedrag IS NOT NULL
          AND uitlees_status IN ('ok', 'handmatig')
        ORDER BY id`).all();
    },

    // -- lijst en tegels -------------------------------------------------
    // `sorteer` is een sleutel uit SORTERINGEN; alles anders valt terug op de
    // standaardvolgorde (open eerst, op vervaldatum).
    lijst(filter, zoek, nu, sorteer = '') {
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
      const volgorde = SORTERINGEN[sorteer] || `
          CASE WHEN status = 'open' THEN 0 ELSE 1 END,
          CASE WHEN status = 'open' AND vervaldatum IS NULL THEN 1 ELSE 0 END,
          CASE WHEN status = 'open' THEN vervaldatum END ASC,
          coalesce(betaald_op, ontvangen, aangemaakt_op) DESC,
          id DESC`;
      // draft_status: de stand van een lopende conceptbetaling in bunq, voor
      // het labeltje in de lijst.
      return db.prepare(`SELECT *,
          (SELECT d.status FROM bunq_draft_regels r JOIN bunq_drafts d ON d.id = r.draft_id
           WHERE r.factuur_id = facturen.id AND r.actief = 1 ORDER BY r.id DESC LIMIT 1) AS draft_status
        FROM facturen WHERE ${waar} ORDER BY ${volgorde} LIMIT 500`).all(...waarden);
    },

    // Alles wat aandacht vraagt, voor het dashboard: mislukt uitlezen, een
    // voorstel dat bevestigd moet worden, verlopen, en betaald maar nog niet
    // doorgestuurd. Eén regel per factuur, met de reden erbij.
    actieVereist(nu, max = 8) {
      return db.prepare(`
        SELECT *,
          CASE
            WHEN uitlees_status = 'mislukt' THEN 'uitlezen mislukt'
            WHEN status = 'open' AND suggestie_betaling_id IS NOT NULL THEN 'betaling gevonden, bevestigen'
            WHEN status = 'open' AND vervaldatum IS NOT NULL AND vervaldatum < ? THEN 'verlopen'
            WHEN status = 'betaald' AND doorgestuurd_op IS NULL THEN 'nog naar de boekhouder'
          END AS actie
        FROM facturen
        WHERE uitlees_status = 'mislukt'
           OR (status = 'open' AND suggestie_betaling_id IS NOT NULL)
           OR (status = 'open' AND vervaldatum IS NOT NULL AND vervaldatum < ?)
           OR (status = 'betaald' AND doorgestuurd_op IS NULL)
        ORDER BY
          CASE WHEN uitlees_status = 'mislukt' THEN 0 WHEN suggestie_betaling_id IS NOT NULL THEN 1
               WHEN status = 'open' THEN 2 ELSE 3 END,
          vervaldatum ASC, id DESC
        LIMIT ?`).all(nu, nu, Number(max));
    },

    // Per leverancier: aantal, totaal, open en verlopen bedrag, laatste factuur.
    leveranciers(nu) {
      return db.prepare(`
        SELECT coalesce(nullif(leverancier, ''), '(onbekend)') AS leverancier,
               count(*) AS aantal,
               coalesce(sum(bedrag), 0) AS som,
               coalesce(sum(CASE WHEN status = 'open' THEN bedrag END), 0) AS open_som,
               sum(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_aantal,
               sum(CASE WHEN status = 'open' AND vervaldatum IS NOT NULL AND vervaldatum < ? THEN 1 ELSE 0 END) AS verlopen_aantal,
               max(coalesce(factuurdatum, substr(ontvangen, 1, 10))) AS laatste
        FROM facturen
        WHERE status != 'genegeerd'
        GROUP BY leverancier
        ORDER BY open_som DESC, som DESC, leverancier`).all(nu);
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
    // `door`: wie het deed (e-mailadres van de sessie), als het een mens was.
    log(niveau, bericht, factuurId = null, door = null) {
      sLog.run(nuIso(), factuurId === null ? null : Number(factuurId), niveau, String(bericht).slice(0, 1000), w(door));
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
