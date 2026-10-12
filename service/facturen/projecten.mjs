// WEBSITE > Projecten in het portaal: de projecten van dekoningtegelwerken.nl
// beheren. Achter de login van het portaal; elke POST is al op herkomst en
// CSRF gecontroleerd in portaal.mjs, behalve de upload (multipart): die leest
// zijn eigen body en controleert het CSRF-token zelf.
//
//   GET  /website/projecten/                 overzicht (?status=concept|gepubliceerd)
//   GET  /website/projecten/nieuw            formulier; POST maakt het project
//   GET  /website/projecten/<id>             bewerken + foto's; POST slaat op
//   POST /website/projecten/<id>/omhoog|omlaag
//   GET  /website/projecten/<id>/verwijderen bevestiging; POST verwijdert (zacht)
//   POST /website/projecten/<id>/fotos       upload (multipart, één of meer foto's)
//   POST /website/projecten/<id>/fotos/<f>   alt-tekst, soort, bijschrift
//   POST /website/projecten/<id>/fotos/<f>/cover|omhoog|omlaag|verwijder
//   GET  /website/projecten/beeld/<naam>-<breedte>.webp   miniatuur voor het portaal
//
// Na elke wijziging wordt de cache van de site geleegd (site-projecten.mjs).

import { createReadStream, existsSync } from 'node:fs';

import { boundaryUit, leesMultipart } from './lib/multipart.mjs';
import { FOTO_SOORTEN, GRENZEN, controleerProject } from './lib/projecten-opslag.mjs';
import {
  FotoFout, GELDIGE_NAAM, MAX_BESTANDEN, MAX_BYTES, bestandVoor, verwerkFoto, verwijderBestanden,
} from './lib/beeldverwerking.mjs';
import { SITE_URL } from '../site/weergave.mjs';
import { doorsturen, kop, meldingenUit, stuurHtml, stuurTekst, zelfdeTekst } from './lib/web.mjs';
import { bewerkPagina, nieuwPagina, overzichtPagina, verwijderPagina } from './web/projecten.mjs';

export const BASIS = '/website/projecten';
// Eén verzoek mag iets groter zijn dan één foto (de multipart-koppen en het
// CSRF-veld); de browser stuurt elke foto apart. nginx laat 16 MB door.
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

const MELDINGEN = {
  aangemaakt: ['goed', 'Project aangemaakt. Voeg nu foto\'s toe.'],
  opgeslagen: ['goed', 'Opgeslagen.'],
  verwijderd: ['goed', 'Project verwijderd; het staat niet meer op de site.'],
  geupload: ['goed', 'Foto\'s toegevoegd.'],
  fotoOpgeslagen: ['goed', 'Foto opgeslagen.'],
  fotoWeg: ['goed', 'Foto verwijderd.'],
  cover: ['goed', 'Cover gewijzigd.'],
  uploadFout: ['fout', 'Niet alle foto\'s konden worden toegevoegd. Alleen JPEG, PNG of WebP tot 15 MB.'],
  uploadLeeg: ['fout', 'Kies eerst één of meer foto\'s.'],
  uploadTeVeel: ['fout', `Maximaal ${MAX_BESTANDEN} foto's per keer en 16 MB per verzending.`],
};

/** Is dit de upload-route (die zijn eigen body leest)? */
export const isUpload = (pad, methode) => methode === 'POST' && /^\/website\/projecten\/\d+\/fotos$/.test(pad);

function leesBuffer(req, max) {
  return new Promise((klaar, mislukt) => {
    const delen = [];
    let grootte = 0;
    let te = false;
    req.on('data', (deel) => {
      if (te) return;
      grootte += deel.length;
      if (grootte > max) {
        te = true;
        mislukt(Object.assign(new Error('te groot'), { teGroot: true }));
        req.resume();
        return;
      }
      delen.push(deel);
    });
    req.on('end', () => { if (!te) klaar(Buffer.concat(delen)); });
    req.on('error', mislukt);
  });
}

export function maakProjectenApp({ opslag, site, uploadMap, cwebp = 'cwebp', jpegtran = 'jpegtran', log = () => {} }) {
  const gewijzigd = () => site.leegCache();
  const naar = (res, pad, code) => doorsturen(res, 303, `${pad}${code ? (pad.includes('?') ? '&' : '?') + 'm=' + code : ''}`);
  const siteUrl = (p) => `${SITE_URL}/projecten/${p.slug}/`;

  function formulierVelden(body) {
    const uit = {};
    for (const k of ['titel', 'slug', 'plaats', 'ruimte', 'korte_omschrijving', 'beschrijving', 'meta_description',
      'soort_tegel', 'formaat', 'werkzaamheden', 'bijzonderheden', 'datum', 'status', 'uitgelicht', 'voorbeeld']) {
      uit[k] = body.get(k) ?? '';
    }
    uit.categorieen = body.getAll('categorieen');
    return uit;
  }

  function opslaanOfFouten(id, body) {
    const { velden, fouten } = controleerProject(formulierVelden(body));
    if (!fouten.slug && opslag.slugBezet(velden.slug, id)) fouten.slug = 'Dit adres is al van een ander project.';
    return { velden, fouten };
  }

  // -- upload ---------------------------------------------------------------------
  async function upload(req, res, ctx, p) {
    const json = String(req.headers.accept || '').includes('application/json');
    const antwoord = (status, data, code) => {
      if (json) {
        kop(res, status, 'application/json; charset=utf-8');
        return res.end(JSON.stringify(data));
      }
      return naar(res, `${BASIS}/${p.id}`, code);
    };

    const boundary = boundaryUit(req.headers['content-type']);
    if (!boundary) return stuurTekst(res, 400, 'Verwacht multipart/form-data.');
    let delen;
    try {
      delen = leesMultipart(await leesBuffer(req, MAX_UPLOAD_BYTES), boundary);
    } catch (fout) {
      if (fout.teGroot) return antwoord(413, { ok: false, fout: MELDINGEN.uploadTeVeel[1] }, 'uploadTeVeel');
      return stuurTekst(res, 400, 'Ongeldige upload.');
    }
    if (!zelfdeTekst((delen.velden.get('_csrf') || [])[0], ctx.kader.csrf)) {
      console.warn('upload zonder geldig CSRF-token geweigerd');
      return stuurTekst(res, 403, 'Het formulier is verlopen of komt niet van het portaal; laad de pagina opnieuw.');
    }
    const bestanden = delen.bestanden.filter((b) => b.veld === 'foto');
    if (!bestanden.length) return antwoord(400, { ok: false, fout: MELDINGEN.uploadLeeg[1] }, 'uploadLeeg');
    if (bestanden.length > MAX_BESTANDEN) return antwoord(413, { ok: false, fout: MELDINGEN.uploadTeVeel[1] }, 'uploadTeVeel');

    const fotos = [];
    const fouten = [];
    for (const b of bestanden) {
      try {
        if (b.inhoud.length > MAX_BYTES) throw new FotoFout('te-groot', 'Het bestand is groter dan 15 MB.');
        const r = await verwerkFoto(b.inhoud, { map: uploadMap, slug: p.slug, cwebp, jpegtran });
        const id = opslag.voegFotoToe(p.id, { ...r, alt_tekst: '' });
        fotos.push({ id, bestandsnaam: r.bestandsnaam });
      } catch (fout) {
        // De naam van het bestand gaat alleen terug naar de browser, niet naar het log.
        if (!(fout instanceof FotoFout)) console.error('foto verwerken mislukt: ' + fout.message);
        fouten.push({ naam: b.naam, melding: fout instanceof FotoFout ? fout.message : 'Deze foto kon niet verwerkt worden.' });
      }
    }
    if (fotos.length) {
      gewijzigd();
      log('info', `Project ${p.slug}: ${fotos.length} foto('s) toegevoegd`);
    }
    const status = fotos.length ? 200 : 422;
    return antwoord(status, { ok: !fouten.length, fotos, fouten }, fouten.length ? 'uploadFout' : 'geupload');
  }

  // -- miniaturen in het portaal ----------------------------------------------------
  function beeld(res, naam) {
    const m = /^([a-z0-9-]+)-(\d{2,5})\.webp$/.exec(naam);
    if (!m || !GELDIGE_NAAM.test(m[1])) return stuurTekst(res, 404, 'Niet gevonden.');
    const bestand = bestandVoor(uploadMap, m[1], Number(m[2]));
    if (!existsSync(bestand)) return stuurTekst(res, 404, 'Niet gevonden.');
    kop(res, 200, 'image/webp', { 'cache-control': 'private, max-age=86400' });
    createReadStream(bestand).pipe(res);
    return undefined;
  }

  // -- router -----------------------------------------------------------------------
  async function handle(req, res, ctx) {
    const url = new URL(req.url, 'http://localhost');
    const pad = url.pathname.replace(/\/+$/, '') || '/';
    const { kader, body } = ctx;
    const get = req.method === 'GET' || req.method === 'HEAD';
    const post = req.method === 'POST';
    const meldingen = meldingenUit(url.searchParams, MELDINGEN);

    if (pad === '/website' || pad === BASIS) {
      if (!get) return stuurTekst(res, 405, 'Niet toegestaan.');
      if (url.pathname !== `${BASIS}/`) return doorsturen(res, 301, `${BASIS}/${url.search}`);
      const filter = ['concept', 'gepubliceerd'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'alle';
      return stuurHtml(res, 200, overzichtPagina({
        kader, filter, meldingen, projecten: opslag.lijst({ status: filter === 'alle' ? null : filter }),
      }));
    }

    if (pad.startsWith(`${BASIS}/beeld/`) && get) return beeld(res, pad.slice(`${BASIS}/beeld/`.length));

    if (pad === `${BASIS}/nieuw`) {
      if (get) return stuurHtml(res, 200, nieuwPagina({ kader }));
      if (!post) return stuurTekst(res, 405, 'Niet toegestaan.');
      const { velden, fouten } = opslaanOfFouten(null, body);
      if (Object.keys(fouten).length) return stuurHtml(res, 422, nieuwPagina({ kader, p: velden, fouten }));
      const id = opslag.maak(velden);
      gewijzigd();
      log('info', `Project aangemaakt: ${velden.slug}`);
      return naar(res, `${BASIS}/${id}`, 'aangemaakt');
    }

    const m = new RegExp(`^${BASIS}/(\\d{1,9})(?:/(.+))?$`).exec(pad);
    if (!m) return stuurTekst(res, 404, 'Niet gevonden.');
    const p = opslag.opId(m[1]);
    if (!p) return stuurTekst(res, 404, 'Dit project bestaat niet (meer).');
    const rest = m[2] || '';
    const terug = `${BASIS}/${p.id}`;

    if (!rest) {
      if (get) return stuurHtml(res, 200, bewerkPagina({ kader, p, meldingen, voorbeeldUrl: site.voorbeeldUrl(p), siteUrl: siteUrl(p) }));
      if (!post) return stuurTekst(res, 405, 'Niet toegestaan.');
      const { velden, fouten } = opslaanOfFouten(p.id, body);
      if (Object.keys(fouten).length) {
        return stuurHtml(res, 422, bewerkPagina({ kader, p, fouten, waarden: velden, voorbeeldUrl: site.voorbeeldUrl(p), siteUrl: siteUrl(p) }));
      }
      opslag.werkBij(p.id, velden);
      gewijzigd();
      log('info', `Project opgeslagen: ${velden.slug} (${velden.status})`);
      return naar(res, terug, 'opgeslagen');
    }

    if (rest === 'verwijderen') {
      if (get) return stuurHtml(res, 200, verwijderPagina({ kader, p }));
      if (!post) return stuurTekst(res, 405, 'Niet toegestaan.');
      opslag.verwijder(p.id);
      gewijzigd();
      log('info', `Project verwijderd: ${p.slug}`);
      return naar(res, `${BASIS}/`, 'verwijderd');
    }

    if (!post) return stuurTekst(res, 405, 'Niet toegestaan.');

    if (rest === 'omhoog' || rest === 'omlaag') {
      opslag.verplaats(p.id, rest);
      gewijzigd();
      return naar(res, `${BASIS}/`);
    }

    if (rest === 'fotos') return upload(req, res, ctx, p);

    const f = /^fotos\/(\d{1,9})(?:\/(cover|omhoog|omlaag|verwijder))?$/.exec(rest);
    if (!f) return stuurTekst(res, 404, 'Niet gevonden.');
    const foto = opslag.foto(p.id, f[1]);
    if (!foto) return stuurTekst(res, 404, 'Deze foto bestaat niet (meer).');
    const actie = f[2];
    if (!actie) {
      const soort = FOTO_SOORTEN.some(([k]) => k === body.get('soort')) ? body.get('soort') : foto.soort;
      opslag.werkFotoBij(p.id, foto.id, {
        alt_tekst: String(body.get('alt_tekst') || '').trim().slice(0, GRENZEN.alt_tekst),
        bijschrift: String(body.get('bijschrift') || '').trim().slice(0, GRENZEN.bijschrift),
        soort,
      });
      gewijzigd();
      return naar(res, terug, 'fotoOpgeslagen');
    }
    if (actie === 'cover') {
      opslag.zetCover(p.id, foto.id);
      gewijzigd();
      return naar(res, terug, 'cover');
    }
    if (actie === 'omhoog' || actie === 'omlaag') {
      opslag.verplaatsFoto(p.id, foto.id, actie);
      gewijzigd();
      return naar(res, terug);
    }
    const weg = opslag.verwijderFoto(p.id, foto.id);
    if (weg) verwijderBestanden(uploadMap, weg.bestandsnaam, weg.varianten);
    gewijzigd();
    log('info', `Project ${p.slug}: foto verwijderd`);
    return naar(res, terug, 'fotoWeg');
  }

  return { handle, isUpload };
}
