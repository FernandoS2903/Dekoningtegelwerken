// Schermen van WEBSITE > Projecten: het overzicht, nieuw/bewerken met de
// foto's, en de bevestiging bij verwijderen. Alles werkt zonder JavaScript;
// /projecten.js voegt de upload met voortgang en de automatische slug toe.

import { escapeHtml as e } from '../lib/hulp.mjs';
import { FILTERS } from '../../site/weergave.mjs';
import { FOTO_SOORTEN, GRENZEN } from '../lib/projecten-opslag.mjs';
import { MAX_BESTANDEN } from '../lib/beeldverwerking.mjs';
import { icoon, pagina } from './opmaak.mjs';
import { VERSIE } from './statisch.mjs';

const BASIS = '/website/projecten';
const CATEGORIE_LABELS = Object.fromEntries(FILTERS.slice(1));
const script = `<script src="/projecten.js?v=${VERSIE}" type="module"></script>`;

const datumNl = (iso) => {
  if (!iso) return '';
  const [j, m, d] = String(iso).slice(0, 10).split('-');
  return `${Number(d)}-${Number(m)}-${j}`;
};

const thumb = (f, breedte = 600) => {
  const w = String(f.varianten).split(',').map(Number).find((x) => x >= breedte) || Number(String(f.varianten).split(',')[0]);
  return `${BASIS}/beeld/${e(f.bestandsnaam)}-${w}.webp`;
};

function statusVlag(p) {
  return p.status === 'gepubliceerd'
    ? '<span class="vlag vlag--betaald">gepubliceerd</span>'
    : '<span class="vlag vlag--open">concept</span>';
}

// -- overzicht ------------------------------------------------------------------
export function overzichtPagina({ kader, projecten, filter, meldingen }) {
  const filters = [['alle', 'Alle'], ['gepubliceerd', 'Gepubliceerd'], ['concept', 'Concept']];
  const lijst = projecten.length ? `<ol class="projectlijst">
  ${projecten.map((p, i) => {
    const cover = p.fotos.find((f) => f.is_cover) || p.fotos[0];
    return `<li class="projectrij">
    <a class="projectrij__link" href="${BASIS}/${p.id}">
      ${cover ? `<img class="projectrij__beeld" src="${thumb(cover)}" alt="" width="96" height="72" loading="lazy">` : '<span class="projectrij__beeld projectrij__beeld--leeg" aria-hidden="true">geen foto</span>'}
      <span class="projectrij__tekst">
        <span class="projectrij__titel">${e(p.titel)}</span>
        <span class="projectrij__sub">${e([p.plaats, p.ruimte].filter(Boolean).join(' · ') || 'geen plaats')} · ${p.fotos.length} foto${p.fotos.length === 1 ? '' : "'s"}</span>
        <span class="projectrij__vlaggen">${statusVlag(p)}${p.uitgelicht ? '<span class="vlag vlag--uitgelicht">uitgelicht</span>' : ''}${p.voorbeeld ? '<span class="vlag vlag--rustig">voorbeeld</span>' : ''}</span>
      </span>
    </a>
    ${filter === 'alle' ? `<span class="projectrij__volgorde">
      <form method="post" action="${BASIS}/${p.id}/omhoog"><button class="knop knop--rustig knop--icoon" type="submit"${i === 0 ? ' disabled' : ''} aria-label="${e(p.titel)} omhoog">${icoon('omhoog')}</button></form>
      <form method="post" action="${BASIS}/${p.id}/omlaag"><button class="knop knop--rustig knop--icoon" type="submit"${i === projecten.length - 1 ? ' disabled' : ''} aria-label="${e(p.titel)} omlaag">${icoon('omlaag')}</button></form>
    </span>` : ''}
  </li>`;
  }).join('\n  ')}
</ol>` : `<p class="leeg">${filter === 'alle' ? 'Nog geen projecten. Maak het eerste project aan.' : 'Geen projecten met deze status.'}</p>`;

  const inhoud = `<p class="dashboard__uitleg">De projecten op dekoningtegelwerken.nl. Alleen gepubliceerde projecten staan op de site; de homepage toont de eerste zes uitgelichte, in deze volgorde.${filter === 'alle' ? '' : ' De volgorde wijzig je onder Alle.'}</p>
<div class="werkbalk">
  <nav class="filters" aria-label="Filteren op status">
    ${filters.map(([k, n]) => `<a href="${BASIS}/${k === 'alle' ? '' : '?status=' + k}"${k === filter ? ' aria-current="true"' : ''}>${n}</a>`).join('\n    ')}
  </nav>
</div>
${lijst}`;
  return pagina({
    titel: 'Projecten', inhoud, meldingen, kader, onderdeel: 'Projecten',
    kopActies: `<a class="knop" href="${BASIS}/nieuw">${icoon('plus')}<span>Nieuw project</span></a>`,
  });
}

// -- formulier ------------------------------------------------------------------
const fout = (fouten, veld) => (fouten[veld] ? `<span class="veldfout" id="fout-${veld}">${e(fouten[veld])}</span>` : '');
const beschreven = (fouten, veld, hint = false) => {
  const ids = [hint ? `hint-${veld}` : '', fouten[veld] ? `fout-${veld}` : ''].filter(Boolean).join(' ');
  return (ids ? ` aria-describedby="${ids}"` : '') + (fouten[veld] ? ' aria-invalid="true"' : '');
};

function tekstveld(naam, label, waarde, fouten, { hint = '', verplicht = false, type = 'text', extra = '' } = {}) {
  return `<p>
      <label for="v-${naam}">${e(label)}${verplicht ? '' : ' <span class="optioneel">(optioneel)</span>'}</label>
      <input type="${type}" id="v-${naam}" name="${naam}" value="${e(waarde ?? '')}"${GRENZEN[naam] ? ` maxlength="${GRENZEN[naam]}"` : ''}${verplicht ? ' required' : ''}${extra}${beschreven(fouten, naam, !!hint)}>
      ${hint ? `<span class="uitleg" id="hint-${naam}">${hint}</span>` : ''}${fout(fouten, naam)}
    </p>`;
}
function tekstvak(naam, label, waarde, fouten, { hint = '', rijen = 4 } = {}) {
  return `<p>
      <label for="v-${naam}">${e(label)} <span class="optioneel">(optioneel)</span></label>
      <textarea id="v-${naam}" name="${naam}" rows="${rijen}" maxlength="${GRENZEN[naam]}"${beschreven(fouten, naam, !!hint)}>${e(waarde ?? '')}</textarea>
      ${hint ? `<span class="uitleg" id="hint-${naam}">${hint}</span>` : ''}${fout(fouten, naam)}
    </p>`;
}

function projectFormulier({ p, fouten, nieuw }) {
  const cats = Array.isArray(p.categorieen) ? p.categorieen : String(p.categorieen || '').split(/\s+/);
  return `<form method="post" action="${nieuw ? `${BASIS}/nieuw` : `${BASIS}/${p.id}`}" class="projectform" novalidate>
  ${Object.keys(fouten).length ? `<div class="melding melding--fout" role="alert"><p>Niet opgeslagen: controleer de velden met een melding.</p></div>` : ''}
  <fieldset class="veldgroep veldgroep--zichtbaar">
    <legend>Zichtbaarheid</legend>
    <div class="keuzerij" role="radiogroup" aria-label="Status">
      <label class="keuzeknop"><input type="radio" name="status" value="concept"${p.status !== 'gepubliceerd' ? ' checked' : ''}><span>Concept</span><small>niet op de site</small></label>
      <label class="keuzeknop"><input type="radio" name="status" value="gepubliceerd"${p.status === 'gepubliceerd' ? ' checked' : ''}><span>Gepubliceerd</span><small>staat op de site</small></label>
    </div>
    <div class="schakel"><input type="checkbox" id="v-uitgelicht" name="uitgelicht" value="1"${p.uitgelicht ? ' checked' : ''}><label for="v-uitgelicht">Uitgelicht<span class="uitleg">Op de homepage (de eerste zes in de volgorde van het overzicht).</span></label></div>
    <div class="schakel"><input type="checkbox" id="v-voorbeeld" name="voorbeeld" value="1"${p.voorbeeld ? ' checked' : ''}><label for="v-voorbeeld">Voorbeeldproject<span class="uitleg">Krijgt het label "Voorbeeldkaart" en wordt niet geïndexeerd. Voor de oude voorbeeldprojecten; zet het uit bij een echt project.</span></label></div>
  </fieldset>

  <fieldset class="veldgroep">
    <legend>Project</legend>
    ${tekstveld('titel', 'Titel', p.titel, fouten, { verplicht: true, extra: ' data-titel' })}
    ${tekstveld('slug', 'Adres op de site', p.slug, fouten, {
    hint: `dekoningtegelwerken.nl/projecten/<strong data-slug-voorbeeld>${e(p.slug || '…')}</strong>/ · leeg laten maakt het uit de titel. Wijzig je het later, dan stuurt het oude adres door.`,
    extra: ` pattern="[a-z0-9]+(-[a-z0-9]+)*" data-slug${p.slug ? '' : ' data-slug-auto'} autocapitalize="off" spellcheck="false"`,
  })}
    ${tekstveld('plaats', 'Plaats', p.plaats, fouten, { hint: 'Alleen de plaatsnaam, bijvoorbeeld Haarlem. Nooit een adres of postcode van de klant.' })}
    ${tekstveld('ruimte', 'Ruimte of soort werk', p.ruimte, fouten, { hint: 'Bijvoorbeeld Badkamer of Tegelvloer; staat op de projectkaart naast de plaats.' })}
    <div class="categorieen" role="group" aria-labelledby="cat-kop">
      <p class="categorieen__kop" id="cat-kop">Categorieën <span class="optioneel">(voor de filters op de site)</span></p>
      ${Object.entries(CATEGORIE_LABELS).map(([k, l]) => `<label class="vinkje"><input type="checkbox" name="categorieen" value="${k}"${cats.includes(k) ? ' checked' : ''}><span>${e(l)}</span></label>`).join('')}
      ${fout(fouten, 'categorieen')}
    </div>
    ${tekstvak('korte_omschrijving', 'Korte omschrijving', p.korte_omschrijving, fouten, { rijen: 2, hint: 'Eén of twee zinnen onder de titel.' })}
    ${tekstvak('beschrijving', 'Beschrijving', p.beschrijving, fouten, { rijen: 8, hint: 'Een lege regel begint een nieuwe alinea.' })}
  </fieldset>

  <fieldset class="veldgroep">
    <legend>Projectgegevens</legend>
    ${tekstveld('soort_tegel', 'Soort tegel', p.soort_tegel, fouten)}
    ${tekstveld('formaat', 'Formaat', p.formaat, fouten, { hint: 'Bijvoorbeeld 120 × 60 cm.' })}
    ${tekstveld('werkzaamheden', 'Werkzaamheden', p.werkzaamheden, fouten)}
    ${tekstveld('bijzonderheden', 'Bijzonderheden', p.bijzonderheden, fouten)}
    ${tekstveld('datum', 'Datum', p.datum, fouten, { type: 'date', hint: 'Wanneer het werk klaar was; alleen voor jezelf.' })}
  </fieldset>

  <fieldset class="veldgroep">
    <legend>Zoekmachines</legend>
    ${tekstvak('meta_description', 'Meta description', p.meta_description, fouten, { rijen: 2, hint: 'Ongeveer 150 tekens; leeg = de korte omschrijving.' })}
  </fieldset>

  <div class="knoppen knoppen--plak"><button class="knop" type="submit">${nieuw ? 'Project aanmaken' : 'Opslaan'}</button><a class="knop knop--rustig" href="${BASIS}/">Annuleren</a></div>
</form>`;
}

export function nieuwPagina({ kader, p = {}, fouten = {} }) {
  return pagina({
    titel: 'Nieuw project', kader, onderdeel: 'Projecten',
    inhoud: `<p><a class="terug" href="${BASIS}/">${icoon('terug')}Alle projecten</a></p>
${projectFormulier({ p: { status: 'concept', ...p }, fouten, nieuw: true })}
<p class="uitleg">Foto's voeg je toe na het aanmaken.</p>${script}`,
  });
}

// -- foto's ----------------------------------------------------------------------
function fotoKaart(p, f, i, aantal) {
  const actie = (pad, label, ico, { bevestig = '', uit = false } = {}) => `<form method="post" action="${BASIS}/${p.id}/fotos/${f.id}/${pad}"${bevestig ? ` data-bevestig="${e(bevestig)}"` : ''}><button class="knop knop--rustig knop--klein" type="submit"${uit ? ' disabled' : ''}>${ico ? icoon(ico) : ''}<span>${e(label)}</span></button></form>`;
  return `<li class="fotokaart${f.is_cover ? ' fotokaart--cover' : ''}">
    <img class="fotokaart__beeld" src="${thumb(f)}" alt="" width="300" height="${Math.round((300 * f.hoogte) / f.breedte)}" loading="lazy">
    <div class="fotokaart__info">
      <p class="fotokaart__meta">${f.is_cover ? '<span class="vlag vlag--betaald">cover</span>' : ''}${f.sfeerbeeld ? '<span class="vlag vlag--rustig">sfeerbeeld</span>' : ''}<span>${f.breedte} × ${f.hoogte}</span></p>
      <form method="post" action="${BASIS}/${p.id}/fotos/${f.id}" class="fotokaart__form">
        <p><label for="alt-${f.id}">Alt-tekst</label><input type="text" id="alt-${f.id}" name="alt_tekst" value="${e(f.alt_tekst)}" maxlength="${GRENZEN.alt_tekst}" aria-describedby="alt-hint-${f.id}"><span class="uitleg" id="alt-hint-${f.id}">Wat er te zien is, voor schermlezers en zoekmachines.</span></p>
        <p><label for="soort-${f.id}">Soort</label><select id="soort-${f.id}" name="soort">${FOTO_SOORTEN.map(([k, l]) => `<option value="${k}"${f.soort === k ? ' selected' : ''}>${e(l)}</option>`).join('')}</select></p>
        <p><label for="bijschrift-${f.id}">Bijschrift <span class="optioneel">(bij een detail)</span></label><input type="text" id="bijschrift-${f.id}" name="bijschrift" value="${e(f.bijschrift)}" maxlength="${GRENZEN.bijschrift}"></p>
        <div class="knoppen"><button class="knop knop--klein" type="submit">Foto opslaan</button></div>
      </form>
      <div class="fotokaart__acties">
        ${f.is_cover ? '' : actie('cover', 'Maak cover', 'ster')}
        ${actie('omhoog', 'Eerder', 'omhoog', { uit: i === 0 })}
        ${actie('omlaag', 'Later', 'omlaag', { uit: i === aantal - 1 })}
        ${actie('verwijder', 'Verwijderen', 'prullenbak', { bevestig: 'Deze foto verwijderen? Dit kan niet ongedaan worden.' })}
      </div>
    </div>
  </li>`;
}

function fotoSectie(p) {
  return `<section class="paneel fotos" aria-labelledby="kop-fotos" id="fotos">
  <h2 id="kop-fotos">Foto's</h2>
  <form method="post" action="${BASIS}/${p.id}/fotos" enctype="multipart/form-data" class="upload" data-upload data-max="${MAX_BESTANDEN}">
    <label class="upload__vak" for="upload-invoer">
      ${icoon('foto')}
      <span class="upload__tekst"><strong>Foto's kiezen</strong><small>JPEG, PNG of WebP, tot 15 MB per foto, ${MAX_BESTANDEN} per keer. Locatie en andere gegevens uit de foto worden verwijderd.</small></span>
    </label>
    <input class="upload__invoer" id="upload-invoer" type="file" name="foto" accept="image/jpeg,image/png,image/webp" multiple required>
    <ul class="upload__lijst" data-upload-lijst aria-live="polite"></ul>
    <div class="knoppen"><button class="knop" type="submit" data-upload-knop>Uploaden</button></div>
  </form>
  ${p.fotos.length ? `<ol class="fotolijst">${p.fotos.map((f, i) => fotoKaart(p, f, i, p.fotos.length)).join('\n')}</ol>`
    : '<p class="leeg">Nog geen foto\'s. De eerste foto wordt de cover (kaart en grote foto bovenaan).</p>'}
  <p class="uitleg">Galerij: de foto's na de cover. Detail: close-ups met een bijschrift onderaan de pagina. Voor en na: samen een schuifvergelijking.</p>
</section>`;
}

export function bewerkPagina({ kader, p, fouten = {}, waarden = null, meldingen = [], voorbeeldUrl, siteUrl }) {
  const acties = `<a class="knop knop--rustig" href="${e(voorbeeldUrl)}" target="_blank" rel="noopener">${icoon('oog')}<span>Bekijk voorbeeld</span><span class="verborgen"> (opent in een nieuw tabblad)</span></a>
  ${p.status === 'gepubliceerd' ? `<a class="knop knop--rustig" href="${e(siteUrl)}" target="_blank" rel="noopener">${icoon('extern')}<span>Op de site</span><span class="verborgen"> (opent in een nieuw tabblad)</span></a>` : ''}`;
  const inhoud = `<p><a class="terug" href="${BASIS}/">${icoon('terug')}Alle projecten</a></p>
<p class="projectstatus">${statusVlag(p)} <span>Laatst gewijzigd ${e(datumNl(p.gewijzigd_op))}</span></p>
<div class="projectbewerk">
  <div class="projectbewerk__velden">
  ${projectFormulier({ p: waarden ? { ...p, ...waarden } : p, fouten, nieuw: false })}
  </div>
  <div class="projectbewerk__fotos">
  ${fotoSectie(p)}
  <section class="paneel paneel--gevaar" aria-labelledby="kop-verwijderen">
    <h2 id="kop-verwijderen">Verwijderen</h2>
    <p>Het project verdwijnt van de site en uit dit overzicht.</p>
    <p><a class="knop knop--let" href="${BASIS}/${p.id}/verwijderen">Project verwijderen</a></p>
  </section>
  </div>
</div>
<p class="uitleg">Voorbeeldlink: 24 uur geldig, ook voor een concept. <a href="${e(voorbeeldUrl)}" target="_blank" rel="noopener">Kopieer of open de link</a>.</p>${script}`;
  return pagina({ titel: p.titel, kader, onderdeel: 'Projecten', meldingen, kopActies: acties, inhoud });
}

export function verwijderPagina({ kader, p }) {
  return pagina({
    titel: 'Project verwijderen', kader, onderdeel: 'Projecten',
    inhoud: `<p><a class="terug" href="${BASIS}/${p.id}">${icoon('terug')}Terug naar het project</a></p>
<section class="paneel paneel--gevaar">
  <h2>${e(p.titel)} verwijderen?</h2>
  <p>Het project verdwijnt van de site (het adres geeft daarna "niet gevonden") en uit het overzicht. De slug komt vrij voor een nieuw project.</p>
  <form method="post" action="${BASIS}/${p.id}/verwijderen">
    <div class="knoppen"><button class="knop knop--let" type="submit">Ja, verwijderen</button><a class="knop knop--rustig" href="${BASIS}/${p.id}">Nee, terug</a></div>
  </form>
</section>`,
  });
}
