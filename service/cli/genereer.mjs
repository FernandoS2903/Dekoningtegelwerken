// Generator voor de statische site. Geen build-step: de uitvoer is gewone
// HTML die in de repo staat en zonder deze stap direct te serveren is. Dit
// script houdt alleen de gedeelde delen gelijk en maakt pagina's uit data.
//
//   node service/cli/genereer.mjs              alles (opnieuw) schrijven
//   node service/cli/genereer.mjs --controleer niets schrijven; exit 1 als de
//                                              bestanden niet bij de data passen
//
// Wat het doet:
//  1. projecten/<slug>/index.html uit _sjablonen/project.html + data/projecten.json
//     (alleen projecten met pagina: true)
//  2. <slug>/index.html uit _sjablonen/dienst.html + data/diensten.json
//  3. In elke .html-pagina de gemarkeerde gebieden vervangen:
//       <!-- gen:head -->         charset, viewport, fonts, css, script
//       <!-- gen:header [over-hero] -->  header + mobiel menu (_sjablonen/header.html)
//       <!-- gen:footer -->       footer + sticky CTA (_sjablonen/footer.html)
//       <!-- gen:werkwijze -->    tijdlijn (_sjablonen/werkwijze.html)
//       <!-- gen:eind -->         contact-CTA-sectie (_sjablonen/eind.html)
//       <!-- gen:dienstkaarten --> de zes specialismen als kaarten
//       <!-- gen:projecten uitgelicht|alle|categorie=<c> [filters] -->
//       <!-- gen:wizard -->       de stappen van de offertewizard (data/wizard.json)
//       <!-- gen:beeld id=<id> [maat=<preset>] [klasse=a+b] [mobiel=<id>] [prioriteit] [donker] [sfeer] [label=Tekst_met_underscores] -->
//                                 één beeld uit data/beelden.json (of een placeholdervlak als het ontbreekt)
//     Alles tussen <!-- gen:x --> en <!-- /gen:x --> wordt overschreven:
//     daar niet met de hand in werken.
//  4. sitemap.xml (een sitemap-index) en sitemap-paginas.xml (de vaste
//     pagina's); de projecten staan in /sitemap-projecten.xml uit het portaal.
//
// De opmaak zelf staat in service/site/weergave.mjs; het portaal gebruikt
// dezelfde code voor de projecten uit het CMS. Elk projectgrid
// (gen:projecten) komt tussen SSI-opdrachten: live vult nginx het in vanuit
// het CMS, zonder SSI (preview, lokaal) blijft het statische grid uit
// data/projecten.json staan.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_URL, esc, icoon, maakWeergave, vul } from '../site/weergave.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const controleer = process.argv.includes('--controleer');

const site = maakWeergave({ root: ROOT, ssi: true });
const { lees, leesJson, statischeProjecten: projecten, diensten, dienstPerSlug } = site;
const beeld = (...a) => site.beeld(...a);

// Mappen die nooit pagina's bevatten.
const UITGESLOTEN = new Set(['.git', '_sjablonen', 'docs', 'deploy', 'service', 'test', 'node_modules', 'assets', 'css', 'js', 'data']);

// -- offertewizard (plan stap 2) ---------------------------------------------
// Alle stappen staan als gewone HTML in de pagina; js/wizard.js toont er één
// tegelijk, regelt de vervolgvragen per ruimte (data-voor) en de uploads.
function wizardBlok() {
  const w = leesJson('data/wizard.json');
  const stap = (nr, kop, inhoud, hulp = '') => `<fieldset class="wizard__stap" data-stap="${nr}">`
    + `<legend class="wizard__legend"><span class="wizard__kop" tabindex="-1">${esc(kop)}</span></legend>`
    + (hulp ? `<p class="wizard__hulp">${hulp}</p>` : '') + inhoud + `<p class="wizard__fout" role="alert" data-fout></p></fieldset>`;
  const chip = (naam, waarde, label, type = 'checkbox') => `<label class="chip"><input type="${type}" name="${esc(naam)}" value="${esc(waarde)}"><span>${esc(label)}</span></label>`;
  const veld = (id, label, attrs, hint = '') => `<div class="veld"><label for="${id}">${label}</label>${hint ? `<span class="veld__hint" id="${id}-hint">${hint}</span>` : ''}<input id="${id}" ${attrs}${hint ? ` aria-describedby="${id}-hint"` : ''}></div>`;
  const upload = (naam, { accept, capture = false, meerdere = true, knoppen }) => `<div class="upload" data-upload="${naam}" data-accept="${accept}">`
    + `<div class="upload__knoppen">${knoppen.map(([label, ico, extra]) => `<label class="knop knop--lijn upload__knop">${icoon(ico)} ${esc(label)}<input class="visueel-verborgen" type="file" accept="${accept}"${meerdere ? ' multiple' : ''}${extra || ''} data-upload-invoer></label>`).join('')}</div>`
    + `<ul class="upload__lijst" role="list" data-upload-lijst></ul><p class="upload__status" aria-live="polite" data-upload-status></p></div>`;

  const s1 = `<div class="keuzekaarten">${w.ruimtes.map((r) => `<label class="keuze"><input type="checkbox" name="ruimte" value="${esc(r.id)}"><span class="keuze__label">${esc(r.label)}</span><span class="keuze__sub">${esc(r.omschrijving)}</span><span class="keuze__vink" aria-hidden="true">${icoon('vink')}</span></label>`).join('')}</div>`
    + w.ruimtes.map((r) => {
      if (r.vrij) return `<div class="wizard__verdieping" data-voor="${esc(r.id)}" hidden><label class="wizard__subvraag" for="anders-tekst">Wat wil je laten tegelen?</label><textarea id="anders-tekst" name="anders" rows="3" maxlength="600"></textarea></div>`;
      if (!r.extra?.length) return '';
      return `<div class="wizard__verdieping" data-voor="${esc(r.id)}" hidden><p class="wizard__subvraag">${esc(r.label)}: wat komt erbij? <span class="wizard__optioneel">(optioneel)</span></p><div class="chips">${r.extra.map((e) => chip(`extra-${r.id}`, e, e)).join('')}</div></div>`;
    }).join('');

  const s2 = w.ruimtes.filter((r) => !r.vrij).map((r) => `<div class="maatblok" data-voor="${esc(r.id)}" hidden>`
    + `<p class="maatblok__kop">${esc(r.label)}</p>`
    + `<div class="maatblok__velden">`
    + veld(`m2-${r.id}`, 'Vloer', `name="m2-${r.id}" type="text" inputmode="decimal" autocomplete="off" placeholder="bijv. 8" data-m2`, 'in m²')
    + (r.wand ? veld(`wand-${r.id}`, 'Wanden', `name="wand-${r.id}" type="text" inputmode="decimal" autocomplete="off" placeholder="als je het weet" data-m2`, 'in m², optioneel') : '')
    + `</div>`
    + `<details class="maatblok__reken"><summary>Reken uit met lengte × breedte</summary><div class="maatblok__velden">`
    + veld(`l-${r.id}`, 'Lengte', `type="text" inputmode="decimal" autocomplete="off" data-lengte="${esc(r.id)}"`, 'in meter')
    + veld(`b-${r.id}`, 'Breedte', `type="text" inputmode="decimal" autocomplete="off" data-breedte="${esc(r.id)}"`, 'in meter')
    + `</div></details>`
    + `<label class="vink"><input type="checkbox" name="onbekend-${r.id}" value="ja" data-onbekend><span>Weet ik nog niet</span></label>`
    + `</div>`).join('')
    + `<p class="wizard__tip">Weet je het niet precies? Geen probleem. In stap 5 kun je een plattegrond meesturen; dan rekenen wij het na.</p>`;

  const s3 = `<div class="keuzelijst">${w.tegelStatus.map(([k, l]) => `<label class="keuze keuze--rij"><input type="radio" name="tegels" value="${k}"><span class="keuze__label">${esc(l)}</span><span class="keuze__vink" aria-hidden="true">${icoon('vink')}</span></label>`).join('')}</div>`
    + `<div class="wizard__verdieping" data-tegels-meer hidden><p class="wizard__subvraag">Welk formaat of soort? <span class="wizard__optioneel">(optioneel, meerdere keuzes)</span></p><div class="chips">${w.tegelFormaten.map((f) => chip('formaat', f, f)).join('')}</div></div>`
    + `<div class="wizard__verdieping" data-tegels-foto hidden><p class="wizard__subvraag">Foto van de tegel <span class="wizard__optioneel">(optioneel)</span></p>${upload('tegelfoto', { accept: 'image/*', meerdere: false, knoppen: [['Foto toevoegen', 'camera']] })}</div>`;

  const s4 = upload('fotos', { accept: 'image/*', knoppen: [['Maak foto', 'camera', ' capture="environment"'], ['Kies uit foto\'s', 'foto']] })
    + `<div class="wizard__tips"><p>Handig om te laten zien:</p><ul role="list">${w.fotoTips.map((t) => `<li>${icoon('vink')}${esc(t)}</li>`).join('')}</ul></div>`;

  const s5 = upload('plattegrond', { accept: 'image/*,application/pdf', meerdere: false, knoppen: [['Plattegrond toevoegen', 'plattegrond']] })
    + `<p class="wizard__privacy">${icoon('afspraak')}<span>Je plattegrond gebruiken we alleen om deze aanvraag te beoordelen. Aanvragen waar geen opdracht uit volgt, verwijderen we na 12 maanden. Zie de <a href="/privacy/">privacyverklaring</a>.</span></p>`;

  const s6 = `<div class="velden">`
    + veld('naam', 'Naam', 'name="naam" type="text" autocomplete="name" required')
    + `<p class="wizard__hulp wizard__hulp--klein">Telefoon of e-mail is genoeg; allebei mag ook.</p>`
    + veld('telefoon', 'Telefoonnummer', 'name="telefoon" type="tel" autocomplete="tel" inputmode="tel"')
    + veld('email', 'E-mailadres', 'name="email" type="email" autocomplete="email" inputmode="email"')
    + veld('postcode', 'Postcode', 'name="postcode" type="text" autocomplete="postal-code" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="next" maxlength="7" placeholder="1234 AB" required')
    + `<div class="veld"><label for="periode">Wanneer wil je het laten uitvoeren?</label><select id="periode" name="periode" data-periode><option value="">Kies een periode</option><option>Zo snel mogelijk</option><option>Nog niet bekend</option></select></div>`
    + `<div class="veld"><label for="toelichting">Toelichting <span class="wizard__optioneel">(optioneel)</span></label><textarea id="toelichting" name="toelichting" rows="3" maxlength="1500"></textarea></div>`
    + `</div><label class="vink vink--privacy"><input type="checkbox" name="privacy" value="ja" required><span>Ik ga akkoord met de <a href="/privacy/">privacyverklaring</a>.</span></label>`
    + `<input class="wizard__honing" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">`
    // Tijdstip van laden (zet js/wizard.js), voor de minimale invultijd aan de serverkant.
    + `<input type="hidden" name="t" value="" data-wizard-tijd>`;

  // data-endpoint: de aanvraagdienst (service/facturen/aanvraag.mjs, via
  // nginx). Zonder endpoint toont de wizard de samenvatting om zelf door te sturen.
  return `<form class="wizard" data-wizard data-endpoint="${esc(w.endpoint || '/api/aanvraag/indienen')}" data-max-fotos="${Number(w.maxFotos) || 8}" novalidate>
  <div class="wizard__voortgang"><p class="wizard__stapnr" aria-live="polite" data-wizard-stapnr>Stap 1 van 6</p><div class="wizard__balk" aria-hidden="true"><span data-wizard-balk></span></div></div>
  ${stap(1, 'Wat wil je laten tegelen?', s1, 'Meerdere keuzes mogelijk.')}
  ${stap(2, 'Hoe groot is de ruimte?', s2, 'Een schatting is genoeg.')}
  ${stap(3, 'Heb je al tegels?', s3)}
  ${stap(4, 'Laat de huidige situatie zien.', s4, 'Met een paar foto\'s kunnen we veel beter inschatten wat er nodig is.')}
  ${stap(5, 'Heb je een plattegrond?', s5, 'Een foto, PDF of bouwtekening. Dit is optioneel.')}
  ${stap(6, 'Waar kunnen we je bereiken?', s6, 'Alleen wat we nodig hebben om contact op te nemen.')}
  <div class="wizard__nav">
    <button class="knop knop--lijn wizard__terug" type="button" data-terug>Terug</button>
    <button class="knop wizard__verder" type="button" data-volgende>Volgende ${icoon('pijl')}</button>
    <button class="knop wizard__verder" type="submit" data-verstuur hidden>Verstuur mijn aanvraag ${icoon('pijl')}</button>
  </div>
</form>`;
}

site.extra.wizard = wizardBlok;

function dienstPagina(d) {
  const pad = `/${d.slug}/`;
  const items = d.slug === 'tegelzetter'
    ? [['Home', '/'], [d.titel, pad]]
    : [['Home', '/'], ['Diensten', '/tegelzetter/'], [d.titel, pad]];
  const service = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Service',
        name: d.titel,
        serviceType: d.serviceType,
        description: d.intro,
        url: SITE_URL + pad,
        provider: { '@type': 'Organization', name: 'De Koning Tegelwerken', url: SITE_URL + '/' },
      },
      site.kruimel(items),
    ],
  };
  const dienstkaarten = d.toonDienstkaarten ? `
  <section class="sectie sectie--diep" aria-labelledby="diensten-kop">
    <div class="wrap">
      <div class="sectiekop"><span class="eyebrow">Specialismen</span><h2 id="diensten-kop">Voor ieder oppervlak de juiste afwerking.</h2></div>
      <!-- gen:dienstkaarten -->
      <!-- /gen:dienstkaarten -->
    </div>
  </section>` : '';
  const werkArgs = d.categorie ? `categorie=${d.categorie}` : 'uitgelicht';
  return vul(lees('_sjablonen/dienst.html'), {
    titel: d.metaTitel,
    omschrijving: d.metaOmschrijving,
    canonical: SITE_URL + pad,
    jsonld: site.jsonld(service),
    kruimels: site.kruimelHtml(items),
    eyebrow: d.eyebrow,
    h1: d.h1,
    intro: d.intro,
    hero: beeld(d.beeld, { maat: 'half', prioriteit: true }),
    dienstkaarten,
    puntenKop: d.puntenKop,
    punten: d.punten.map(([kop, tekst], i) => `<li class="punt reveal" data-vertraging="${i % 2}"><h3>${esc(kop)}</h3><p>${esc(tekst)}</p></li>`).join(''),
    werkArgs,
    verwant: (d.verwant || []).map((s) => `<li><a href="/${s}/">${esc(dienstPerSlug[s].titel)}</a></li>`).join(''),
  });
}

// -- alle pagina's verzamelen ----------------------------------------------
const teSchrijven = new Map(); // relatief pad -> inhoud

for (const p of projecten.filter((x) => x.pagina)) {
  teSchrijven.set(`projecten/${p.slug}/index.html`, site.projectPagina(p));
}
for (const d of diensten) {
  teSchrijven.set(`${d.slug}/index.html`, dienstPagina(d));
}

function zoekHtml(map, rel = '') {
  for (const naam of readdirSync(map)) {
    const vol = path.join(map, naam);
    const r = rel ? rel + '/' + naam : naam;
    if (statSync(vol).isDirectory()) {
      if (!rel && UITGESLOTEN.has(naam)) continue;
      zoekHtml(vol, r);
    } else if (naam.endsWith('.html') && !teSchrijven.has(r)) {
      teSchrijven.set(r, readFileSync(vol, 'utf8'));
    }
  }
}
zoekHtml(ROOT);

const paginaPad = (rel) => (rel === 'index.html' ? '/' : rel.endsWith('/index.html') ? '/' + rel.slice(0, -'index.html'.length) : '/' + rel);

for (const [rel, html] of teSchrijven) {
  teSchrijven.set(rel, site.vervangBlokken(html, paginaPad(rel)));
}

// -- sitemap ---------------------------------------------------------------
// sitemap.xml is een index: de vaste pagina's hier, de projecten uit het CMS
// in /sitemap-projecten.xml (service/facturen/site-projecten.mjs). Pagina's
// onder /projecten/<slug>/ staan daarom niet in sitemap-paginas.xml.
const indexeerbaar = [...teSchrijven.entries()]
  .filter(([rel, html]) => rel.endsWith('index.html') && !/name="robots" content="noindex/.test(html))
  .map(([rel]) => paginaPad(rel))
  .filter((p) => !/^\/projecten\/[^/]+\/$/.test(p))
  .sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
teSchrijven.set('sitemap-paginas.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${indexeerbaar.map((p) => `  <url><loc>${SITE_URL}${p}</loc></url>`).join('\n')}
</urlset>
`);
teSchrijven.set('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${SITE_URL}/sitemap-paginas.xml</loc></sitemap>
  <sitemap><loc>${SITE_URL}/sitemap-projecten.xml</loc></sitemap>
</sitemapindex>
`);

// -- schrijven of controleren ----------------------------------------------
let afwijkend = 0;
for (const [rel, inhoud] of teSchrijven) {
  const vol = path.join(ROOT, rel);
  const huidig = existsSync(vol) ? readFileSync(vol, 'utf8') : null;
  if (huidig === inhoud) continue;
  afwijkend++;
  if (controleer) {
    console.log('niet bijgewerkt: ' + rel);
  } else {
    mkdirSync(path.dirname(vol), { recursive: true });
    writeFileSync(vol, inhoud);
    console.log('geschreven: ' + rel);
  }
}
if (controleer && afwijkend) {
  console.error(afwijkend + ' bestand(en) wijken af; draai node service/cli/genereer.mjs');
  process.exit(1);
}
if (!afwijkend) console.log('alles is bijgewerkt (' + teSchrijven.size + ' bestanden gecontroleerd)');
