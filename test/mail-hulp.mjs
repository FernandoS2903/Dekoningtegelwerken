// Gedeelde hulp voor de tests van de mailsorteerder: een nagebootste
// mailbox (achter de mailinterface) en een nagebootste classificeerder.
// Geen testbestand zelf.

import { maakSorteerOpslag } from '../service/facturen/lib/sorteer-opslag.mjs';
import { tijdelijkeOpslag } from './facturen-hulp.mjs';

export const EIGEN = 'info@dekoningtegelwerken.nl';

let teller = 0;

// Een Bericht zoals de mailinterface het geeft.
export function bericht({
  id = 'm' + (++teller),
  adres = 'jan@klant.nl',
  naam = 'Jan Klant',
  onderwerp = 'Vraag',
  ontvangen = '2026-10-09T13:00:00Z',
  ...rest
} = {}) {
  return {
    id,
    internetId: `<${id}@test>`,
    ontvangen,
    afzender: { naam, adres },
    onderwerp,
    heeftBijlagen: false,
    soort: 'mail',
    gemarkeerd: false,
    concept: false,
    categorieen: [],
    verwijderd: false,
    ...rest,
  };
}

// `rondes`: per delta-ronde de berichten die "binnenkomen". De eerste aanroep
// zonder deltaLink is het startpunt en geeft `startpuntBerichten` terug.
export function nepMailbox({ rondes = [], startpuntBerichten = [], inhoud = {}, bestaandeMappen = ['Facturen'] } = {}) {
  const lijst = [...rondes];
  let n = 0;
  const mb = {
    provider: 'nep',
    beschikbaar: true,
    adres: EIGEN,
    verplaatst: [],
    categorieen: [],
    aangemaakt: [],
    aanroepen: [],
    mappen: new Set(bestaandeMappen),
    faalVerplaatsen: false,
    verlopen: false,

    async nieuweBerichten({ deltaLink, vanaf }) {
      mb.aanroepen.push({ deltaLink, vanaf });
      if (!deltaLink) return { berichten: startpuntBerichten, deltaLink: 'delta-0' };
      if (mb.verlopen) {
        mb.verlopen = false;
        const fout = new Error('deltaLink verlopen (410)');
        fout.verlopen = true;
        throw fout;
      }
      n++;
      return { berichten: lijst.shift() || [], deltaLink: 'delta-' + n };
    },
    async verplaats(id, mapId) {
      if (mb.faalVerplaatsen) throw new Error('Graph is stuk');
      const nieuw = `${id}@${mapId}`;
      mb.verplaatst.push({ id, mapId, nieuw });
      return nieuw;
    },
    async categorie(id, naam) { mb.categorieen.push({ id, naam }); return true; },
    async doorsturen() { throw new Error('de sorteerder stuurt nooit door'); },
    async mapAanmaken(naam) {
      const nieuw = !mb.mappen.has(naam);
      if (nieuw) { mb.mappen.add(naam); mb.aangemaakt.push(naam); }
      return { id: 'map:' + naam, naam, nieuw };
    },
    async mapZoeken(naam) { return mb.mappen.has(naam) ? { id: 'map:' + naam, naam } : null; },
    async mapInfo() { return { id: 'map:Facturen', naam: 'Facturen' }; },
    async inhoud(id) { return inhoud[id] || { tekst: 'Goedendag, ...', bijlagen: [] }; },
    async test() { return { ok: true, melding: 'nep' }; },
  };
  return mb;
}

// Geeft per aanroep het antwoord van `antwoord` (object of functie).
export function nepClassificeerder(antwoord = { map: 'Klanten & projecten', zekerheid: 0.9, reden: 'klant' }) {
  const c = {
    beschikbaar: true,
    model: 'claude-haiku-4-5',
    aanroepen: [],
    async classificeer(invoer) {
      c.aanroepen.push(invoer);
      const uit = typeof antwoord === 'function' ? antwoord(invoer) : antwoord;
      if (uit instanceof Error) throw uit;
      return uit;
    },
  };
  return c;
}

export function sorteerOpslagen() {
  const t = tijdelijkeOpslag();
  return { ...t, sorteerOpslag: maakSorteerOpslag(t.opslag.db) };
}
