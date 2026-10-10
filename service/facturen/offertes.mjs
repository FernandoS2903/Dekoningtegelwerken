// Het onderdeel Offertes van het portaal: de lijst uit Offerteknop en het
// bijwerken daarvan. Zelfde opzet als mail.mjs: `handle(req, res, ctx)`;
// inloggen en CSRF regelt het portaal. Daarnaast `conceptUitMail`, dat de
// Mail-pagina gebruikt voor de knop "Maak offerte".

import { nuIso } from './lib/hulp.mjs';
import { OFFERTE_FILTERS } from './lib/offerte-opslag.mjs';
import { IS_OFFERTEKNOP_PAD, OfferteknopFout, offerteknopPad } from './lib/offerteknop.mjs';
import { doorsturen, kop, leesBody, meldingenUit, stuurHtml, stuurTekst } from './lib/web.mjs';
import { offertesPagina } from './web/offertes.mjs';

const MELDINGEN = {
  bijgewerkt: ['goed', 'De lijst is bijgewerkt.'],
  'bijwerken-fout': ['fout', 'Bijwerken is mislukt. De reden staat in het logboek onder Facturen › Instellingen.'],
  'niet-ingesteld': ['fout', 'De koppeling met Offerteknop is niet ingesteld.'],
};

export const STAAT_LAATSTE_SYNC = 'offertes_laatste_sync';

export function maakOffertesApp({ opslag, offerteOpslag, offerteknop, mail = null, aanvraagLezer = null, basisPad = '/offertes', publiekeUrl = '', log = (n, b) => opslag.log(n, b) }) {
  const basis = basisPad.replace(/\/+$/, '');
  // De publieke host van Offerteknop (voor de inloglink): uit OFFERTES_URL.
  let publiek = '';
  try { publiek = publiekeUrl ? new URL(publiekeUrl).origin : ''; } catch { publiek = ''; }
  const metSso = () => Boolean(offerteknop.beschikbaar && publiek);

  // /offertes/open?naar=<pad>: eenmalig inloggen in Offerteknop en door naar
  // het pad; zonder koppeling gewoon de link zelf.
  function openUrl(pad) {
    const doel = IS_OFFERTEKNOP_PAD.test(pad) ? pad : '/offertes/';
    return metSso() ? `${basis}/open?naar=${encodeURIComponent(doel)}` : (publiek ? publiek + doel : '');
  }
  let bezig = false;

  function terug(res, pad, code) {
    kop(res, 303, 'text/plain; charset=utf-8', { location: basis + pad + (code ? (pad.includes('?') ? '&' : '?') + 'm=' + code : '') });
    res.end('');
  }

  // Haalt de lijst op sinds de vorige keer (met een dag overlap) en zet hem
  // in de spiegel. Geeft het aantal bijgewerkte offertes terug.
  async function bijwerken({ volledig = false } = {}) {
    if (!offerteknop.beschikbaar) throw new OfferteknopFout(503, 'Offerteknop is niet ingesteld.');
    if (bezig) return 0;
    bezig = true;
    try {
      const vorige = offerteOpslag.staat(STAAT_LAATSTE_SYNC);
      const sinds = volledig || !vorige ? null : new Date(new Date(vorige).getTime() - 24 * 3600 * 1000).toISOString();
      const uit = await offerteknop.lijst({ sinds, limiet: 500, archief: 'alle' });
      for (const o of uit.offertes || []) offerteOpslag.bewaar(o);
      offerteOpslag.zetStaat(STAAT_LAATSTE_SYNC, nuIso());
      return (uit.offertes || []).length;
    } finally {
      bezig = false;
    }
  }

  // Van een mail (regel in sorteer_log) een concept in Offerteknop. Geeft
  // {bewerkUrl, bestaand}. Idempotent op het internet-message-id.
  async function conceptUitMail(logRegel, { gebruiker = '' } = {}) {
    if (!offerteknop.beschikbaar) throw new OfferteknopFout(503, 'Offerteknop is niet ingesteld.');
    const referentie = logRegel.internet_id || `sorteer_log:${logRegel.id}`;
    const eerder = offerteOpslag.conceptBijReferentie(referentie) || offerteOpslag.conceptBijLog(logRegel.id);
    if (eerder) return { bewerkUrl: eerder.bewerk_url, offerteId: eerder.offerte_id, bestaand: true };

    // Tekst en foto's uit de mail; beide zijn optioneel (de sorteerder heeft
    // de mail mogelijk al verplaatst, dan werkt huidig_id).
    const mailId = logRegel.huidig_id || logRegel.message_id;
    let tekst = '';
    let fotos = [];
    if (mail && mail.beschikbaar && mailId) {
      try { tekst = (await mail.inhoud(mailId, { maxTekens: 6000, metBijlagen: false })).tekst; } catch (fout) { log('warn', `Maak offerte: mailtekst niet opgehaald: ${fout.message}`); }
      try { fotos = typeof mail.bijlagen === 'function' ? await mail.bijlagen(mailId) : []; } catch (fout) { log('warn', `Maak offerte: foto's niet opgehaald: ${fout.message}`); }
    }
    const gelezen = aanvraagLezer
      ? await aanvraagLezer.lees({ afzenderNaam: logRegel.afzender_naam || '', afzender: logRegel.afzender || '', onderwerp: logRegel.onderwerp || '', tekst })
      : { velden: { naam: logRegel.afzender_naam || logRegel.afzender || 'Onbekende aanvrager', email: logRegel.afzender || '', telefoon: '', adres: '', postcode_plaats: '', omschrijving: tekst.slice(0, 2000) }, bron: 'geen' };
    if (gelezen.fout) log('warn', `Maak offerte: gegevens uit de mail halen via Claude mislukte (${gelezen.fout}); afzender gebruikt.`);
    const v = gelezen.velden;
    const omschrijving = [logRegel.onderwerp ? `Onderwerp: ${logRegel.onderwerp}` : '', v.omschrijving].filter(Boolean).join('\n');
    const uit = await offerteknop.concept({
      bron: 'portaal-mail',
      referentie,
      klant: { naam: v.naam, email: v.email, telefoon: v.telefoon, adres: v.adres, postcode_plaats: v.postcode_plaats },
      project: { omschrijving },
      bijlagen: fotos,
    });
    offerteOpslag.bewaar(uit);
    offerteOpslag.noteerConcept({ bron: 'mail', referentie, sorteerLogId: logRegel.id, offerteId: uit.id, bewerkUrl: uit.bewerk_url, door: gebruiker || null });
    log('info', `Concept-offerte ${uit.nummer_str || uit.id} gemaakt uit mail van ${logRegel.afzender || '?'}${gebruiker ? ' door ' + gebruiker : ''} (gegevens via ${gelezen.bron}${fotos.length ? `, ${fotos.length} foto's` : ''}).`);
    return { bewerkUrl: uit.bewerk_url, offerteId: uit.id, bestaand: Boolean(uit.bestaand) };
  }

  async function handle(req, res, ctx = {}) {
    const kader = ctx.kader || null;
    const gebruiker = kader?.email || kader?.naam || '';
    const lees = () => (ctx.body ? Promise.resolve(ctx.body) : leesBody(req));
    const url = new URL(req.url, 'http://localhost');
    let pad = url.pathname;
    if (basis && pad.startsWith(basis)) pad = pad.slice(basis.length) || '/';
    if (pad.length > 1 && pad.endsWith('/')) pad = pad.slice(0, -1);
    const meldingen = meldingenUit(url.searchParams, MELDINGEN);

    if (pad === '/' && req.method === 'GET') {
      const gevraagd = url.searchParams.get('filter') || 'open';
      const filter = OFFERTE_FILTERS.some(([s]) => s === gevraagd) ? gevraagd : 'open';
      const zoek = (url.searchParams.get('zoek') || '').trim().slice(0, 100);
      return stuurHtml(res, 200, offertesPagina({
        basis, offerteOpslag, offerteknop, filter, zoek, meldingen, kader, laatsteSync: offerteOpslag.staat(STAAT_LAATSTE_SYNC), openUrl,
      }));
    }

    if (pad === '/open' && req.method === 'GET') {
      const naar = String(url.searchParams.get('naar') || '/offertes/');
      const doel = IS_OFFERTEKNOP_PAD.test(naar) ? naar : '/offertes/';
      if (!metSso()) return publiek ? doorsturen(res, 302, publiek + doel) : terug(res, '/', 'niet-ingesteld');
      const email = kader?.email || '';
      if (!email) return stuurTekst(res, 403, 'Inloggen in Offerteknop vraagt een e-mailadres; log in met Microsoft.');
      const token = offerteknop.inlogToken({ email });
      log('info', `Naar Offerteknop via de koppeling: ${email} -> ${doel}`);
      return doorsturen(res, 302, `${publiek}/inloggen-via-koppeling?${new URLSearchParams({ t: token, naar: doel })}`, { 'cache-control': 'no-store' });
    }

    if (pad === '/sync' && req.method === 'POST') {
      await lees();
      if (!offerteknop.beschikbaar) return terug(res, '/', 'niet-ingesteld');
      try {
        const n = await bijwerken({ volledig: true });
        log('info', `Offertelijst bijgewerkt uit Offerteknop (${n} offertes)${gebruiker ? ' door ' + gebruiker : ''}.`);
        return terug(res, '/', 'bijgewerkt');
      } catch (fout) {
        log('error', 'Offertelijst bijwerken mislukt: ' + fout.message);
        return terug(res, '/', 'bijwerken-fout');
      }
    }

    return stuurTekst(res, 404, 'Niet gevonden.');
  }

  // Het concept dat al bij deze logregel hoort, of null (voor de Mail-pagina).
  const conceptVan = (r) => {
    const c = (r.internet_id ? offerteOpslag.conceptBijReferentie(r.internet_id) : null) || offerteOpslag.conceptBijLog(r.id);
    return c ? { ...c, open_url: openUrl(offerteknopPad(c.bewerk_url)) || c.bewerk_url } : null;
  };

  return { handle, basis, bijwerken, conceptUitMail, conceptVan, openUrl, metSso, tellingen: (nu) => offerteOpslag.tellingen(nu) };
}
