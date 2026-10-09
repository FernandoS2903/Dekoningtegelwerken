// Microsoft Graph, app-only (client credentials).
//
// De app heeft in Entra géén Mail-permissions; de toegang loopt via Exchange
// RBAC for Applications en is daar beperkt tot één mailbox (scope op
// info@dekoningtegelwerken.nl, zie deploy/Setup-MailboxScope.ps1). De tenant
// wordt gedeeld met andere mailboxen, dus nooit Entra Mail-rechten toevoegen:
// die gelden tenant-breed. We spreken de mailbox altijd aan als
// /users/{mailbox}/... en nooit tenant-breed.
//
// Met RBAC staat er geen roles-claim in het token. Of de toegang werkt, test
// je dus echt op de mailbox (zie test()), niet aan het token.
//
// Wat deze module doet: token halen en cachen, mappen onder Inbox vinden en
// aanmaken, mails en PDF-bijlagen ophalen, de Inbox volgen met een delta
// query, mails verplaatsen, doorsturen en een categorie geven, en de
// webhook-subscription beheren. 429 en 503 met Retry-After vangt http.mjs op.
//
// De rest van de dienst praat via de vaste mailinterface (lib/mail/), niet
// rechtstreeks met deze module; zie lib/mail/m365.mjs.

import { HttpFout, jsonOfFout, vraag } from './http.mjs';

export const GRAPH = 'https://graph.microsoft.com/v1.0';
export const SCOPE = 'https://graph.microsoft.com/.default';
export const USER_AGENT = 'dekoning-facturen/1.0';

// Velden die de sorteerder van een nieuwe mail nodig heeft. De inhoud zelf
// (tekst, bijlagenamen) wordt pas opgehaald als er echt geclassificeerd moet
// worden.
export const DELTA_SELECT = [
  'id', 'internetMessageId', 'subject', 'from', 'receivedDateTime',
  'hasAttachments', 'isDraft', 'flag', 'categories',
].join(',');

// Een delta-ronde loopt nooit eindeloos door: na zoveel pagina's stopt hij
// met een fout, zodat een kapotte nextLink de dienst niet vasthoudt.
export const MAX_DELTA_PAGINAS = 200;

// Mail-subscriptions mogen hooguit iets minder dan 7 dagen lopen; we nemen
// er 3 en verlengen ruim op tijd (zie lib/webhook.mjs).
export const SUBSCRIPTION_MINUTEN = 3 * 24 * 60;

// Enkele quotes in een OData-filter worden verdubbeld.
const odataTekst = (waarde) => String(waarde).replaceAll("'", "''");

export function maakGraph({
  tenantId,
  clientId,
  clientSecret,
  mailbox,
  map = 'Facturen',
  fetch: fetchFn = globalThis.fetch,
  nu = () => Date.now(),
} = {}) {
  const beschikbaar = Boolean(tenantId && clientId && clientSecret && mailbox);
  const basis = () => `${GRAPH}/users/${encodeURIComponent(mailbox)}`;

  let token = null;
  let tokenTot = 0;
  let mapId = null;
  let mapNaam = null;

  async function haalToken() {
    if (!beschikbaar) throw new Error('Microsoft 365 is niet ingesteld');
    if (token && nu() < tokenTot) return token;

    const url = `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
    const lichaam = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: SCOPE,
      grant_type: 'client_credentials',
    });

    const antwoord = await vraag(fetchFn, url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: lichaam.toString(),
    }, { timeoutMs: 20000 });

    let data;
    try {
      data = await jsonOfFout(antwoord, 'login.microsoftonline.com');
    } catch (fout) {
      // Het antwoord van de tokendienst kan het client secret echoën in een
      // foutmelding; daarom alleen de status doorgeven.
      throw new Error('token ophalen mislukt (' + (fout.status || '?') + ')');
    }
    if (!data.access_token) throw new Error('tokendienst gaf geen access_token');

    token = data.access_token;
    // Twee minuten marge, zodat een lopend verzoek niet alsnog verloopt.
    tokenTot = nu() + Math.max(60, Number(data.expires_in || 3600) - 120) * 1000;
    return token;
  }

  async function graph(pad, { methode = 'GET', body = null, headers = {}, volledig = false } = {}) {
    const bearer = await haalToken();
    const url = volledig ? pad : basis() + pad;
    const opties = {
      method: methode,
      headers: {
        authorization: 'Bearer ' + bearer,
        accept: 'application/json',
        'user-agent': USER_AGENT,
        ...headers,
      },
    };
    if (body !== null) {
      opties.headers['content-type'] = 'application/json';
      opties.body = JSON.stringify(body);
    }

    const antwoord = await vraag(fetchFn, url, opties, { timeoutMs: 60000 });
    if (!antwoord || !antwoord.ok) {
      const tekst = antwoord ? await antwoord.text().catch(() => '') : 'geen antwoord';
      throw new HttpFout(antwoord ? antwoord.status : 0, tekst, url);
    }
    if (antwoord.status === 202 || antwoord.status === 204) return null;
    return antwoord.json();
  }

  // Begint bij de well-known map `inbox`, zodat het ook werkt als die
  // "Postvak IN" heet, en loopt dan het pad af (bv. "Facturen/2026").
  async function zoekMap() {
    if (mapId) return { id: mapId, naam: mapNaam };

    const inbox = await graph('/mailFolders/inbox?$select=id,displayName');
    let huidigId = inbox.id;
    let huidigNaam = inbox.displayName;

    for (const deel of String(map).split('/').map((s) => s.trim()).filter(Boolean)) {
      const filter = encodeURIComponent(`displayName eq '${odataTekst(deel)}'`);
      const uit = await graph(`/mailFolders/${encodeURIComponent(huidigId)}/childFolders?$select=id,displayName&$filter=${filter}`);
      const gevonden = (uit.value || [])[0];
      if (!gevonden) throw new Error(`map "${deel}" niet gevonden onder "${huidigNaam}"`);
      huidigId = gevonden.id;
      huidigNaam = gevonden.displayName;
    }

    mapId = huidigId;
    mapNaam = huidigNaam;
    return { id: mapId, naam: mapNaam };
  }

  return {
    beschikbaar,
    mailbox,
    mapPad: map,

    async mapInfo() { return zoekMap(); },

    // Mails uit de map, nieuwste eerst, vanaf `vanaf` (ISO). `bekend` zijn de
    // message_id's die we al hebben; die slaan we over.
    async mails({ vanaf, bekend = new Set(), maxMails = 200 }) {
      const { id } = await zoekMap();
      const select = 'id,subject,from,receivedDateTime,hasAttachments,categories';
      const filter = encodeURIComponent(`receivedDateTime ge ${vanaf}`);
      let pad = `/mailFolders/${encodeURIComponent(id)}/messages`
        + `?$select=${select}&$filter=${filter}&$orderby=receivedDateTime desc&$top=50`;
      let volledig = false;

      const uit = [];
      while (pad && uit.length < maxMails) {
        const data = await graph(pad, { volledig });
        for (const mail of data.value || []) {
          if (bekend.has(mail.id)) continue;
          uit.push(mail);
        }
        pad = data['@odata.nextLink'] || null;
        volledig = true;
      }
      return uit;
    },

    // Alleen echte PDF-bijlagen: geen inline plaatjes, geen item-attachments.
    async pdfBijlagen(messageId) {
      const data = await graph(`/messages/${encodeURIComponent(messageId)}/attachments`);
      return (data.value || []).filter((b) => (
        b['@odata.type'] === '#microsoft.graph.fileAttachment'
        && !b.isInline
        && (String(b.contentType || '').toLowerCase().includes('pdf') || /\.pdf$/i.test(b.name || ''))
        && b.contentBytes
      ));
    },

    async mailTekst(messageId) {
      const data = await graph(`/messages/${encodeURIComponent(messageId)}?$select=body`, {
        headers: { prefer: 'outlook.body-content-type="text"' },
      });
      return (data.body && data.body.content) ? String(data.body.content) : '';
    },

    // Stuurt de originele mail door, dus mét de PDF erin.
    async stuurDoor(messageId, { commentaar, naar }) {
      await graph(`/messages/${encodeURIComponent(messageId)}/forward`, {
        methode: 'POST',
        body: {
          comment: commentaar,
          toRecipients: naar.map((adres) => ({ emailAddress: { address: adres } })),
        },
      });
    },

    // Voegt een categorie toe zonder de bestaande weg te gooien.
    async voegCategorieToe(messageId, categorie) {
      const data = await graph(`/messages/${encodeURIComponent(messageId)}?$select=categories`);
      const huidig = Array.isArray(data.categories) ? data.categories : [];
      if (huidig.includes(categorie)) return false;
      await graph(`/messages/${encodeURIComponent(messageId)}`, {
        methode: 'PATCH',
        body: { categories: [...huidig, categorie] },
      });
      return true;
    },

    // -- sorteren ----------------------------------------------------------
    // Eén delta-ronde op de Inbox. Met een deltaLink krijg je wat er sinds de
    // vorige ronde veranderde. Zonder deltaLink begint hij bij `vanaf`: het
    // filter op receivedDateTime zorgt dat er niets historisch meekomt en dat
    // de eerste ronde alleen een deltaLink oplevert.
    // Een verlopen deltaLink geeft 410; dat handelt de sorteerder af.
    async inboxDelta({ deltaLink = null, vanaf = null } = {}) {
      let url = deltaLink;
      if (!url) {
        const filter = encodeURIComponent(`receivedDateTime ge ${vanaf || new Date(nu()).toISOString()}`);
        url = `${basis()}/mailFolders/inbox/messages/delta?$select=${DELTA_SELECT}&$filter=${filter}`;
      }

      const berichten = [];
      for (let pagina = 0; pagina < MAX_DELTA_PAGINAS; pagina++) {
        const data = await graph(url, { volledig: true, headers: { prefer: 'odata.maxpagesize=50' } });
        berichten.push(...(data.value || []));
        if (data['@odata.deltaLink']) return { berichten, deltaLink: data['@odata.deltaLink'] };
        url = data['@odata.nextLink'];
        if (!url) throw new Error('delta query gaf geen nextLink en geen deltaLink');
      }
      throw new Error(`delta query liep langer dan ${MAX_DELTA_PAGINAS} pagina's`);
    },

    // Alleen de namen, voor de classificatie; de bijlagen zelf gaan nooit mee.
    async bijlageNamen(messageId) {
      const data = await graph(`/messages/${encodeURIComponent(messageId)}/attachments?$select=name,isInline`);
      return (data.value || []).filter((b) => !b.isInline && b.name).map((b) => String(b.name));
    },

    // Verplaatst een mail. Graph geeft de mail in de nieuwe map terug, met
    // een nieuw id; dat id is vanaf nu het enige dat werkt. De leesstatus
    // verandert niet.
    async verplaats(messageId, mapId) {
      const data = await graph(`/messages/${encodeURIComponent(messageId)}/move`, {
        methode: 'POST',
        body: { destinationId: mapId },
      });
      if (!data || !data.id) throw new Error('verplaatsen gaf geen nieuw id terug');
      return data.id;
    },

    // De directe submappen van de Inbox.
    async inboxMappen() {
      const data = await graph('/mailFolders/inbox/childFolders?$select=id,displayName&$top=100');
      return (data.value || []).map((m) => ({ id: m.id, naam: m.displayName }));
    },

    // Zoekt een submap van de Inbox op naam en maakt hem aan als hij er niet
    // is. Bestaat hij intussen toch (409), dan zoeken we opnieuw.
    async inboxMap(naam, { aanmaken = true } = {}) {
      const zoek = async () => {
        const filter = encodeURIComponent(`displayName eq '${odataTekst(naam)}'`);
        const uit = await graph(`/mailFolders/inbox/childFolders?$select=id,displayName&$filter=${filter}`);
        const gevonden = (uit.value || [])[0];
        return gevonden ? { id: gevonden.id, naam: gevonden.displayName, nieuw: false } : null;
      };

      const bestaand = await zoek();
      if (bestaand || !aanmaken) return bestaand;
      try {
        const gemaakt = await graph('/mailFolders/inbox/childFolders', {
          methode: 'POST',
          body: { displayName: naam, isHidden: false },
        });
        return { id: gemaakt.id, naam: gemaakt.displayName, nieuw: true };
      } catch (fout) {
        if (fout instanceof HttpFout && fout.status === 409) {
          const alsnog = await zoek();
          if (alsnog) return alsnog;
        }
        throw fout;
      }
    },

    // -- webhook-subscription --------------------------------------------
    // Alleen `created` op de Inbox. De notificatie zelf vertrouwen we niet;
    // hij is alleen een seintje om de delta-ronde te draaien.
    async maakSubscription({ notificatieUrl, clientState, verlooptOp }) {
      const data = await graph(`${GRAPH}/subscriptions`, {
        volledig: true,
        methode: 'POST',
        body: {
          changeType: 'created',
          notificationUrl: notificatieUrl,
          resource: `users/${mailbox}/mailFolders('inbox')/messages`,
          expirationDateTime: verlooptOp,
          clientState,
          latestSupportedTlsVersion: 'v1_2',
        },
      });
      return { id: data.id, verlooptOp: data.expirationDateTime };
    },

    async verlengSubscription(id, verlooptOp) {
      const data = await graph(`${GRAPH}/subscriptions/${encodeURIComponent(id)}`, {
        volledig: true,
        methode: 'PATCH',
        body: { expirationDateTime: verlooptOp },
      });
      return { id: data.id, verlooptOp: data.expirationDateTime };
    },

    async verwijderSubscription(id) {
      await graph(`${GRAPH}/subscriptions/${encodeURIComponent(id)}`, { volledig: true, methode: 'DELETE' });
    },

    async test() {
      if (!beschikbaar) return { ok: false, melding: 'Microsoft 365 is niet ingesteld in de env.' };
      try {
        const { naam } = await zoekMap();
        return { ok: true, melding: `map "${naam}" gevonden in ${mailbox}` };
      } catch (fout) {
        return { ok: false, melding: fout.message };
      }
    },

    // Alleen voor de tests: de mapcache leegmaken.
    _vergeetMap() { mapId = null; mapNaam = null; },
  };
}
