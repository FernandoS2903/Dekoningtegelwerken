// Opslag van de mailsorteerder: logboek, regels en toestand.
//
// Zelfde database als het factuurdashboard (het schema staat in db.mjs);
// deze module kent alleen de queries van de sorteerder.

import { nuIso } from './hulp.mjs';

const w = (v) => (v === undefined || v === '' ? null : v);

export const STATUSSEN = ['verplaatst', 'controleren', 'inbox', 'map uit', 'overgeslagen', 'niet beoordeeld', 'fout', 'teruggezet', 'gecorrigeerd'];
export const BRONNEN = ['regel', 'website', 'ai', 'overgeslagen', 'handmatig'];

// "Jan@Voorbeeld.NL " -> "jan@voorbeeld.nl"; "@voorbeeld.nl" -> "voorbeeld.nl".
export function normaliseerAdres(waarde) {
  return String(waarde ?? '').trim().toLowerCase();
}

export function domeinVan(adres) {
  const s = normaliseerAdres(adres);
  const at = s.lastIndexOf('@');
  return at === -1 ? s.replace(/^@/, '') : s.slice(at + 1);
}

export function maakSorteerOpslag(db) {
  const q = (sql) => db.prepare(sql);

  const sStaat = q('SELECT waarde FROM sorteer_staat WHERE sleutel = ?');
  const sZetStaat = q(`INSERT INTO sorteer_staat (sleutel, waarde) VALUES (?, ?)
    ON CONFLICT (sleutel) DO UPDATE SET waarde = excluded.waarde`);
  const sWisStaat = q('DELETE FROM sorteer_staat WHERE sleutel = ?');

  const sLog = q(`INSERT INTO sorteer_log
    (tijd, message_id, huidig_id, internet_id, ontvangen, afzender_naam, afzender, onderwerp,
     van_map, naar_map, huidige_map, bron, zekerheid, reden, status, fout)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const sLogRegel = q('SELECT * FROM sorteer_log WHERE id = ?');
  const sGezien = q(`SELECT 1 FROM sorteer_log
    WHERE (internet_id IS NOT NULL AND internet_id = ?) OR message_id = ? OR huidig_id = ? LIMIT 1`);
  const sZetHuidig = q('UPDATE sorteer_log SET huidig_id = ?, huidige_map = ?, status = ? WHERE id = ?');

  const sRegels = q('SELECT * FROM sorteer_regels ORDER BY soort, waarde');
  const sRegel = q('SELECT * FROM sorteer_regels WHERE id = ?');
  const sRegelUpsert = q(`INSERT INTO sorteer_regels (soort, waarde, map, door, aangemaakt_op)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (soort, waarde) DO UPDATE SET map = excluded.map, door = excluded.door,
      aangemaakt_op = excluded.aangemaakt_op`);
  const sRegelWeg = q('DELETE FROM sorteer_regels WHERE id = ?');
  const sAdresRegel = q("SELECT * FROM sorteer_regels WHERE soort = 'adres' AND waarde = ?");
  const sDomeinRegels = q("SELECT * FROM sorteer_regels WHERE soort = 'domein'");

  return {
    // -- toestand --------------------------------------------------------
    staat(sleutel) {
      const r = sStaat.get(sleutel);
      return r ? r.waarde : null;
    },
    zetStaat(sleutel, waarde) { sZetStaat.run(sleutel, waarde === null || waarde === undefined ? null : String(waarde)); },
    wisStaat(sleutel) { sWisStaat.run(sleutel); },

    // -- logboek ---------------------------------------------------------
    log(r) {
      const uit = sLog.run(
        r.tijd || nuIso(), w(r.message_id), w(r.huidig_id ?? r.message_id), w(r.internet_id), w(r.ontvangen),
        w(r.afzender_naam), w(r.afzender), w(r.onderwerp), w(r.van_map), w(r.naar_map),
        w(r.huidige_map ?? r.van_map), r.bron,
        r.zekerheid === null || r.zekerheid === undefined ? null : Number(r.zekerheid),
        w(r.reden ? String(r.reden).slice(0, 300) : null), r.status,
        w(r.fout ? String(r.fout).slice(0, 500) : null),
      );
      return Number(uit.lastInsertRowid);
    },
    logRegel(id) { return sLogRegel.get(Number(id)) ?? null; },
    alGezien({ internetId = null, id = null }) {
      return Boolean(sGezien.get(internetId ?? null, id ?? '', id ?? ''));
    },
    zetHuidig(id, { huidig_id, huidige_map, status }) {
      sZetHuidig.run(huidig_id, huidige_map, status, Number(id));
    },

    logLijst({ map = '', bron = '', status = '', max = 200 } = {}) {
      const waar = [];
      const waarden = [];
      if (map) { waar.push('(naar_map = ? OR huidige_map = ?)'); waarden.push(map, map); }
      if (bron) { waar.push('bron = ?'); waarden.push(bron); }
      if (status) { waar.push('status = ?'); waarden.push(status); }
      return db.prepare(`SELECT * FROM sorteer_log ${waar.length ? 'WHERE ' + waar.join(' AND ') : ''}
        ORDER BY id DESC LIMIT ?`).all(...waarden, Number(max));
    },

    // Voor de tegel op de startpagina. `vanaf` is een ISO-tijd (begin van de dag).
    tellingen({ vandaagVanaf, weekVanaf }) {
      const een = (sql, ...p) => db.prepare(sql).get(...p).n;
      return {
        gesorteerdVandaag: een("SELECT count(*) AS n FROM sorteer_log WHERE bron != 'handmatig' AND status IN ('verplaatst', 'teruggezet', 'gecorrigeerd') AND tijd >= ?", vandaagVanaf),
        teControleren: een("SELECT count(*) AS n FROM sorteer_log WHERE status = 'controleren' AND tijd >= ?", weekVanaf),
        offertesWeek: een("SELECT count(*) AS n FROM sorteer_log WHERE bron != 'handmatig' AND naar_map = 'Offerteaanvragen' AND status = 'verplaatst' AND tijd >= ?", weekVanaf),
        fouten: een("SELECT count(*) AS n FROM sorteer_log WHERE status = 'fout' AND tijd >= ?", weekVanaf),
      };
    },

    // -- regels ----------------------------------------------------------
    regels() { return sRegels.all(); },
    regel(id) { return sRegel.get(Number(id)) ?? null; },
    voegRegelToe({ soort, waarde, map, door = null }) {
      const schoon = soort === 'domein' ? domeinVan(waarde) : normaliseerAdres(waarde);
      sRegelUpsert.run(soort, schoon, map, w(door), nuIso());
      return db.prepare('SELECT * FROM sorteer_regels WHERE soort = ? AND waarde = ?').get(soort, schoon);
    },
    verwijderRegel(id) { return sRegelWeg.run(Number(id)).changes > 0; },

    // Een adresregel wint van een domeinregel. Bij domeinen telt ook een
    // subdomein mee (mail.leverancier.nl valt onder leverancier.nl); de
    // meest specifieke wint.
    regelVoor(adres) {
      const a = normaliseerAdres(adres);
      if (!a) return null;
      const opAdres = sAdresRegel.get(a);
      if (opAdres) return opAdres;
      const domein = domeinVan(a);
      let beste = null;
      for (const r of sDomeinRegels.all()) {
        if (domein === r.waarde || domein.endsWith('.' + r.waarde)) {
          if (!beste || r.waarde.length > beste.waarde.length) beste = r;
        }
      }
      return beste;
    },
  };
}
