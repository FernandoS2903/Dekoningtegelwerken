// bunq: lezen, en conceptbetalingen klaarzetten.
//
// Let op: een bunq API-key geeft zelf volledige toegang tot de rekening. Wat
// deze dienst ermee doet, is een eigenschap van deze code en niet van de
// sleutel. Daarom staat de sleutel in /etc/dekoning/facturen.env (600) en
// doet dit bestand precies dit:
//  - GET op monetary-account, payment en draft-payment;
//  - POST op draft-payment: een conceptbetaling (DraftPayment) die de
//    eigenaar in de bunq-app moet goedkeuren, met number_of_required_accepts 1.
// Nooit een POST op payment (direct betalen) en nooit een PUT op een draft:
// intrekken gebeurt in de app. test/facturen-betalen.test.mjs bewaakt dat.
//
// Een draft wordt nooit automatisch opnieuw verstuurd: bij een time-out of
// 5xx weten we niet of hij bij bunq is aangekomen (DraftFout met zeker =
// false). lib/betalen.mjs zoekt hem dan op in de lijst in plaats van een
// tweede te maken.
//
// Eenmalige opbouw: RSA-2048 sleutelpaar -> /installation -> /device-server
// (registreert het publieke IP van deze server) -> /session-server.
// Verzoeken met een body worden ondertekend met X-Bunq-Client-Signature:
// base64(RSA-SHA256 PKCS#1 v1.5 over de body).
//
// De toestand (sleutelpaar, tokens, user-id) staat in DATA_DIR/bunq_state.json
// met rechten 600.

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { HttpFout, vraag } from './http.mjs';
import { naarDatum, naarIban, schoonTenaamstelling } from './hulp.mjs';

export const PRODUCTIE_URL = 'https://api.bunq.com/v1';
export const SANDBOX_URL = 'https://public-api.sandbox.bunq.com/v1';
export const USER_AGENT = 'dekoning-facturen/1.0';
export const BETALINGEN_PER_PAGINA = 200;

export const basisUrl = (omgeving) => (omgeving === 'sandbox' ? SANDBOX_URL : PRODUCTIE_URL);

// base64(RSA-SHA256 PKCS#1 v1.5) over de body. Los exporteerbaar, zodat de
// test de handtekening met de publieke sleutel kan verifiëren.
export function ondertekenLichaam(privateKeyPem, lichaam) {
  return crypto.sign('sha256', Buffer.from(lichaam, 'utf8'), {
    key: privateKeyPem,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }).toString('base64');
}

export function verifieerLichaam(publicKeyPem, lichaam, handtekening) {
  return crypto.verify('sha256', Buffer.from(lichaam, 'utf8'), {
    key: publicKeyPem,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  }, Buffer.from(handtekening, 'base64'));
}

export function maakSleutelpaar() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

const vingerafdruk = (apiKey) => crypto.createHash('sha256').update(String(apiKey)).digest('hex');

// bunq antwoordt met {Response: [{Sleutel: {...}}, ...]}; dit haalt er één
// soort uit.
export function uitResponse(data, sleutel) {
  for (const item of (data && data.Response) || []) {
    if (item && Object.prototype.hasOwnProperty.call(item, sleutel)) return item[sleutel];
  }
  return null;
}

export function alleUitResponse(data, sleutels) {
  const uit = [];
  for (const item of (data && data.Response) || []) {
    if (!item) continue;
    for (const sleutel of sleutels) {
      if (Object.prototype.hasOwnProperty.call(item, sleutel)) uit.push(item[sleutel]);
    }
  }
  return uit;
}

// Een bunq-betaling omzetten naar onze kolommen.
export function naarBetaling(payment, rekening) {
  const tegen = payment.counterparty_alias || {};
  const label = tegen.label_monetary_account || {};
  return {
    id: String(payment.id),
    rekening_id: String(rekening.id),
    rekening_iban: rekening.iban || null,
    datum: naarDatum(String(payment.created || '').slice(0, 10)),
    bedrag: Number(payment.amount && payment.amount.value),
    valuta: (payment.amount && payment.amount.currency) || null,
    tegenrekening_iban: naarIban(tegen.iban || label.iban),
    tegenpartij_naam: tegen.display_name || label.display_name || label.label_user?.display_name || null,
    omschrijving: payment.description || null,
  };
}

export function maakBunq({
  apiKey,
  omgeving = 'production',
  statePad,
  ibanFilter = [],
  fetch: fetchFn = globalThis.fetch,
  log = () => {},
} = {}) {
  const beschikbaar = Boolean(apiKey && statePad);
  const basis = basisUrl(omgeving);
  const origin = new URL(basis).origin;
  let state = null;

  function leesState() {
    if (state) return state;
    if (statePad && existsSync(statePad)) {
      try {
        state = JSON.parse(readFileSync(statePad, 'utf8'));
      } catch (fout) {
        log('warn', 'bunq-state onleesbaar, wordt opnieuw opgebouwd: ' + fout.message);
        state = {};
      }
    } else {
      state = {};
    }
    return state;
  }

  function bewaarState() {
    // Eerst schrijven, dan omzetten: zo blijft er nooit een half bestand staan.
    const tijdelijk = statePad + '.nieuw';
    writeFileSync(tijdelijk, JSON.stringify(state, null, 2), { mode: 0o600 });
    renameSync(tijdelijk, statePad);
  }

  function headers({ sessie = null, lichaam = null }) {
    const h = {
      'cache-control': 'no-cache',
      'user-agent': USER_AGENT,
      'x-bunq-client-request-id': crypto.randomUUID(),
      'x-bunq-language': 'nl_NL',
      'x-bunq-region': 'nl_NL',
      'x-bunq-geolocation': '0 0 0 0 000',
    };
    if (sessie) h['x-bunq-client-authentication'] = sessie;
    if (lichaam !== null) {
      h['content-type'] = 'application/json';
      h['x-bunq-client-signature'] = ondertekenLichaam(leesState().privateKey, lichaam);
    }
    return h;
  }

  async function verzoek(pad, { methode = 'GET', body = null, sessie = null, volledig = false, pogingen = 3 } = {}) {
    const lichaam = body === null ? null : JSON.stringify(body);
    const url = volledig ? origin + pad : basis + pad;
    const antwoord = await vraag(fetchFn, url, {
      method: methode,
      headers: headers({ sessie, lichaam }),
      ...(lichaam === null ? {} : { body: lichaam }),
    }, { timeoutMs: 60000, pogingen });

    if (!antwoord || !antwoord.ok) {
      const tekst = antwoord ? await antwoord.text().catch(() => '') : 'geen antwoord';
      throw new HttpFout(antwoord ? antwoord.status : 0, bunqFoutTekst(tekst), url);
    }
    return antwoord.json();
  }

  // Installatie en apparaat: eenmalig per sleutel.
  async function zorgVoorInstallatie() {
    leesState();
    if (!state.privateKey) {
      const { privateKey, publicKey } = maakSleutelpaar();
      state.privateKey = privateKey;
      state.publicKey = publicKey;
      state.apiKeyAfdruk = vingerafdruk(apiKey);
      delete state.installationToken;
      delete state.apparaatOk;
      delete state.sessieToken;
      delete state.userId;
      bewaarState();
    }

    if (!state.installationToken) {
      const data = await verzoek('/installation', {
        methode: 'POST',
        body: { client_public_key: state.publicKey },
      });
      const token = uitResponse(data, 'Token');
      if (!token || !token.token) throw new Error('bunq gaf geen installatietoken');
      state.installationToken = token.token;
      const server = uitResponse(data, 'ServerPublicKey');
      if (server) state.serverPublicKey = server.server_public_key;
      delete state.apparaatOk;
      bewaarState();
      log('info', 'bunq-installatie aangemaakt.');
    }

    if (!state.apparaatOk) {
      try {
        await verzoek('/device-server', {
          methode: 'POST',
          sessie: state.installationToken,
          body: { description: 'hfd-web01 factuurdashboard', secret: apiKey },
        });
      } catch (fout) {
        // Een al geregistreerd apparaat is geen probleem; een IP-klacht wel,
        // want dan is het publieke adres van deze server veranderd.
        if (!/already|bestaat/i.test(String(fout.message))) throw fout;
      }
      state.apparaatOk = true;
      bewaarState();
      log('info', 'bunq-apparaat geregistreerd op het huidige publieke IP.');
    }
  }

  async function nieuweSessie() {
    await zorgVoorInstallatie();
    const data = await verzoek('/session-server', {
      methode: 'POST',
      sessie: state.installationToken,
      body: { secret: apiKey },
    });
    const token = uitResponse(data, 'Token');
    if (!token || !token.token) throw new Error('bunq gaf geen sessietoken');
    state.sessieToken = token.token;

    const gebruiker = uitResponse(data, 'UserCompany')
      || uitResponse(data, 'UserPerson')
      || uitResponse(data, 'UserApiKey');
    if (!gebruiker || !gebruiker.id) throw new Error('bunq gaf geen user-id');
    state.userId = String(gebruiker.id);
    bewaarState();
    return state.sessieToken;
  }

  // Hier wordt gecontroleerd of de API-key nog dezelfde is. Dat moet vóór het
  // hergebruiken van een sessie gebeuren: met een oude sessie in de state zou
  // een nieuwe sleutel anders nooit opgemerkt worden.
  async function zorgVoorSessie() {
    const s = leesState();
    if (s.apiKeyAfdruk && s.apiKeyAfdruk !== vingerafdruk(apiKey)) {
      log('warn', 'Andere bunq API-key gevonden; installatie en sessie worden opnieuw opgebouwd.');
      state = {};
      bewaarState();
    }
    if (state.sessieToken && state.userId) return state.sessieToken;
    return nieuweSessie();
  }

  // Leest met de sessie; bij 401 wordt de sessie één keer opnieuw opgebouwd.
  async function lees(pad, { volledig = false } = {}) {
    let sessie = await zorgVoorSessie();
    try {
      return await verzoek(pad, { sessie, volledig });
    } catch (fout) {
      if (!(fout instanceof HttpFout) || fout.status !== 401) throw fout;
      log('info', 'bunq-sessie verlopen; opnieuw inloggen.');
      delete state.sessieToken;
      bewaarState();
      sessie = await nieuweSessie();
      return verzoek(pad, { sessie, volledig });
    }
  }

  // Een conceptbetaling versturen: één poging (geen herhaling bij een
  // time-out of 5xx, zie bovenaan). Alleen bij 401 nog één keer met een
  // nieuwe sessie; bunq heeft het verzoek dan aantoonbaar niet uitgevoerd.
  async function schrijfDraft(pad, body) {
    let sessie = await zorgVoorSessie();
    try {
      return await verzoek(pad, { methode: 'POST', body, sessie, pogingen: 1 });
    } catch (fout) {
      if (!(fout instanceof HttpFout) || fout.status !== 401) throw fout;
      log('info', 'bunq-sessie verlopen; opnieuw inloggen.');
      delete state.sessieToken;
      bewaarState();
      sessie = await nieuweSessie();
      return verzoek(pad, { methode: 'POST', body, sessie, pogingen: 1 });
    }
  }

  async function rekeningen() {
    // Eerst de sessie, dan het pad: de user-id komt uit de sessie.
    await zorgVoorSessie();
    const data = await lees(`/user/${encodeURIComponent(state.userId)}/monetary-account?count=100`);
    const uit = [];
    for (const [sleutel, soort] of Object.entries(REKENINGSOORTEN)) {
      for (const rekening of alleUitResponse(data, [sleutel])) {
        if (String(rekening.status).toUpperCase() !== 'ACTIVE') continue;
        const alias = (rekening.alias || []).find((a) => String(a.type).toUpperCase() === 'IBAN');
        const iban = naarIban(alias && alias.value);
        if (ibanFilter.length && (!iban || !ibanFilter.includes(iban))) continue;
        uit.push({ id: String(rekening.id), iban, naam: rekening.description || (alias && alias.name) || iban, soort });
      }
    }
    return uit;
  }

  const draftPad = (rekeningId, extra = '') => `/user/${encodeURIComponent(state.userId)}/monetary-account/`
    + `${encodeURIComponent(String(rekeningId))}/draft-payment${extra}`;

  return {
    beschikbaar,
    omgeving,

    async rekeningen() {
      if (!beschikbaar) throw new Error('bunq is niet ingesteld');
      return rekeningen();
    },

    // Alleen rekeningen waar je vanaf betaalt (geen spaarrekeningen).
    async bankrekeningen() {
      if (!beschikbaar) throw new Error('bunq is niet ingesteld');
      return (await rekeningen()).filter((r) => r.soort === 'bank' || r.soort === 'gezamenlijk');
    },

    // Zet een conceptbetaling klaar met één regel per factuur. Geeft {id}.
    // Gooit DraftFout: zeker = true als bunq antwoordde dat het niet lukte
    // (4xx), false als we het niet weten (netwerk, time-out, 5xx).
    async maakDraft({ rekeningId, regels }) {
      if (!beschikbaar) throw new DraftFout('bunq is niet ingesteld', true);
      const body = draftLichaam(regels);
      let data;
      try {
        await zorgVoorSessie();
        data = await schrijfDraft(draftPad(rekeningId), body);
      } catch (fout) {
        const status = fout instanceof HttpFout ? fout.status : 0;
        const zeker = status >= 400 && status < 500;
        throw new DraftFout(zeker ? fout.message : `geen zeker antwoord van bunq (${fout.message})`, zeker);
      }
      const id = uitResponse(data, 'Id');
      if (!id || id.id === undefined) throw new DraftFout('bunq gaf geen id terug voor de conceptbetaling', false);
      return { id: String(id.id) };
    },

    // De stand van één draft: {status, bijgewerkt, betalingen}.
    async draft(rekeningId, draftId) {
      if (!beschikbaar) throw new Error('bunq is niet ingesteld');
      await zorgVoorSessie();
      const data = await lees(draftPad(rekeningId, '/' + encodeURIComponent(String(draftId))));
      const draft = uitResponse(data, 'DraftPayment');
      if (!draft) throw new Error('bunq gaf geen DraftPayment terug');
      return naarDraft(draft);
    },

    // De recente drafts van een rekening, om een draft met een onzeker
    // antwoord terug te vinden.
    async drafts(rekeningId) {
      if (!beschikbaar) throw new Error('bunq is niet ingesteld');
      await zorgVoorSessie();
      const data = await lees(draftPad(rekeningId, '?count=50'));
      return alleUitResponse(data, ['DraftPayment']).map(naarDraft);
    },

    // Alle betalingen vanaf `vanafDatum` (YYYY-MM-DD) over alle rekeningen,
    // met terugbladeren via Pagination.older_url.
    async betalingen({ vanafDatum, maxPaginas = 25 }) {
      if (!beschikbaar) throw new Error('bunq is niet ingesteld');
      const uit = [];
      for (const rekening of await rekeningen()) {
        let pad = `/user/${encodeURIComponent(state.userId)}/monetary-account/`
          + `${encodeURIComponent(rekening.id)}/payment?count=${BETALINGEN_PER_PAGINA}`;
        let volledig = false;

        for (let pagina = 0; pagina < maxPaginas && pad; pagina++) {
          const data = await lees(pad, { volledig });
          const betalingen = alleUitResponse(data, ['Payment']).map((p) => naarBetaling(p, rekening));
          uit.push(...betalingen);

          // Stoppen zodra de oudste op deze pagina buiten de periode valt.
          const oudste = betalingen.reduce((min, b) => (b.datum && (!min || b.datum < min) ? b.datum : min), null);
          if (!betalingen.length || (oudste && oudste < vanafDatum)) break;

          pad = (data.Pagination && data.Pagination.older_url) || null;
          volledig = true;
        }
      }
      return uit.filter((b) => !b.datum || b.datum >= vanafDatum);
    },

    async test() {
      if (!beschikbaar) return { ok: false, melding: 'bunq is niet ingesteld in de env.' };
      try {
        const lijst = await rekeningen();
        if (!lijst.length) {
          return { ok: false, melding: 'verbonden, maar geen actieve rekening gevonden (staat het IBAN-filter goed?)' };
        }
        return { ok: true, melding: `${lijst.length} rekening(en): ` + lijst.map((r) => r.iban || r.naam).join(', ') };
      } catch (fout) {
        return { ok: false, melding: fout.message };
      }
    },
  };
}

// Soorten rekeningen in het antwoord van monetary-account, met onze naam.
export const REKENINGSOORTEN = {
  MonetaryAccountBank: 'bank',
  MonetaryAccountJoint: 'gezamenlijk',
  MonetaryAccountSavings: 'spaar',
  MonetaryAccountLight: 'light',
};

export class DraftFout extends Error {
  constructor(melding, zeker) {
    super(melding);
    this.name = 'DraftFout';
    this.zeker = Boolean(zeker);
  }
}

// De body van POST draft-payment (swagger: DraftPayment met entries[]). Elke
// regel: {bedrag, iban, naam, omschrijving}. Bedrag als tekst met twee
// decimalen; de omschrijving mag naar een externe IBAN hooguit 140 tekens.
export function draftLichaam(regels) {
  return {
    entries: regels.map((r) => ({
      amount: { value: Number(r.bedrag).toFixed(2), currency: 'EUR' },
      counterparty_alias: { type: 'IBAN', value: r.iban, name: schoonTenaamstelling(r.naam) ?? r.naam },
      description: String(r.omschrijving).slice(0, 140),
    })),
    number_of_required_accepts: 1,
  };
}

// Een DraftPayment uit een GET omzetten. `object` bestaat pas na goedkeuring
// en is een Payment of een PaymentBatch; de betaal-id's daaruit helpen bij
// het koppelen van de echte betaling.
export function naarDraft(draft) {
  const regels = (draft.entries || []).map((e) => {
    const tegen = e.counterparty_alias || {};
    return {
      iban: naarIban(tegen.iban || tegen.value),
      bedrag: Number(e.amount && e.amount.value),
      omschrijving: e.description || '',
    };
  });
  const betalingen = [];
  const object = draft.object || {};
  const losse = object.Payment ? [object.Payment] : [];
  const batch = object.PaymentBatch?.payments?.Payment || object.PaymentBatch?.payments || [];
  for (const p of [...losse, ...(Array.isArray(batch) ? batch : [])]) {
    const b = p && (p.Payment || p);
    if (!b || b.id === undefined) continue;
    const tegen = b.counterparty_alias || {};
    betalingen.push({
      id: String(b.id),
      iban: naarIban(tegen.iban || tegen.label_monetary_account?.iban),
      bedrag: Math.abs(Number(b.amount && b.amount.value)),
    });
  }
  return {
    id: String(draft.id),
    status: String(draft.status || '').toUpperCase() || 'ONBEKEND',
    bijgewerkt: draft.updated || null,
    aangemaakt: draft.created || null,
    regels,
    betalingen,
  };
}

// bunq zet zijn fouten in {"Error":[{"error_description":"..."}]}; dat leest
// prettiger dan de ruwe JSON, en een hint bij de bekendste oorzaak helpt.
function bunqFoutTekst(tekst) {
  let melding = String(tekst || '');
  try {
    const data = JSON.parse(melding);
    const fouten = (data.Error || []).map((f) => f.error_description || f.error_description_translated).filter(Boolean);
    if (fouten.length) melding = fouten.join('; ');
  } catch { /* geen JSON: de ruwe tekst is het beste wat we hebben */ }
  if (/ip|address/i.test(melding) && /not|invalid|insufficient/i.test(melding)) {
    melding += ' (mogelijk is het publieke IP van hfd-web01 veranderd; zie deploy/README.md)';
  }
  return melding;
}
