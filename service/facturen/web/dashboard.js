// JavaScript voor het portaal. De pagina's komen van de server en werken
// zonder dit bestand: formulieren versturen gewoon, lijsten en filters zijn
// links. Dit script voegt toe wat in HTML niet kan:
//
//  1. breedtes voor balkjes (zekerheid, top-leveranciers) via setProperty,
//     omdat inline styles niet mogen van de CSP;
//  2. bevestiging vóór belangrijke acties (data-bevestig) en één keer
//     versturen: na het verzenden gaat de knop op disabled;
//  3. het sorteerveld past zich meteen toe;
//  4. een tooltip op de maandgrafiek;
//  5. op desktop het zijpaneel: een factuur uit de lijst opent naast de
//     lijst in plaats van op een nieuwe pagina. Formulieren in het paneel
//     worden via fetch verstuurd en het paneel laadt opnieuw; op mobiel en
//     zonder JS blijft het de gewone pagina.

document.documentElement.classList.add('js');

const DESKTOP = window.matchMedia('(min-width: 64em)');

function balkjes(wortel = document) {
  for (const el of wortel.querySelectorAll('[data-deel]')) {
    const deel = Number(el.dataset.deel);
    if (Number.isFinite(deel)) el.style.setProperty('--deel', Math.min(100, Math.max(0, deel)) + '%');
  }
}

// Bevestiging en dubbel verzenden voorkomen. Werkt voor de hele pagina én
// voor formulieren die later in het paneel komen (één luisteraar op document).
document.addEventListener('submit', (gebeurtenis) => {
  const formulier = gebeurtenis.target;
  if (!(formulier instanceof HTMLFormElement)) return;
  if (formulier.dataset.bevestig && !window.confirm(formulier.dataset.bevestig)) {
    gebeurtenis.preventDefault();
    return;
  }
  if (formulier.dataset.bezig === '1') {
    gebeurtenis.preventDefault();
    return;
  }
  formulier.dataset.bezig = '1';
  for (const knop of formulier.querySelectorAll('button[type="submit"], button:not([type])')) {
    knop.classList.add('bezig');
    knop.setAttribute('aria-disabled', 'true');
  }
  // Loopt het formulier via het paneel, dan zet dat hem zelf weer vrij.
  if (!formulier.closest('[data-zijpaneel]')) setTimeout(() => { formulier.dataset.bezig = ''; }, 8000);
});

// Het zoekveld verstuurt zijn formulier met Enter; een leeg veld haalt de
// parameter weg in plaats van hem leeg mee te sturen. Het sorteerveld past
// meteen toe.
for (const zoekformulier of document.querySelectorAll('form[data-zoek]')) {
  zoekformulier.addEventListener('submit', () => {
    for (const veld of zoekformulier.querySelectorAll('input[name="zoek"], select[name="sorteer"]')) {
      if (!veld.value.trim()) veld.disabled = true;
    }
  });
  const sorteer = zoekformulier.querySelector('select[data-direct]');
  if (sorteer) sorteer.addEventListener('change', () => zoekformulier.requestSubmit());
}

// -- grafiek: tooltip ----------------------------------------------------------
for (const vak of document.querySelectorAll('[data-grafiek]')) {
  const tip = vak.querySelector('.grafiek__tip');
  if (!tip) continue;
  let actief = null;
  const toon = (staaf) => {
    if (actief) actief.classList.remove('actief');
    actief = staaf;
    staaf.classList.add('actief');
    tip.textContent = '';
    const kop = document.createElement('strong');
    kop.textContent = staaf.dataset.maand;
    tip.append(kop, `${staaf.dataset.bedrag} · ${staaf.dataset.aantal} factu${staaf.dataset.aantal === '1' ? 'ur' : 'ren'}`);
    tip.style.setProperty('--tip-x', staaf.dataset.x + '%');
    tip.hidden = false;
  };
  const verberg = () => {
    if (actief) actief.classList.remove('actief');
    actief = null;
    tip.hidden = true;
  };
  for (const staaf of vak.querySelectorAll('.staaf')) {
    staaf.addEventListener('mouseenter', () => toon(staaf));
    staaf.addEventListener('focus', () => toon(staaf));
    staaf.addEventListener('mouseleave', verberg);
    staaf.addEventListener('blur', verberg);
  }
}

// -- zijpaneel -------------------------------------------------------------------
const paneel = document.querySelector('[data-zijpaneel]');
const lijstvak = document.querySelector('[data-lijst]');
// De URL van de lijst zelf; na pushState staat de factuur-URL in de adresbalk.
const lijstUrl = location.href.split('#')[0];

function paneelUrl(href) {
  const url = new URL(href, location.href);
  url.searchParams.set('deel', 'paneel');
  return url;
}

async function laadPaneel(href, { push = true } = {}) {
  if (!paneel) return false;
  paneel.hidden = false;
  document.body.classList.add('paneel-open');
  document.querySelector('[data-splits]')?.classList.add('splits');
  if (!paneel.children.length) paneel.innerHTML = '<p class="zijpaneel__laden">Laden…</p>';
  let antwoord;
  try {
    antwoord = await fetch(paneelUrl(href), { headers: { accept: 'text/html' }, credentials: 'same-origin' });
  } catch {
    location.href = href;
    return true;
  }
  if (!antwoord.ok) {
    location.href = href;
    return true;
  }
  paneel.innerHTML = await antwoord.text();
  balkjes(paneel);
  markeerActief(href);
  if (push) {
    const schoon = new URL(href, location.href);
    schoon.searchParams.delete('deel');
    history.pushState({ paneel: schoon.href }, '', schoon.href);
  }
  paneel.querySelector('.zijpaneel__kop h2')?.focus?.();
  return true;
}

function markeerActief(href) {
  const id = (String(href).match(/\/factuur\/(\d+)/) || [])[1];
  for (const rij of document.querySelectorAll('.rij.actief')) rij.classList.remove('actief');
  if (id) document.querySelector(`.rij[data-factuur="${id}"]`)?.classList.add('actief');
}

function sluitPaneel({ push = true } = {}) {
  if (!paneel || paneel.hidden) return;
  paneel.hidden = true;
  paneel.innerHTML = '';
  document.body.classList.remove('paneel-open');
  markeerActief('');
  if (push && history.state?.paneel) history.back();
}

// De lijst opnieuw ophalen na een actie in het paneel, zodat status en
// bedragen kloppen zonder de hele pagina te verversen.
async function ververs() {
  if (!document.querySelector('[data-lijst]')) return;
  try {
    const antwoord = await fetch(lijstUrl, { credentials: 'same-origin' });
    if (!antwoord.ok) return;
    const doc = new DOMParser().parseFromString(await antwoord.text(), 'text/html');
    const nieuw = doc.querySelector('[data-lijst]');
    const oud = document.querySelector('[data-lijst]');
    if (nieuw && oud) {
      oud.replaceWith(nieuw);
      balkjes(nieuw);
      markeerActief(history.state?.paneel || '');
    }
  } catch { /* dan blijft de oude lijst staan */ }
}

if (paneel) {
  // Klik op een factuur in de lijst (of in "Actie vereist") opent het paneel.
  document.addEventListener('click', (gebeurtenis) => {
    const link = gebeurtenis.target.closest('a[data-factuur]');
    if (!link || !DESKTOP.matches || gebeurtenis.metaKey || gebeurtenis.ctrlKey || gebeurtenis.button !== 0) return;
    gebeurtenis.preventDefault();
    laadPaneel(link.href);
  });

  // Sluiten: knop, Escape, of terug in de browser.
  document.addEventListener('click', (gebeurtenis) => {
    if (gebeurtenis.target.closest('[data-paneel-sluit]')) {
      gebeurtenis.preventDefault();
      sluitPaneel();
    }
  });
  document.addEventListener('keydown', (gebeurtenis) => {
    if (gebeurtenis.key === 'Escape') sluitPaneel();
  });
  window.addEventListener('popstate', (gebeurtenis) => {
    if (gebeurtenis.state?.paneel) laadPaneel(gebeurtenis.state.paneel, { push: false });
    else sluitPaneel({ push: false });
  });

  // Formulieren in het paneel: versturen via fetch, daarna het paneel en de
  // lijst verversen. De server antwoordt met een 303 naar de factuurpagina
  // (met de melding in de URL); die laden we als paneel.
  paneel.addEventListener('submit', async (gebeurtenis) => {
    const formulier = gebeurtenis.target;
    if (!(formulier instanceof HTMLFormElement) || formulier.method.toLowerCase() !== 'post') return;
    if (gebeurtenis.defaultPrevented) return;
    gebeurtenis.preventDefault();
    try {
      const antwoord = await fetch(formulier.action, {
        method: 'POST',
        body: new URLSearchParams(new FormData(formulier)),
        credentials: 'same-origin',
        redirect: 'follow',
      });
      if (!antwoord.ok) {
        // Een foutpagina (bijv. verlopen sessie): gewoon tonen.
        location.href = formulier.action;
        return;
      }
      await laadPaneel(antwoord.url, { push: false });
      await ververs();
    } catch {
      location.href = formulier.action;
    } finally {
      formulier.dataset.bezig = '';
    }
  });

  // Een deeplink ?factuur=ID op de lijstpagina opent het paneel meteen.
  const gevraagd = new URL(location.href).searchParams.get('factuur');
  if (gevraagd && DESKTOP.matches) {
    const link = document.querySelector(`.rij[data-factuur="${gevraagd}"]`);
    if (link) laadPaneel(link.href, { push: false });
  }
}

balkjes();
