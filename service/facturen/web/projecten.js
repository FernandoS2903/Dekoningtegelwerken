// JavaScript voor WEBSITE > Projecten. Zonder dit bestand werkt alles ook:
// de slug wordt dan op de server uit de titel gemaakt en de foto's gaan in
// één verzending mee. Dit script voegt toe:
//
//  1. de slug volgt de titel zolang je hem niet zelf hebt aangepast, met het
//     adres als voorbeeld eronder;
//  2. foto's uploaden één voor één, elk met een eigen voortgangsbalk en een
//     melding per foto; vooraf al een controle op type, grootte en aantal.

const MAX_BYTES = 15 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// -- 1. slug ---------------------------------------------------------------------
const titel = document.querySelector('[data-titel]');
const slug = document.querySelector('[data-slug]');
const slugVoorbeeld = document.querySelector('[data-slug-voorbeeld]');

function maakSlug(tekst) {
  return String(tekst || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' en ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

function toonSlug() {
  if (slugVoorbeeld) slugVoorbeeld.textContent = slug.value || maakSlug(titel?.value) || '…';
}

if (titel && slug) {
  titel.addEventListener('input', () => {
    if (slug.hasAttribute('data-slug-auto')) slug.value = maakSlug(titel.value);
    toonSlug();
  });
  slug.addEventListener('input', () => {
    slug.removeAttribute('data-slug-auto');
    toonSlug();
  });
}

// -- 2. upload ---------------------------------------------------------------------
const formulier = document.querySelector('form[data-upload]');

function grootte(bytes) {
  return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB' : Math.round(bytes / 1024) + ' kB';
}

function regel(lijst, bestand) {
  const li = document.createElement('li');
  li.className = 'upload__regel';
  const naam = document.createElement('span');
  naam.className = 'upload__naam';
  naam.textContent = `${bestand.name} (${grootte(bestand.size)})`;
  const balk = document.createElement('progress');
  balk.max = 100;
  balk.value = 0;
  balk.setAttribute('aria-label', `Voortgang ${bestand.name}`);
  const stand = document.createElement('span');
  stand.className = 'upload__stand';
  li.append(naam, balk, stand);
  lijst.append(li);
  return { li, balk, stand };
}

function controleer(bestand) {
  if (!TYPES.includes(bestand.type)) return 'Alleen JPEG, PNG of WebP.';
  if (bestand.size > MAX_BYTES) return 'Groter dan 15 MB.';
  return '';
}

function verstuur(actie, csrf, bestand, r) {
  return new Promise((klaar) => {
    const data = new FormData();
    data.append('_csrf', csrf);
    data.append('foto', bestand, bestand.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', actie);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.addEventListener('progress', (g) => {
      if (g.lengthComputable) r.balk.value = Math.round((g.loaded / g.total) * 90);
    });
    xhr.upload.addEventListener('load', () => { r.stand.textContent = 'Verwerken…'; });
    xhr.addEventListener('load', () => {
      let antwoord = {};
      try { antwoord = JSON.parse(xhr.responseText); } catch { /* geen json */ }
      const ok = xhr.status === 200 && antwoord.fotos?.length;
      r.balk.value = 100;
      r.li.classList.add(ok ? 'upload__regel--goed' : 'upload__regel--fout');
      r.stand.textContent = ok ? 'Toegevoegd'
        : (antwoord.fouten?.[0]?.melding || antwoord.fout || (xhr.status === 403 ? 'Sessie verlopen; laad de pagina opnieuw.' : 'Mislukt.'));
      klaar(!!ok);
    });
    xhr.addEventListener('error', () => {
      r.li.classList.add('upload__regel--fout');
      r.stand.textContent = 'Geen verbinding.';
      klaar(false);
    });
    xhr.send(data);
  });
}

if (formulier) {
  const invoer = formulier.querySelector('input[type="file"]');
  const lijst = formulier.querySelector('[data-upload-lijst]');
  const knop = formulier.querySelector('[data-upload-knop]');
  const max = Number(formulier.dataset.max) || 20;
  const csrf = formulier.querySelector('input[name="_csrf"]')?.value || '';

  invoer.addEventListener('change', () => {
    lijst.replaceChildren();
    const bestanden = [...invoer.files];
    for (const b of bestanden.slice(0, max)) {
      const r = regel(lijst, b);
      const fout = controleer(b);
      if (fout) {
        r.li.classList.add('upload__regel--fout');
        r.stand.textContent = fout;
      }
    }
    if (bestanden.length > max) {
      const li = document.createElement('li');
      li.className = 'upload__regel upload__regel--fout';
      li.textContent = `Je koos ${bestanden.length} foto's; de eerste ${max} gaan mee.`;
      lijst.append(li);
    }
  });

  formulier.addEventListener('submit', async (g) => {
    g.preventDefault();
    // Niet ook de algemene "één keer versturen" van dashboard.js.
    g.stopPropagation();
    const bestanden = [...invoer.files].slice(0, max);
    if (!bestanden.length) {
      invoer.focus();
      return;
    }
    knop.disabled = true;
    invoer.disabled = true;
    lijst.replaceChildren();
    let goed = 0;
    let fout = 0;
    for (const b of bestanden) {
      const r = regel(lijst, b);
      const melding = controleer(b);
      if (melding) {
        r.li.classList.add('upload__regel--fout');
        r.stand.textContent = melding;
        fout++;
        continue;
      }
      r.stand.textContent = 'Uploaden…';
      if (await verstuur(formulier.action, csrf, b, r)) goed++;
      else fout++;
    }
    const klaar = formulier.action.replace(/\/fotos$/, '');
    if (goed && !fout) {
      window.location.assign(klaar + '?m=geupload');
      return;
    }
    const li = document.createElement('li');
    li.className = 'upload__regel upload__samenvatting';
    li.textContent = `${goed} toegevoegd, ${fout} niet gelukt. `;
    if (goed) {
      const a = document.createElement('a');
      a.href = klaar;
      a.textContent = 'Toon de toegevoegde foto\'s';
      li.append(a);
    }
    lijst.append(li);
    knop.disabled = false;
    invoer.disabled = false;
    invoer.value = '';
  }, true);
}
