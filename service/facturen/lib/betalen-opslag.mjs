// Opslag voor betalen via bunq (schema versie 7, zie db.mjs): de
// conceptbetalingen (bunq_drafts), hun regels per factuur
// (bunq_draft_regels) en de bekende IBAN's per leverancier
// (leverancier_ibans).
//
// Net als de rest van de opslag: kleine functies met elk één query, zodat de
// logica in lib/betalen.mjs geen SQL hoeft te kennen.

import { nuIso } from './hulp.mjs';

// Statussen waarmee een draft klaar is zonder dat er geld weg is: de regels
// worden dan inactief en de factuur kan opnieuw worden klaargezet.
export const DRAFT_AFGEWEZEN = ['REJECTED', 'CANCELLED', 'mislukt'];
// Statussen die we niet meer bij bunq hoeven op te vragen.
export const DRAFT_KLAAR = ['ACCEPTED', ...DRAFT_AFGEWEZEN];

export class DubbeleDraft extends Error {
  constructor() {
    super('Voor een of meer van deze facturen loopt al een conceptbetaling.');
    this.name = 'DubbeleDraft';
  }
}

const w = (v) => (v === undefined || v === '' ? null : v);

export function maakBetaalOpslag(db) {
  const q = (sql) => db.prepare(sql);

  const sDraftNieuw = q(`
    INSERT INTO bunq_drafts (sleutel, rekening_id, rekening_iban, status, totaal, aantal, door, aangemaakt_op, bijgewerkt_op)
    VALUES (?, ?, ?, 'bezig', ?, ?, ?, ?, ?)`);
  const sRegelNieuw = q(`
    INSERT INTO bunq_draft_regels (draft_id, factuur_id, leverancier, bedrag, iban, naam, omschrijving)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const sDraft = q('SELECT * FROM bunq_drafts WHERE id = ?');
  const sDraftSleutel = q('SELECT * FROM bunq_drafts WHERE sleutel = ?');
  const sDraftZet = q(`
    UPDATE bunq_drafts SET status = ?, bunq_id = coalesce(?, bunq_id), fout = ?,
      bunq_bijgewerkt = coalesce(?, bunq_bijgewerkt), bijgewerkt_op = ?
    WHERE id = ?`);
  const sRegelsUit = q('UPDATE bunq_draft_regels SET actief = 0 WHERE draft_id = ?');
  const sRegels = q('SELECT * FROM bunq_draft_regels WHERE draft_id = ? ORDER BY id');
  const sRegelBetaling = q('UPDATE bunq_draft_regels SET betaling_id = ? WHERE id = ?');
  const sActief = q(`
    SELECT r.*, d.status, d.bunq_id, d.door, d.aangemaakt_op, d.bijgewerkt_op, d.fout, d.rekening_iban, d.sleutel
    FROM bunq_draft_regels r JOIN bunq_drafts d ON d.id = r.draft_id
    WHERE r.factuur_id = ? AND r.actief = 1 ORDER BY r.id DESC LIMIT 1`);
  const sLaatste = q(`
    SELECT r.*, d.status, d.bunq_id, d.door, d.aangemaakt_op, d.bijgewerkt_op, d.fout, d.rekening_iban, d.sleutel
    FROM bunq_draft_regels r JOIN bunq_drafts d ON d.id = r.draft_id
    WHERE r.factuur_id = ? ORDER BY r.id DESC LIMIT 1`);
  const sLopend = q(`
    SELECT * FROM bunq_drafts
    WHERE status NOT IN (${DRAFT_KLAAR.map(() => '?').join(', ')})
    ORDER BY id`);
  const sBetalingAlGekoppeld = q('SELECT 1 FROM bunq_draft_regels WHERE betaling_id = ? LIMIT 1');
  const sBekendeBunqIds = q('SELECT bunq_id FROM bunq_drafts WHERE bunq_id IS NOT NULL');
  const sGoedgekeurd = q(`
    SELECT r.*, d.bunq_id FROM bunq_draft_regels r JOIN bunq_drafts d ON d.id = r.draft_id
    WHERE r.actief = 1 AND d.status = 'ACCEPTED' AND r.betaling_id IS NOT NULL ORDER BY r.id`);

  const sIbansVan = q('SELECT * FROM leverancier_ibans WHERE leverancier = ? ORDER BY id');
  const sIbanBij = q('SELECT * FROM leverancier_ibans WHERE iban = ? ORDER BY id');
  const sIbanNieuw = q(`
    INSERT INTO leverancier_ibans (leverancier, naam, iban, iban_naam, status, bevestigd_door, bevestigd_op)
    VALUES (?, ?, ?, ?, 'voorlopig', ?, ?)
    ON CONFLICT (leverancier, iban) DO NOTHING`);
  const sIbanVertrouw = q(`
    UPDATE leverancier_ibans SET status = 'vertrouwd', vertrouwd_op = coalesce(vertrouwd_op, ?)
    WHERE leverancier = ? AND iban = ?`);

  return {
    // Legt een draft met zijn regels vast vóór het verzoek naar bunq. Lukt
    // dat niet omdat een factuur al een actieve regel heeft, dan DubbeleDraft:
    // de unieke index op (factuur_id) WHERE actief = 1 houdt ook twee
    // gelijktijdige verzoeken uit elkaar.
    reserveer({ sleutel, rekeningId, rekeningIban, regels, door, nu = nuIso() }) {
      const totaal = Math.round(regels.reduce((som, r) => som + Number(r.bedrag), 0) * 100) / 100;
      db.exec('BEGIN IMMEDIATE');
      try {
        const r = sDraftNieuw.run(sleutel, String(rekeningId), w(rekeningIban), totaal, regels.length, door, nu, nu);
        const draftId = Number(r.lastInsertRowid);
        for (const regel of regels) {
          sRegelNieuw.run(draftId, Number(regel.factuurId), regel.leverancier, Number(regel.bedrag), regel.iban, regel.naam, regel.omschrijving);
        }
        db.exec('COMMIT');
        return draftId;
      } catch (fout) {
        db.exec('ROLLBACK');
        if (/UNIQUE/i.test(String(fout.message)) && /bunq_draft_regels/i.test(String(fout.message))) throw new DubbeleDraft();
        throw fout;
      }
    },

    draft(id) { return sDraft.get(Number(id)) ?? null; },
    draftMetSleutel(sleutel) { return sleutel ? (sDraftSleutel.get(String(sleutel)) ?? null) : null; },
    regels(draftId) { return sRegels.all(Number(draftId)); },

    // Nieuwe stand van een draft. Bij een afwijzing (of mislukt) gaan de
    // regels uit, zodat dezelfde facturen opnieuw klaargezet kunnen worden.
    zetDraft(id, { status, bunqId = null, fout = null, bunqBijgewerkt = null, nu = nuIso() }) {
      sDraftZet.run(String(status), w(bunqId === null ? null : String(bunqId)), w(fout), w(bunqBijgewerkt), nu, Number(id));
      if (DRAFT_AFGEWEZEN.includes(status)) sRegelsUit.run(Number(id));
    },

    zetBetalingId(regelId, betalingId) { sRegelBetaling.run(String(betalingId), Number(regelId)); },
    betalingAlGekoppeld(betalingId) { return Boolean(sBetalingAlGekoppeld.get(String(betalingId))); },
    bekendeBunqIds() { return new Set(sBekendeBunqIds.all().map((r) => String(r.bunq_id))); },
    // Goedgekeurde regels waarvan bunq de betaal-id gaf: klaar om te koppelen.
    goedgekeurdeRegels() { return sGoedgekeurd.all(); },

    // De lopende regel van een factuur (draft die loopt of is goedgekeurd).
    actieveRegel(factuurId) { return sActief.get(Number(factuurId)) ?? null; },
    // De laatste poging, ook als die is afgewezen of mislukt.
    laatsteRegel(factuurId) { return sLaatste.get(Number(factuurId)) ?? null; },
    // Drafts waarvan de stand bij bunq nog kan veranderen.
    lopendeDrafts() { return sLopend.all(...DRAFT_KLAAR); },

    // -- bekende IBAN's ----------------------------------------------------
    ibansVan(leverancier) { return sIbansVan.all(String(leverancier)); },
    ibanBij(iban) { return sIbanBij.all(String(iban)); },
    bevestigIban({ leverancier, naam, iban, ibanNaam, door, nu = nuIso() }) {
      sIbanNieuw.run(leverancier, w(naam), iban, w(ibanNaam), door, nu);
    },
    vertrouwIban(leverancier, iban, nu = nuIso()) { sIbanVertrouw.run(nu, leverancier, iban); },
  };
}
