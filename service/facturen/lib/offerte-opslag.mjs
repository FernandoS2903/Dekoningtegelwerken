// Opslag voor de koppeling met Offerteknop (schema versie 3).
//
//   offertes_spiegel      kopie van de offertelijst uit de API (voor de pagina
//                         Offertes en de tegels op het dashboard); bijgewerkt
//                         door de webhook en de periodieke ronde
//   offerte_concepten     welke mail of website-aanvraag welk concept werd
//                         (referentie -> offerte), zodat een tweede klik niets
//                         dubbel maakt
//   webhook_gebeurtenissen ontvangen webhook-id's: een herhaalde aflevering
//                         wordt herkend
//   intern_replay         replaycache van de ondertekende verzoeken
//   mail_relay_log        elke mail die Offerteknop via ons verstuurde, voor de
//                         limiet en het logboek
//   aanvragen             website-aanvragen van de offertewizard (voorbereid;
//                         de wizard krijgt later een backend)

import { nuIso } from './hulp.mjs';

export const API_STATUSSEN = ['concept', 'verstuurd', 'bekeken', 'geaccepteerd', 'afgewezen', 'verlopen', 'ingetrokken'];
export const STATUS_NAAM = {
  concept: 'concept', verstuurd: 'verstuurd', bekeken: 'bekeken', geaccepteerd: 'geaccepteerd',
  afgewezen: 'afgewezen', verlopen: 'verlopen', ingetrokken: 'ingetrokken',
};
// Filters op de pagina Offertes: sleutel -> statussen.
export const OFFERTE_FILTERS = [
  ['open', 'Openstaand', ['concept', 'verstuurd', 'bekeken']],
  ['wacht', 'Wacht op akkoord', ['verstuurd', 'bekeken']],
  ['concept', 'Concepten', ['concept']],
  ['geaccepteerd', 'Geaccepteerd', ['geaccepteerd']],
  ['afgewezen', 'Afgewezen', ['afgewezen', 'verlopen', 'ingetrokken']],
  ['alle', 'Alle', API_STATUSSEN],
];

const w = (v) => (v === undefined || v === '' ? null : v);
const vlag = (v) => (v ? 1 : 0);

export function maakOfferteOpslag(db) {
  const sSpiegel = db.prepare(`INSERT INTO offertes_spiegel
    (id, nummer, nummer_str, versie, status, status_intern, gearchiveerd, klant_naam, klant_email, klant_telefoon, klanttype,
     projectadres, bedrag_excl_cent, bedrag_incl_cent, btw_pct, datum, aangemaakt_op, gewijzigd_op, verstuurd_op, bekeken_op,
     beslist_op, geldig_tot, verlopen_op, ingetrokken_op, bron, referentie, bewerk_url, bijgewerkt_op)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      nummer = excluded.nummer, nummer_str = excluded.nummer_str, versie = excluded.versie, status = excluded.status,
      status_intern = excluded.status_intern, gearchiveerd = excluded.gearchiveerd, klant_naam = excluded.klant_naam,
      klant_email = excluded.klant_email, klant_telefoon = excluded.klant_telefoon, klanttype = excluded.klanttype,
      projectadres = excluded.projectadres, bedrag_excl_cent = excluded.bedrag_excl_cent, bedrag_incl_cent = excluded.bedrag_incl_cent,
      btw_pct = excluded.btw_pct, datum = excluded.datum, aangemaakt_op = excluded.aangemaakt_op, gewijzigd_op = excluded.gewijzigd_op,
      verstuurd_op = excluded.verstuurd_op, bekeken_op = excluded.bekeken_op, beslist_op = excluded.beslist_op,
      geldig_tot = excluded.geldig_tot, verlopen_op = excluded.verlopen_op, ingetrokken_op = excluded.ingetrokken_op,
      bron = excluded.bron, referentie = excluded.referentie, bewerk_url = excluded.bewerk_url, bijgewerkt_op = excluded.bijgewerkt_op`);
  const sSpiegelEen = db.prepare('SELECT * FROM offertes_spiegel WHERE id = ?');
  const sConcept = db.prepare(`INSERT INTO offerte_concepten (bron, referentie, sorteer_log_id, aanvraag_id, offerte_id, bewerk_url, door, tijd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const sConceptBijReferentie = db.prepare('SELECT * FROM offerte_concepten WHERE referentie = ? ORDER BY id DESC LIMIT 1');
  const sConceptBijLog = db.prepare('SELECT * FROM offerte_concepten WHERE sorteer_log_id = ? ORDER BY id DESC LIMIT 1');
  const sGebeurtenis = db.prepare('INSERT OR IGNORE INTO webhook_gebeurtenissen (id, gebeurtenis, offerte_id, tijd) VALUES (?, ?, ?, ?)');
  const sReplayWeg = db.prepare('DELETE FROM intern_replay WHERE verloopt < ?');
  const sReplay = db.prepare('INSERT OR IGNORE INTO intern_replay (handtekening, verloopt) VALUES (?, ?)');
  const sRelay = db.prepare('INSERT INTO mail_relay_log (tijd, offerte_id, aan, onderwerp, status, fout) VALUES (?, ?, ?, ?, ?, ?)');
  const sRelayTel = db.prepare("SELECT COUNT(*) n FROM mail_relay_log WHERE status = 'verzonden' AND tijd >= ?");
  const sStaat = db.prepare('INSERT INTO sorteer_staat (sleutel, waarde) VALUES (?, ?) ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde');
  const sStaatLees = db.prepare('SELECT waarde FROM sorteer_staat WHERE sleutel = ?');

  // Samenvatting uit de API (lib/offertestatus.js in Offerteknop) -> rij.
  function bewaar(o) {
    sSpiegel.run(
      Number(o.id), w(o.nummer), w(o.nummer_str), Number(o.versie) || 1, String(o.status || 'concept'), w(o.status_intern), vlag(o.gearchiveerd),
      w(o.klant_naam), w(o.klant_email ? String(o.klant_email).toLowerCase() : null), w(o.klant_telefoon), w(o.klanttype),
      w(o.projectadres), o.bedrag_excl_cent == null ? null : Number(o.bedrag_excl_cent), o.bedrag_incl_cent == null ? null : Number(o.bedrag_incl_cent),
      o.btw_pct == null ? null : Number(o.btw_pct), w(o.datum), w(o.aangemaakt_op), w(o.gewijzigd_op), w(o.verstuurd_op), w(o.bekeken_op),
      w(o.beslist_op), w(o.geldig_tot), w(o.verlopen_op), w(o.ingetrokken_op), w(o.bron), w(o.referentie), w(o.bewerk_url), nuIso(),
    );
    return sSpiegelEen.get(Number(o.id));
  }

  return {
    bewaar,
    offerte: (id) => sSpiegelEen.get(Number(id)) ?? null,

    // De lijst voor de pagina Offertes: gearchiveerd blijft buiten beeld.
    lijst({ filter = 'open', zoek = '', max = 500 } = {}) {
      const keuze = OFFERTE_FILTERS.find(([s]) => s === filter) || OFFERTE_FILTERS[0];
      const waar = ['gearchiveerd = 0', `status IN (${keuze[2].map(() => '?').join(',')})`];
      const waarden = [...keuze[2]];
      const term = String(zoek || '').trim().toLowerCase();
      if (term) {
        waar.push("(lower(coalesce(klant_naam, '')) LIKE ? OR lower(coalesce(nummer_str, '')) LIKE ? OR lower(coalesce(klant_email, '')) LIKE ? OR lower(coalesce(projectadres, '')) LIKE ?)");
        for (let i = 0; i < 4; i++) waarden.push(`%${term}%`);
      }
      return db.prepare(`SELECT * FROM offertes_spiegel WHERE ${waar.join(' AND ')}
        ORDER BY coalesce(gewijzigd_op, aangemaakt_op) DESC, id DESC LIMIT ?`).all(...waarden, max);
    },

    // Tegels op het dashboard. `nu` is een ISO-datum (YYYY-MM-DD).
    tellingen(nu) {
      const maand = String(nu).slice(0, 7);
      const tel = (statussen, extra = '', waarden = []) => db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(bedrag_incl_cent), 0) som FROM offertes_spiegel
        WHERE gearchiveerd = 0 AND status IN (${statussen.map(() => '?').join(',')}) ${extra}`).get(...statussen, ...waarden);
      return {
        concepten: tel(['concept']),
        wachtOpAkkoord: tel(['verstuurd', 'bekeken']),
        geaccepteerdDezeMaand: tel(['geaccepteerd'], 'AND substr(beslist_op, 1, 7) = ?', [maand]),
        verlopen: tel(['verlopen']),
      };
    },

    // -- concepten uit mail of website -----------------------------------
    conceptBijReferentie: (referentie) => sConceptBijReferentie.get(String(referentie)) ?? null,
    conceptBijLog: (logId) => sConceptBijLog.get(Number(logId)) ?? null,
    noteerConcept({ bron, referentie, sorteerLogId = null, aanvraagId = null, offerteId, bewerkUrl, door = null }) {
      sConcept.run(bron, w(referentie), sorteerLogId === null ? null : Number(sorteerLogId), aanvraagId === null ? null : Number(aanvraagId), Number(offerteId), w(bewerkUrl), w(door), nuIso());
    },

    // -- webhook en replay ---------------------------------------------------
    // true als deze gebeurtenis nieuw is.
    noteerGebeurtenis(id, gebeurtenis, offerteId) {
      return sGebeurtenis.run(String(id), String(gebeurtenis), offerteId === null ? null : Number(offerteId), nuIso()).changes === 1;
    },
    registreerHandtekening(handtekening, { nu = Date.now(), bewaarMs = 10 * 60 * 1000 } = {}) {
      sReplayWeg.run(nu);
      return sReplay.run(String(handtekening), nu + bewaarMs).changes === 1;
    },

    // -- mailrelay -------------------------------------------------------------
    noteerRelay({ offerteId = null, aan, onderwerp, status, fout = null }) {
      sRelay.run(nuIso(), offerteId === null ? null : Number(offerteId), String(aan || ''), String(onderwerp || '').slice(0, 200), status, w(fout ? String(fout).slice(0, 300) : null));
    },
    relayTelling(nu = Date.now()) {
      return {
        uur: sRelayTel.get(new Date(nu - 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')).n,
        dag: sRelayTel.get(new Date(nu - 24 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')).n,
      };
    },
    relayLijst(max = 50) {
      return db.prepare('SELECT * FROM mail_relay_log ORDER BY id DESC LIMIT ?').all(max);
    },

    // -- website-aanvragen (voorbereid) ---------------------------------------
    noteerAanvraag({ bron = 'website', velden, bestanden = [] }) {
      const info = db.prepare('INSERT INTO aanvragen (tijd, bron, velden, bestanden, status) VALUES (?, ?, ?, ?, ?)')
        .run(nuIso(), bron, JSON.stringify(velden || {}), JSON.stringify(bestanden || []), 'nieuw');
      return Number(info.lastInsertRowid);
    },
    aanvraag: (id) => db.prepare('SELECT * FROM aanvragen WHERE id = ?').get(Number(id)) ?? null,
    koppelAanvraag(id, offerteId) {
      db.prepare("UPDATE aanvragen SET status = 'concept', offerte_id = ? WHERE id = ?").run(Number(offerteId), Number(id));
    },

    // -- stand ---------------------------------------------------------------
    zetStaat: (sleutel, waarde) => { sStaat.run(sleutel, waarde === null || waarde === undefined ? null : String(waarde)); },
    staat: (sleutel) => sStaatLees.get(sleutel)?.waarde ?? null,
  };
}
