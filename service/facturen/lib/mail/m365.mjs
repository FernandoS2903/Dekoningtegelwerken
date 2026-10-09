// Microsoft 365-adapter voor de mailinterface (zie koppeling.mjs).
//
// Een dun laagje over lib/graph.mjs: Graph-antwoorden worden hier omgezet in
// het gewone Bericht, zodat de sorteerder niets van Graph hoeft te weten.

import { maakGraph } from '../graph.mjs';
import { HttpFout } from '../http.mjs';

export const MAX_TEKST = 1500;

// Graph-mail -> Bericht.
export function naarBericht(m) {
  const van = m.from?.emailAddress || {};
  return {
    id: m.id,
    internetId: m.internetMessageId || null,
    ontvangen: m.receivedDateTime || null,
    afzender: { naam: String(van.name || ''), adres: String(van.address || '').trim().toLowerCase() },
    onderwerp: String(m.subject || ''),
    heeftBijlagen: Boolean(m.hasAttachments),
    // eventMessage, eventMessageRequest, eventMessageResponse: agenda.
    soort: /eventMessage/i.test(String(m['@odata.type'] || '')) ? 'agenda' : 'mail',
    gemarkeerd: m.flag?.flagStatus === 'flagged',
    concept: Boolean(m.isDraft),
    categorieen: Array.isArray(m.categories) ? m.categories.map(String) : [],
    verwijderd: Boolean(m['@removed']),
  };
}

export function maakM365Koppeling({ graph = null, ...opties } = {}) {
  const g = graph || maakGraph(opties);

  return {
    provider: 'm365',
    beschikbaar: g.beschikbaar,
    adres: String(g.mailbox || '').toLowerCase(),
    mapPad: g.mapPad,

    // -- kern ---------------------------------------------------------------
    async nieuweBerichten({ deltaLink = null, vanaf = null } = {}) {
      try {
        const uit = await g.inboxDelta({ deltaLink, vanaf });
        return { berichten: uit.berichten.map(naarBericht), deltaLink: uit.deltaLink };
      } catch (fout) {
        // 410 Gone: de deltaLink is verlopen of de synchronisatie is kwijt.
        if (fout instanceof HttpFout && fout.status === 410) {
          const verlopen = new Error('deltaLink verlopen (410)');
          verlopen.verlopen = true;
          throw verlopen;
        }
        throw fout;
      }
    },
    verplaats: (id, mapId) => g.verplaats(id, mapId),
    categorie: (id, naam) => g.voegCategorieToe(id, naam),
    doorsturen: (id, { naar, commentaar }) => g.stuurDoor(id, { naar, commentaar }),
    mapAanmaken: (naam) => g.inboxMap(naam, { aanmaken: true }),

    // -- ondersteunend ------------------------------------------------------
    mapZoeken: (naam) => g.inboxMap(naam, { aanmaken: false }),

    async inhoud(id, { maxTekens = MAX_TEKST, metBijlagen = true } = {}) {
      const tekst = (await g.mailTekst(id)).replace(/\s+/g, ' ').trim().slice(0, maxTekens);
      const bijlagen = metBijlagen ? await g.bijlageNamen(id) : [];
      return { tekst, bijlagen };
    },

    test: () => g.test(),

    // -- factuurdashboard ---------------------------------------------------
    mapInfo: () => g.mapInfo(),
    mails: (opties2) => g.mails(opties2),
    pdfBijlagen: (id) => g.pdfBijlagen(id),
    mailTekst: (id) => g.mailTekst(id),
    stuurDoor: (id, opties2) => g.stuurDoor(id, opties2),
    voegCategorieToe: (id, naam) => g.voegCategorieToe(id, naam),

    // -- webhook ------------------------------------------------------------
    webhook: {
      maak: (opties2) => g.maakSubscription(opties2),
      verleng: (id, verlooptOp) => g.verlengSubscription(id, verlooptOp),
      verwijder: (id) => g.verwijderSubscription(id),
    },
  };
}
