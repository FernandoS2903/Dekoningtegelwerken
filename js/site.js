// Gedrag van de publieke site. Eén module zonder dependencies; elk onderdeel
// controleert eerst of zijn elementen op de pagina staan, zodat elke pagina
// alleen doet wat er op die pagina staat. Alle beweging staat uit bij
// prefers-reduced-motion. Zonder JavaScript blijft alle inhoud zichtbaar.

const html = document.documentElement;
html.classList.add('js');

const rustig = matchMedia('(prefers-reduced-motion: reduce)').matches;
const $ = (sel, ouder = document) => ouder.querySelector(sel);
const $$ = (sel, ouder = document) => [...ouder.querySelectorAll(sel)];

/* -- header: compact en vast na scrollen ---------------------------------- */
function initKop() {
  const kop = $('[data-kop]');
  if (!kop) return;
  const hero = $('[data-hero]');
  const sticky = $('[data-stickycta]');
  const geenSticky = document.body.hasAttribute('data-geen-sticky');

  let gepland = false;
  const bijwerken = () => {
    gepland = false;
    const y = window.scrollY;
    kop.classList.toggle('kop--vast', y > 24);
    if (sticky && !geenSticky) {
      // op de homepage pas na de hero, elders na een stukje scrollen
      const drempel = hero ? hero.offsetHeight * 0.6 : 240;
      sticky.classList.toggle('zichtbaar', y > drempel);
    }
  };
  window.addEventListener('scroll', () => {
    if (!gepland) { gepland = true; requestAnimationFrame(bijwerken); }
  }, { passive: true });
  bijwerken();
  // Zolang iemand een veld invult, staat de balk niet over het formulier.
  if (sticky) {
    const isVeld = (el) => el?.matches?.('input:not([type="checkbox"]):not([type="radio"]), textarea, select');
    document.addEventListener('focusin', (e) => { if (isVeld(e.target)) sticky.classList.add('invoer'); });
    document.addEventListener('focusout', (e) => { if (isVeld(e.target)) sticky.classList.remove('invoer'); });
  }
}

/* -- desktopnavigatie: uitklapmenu Diensten ------------------------------- */
function initNavGroep() {
  for (const groep of $$('[data-nav-groep]')) {
    const knop = $('.nav-trigger', groep);
    const zet = (open) => {
      groep.classList.toggle('open', open);
      knop.setAttribute('aria-expanded', String(open));
    };
    knop.addEventListener('click', () => zet(!groep.classList.contains('open')));
    if (matchMedia('(hover: hover) and (pointer: fine)').matches) {
      let timer;
      groep.addEventListener('mouseenter', () => { clearTimeout(timer); zet(true); });
      groep.addEventListener('mouseleave', () => { timer = setTimeout(() => zet(false), 160); });
    }
    groep.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && groep.classList.contains('open')) { zet(false); knop.focus(); }
    });
    groep.addEventListener('focusout', (e) => {
      if (!groep.contains(e.relatedTarget)) zet(false);
    });
    document.addEventListener('click', (e) => { if (!groep.contains(e.target)) zet(false); });
  }
}

/* -- mobiel menu: volledig scherm met focus-trap -------------------------- */
function initMobielMenu() {
  const menu = $('#mobielmenu');
  const open = $('[data-menu-open]');
  if (!menu || !open) return;
  const sluit = $('[data-menu-sluit]', menu);

  const focusbaar = () => $$('a[href], button:not([disabled]), summary', menu).filter((el) => el.offsetParent !== null);
  // Openen: direct tonen (CSS-animatie bij verschijnen). Sluiten: eerst de
  // uitgaande animatie, dan pas hidden. Achtergrond scrollt niet mee zolang het open is.
  let sluitTimer;
  const zet = (isOpen) => {
    clearTimeout(sluitTimer);
    open.setAttribute('aria-expanded', String(isOpen));
    document.documentElement.classList.toggle('menu-open', isOpen);
    if (isOpen) {
      menu.classList.remove('mobielmenu--sluit');
      menu.hidden = false;
      sluit.focus();
    } else {
      menu.classList.add('mobielmenu--sluit');
      sluitTimer = setTimeout(() => { menu.hidden = true; menu.classList.remove('mobielmenu--sluit'); }, rustig ? 0 : 200);
      open.focus();
    }
  };
  open.addEventListener('click', () => zet(true));
  sluit.addEventListener('click', () => zet(false));
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { zet(false); return; }
    if (e.key !== 'Tab') return;
    const lijst = focusbaar();
    const eerste = lijst[0];
    const laatste = lijst[lijst.length - 1];
    if (e.shiftKey && document.activeElement === eerste) { e.preventDefault(); laatste.focus(); }
    else if (!e.shiftKey && document.activeElement === laatste) { e.preventDefault(); eerste.focus(); }
  });
  // een link naar een anker op dezelfde pagina (Werkwijze, Over ons) sluit het menu
  menu.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a && a.pathname === location.pathname && a.hash) {
      menu.hidden = true;
      open.setAttribute('aria-expanded', 'false');
      document.documentElement.classList.remove('menu-open');
    }
  });
  // breder dan het menu-breakpoint: menu dicht
  matchMedia('(min-width: 64em)').addEventListener('change', (e) => { if (e.matches && !menu.hidden) zet(false); });
}

/* -- reveal bij scrollen --------------------------------------------------- */
function initReveal() {
  const items = $$('.reveal, [data-tijdlijn]');
  if (!items.length) return;
  if (rustig || !('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  // Wat bij het laden al in beeld staat, krijgt meteen .in (in dezelfde taak
  // als html.js, dus vóór de eerste paint): geen knipperen bovenaan de pagina.
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
  for (const el of items) {
    if (el.getBoundingClientRect().top < innerHeight) el.classList.add('in');
    else io.observe(el);
  }
}

/* -- projectfilters -------------------------------------------------------- */
/** Vormen voor het asymmetrische grid; spiegelt vormen() in service/cli/genereer.mjs. */
function vormen(aantal) {
  const cyclus = ['groot', 'staand', 'staand-hoog', 'groot-laag'];
  const uit = Array.from({ length: aantal }, (_, i) => cyclus[i % cyclus.length]);
  if (aantal % 2 === 1) uit[aantal - 1] = 'breed';
  return uit;
}

function initFilters() {
  for (const groep of $$('.filters')) {
    const grid = groep.parentElement.querySelector('[data-projectgrid]');
    const status = groep.parentElement.querySelector('[data-filter-status]');
    if (!grid) continue;
    const kaarten = $$('.projectkaart', grid);
    const knoppen = $$('[data-filter]', groep);

    const kies = (filter) => {
      knoppen.forEach((k) => k.setAttribute('aria-pressed', String(k.dataset.filter === filter)));
      const zichtbaar = kaarten.filter((k) => filter === 'alles' || k.dataset.categorie.split(' ').includes(filter));
      kaarten.forEach((k) => { k.hidden = !zichtbaar.includes(k); });
      vormen(zichtbaar.length).forEach((v, i) => { zichtbaar[i].dataset.vorm = v; zichtbaar[i].classList.add('in'); });
      if (status) {
        status.classList.toggle('visueel-verborgen', zichtbaar.length > 0);
        status.textContent = zichtbaar.length
          ? zichtbaar.length + (zichtbaar.length === 1 ? ' project' : ' projecten') + ' zichtbaar.'
          : 'Nog geen projecten in deze categorie.';
      }
    };
    knoppen.forEach((k) => k.addEventListener('click', () => kies(k.dataset.filter)));
  }
}

/* -- detailsectie: één item open, desktopfoto wisselt mee ------------------ */
function initDetails() {
  const blok = $('[data-details]');
  if (!blok) return;
  const tabs = $$('.details__tab', blok);
  const paneel = $('[data-details-paneel]', blok);

  const open = (index) => {
    tabs.forEach((tab, i) => {
      const isOpen = i === index;
      tab.setAttribute('aria-expanded', String(isOpen));
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !isOpen;
    });
    if (paneel) {
      const bron = $('.details__foto-mobiel', document.getElementById(tabs[index].getAttribute('aria-controls')));
      if (bron) {
        const kopie = bron.cloneNode(true);
        kopie.classList.remove('details__foto-mobiel');
        const veeg = Object.assign(document.createElement('p'), { className: 'details__veeg', textContent: `Detail ${index + 1} van ${tabs.length} · veeg voor het volgende` });
        veeg.setAttribute('aria-hidden', 'true');
        paneel.replaceChildren(kopie, veeg);
      }
    }
    huidig = index;
  };
  let huidig = 0;
  tabs.forEach((tab, i) => tab.addEventListener('click', () => open(i)));
  // Mobiel: horizontaal vegen over de grote foto bladert door de details.
  if (paneel) {
    let startX = null;
    paneel.addEventListener('pointerdown', (e) => { startX = e.clientX; });
    paneel.addEventListener('pointerup', (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) > 50) open((huidig + (dx < 0 ? 1 : -1) + tabs.length) % tabs.length);
    });
    paneel.addEventListener('pointercancel', () => { startX = null; });
  }
  open(0);
}

/* -- voor/na-slider -------------------------------------------------------- */
function initVoorNa() {
  for (const slider of $$('[data-voorna]')) {
    const invoer = $('.voorna__invoer', slider);
    const zet = (pct) => {
      const p = Math.max(0, Math.min(100, pct));
      slider.style.setProperty('--pos', p + '%');
      invoer.value = String(Math.round(p));
    };
    const vanPointer = (e) => {
      const r = slider.getBoundingClientRect();
      zet(((e.clientX - r.left) / r.width) * 100);
    };
    let actief = false;
    slider.addEventListener('pointerdown', (e) => {
      actief = true;
      slider.setPointerCapture(e.pointerId);
      vanPointer(e);
      invoer.focus({ preventScroll: true });
    });
    slider.addEventListener('pointermove', (e) => { if (actief) vanPointer(e); });
    const stop = () => { actief = false; };
    slider.addEventListener('pointerup', stop);
    slider.addEventListener('pointercancel', stop);
    // vangnet: een sleepactie van de browser (foto) zou de pointer afbreken
    slider.addEventListener('dragstart', (e) => e.preventDefault());
    invoer.addEventListener('input', () => zet(Number(invoer.value)));
    zet(50);
  }
}

/* -- lichtbak voor de projectgalerij --------------------------------------- */
// Zonder JS opent elke foto gewoon als bestand; met JS in een <dialog> met
// vorige/volgende, pijltjestoetsen, vegen en Escape (native bij showModal).
function initLichtbak() {
  const links = $$('[data-lichtbak]');
  if (!links.length || typeof HTMLDialogElement !== 'function') return;
  const ico = (naam) => `<svg class="icoon" aria-hidden="true"><use href="/assets/iconen/iconen.svg#${naam}"/></svg>`;
  const dlg = document.createElement('dialog');
  dlg.className = 'lichtbak';
  dlg.setAttribute('aria-label', 'Foto groot bekijken');
  dlg.innerHTML = `<img class="lichtbak__beeld" alt="">`
    + `<p class="lichtbak__teller" aria-live="polite"></p>`
    + `<button class="lichtbak__knop lichtbak__vorige" type="button" aria-label="Vorige foto">${ico('pijl')}</button>`
    + `<button class="lichtbak__knop lichtbak__volgende" type="button" aria-label="Volgende foto">${ico('pijl')}</button>`
    + `<button class="lichtbak__knop lichtbak__sluit" type="button" aria-label="Sluiten">${ico('sluiten')}</button>`;
  document.body.append(dlg);
  const img = $('.lichtbak__beeld', dlg);
  const teller = $('.lichtbak__teller', dlg);
  const meer = links.length > 1;
  $('.lichtbak__vorige', dlg).hidden = !meer;
  $('.lichtbak__volgende', dlg).hidden = !meer;

  let huidig = 0;
  const toon = (n) => {
    huidig = (n + links.length) % links.length;
    const a = links[huidig];
    img.src = a.href;
    img.alt = $('img', a)?.alt || '';
    teller.textContent = meer ? `${huidig + 1} / ${links.length}` : '';
  };
  links.forEach((a, n) => a.addEventListener('click', (e) => {
    e.preventDefault();
    toon(n);
    dlg.showModal();
  }));
  $('.lichtbak__vorige', dlg).addEventListener('click', () => toon(huidig - 1));
  $('.lichtbak__volgende', dlg).addEventListener('click', () => toon(huidig + 1));
  $('.lichtbak__sluit', dlg).addEventListener('click', () => dlg.close());
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') toon(huidig - 1);
    if (e.key === 'ArrowRight') toon(huidig + 1);
  });
  // klik naast de foto sluit; horizontaal vegen bladert
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  let startX = null;
  dlg.addEventListener('pointerdown', (e) => { startX = e.clientX; });
  dlg.addEventListener('pointerup', (e) => {
    if (startX === null || !meer) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 50) toon(huidig + (dx < 0 ? 1 : -1));
  });
  dlg.addEventListener('close', () => links[huidig].focus({ preventScroll: true }));
}

/* -- bedrijfsgegevens en vertrouwenselementen uit data/site.json ----------- */
const cijfers = (s) => String(s || '').replace(/[^\d]/g, '');

function waardeVoor(veld, d) {
  const b = d.bedrijf || {};
  const v = d.vertrouwen || {};
  switch (veld) {
    case 'telefoon': return b.telefoon ? { tekst: b.telefoonWeergave || b.telefoon, href: 'tel:' + b.telefoon.replace(/\s/g, '') } : null;
    case 'email': return b.email ? { tekst: b.email, href: 'mailto:' + b.email } : null;
    case 'whatsapp': return b.whatsapp
      ? { tekst: b.whatsapp, href: 'https://wa.me/' + cijfers(b.whatsapp) + '?text=' + encodeURIComponent(d.whatsappTekst || '') }
      : null;
    case 'googleProfielUrl': return v.googleProfielUrl ? { tekst: v.googleProfielUrl, href: v.googleProfielUrl } : null;
    default: return b[veld] ? { tekst: b[veld] } : null;
  }
}

function vulVelden(d) {
  const tonen = d.placeholdersTonen !== false;
  const velden = new Set($$('[data-veld], [data-ph]').map((el) => el.dataset.veld || el.dataset.ph));
  for (const veld of velden) {
    const w = waardeVoor(veld, d);
    for (const el of $$(`[data-veld="${veld}"]`)) {
      if (w) {
        if (!el.hasAttribute('data-veld-tekst')) el.textContent = w.tekst;
        if (w.href && el.tagName === 'A') {
          el.href = w.href;
          if (/^https?:/.test(w.href)) { el.target = '_blank'; el.rel = 'noopener'; }
        }
      } else if (!tonen) {
        (el.closest(`[data-veld-blok="${veld}"]`) || el).remove();
      }
    }
    if (w) $$(`[data-ph="${veld}"]`).forEach((el) => el.remove());
    else if (!tonen) $$(`[data-veld-blok="${veld}"]`).forEach((el) => el.remove());
  }
}

function telOp(el, doel) {
  if (rustig || !('IntersectionObserver' in window)) { el.textContent = String(doel); return; }
  el.textContent = '0';
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    const start = performance.now();
    const duur = 1400;
    const stap = (nu) => {
      const t = Math.min(1, (nu - start) / duur);
      el.textContent = String(Math.round(doel * (1 - Math.pow(1 - t, 3))));
      if (t < 1) requestAnimationFrame(stap);
    };
    requestAnimationFrame(stap);
  });
  io.observe(el);
}

function vulVertrouwen(d) {
  const lijst = $('[data-vertrouwen]');
  if (!lijst) return;
  const v = d.vertrouwen || {};
  const items = [];
  const jaren = v.ervaringSinds ? new Date().getFullYear() - Number(v.ervaringSinds) : Number(v.jarenErvaring);
  if (Number.isFinite(jaren) && jaren > 0) {
    const li = document.createElement('li');
    li.innerHTML = '<strong><span data-telop></span>+ jaar</strong> ervaring';
    telOp($('[data-telop]', li), jaren);
    items.push(li);
  }
  const score = Number(v.googleScore);
  if (Number.isFinite(score) && score > 0) {
    const li = document.createElement('li');
    const aantal = Number(v.googleAantalReviews);
    li.innerHTML = '<span class="sterren" aria-hidden="true">★★★★★</span>';
    li.append(Object.assign(document.createElement('strong'), { textContent: score.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }));
    li.append(' op Google' + (Number.isFinite(aantal) && aantal > 0 ? ' (' + aantal + ' reviews)' : ''));
    items.push(li);
  }
  if (v.regio) {
    const li = document.createElement('li');
    li.append('Werkzaam in ', Object.assign(document.createElement('strong'), { textContent: v.regio }));
    items.push(li);
  }
  if (items.length) { lijst.replaceChildren(...items); lijst.hidden = false; }
}

const sterrenSpan = () => {
  const span = Object.assign(document.createElement('span'), { className: 'sterren', textContent: '★★★★★' });
  span.setAttribute('aria-hidden', 'true');
  return span;
};

/** Google-score boven de reviews: "4,8 ★★★★★ 23 reviews op Google". */
function vulReviewScore(d) {
  const el = $('[data-reviews-score]');
  const v = d.vertrouwen || {};
  const score = Number(v.googleScore);
  if (!el || !Number.isFinite(score) || score <= 0) return;
  const aantal = Number(v.googleAantalReviews);
  el.replaceChildren(
    Object.assign(document.createElement('strong'), { textContent: score.toLocaleString('nl-NL', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) }),
    sterrenSpan(),
    Number.isFinite(aantal) && aantal > 0 ? aantal + ' reviews op Google' : 'op Google',
  );
  el.hidden = false;
}

function vulReviews(d) {
  const sectie = $('[data-reviews-sectie]');
  if (!sectie) return;
  const reviews = (Array.isArray(d.reviews) ? d.reviews : []).filter((r) => r && r.tekst && r.naam);
  if (!reviews.length) {
    if (d.placeholdersTonen === false) sectie.remove();
    return;
  }
  const lijst = $('[data-reviews-lijst]', sectie);
  lijst.replaceChildren(...reviews.slice(0, 3).map((r) => {
    const li = document.createElement('li');
    li.className = 'review';
    const sterren = Math.max(1, Math.min(5, Math.round(Number(r.sterren) || 5)));
    li.innerHTML = '<div class="review__sterren" role="img"></div><blockquote></blockquote><p class="review__wie"><strong></strong></p>';
    const st = $('.review__sterren', li);
    st.setAttribute('aria-label', sterren + ' van de 5 sterren');
    st.innerHTML = '<svg class="icoon" aria-hidden="true"><use href="/assets/iconen/iconen.svg#ster"/></svg>'.repeat(sterren);
    $('blockquote', li).textContent = r.tekst;
    $('strong', li).textContent = r.naam;
    const wie = $('.review__wie', li);
    if (r.projecttype) wie.append(' · ' + r.projecttype);
    if (r.bron) {
      const a = Object.assign(document.createElement('a'), { href: r.bron, textContent: 'op Google', target: '_blank', rel: 'noopener' });
      wie.append(' · ', a);
    }
    return li;
  }));
  lijst.hidden = false;
  $('[data-reviews-placeholder]', sectie)?.remove();
}

async function initSiteGegevens() {
  if (!$('[data-veld], [data-ph], [data-vertrouwen], [data-reviews-sectie], [data-alleen-preview]')) return;
  let d;
  try {
    const antwoord = await fetch('/data/site.json', { cache: 'no-cache' });
    if (!antwoord.ok) return;
    d = await antwoord.json();
  } catch {
    return; // geen gegevens: placeholders blijven staan, vertrouwenselementen weg
  }
  vulVelden(d);
  vulVertrouwen(d);
  vulReviewScore(d);
  vulReviews(d);
  // Instructieblokken voor De Koning (bijv. "kort verhaal van de eigenaar") niet op de live site.
  if (d.placeholdersTonen === false) $$('[data-alleen-preview]').forEach((el) => el.remove());
}

initKop();
initNavGroep();
initMobielMenu();
initReveal();
initFilters();
initDetails();
initVoorNa();
initLichtbak();
initSiteGegevens();
