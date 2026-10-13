// Opslag van de website-aanvragen (tabel aanvragen, schema versie 4).
//
// Een aanvraag wordt eerst opgeslagen en pas daarna verwerkt; de twee
// uitgangen (mail naar de mailbox, doorsturen naar Offerteknop) hebben elk
// een eigen stand:
//   mail_status       wacht | verzonden | gestopt
//   koppeling_status  wacht | klaar | gestopt
// `status` is de samenvatting voor het dashboard: nieuw (nog iets te doen),
// klaar (beide uitgangen af) of gestopt (een uitgang definitief mislukt).
// pogingen/volgende_poging sturen de herkansingen (lib/aanvraag-doorsturen.mjs).
//
// `velden` is de JSON van de gecontroleerde antwoorden, `bestanden` de lijst
// {soort, naam, type, bestand, grootte}; de bestanden zelf staan in
// `bestandsmap` op de schijf (buiten de repo, in de statusmap).

import { nuIso } from './hulp.mjs';

const w = (v) => (v === undefined || v === '' ? null : v);

export function maakAanvraagOpslag(db) {
  const sNieuw = db.prepare(`INSERT INTO aanvragen (tijd, bron, velden, bestanden, status, referentie, bestandsmap)
    VALUES (?, ?, ?, ?, 'nieuw', ?, ?)`);
  const sEen = db.prepare('SELECT * FROM aanvragen WHERE id = ?');
  const sBijReferentie = db.prepare('SELECT * FROM aanvragen WHERE referentie = ?');
  const sVandaag = db.prepare('SELECT count(*) n FROM aanvragen WHERE tijd >= ?');
  const sTeDoen = db.prepare(`SELECT * FROM aanvragen
    WHERE (mail_status = 'wacht' OR koppeling_status = 'wacht')
      AND (volgende_poging IS NULL OR volgende_poging <= ?)
    ORDER BY id ASC LIMIT ?`);
  const sMail = db.prepare('UPDATE aanvragen SET mail_status = ?, mail_fout = ?, mail_op = ? WHERE id = ?');
  const sKoppeling = db.prepare('UPDATE aanvragen SET koppeling_status = ?, koppeling_fout = ?, koppeling_op = ?, offerte_id = ?, offerte_nummer = ? WHERE id = ?');
  const sPoging = db.prepare('UPDATE aanvragen SET pogingen = ?, volgende_poging = ?, laatste_poging = ? WHERE id = ?');
  const sStatus = db.prepare('UPDATE aanvragen SET status = ? WHERE id = ?');
  const sStand = db.prepare(`SELECT
      SUM(CASE WHEN koppeling_status = 'wacht' THEN 1 ELSE 0 END) wacht,
      SUM(CASE WHEN koppeling_status = 'gestopt' OR mail_status = 'gestopt' THEN 1 ELSE 0 END) gestopt,
      SUM(CASE WHEN mail_status = 'wacht' THEN 1 ELSE 0 END) mail_wacht
    FROM aanvragen`);

  const lees = (rij) => (rij ? { ...rij, velden: JSON.parse(rij.velden || '{}'), bestanden: JSON.parse(rij.bestanden || '[]') } : null);

  // De samenvattende status na een wijziging van een uitgang.
  function werkStatusBij(id) {
    const r = sEen.get(Number(id));
    if (!r) return;
    const status = r.mail_status === 'gestopt' || r.koppeling_status === 'gestopt' ? 'gestopt'
      : r.mail_status === 'wacht' || r.koppeling_status === 'wacht' ? 'nieuw' : 'klaar';
    if (status !== r.status) sStatus.run(status, Number(id));
  }

  return {
    // `tijd`: van dezelfde klok als de daglimiet (aanvraag.mjs), anders nu.
    nieuw({ bron = 'website', referentie, velden, bestanden = [], bestandsmap = null, tijd = nuIso() }) {
      const info = sNieuw.run(tijd, bron, JSON.stringify(velden || {}), JSON.stringify(bestanden), String(referentie), w(bestandsmap));
      return Number(info.lastInsertRowid);
    },
    aanvraag: (id) => lees(sEen.get(Number(id))),
    bijReferentie: (ref) => lees(sBijReferentie.get(String(ref))),
    aantalSinds: (vanafIso) => sVandaag.get(String(vanafIso)).n,
    teDoen: (nu = nuIso(), max = 20) => sTeDoen.all(nu, max).map(lees),

    zetMail(id, status, { fout = null } = {}) {
      sMail.run(status, w(fout ? String(fout).slice(0, 300) : null), status === 'verzonden' ? nuIso() : null, Number(id));
      werkStatusBij(id);
    },
    zetKoppeling(id, status, { fout = null, offerteId = null, nummer = null } = {}) {
      sKoppeling.run(status, w(fout ? String(fout).slice(0, 300) : null), status === 'klaar' ? nuIso() : null,
        offerteId === null ? null : Number(offerteId), w(nummer), Number(id));
      werkStatusBij(id);
    },
    zetPoging(id, { pogingen, volgendePoging = null }) {
      sPoging.run(Number(pogingen), w(volgendePoging), nuIso(), Number(id));
    },

    // Voor het dashboard: hoeveel aanvragen wachten op doorsturen, hoeveel
    // zijn definitief blijven steken.
    stand() {
      const r = sStand.get();
      return { wacht: Number(r.wacht) || 0, gestopt: Number(r.gestopt) || 0, mailWacht: Number(r.mail_wacht) || 0 };
    },
  };
}
