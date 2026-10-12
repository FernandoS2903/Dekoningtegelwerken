// De projecten op dekoningtegelwerken.nl, uit het project-CMS. Publiek en
// zonder login: nginx van de site stuurt deze paden naar het portaal.
//
//   GET /projecten/<slug>/                een gepubliceerd project; een oude slug
//                                         geeft een 301 naar de huidige
//   GET /projecten/<slug>/?voorbeeld=...  een concept, met een ondertekende
//                                         link die 24 uur geldig is (noindex)
//   GET /_fragment/projecten/<args>       het projectgrid voor SSI op de homepage,
//                                         /projecten/ en de dienstpagina's
//                                         (in nginx internal)
//   GET /sitemap-projecten.xml            de gepubliceerde projecten
//
// De HTML komt uit dezelfde code als de statische site (service/site/
// weergave.mjs). Concept of verwijderd geeft 404. Alles wat gepubliceerd is,
// staat in een cache in het geheugen die het portaal bij elke wijziging leegt.
// Op het adres van het portaal zelf (cms.) bestaan deze pagina's niet.

import crypto from 'node:crypto';

import { CATEGORIEEN, SITE_URL, esc } from '../site/weergave.mjs';

export const VOORBEELD_GELDIG_MS = 24 * 60 * 60 * 1000;
export const UPLOAD_URL = '/uploads/projecten';

// -- voorbeeldlink -------------------------------------------------------------

/** De sleutel voor voorbeeldlinks, afgeleid van het sessiegeheim (geen eigen env-variabele). */
export function voorbeeldSleutel(geheim) {
  const bron = geheim && String(geheim).length >= 32 ? String(geheim) : crypto.randomBytes(32).toString('hex');
  return Buffer.from(crypto.hkdfSync('sha256', bron, Buffer.alloc(0), 'dkt-projectvoorbeeld', 32));
}

const handtekening = (sleutel, inhoud) => crypto.createHmac('sha256', sleutel).update('projectvoorbeeld:' + inhoud).digest('base64url').slice(0, 32);

export function maakVoorbeeldToken(projectId, { sleutel, nu = Date.now(), geldigMs = VOORBEELD_GELDIG_MS }) {
  const inhoud = `${Number(projectId)}.${Math.floor((nu + geldigMs) / 1000)}`;
  return `${inhoud}.${handtekening(sleutel, inhoud)}`;
}

/** Het project-id uit een geldige, niet verlopen token; anders null. */
export function leesVoorbeeldToken(token, { sleutel, nu = Date.now() }) {
  const m = /^(\d{1,9})\.(\d{1,12})\.([A-Za-z0-9_-]{32})$/.exec(String(token || ''));
  if (!m) return null;
  const verwacht = Buffer.from(handtekening(sleutel, `${m[1]}.${m[2]}`));
  const gekregen = Buffer.from(m[3]);
  if (verwacht.length !== gekregen.length || !crypto.timingSafeEqual(verwacht, gekregen)) return null;
  if (Number(m[2]) * 1000 < nu) return null;
  return Number(m[1]);
}

// -- van database naar weergave ---------------------------------------------------

/** Een foto uit de database als beeld voor service/site/weergave.mjs. */
export function fotoBron(f, project, uploadUrl = UPLOAD_URL) {
  let alt = f.alt_tekst || [project.titel, project.plaats].filter(Boolean).join(' in ');
  if (f.sfeerbeeld && !/^Sfeerbeeld/.test(alt)) alt = 'Sfeerbeeld: ' + alt;
  return {
    id: f.id,
    url: (w) => `${uploadUrl}/${f.bestandsnaam}-${w}.webp`,
    varianten: String(f.varianten).split(',').map(Number).filter(Boolean),
    breedte: f.breedte,
    hoogte: f.hoogte,
    alt,
    soort: f.sfeerbeeld ? 'sfeerbeeld' : 'projectfoto',
    fotoSoort: f.soort,
    bijschrift: f.bijschrift,
    isCover: !!f.is_cover,
  };
}

/** Een projectrij (met fotos) als project voor projectPagina en projectkaart. */
export function naarWeergave(p, { uploadUrl = UPLOAD_URL } = {}) {
  const fotos = (p.fotos || []).map((f) => fotoBron(f, p, uploadUrl));
  const cover = fotos.find((f) => f.isCover) || fotos[0] || null;
  const voor = fotos.find((f) => f.fotoSoort === 'voor') || null;
  const na = fotos.find((f) => f.fotoSoort === 'na') || null;
  const metVoorNa = voor && na;
  const galerij = fotos.filter((f) => f !== cover && (f.fotoSoort === 'galerij'
    // Een losse voor- of na-foto (zonder de ander) komt in de galerij.
    || (!metVoorNa && (f.fotoSoort === 'voor' || f.fotoSoort === 'na'))));
  return {
    id: p.id,
    slug: p.slug,
    naam: p.titel,
    plaats: p.plaats,
    type: p.ruimte,
    categorieen: String(p.categorieen || '').split(/\s+/).filter((c) => CATEGORIEEN.includes(c)),
    uitgelicht: !!p.uitgelicht,
    placeholder: !!p.voorbeeld,
    pagina: true,
    metaOmschrijving: p.meta_description || p.korte_omschrijving || '',
    lead: p.korte_omschrijving,
    omschrijving: String(p.beschrijving || '').split(/\n\s*\n/).map((t) => t.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean),
    info: [
      ['Ruimte', p.ruimte], ['Soort tegel', p.soort_tegel], ['Formaat', p.formaat],
      ['Werkzaamheden', p.werkzaamheden], ['Bijzonderheden', p.bijzonderheden],
    ].filter(([, w]) => w),
    kaartBeeld: cover,
    heroBeeld: cover,
    fotos: galerij,
    details: fotos.filter((f) => f.fotoSoort === 'detail').map((f) => [f.bijschrift || 'Detail', f]),
    voorBeeld: metVoorNa ? voor : null,
    naBeeld: metVoorNa ? na : null,
  };
}

// Wat er na /_fragment/projecten/ mag staan: dezelfde argumenten als in
// <!-- gen:projecten ... --> in de statische pagina's.
function fragmentArgs(rest) {
  const args = rest.split('/').filter(Boolean).map((a) => decodeURIComponent(a));
  if (!args.length || args.length > 2) return null;
  const goed = args.every((a) => a === 'uitgelicht' || a === 'alle' || a === 'filters'
    || (a.startsWith('categorie=') && CATEGORIEEN.includes(a.slice('categorie='.length))));
  const soorten = args.filter((a) => a === 'uitgelicht' || a === 'alle' || a.startsWith('categorie=')).length;
  return goed && soorten === 1 ? args : null;
}

// -- de dienst ----------------------------------------------------------------------

export function maakSiteProjecten({
  opslag, weergave, sleutel, portaalHost = '', uploadUrl = UPLOAD_URL, nu = () => Date.now(), log = () => {},
}) {
  const cache = new Map();
  const leegCache = () => cache.clear();

  const gepubliceerd = () => opslag.lijst({ status: 'gepubliceerd' }).map((p) => naarWeergave(p, { uploadUrl }));

  function stuur(req, res, status, type, body, extra = {}) {
    res.writeHead(status, {
      'content-type': type,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-cache',
      ...extra,
    });
    res.end(req.method === 'HEAD' ? '' : body);
  }
  const nietGevonden = (req, res) => stuur(req, res, 404, 'text/plain; charset=utf-8', 'Niet gevonden.\n');
  const doorsturen = (req, res, status, waarheen) => stuur(req, res, status, 'text/plain; charset=utf-8', '', { location: waarheen });

  function uitCache(sleutelNaam, maak) {
    if (!cache.has(sleutelNaam)) cache.set(sleutelNaam, maak());
    return cache.get(sleutelNaam);
  }

  function projectHtml(vm, opties = {}) {
    const html = weergave.vervangBlokken(weergave.projectPagina(vm, opties), `/projecten/${vm.slug}/`);
    return weergave.metOgBeeld(html, vm.heroBeeld);
  }

  function voorbeeldUrl(project) {
    const token = maakVoorbeeldToken(project.id, { sleutel, nu: nu() });
    return `${SITE_URL}/projecten/${project.slug}/?voorbeeld=${token}`;
  }

  /** Is dit een pad van de site dat hier hoort? */
  const isSitePad = (pad) => pad.startsWith('/projecten/') || pad.startsWith('/_fragment/projecten/') || pad === '/sitemap-projecten.xml';

  function handle(req, res, url) {
    const pad = url.pathname;
    if (req.method !== 'GET' && req.method !== 'HEAD') return stuur(req, res, 405, 'text/plain; charset=utf-8', 'Alleen lezen.\n', { allow: 'GET, HEAD' });
    // Op cms.dekoningtegelwerken.nl bestaan de pagina's van de site niet.
    if (portaalHost && String(req.headers.host || '').toLowerCase() === portaalHost) return nietGevonden(req, res);

    if (pad === '/sitemap-projecten.xml') {
      const xml = uitCache('sitemap', () => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${opslag.lijst({ status: 'gepubliceerd' }).filter((p) => !p.voorbeeld)
    .map((p) => `  <url><loc>${SITE_URL}/projecten/${esc(p.slug)}/</loc><lastmod>${esc(String(p.gewijzigd_op).slice(0, 10))}</lastmod></url>`).join('\n')}
</urlset>
`);
      return stuur(req, res, 200, 'application/xml; charset=utf-8', xml);
    }

    if (pad.startsWith('/_fragment/projecten/')) {
      const args = fragmentArgs(pad.slice('/_fragment/projecten/'.length));
      if (!args) return nietGevonden(req, res);
      const html = uitCache('fragment:' + args.join('/'), () => weergave.projectenBlok(args, { projecten: gepubliceerd() }));
      return stuur(req, res, 200, 'text/html; charset=utf-8', html);
    }

    const m = /^\/projecten\/([^/]+)(\/?)$/.exec(pad);
    if (!m) return nietGevonden(req, res);
    const slug = m[1];
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) return nietGevonden(req, res);
    if (!m[2]) return doorsturen(req, res, 301, `/projecten/${slug}/${url.search}`);

    // Voorbeeld van een concept: nooit uit de cache, nooit indexeren.
    if (url.searchParams.has('voorbeeld')) {
      const id = leesVoorbeeldToken(url.searchParams.get('voorbeeld'), { sleutel, nu: nu() });
      const project = id ? opslag.opId(id) : null;
      if (!project) return nietGevonden(req, res);
      const melding = `<p class="ph-blok"><strong>Voorbeeld.</strong> ${project.status === 'gepubliceerd'
        ? 'Dit project staat online.'
        : 'Dit project is nog niet gepubliceerd; alleen wie deze link heeft, ziet het. De link verloopt na 24 uur.'}</p>`;
      const html = projectHtml(naarWeergave(project, { uploadUrl }), { voorbeeldmelding: melding, noindex: true });
      return stuur(req, res, 200, 'text/html; charset=utf-8', html, { 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
    }

    const html = uitCache('project:' + slug, () => {
      const p = opslag.opSlug(slug);
      return p && p.status === 'gepubliceerd' ? projectHtml(naarWeergave(p, { uploadUrl })) : null;
    });
    if (html) return stuur(req, res, 200, 'text/html; charset=utf-8', html);

    const oud = opslag.opOudeSlug(slug);
    if (oud && oud.status === 'gepubliceerd') return doorsturen(req, res, 301, `/projecten/${oud.slug}/`);
    return nietGevonden(req, res);
  }

  return { handle, isSitePad, leegCache, voorbeeldUrl, naarWeergave: (p) => naarWeergave(p, { uploadUrl }), log };
}
