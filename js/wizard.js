// Offertewizard op /offerte/ (plan stap 2). Eén module zonder dependencies.
//
// - Zes stappen, één tegelijk; voortgang bovenaan, Terug/Volgende onderin
//   (op mobiel vast in de duimzone).
// - Vervolgvragen per gekozen ruimte via data-voor; verborgen velden tellen niet mee.
// - Antwoorden blijven in sessionStorage staan (herladen of terug verliest niets);
//   bestanden kunnen daar niet in en moeten na herladen opnieuw gekozen worden.
// - Uploads blijven in de browser. Miniaturen via canvas als data-URL, want de
//   CSP staat blob:-afbeeldingen niet toe.
// - Versturen: heeft het formulier data-endpoint (stap 3, backend), dan gaat de
//   aanvraag daarheen. Zo niet, dan wordt er niets verstuurd en krijgt de bezoeker
//   de samenvatting om zelf door te sturen. Er wordt nooit gedaan alsof iets
//   verstuurd is.

const $ = (sel, ouder = document) => ouder.querySelector(sel);
const $$ = (sel, ouder = document) => [...ouder.querySelectorAll(sel)];
const rustig = matchMedia('(prefers-reduced-motion: reduce)').matches;

const form = $('[data-wizard]');
if (form) initWizard(form);

function initWizard(form) {
  const stappen = $$('.wizard__stap', form);
  const totaal = stappen.length;
  const stapnr = $('[data-wizard-stapnr]', form);
  const balk = $('[data-wizard-balk]', form);
  const terug = $('[data-terug]', form);
  const volgende = $('[data-volgende]', form);
  const verstuur = $('[data-verstuur]', form);
  const klaar = $('[data-wizard-klaar]');
  const OPSLAG = 'dk-offerte';
  const bestanden = { fotos: [], tegelfoto: [], plattegrond: [] };
  let huidig = 0;

  vulPeriodes($('[data-periode]', form));

  /* -- opslaan en herstellen ------------------------------------------------ */
  const bewaar = () => {
    const data = {};
    for (const el of form.elements) {
      if (!el.name || el.type === 'file' || el.name === 'website') continue;
      if (el.type === 'checkbox' || el.type === 'radio') {
        if (el.checked) (data[el.name] ||= []).push(el.value);
      } else data[el.name] = el.value;
    }
    data._stap = huidig;
    try { sessionStorage.setItem(OPSLAG, JSON.stringify(data)); } catch { /* privémodus: niet erg */ }
  };
  const herstel = () => {
    let data;
    try { data = JSON.parse(sessionStorage.getItem(OPSLAG) || 'null'); } catch { data = null; }
    if (!data) return 0;
    for (const el of form.elements) {
      if (!el.name || !(el.name in data)) continue;
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = data[el.name].includes(el.value);
      else if (el.type !== 'file') el.value = data[el.name];
    }
    return Math.min(Number(data._stap) || 0, totaal - 1);
  };

  /* -- vervolgvragen ------------------------------------------------------- */
  const gekozenRuimtes = () => $$('input[name="ruimte"]:checked', form).map((el) => el.value);
  const werkZichtbaarheidBij = () => {
    const ruimtes = gekozenRuimtes();
    for (const blok of $$('[data-voor]', form)) {
      const aan = ruimtes.includes(blok.dataset.voor);
      blok.hidden = !aan;
      $$('input, textarea, select', blok).forEach((el) => { el.disabled = !aan; });
    }
    const tegels = $('input[name="tegels"]:checked', form)?.value;
    $('[data-tegels-meer]', form).hidden = !tegels || tegels === 'nee';
    $('[data-tegels-foto]', form).hidden = tegels !== 'ja';
    // "Weet ik nog niet" maakt de maatvelden van die ruimte leeg en inactief
    for (const vink of $$('[data-onbekend]', form)) {
      const blok = vink.closest('.maatblok');
      const onbekend = vink.checked && !vink.disabled;
      $$('[data-m2], [data-lengte], [data-breedte]', blok).forEach((el) => {
        if (vink.disabled) return;
        el.disabled = onbekend;
      });
    }
  };

  // lengte × breedte vult het vloeroppervlak in
  form.addEventListener('input', (e) => {
    const id = e.target.dataset.lengte || e.target.dataset.breedte;
    if (!id) return;
    const l = getal($(`[data-lengte="${id}"]`, form).value);
    const b = getal($(`[data-breedte="${id}"]`, form).value);
    if (l > 0 && b > 0) $(`[name="m2-${id}"]`, form).value = formatGetal(Math.round(l * b * 10) / 10);
  });

  form.addEventListener('change', () => { werkZichtbaarheidBij(); wisFout(); bewaar(); });
  form.addEventListener('input', () => bewaar());

  /* -- validatie per stap ------------------------------------------------- */
  const foutEl = () => $('[data-fout]', stappen[huidig]);
  const wisFout = () => {
    const el = foutEl();
    if (el) el.textContent = '';
    $$('[aria-invalid]', stappen[huidig]).forEach((x) => x.removeAttribute('aria-invalid'));
  };
  const fout = (tekst, veld) => {
    foutEl().textContent = tekst;
    if (veld) { veld.setAttribute('aria-invalid', 'true'); veld.focus(); }
    return false;
  };

  const controleer = (index) => {
    const stap = stappen[index];
    switch (Number(stap.dataset.stap)) {
      case 1: {
        if (!gekozenRuimtes().length) return fout('Kies minstens één ruimte.');
        const anders = $('[name="anders"]', form);
        if (!anders.disabled && !anders.value.trim()) return fout('Vertel kort wat je wilt laten tegelen.', anders);
        return true;
      }
      case 2: {
        for (const blok of $$('.maatblok:not([hidden])', stap)) {
          const vloer = $('[name^="m2-"]', blok);
          const onbekend = $('[data-onbekend]', blok).checked;
          for (const el of $$('[data-m2]', blok)) {
            if (el.disabled || !el.value.trim()) continue;
            const n = getal(el.value);
            if (!(n > 0 && n < 2000)) return fout('Vul een oppervlak in vierkante meters in, bijvoorbeeld 8 of 12,5.', el);
          }
          if (!onbekend && !vloer.value.trim()) {
            const naam = $('.maatblok__kop', blok).textContent;
            return fout(`Vul het oppervlak van ${naam.toLowerCase()} in, of kies "Weet ik nog niet".`, vloer);
          }
        }
        return true;
      }
      case 3:
        if (!$('input[name="tegels"]:checked', form)) return fout('Kies een van de drie mogelijkheden.');
        return true;
      case 6: {
        const naam = $('[name="naam"]', form);
        const tel = $('[name="telefoon"]', form);
        const mail = $('[name="email"]', form);
        const pc = $('[name="postcode"]', form);
        if (!naam.value.trim()) return fout('Vul je naam in.', naam);
        // telefoon óf e-mail is genoeg; wat wel is ingevuld, moet kloppen
        if (!tel.value.trim() && !mail.value.trim()) return fout('Vul een telefoonnummer of e-mailadres in, zodat we je kunnen bereiken.', tel);
        if (tel.value.trim() && cijfersVan(tel.value).length < 10) return fout('Vul een telefoonnummer in, bijvoorbeeld 06 12345678.', tel);
        if (mail.value.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail.value.trim())) return fout('Vul een geldig e-mailadres in.', mail);
        if (!/^\d{4}\s?[a-z]{2}$/i.test(pc.value.trim())) return fout('Vul een postcode in zoals 1971 RA.', pc);
        pc.value = pc.value.trim().toUpperCase().replace(/^(\d{4})\s?([A-Z]{2})$/, '$1 $2');
        const privacy = $('[name="privacy"]', form);
        if (!privacy.checked) return fout('Ga akkoord met de privacyverklaring om je aanvraag te versturen.', privacy);
        return true;
      }
      default:
        return true; // foto's en plattegrond zijn optioneel
    }
  };

  /* -- navigatie ------------------------------------------------------------ */
  const toon = (index, { focus = true } = {}) => {
    const vorige = huidig;
    huidig = index;
    stappen.forEach((s, i) => {
      s.hidden = i !== index;
      s.classList.toggle('wizard__stap--terug', i === index && index < vorige);
    });
    stapnr.textContent = `Stap ${index + 1} van ${totaal}`;
    balk.style.setProperty('--voortgang', `${((index + 1) / totaal) * 100}%`);
    terug.hidden = index === 0;
    volgende.hidden = index === totaal - 1;
    verstuur.hidden = index !== totaal - 1;
    // stap 4 en 5 zijn optioneel: de knop zegt dat eerlijk zolang er niets gekozen is
    const optioneel = { fotos: 3, plattegrond: 4 };
    const leeg = Object.entries(optioneel).some(([k, i]) => i === index && !bestanden[k].length);
    volgende.firstChild.textContent = leeg ? 'Overslaan ' : 'Volgende ';
    bewaar();
    if (focus) {
      const kop = $('.wizard__kop', stappen[index]);
      kop.focus({ preventScroll: true });
      const boven = form.getBoundingClientRect().top + scrollY - (parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0);
      if (scrollY > boven) scrollTo({ top: boven, behavior: rustig ? 'auto' : 'smooth' });
    }
  };

  volgende.addEventListener('click', () => {
    wisFout();
    if (controleer(huidig)) toon(huidig + 1);
  });
  terug.addEventListener('click', () => { wisFout(); toon(huidig - 1); });
  // Enter in een tekstveld gaat naar de volgende stap in plaats van het formulier te versturen
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input:not([type="checkbox"]):not([type="radio"])') && huidig < totaal - 1) {
      e.preventDefault();
      volgende.click();
    }
  });

  /* -- uploads -------------------------------------------------------------- */
  for (const blok of $$('[data-upload]', form)) initUpload(blok, bestanden, () => toon(huidig, { focus: false }));

  /* -- versturen ----------------------------------------------------------- */
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    wisFout();
    for (let i = 0; i < totaal; i++) {
      if (!controleer(i)) { toon(i); controleer(i); return; }
    }
    if ($('[name="website"]', form).value) return; // honingpot: bot
    const sv = samenvatting(form, bestanden);
    const endpoint = form.dataset.endpoint;
    if (endpoint) {
      verstuur.disabled = true;
      try {
        const fd = new FormData(form);
        for (const [k, lijst] of Object.entries(bestanden)) lijst.forEach((b) => fd.append(k, b.bestand, b.bestand.name));
        const antwoord = await fetch(endpoint, { method: 'POST', body: fd });
        if (!antwoord.ok) throw new Error(String(antwoord.status));
        try { sessionStorage.removeItem(OPSLAG); } catch { /* niets */ }
        return toonKlaar(sv, true);
      } catch {
        verstuur.disabled = false;
        // niet gelukt: niets kwijt, wel de handmatige route aanbieden
      }
    }
    toonKlaar(sv, false);
  });

  const toonKlaar = async (sv, verzonden) => {
    form.hidden = true;
    klaar.hidden = false;
    $('[data-klaar-verzonden]', klaar).hidden = !verzonden;
    $('[data-klaar-handmatig]', klaar).hidden = verzonden;
    $('[data-sv-titel]', klaar).textContent = sv.titel;
    $('[data-sv-lijst]', klaar).replaceChildren(...sv.regels.flatMap(([k, w]) => [
      Object.assign(document.createElement('dt'), { textContent: k }),
      Object.assign(document.createElement('dd'), { textContent: w }),
    ]));
    const kop = $(verzonden ? '[data-klaar-verzonden] [tabindex]' : '[data-klaar-handmatig] [tabindex]', klaar);
    kop.focus({ preventScroll: true });
    klaar.scrollIntoView({ behavior: rustig ? 'auto' : 'smooth', block: 'start' });
    if (!verzonden) await zetKanalen(sv.tekst);
  };

  $('[data-wijzig]', klaar).addEventListener('click', () => {
    klaar.hidden = true;
    form.hidden = false;
    toon(0);
  });
  $('[data-kopieer]', klaar).addEventListener('click', async () => {
    const status = $('[data-kopieer-status]', klaar);
    try {
      await navigator.clipboard.writeText(samenvatting(form, bestanden).tekst);
      status.textContent = 'Gekopieerd. Plak de samenvatting in een mail of bericht aan De Koning Tegelwerken.';
    } catch {
      status.textContent = 'Kopiëren lukte niet. Selecteer de samenvatting hierboven en kopieer die zelf.';
    }
  });

  werkZichtbaarheidBij();
  toon(herstel(), { focus: false });
  werkZichtbaarheidBij();
}

/* -- uploadcomponent -------------------------------------------------------- */
function initUpload(blok, bestanden, bijgewerkt) {
  const naam = blok.dataset.upload;
  const lijst = $('[data-upload-lijst]', blok);
  const status = $('[data-upload-status]', blok);
  const meerdere = naam === 'fotos';
  const max = meerdere ? Number(document.querySelector('[data-wizard]')?.dataset.maxFotos) || 12 : 1;
  const MAX_MB = 20;

  const teken = () => {
    lijst.replaceChildren(...bestanden[naam].map((b, i) => {
      const li = document.createElement('li');
      li.className = 'upload__item';
      if (b.miniatuur) {
        const img = Object.assign(document.createElement('img'), { src: b.miniatuur, alt: '', width: 96, height: 96 });
        li.append(img);
      } else {
        li.insertAdjacentHTML('beforeend', '<span class="upload__bestand"><svg class="icoon" aria-hidden="true"><use href="/assets/iconen/iconen.svg#plattegrond"/></svg></span>');
      }
      li.append(Object.assign(document.createElement('span'), { className: 'upload__naam', textContent: b.bestand.name }));
      const weg = document.createElement('button');
      weg.type = 'button';
      weg.className = 'upload__weg';
      weg.setAttribute('aria-label', `${b.bestand.name} verwijderen`);
      weg.innerHTML = '<svg class="icoon" aria-hidden="true"><use href="/assets/iconen/iconen.svg#prullenbak"/></svg>';
      weg.addEventListener('click', () => {
        bestanden[naam].splice(i, 1);
        teken();
        status.textContent = 'Verwijderd.';
        bijgewerkt();
      });
      li.append(weg);
      return li;
    }));
    blok.classList.toggle('upload--gevuld', bestanden[naam].length > 0);
  };

  for (const invoer of $$('[data-upload-invoer]', blok)) {
    invoer.addEventListener('change', async () => {
      const nieuw = [...invoer.files];
      invoer.value = '';
      const meldingen = [];
      for (const bestand of nieuw) {
        const isBeeld = bestand.type.startsWith('image/');
        const isPdf = bestand.type === 'application/pdf';
        if (!isBeeld && !(isPdf && naam === 'plattegrond')) { meldingen.push(`${bestand.name} is geen foto${naam === 'plattegrond' ? ' of PDF' : ''}.`); continue; }
        if (bestand.size > MAX_MB * 1024 * 1024) { meldingen.push(`${bestand.name} is groter dan ${MAX_MB} MB.`); continue; }
        if (!meerdere) bestanden[naam] = [];
        if (bestanden[naam].length >= max) { meldingen.push(`Maximaal ${max} foto's.`); break; }
        bestanden[naam].push({ bestand, miniatuur: isBeeld ? await miniatuur(bestand) : null });
      }
      teken();
      const n = bestanden[naam].length;
      status.textContent = meldingen.join(' ') || (meerdere ? `${n} ${n === 1 ? 'foto' : "foto's"} toegevoegd.` : 'Toegevoegd.');
      bijgewerkt();
    });
  }
}

/** Kleine vierkante JPEG-miniatuur als data-URL (geen blob: vanwege de CSP). */
async function miniatuur(bestand, maat = 192) {
  try {
    const bron = await createImageBitmap(bestand);
    const canvas = Object.assign(document.createElement('canvas'), { width: maat, height: maat });
    const kant = Math.min(bron.width, bron.height);
    canvas.getContext('2d').drawImage(bron, (bron.width - kant) / 2, (bron.height - kant) / 2, kant, kant, 0, 0, maat, maat);
    bron.close?.();
    return canvas.toDataURL('image/jpeg', 0.75);
  } catch {
    return null; // bijv. HEIC in een browser die dat niet kan tonen: dan alleen de naam
  }
}

/* -- samenvatting ------------------------------------------------------------- */
const LABELS = { badkamer: 'Badkamer', toilet: 'Toilet', vloer: 'Vloer', keuken: 'Keuken', xxl: 'XXL-tegels', anders: 'Anders' };

/**
 * Gestructureerde samenvatting zoals De Koning hem wil ontvangen, bijvoorbeeld:
 *   Nieuwe aanvraag – Badkamer, 1971 RA
 *   Badkamer: vloer ±8 m², wanden ±31 m² · Inloopdouche, Nis
 */
function samenvatting(form, bestanden) {
  const waarde = (n) => form.elements[n]?.value?.trim() || '';
  const gekozen = (n) => [...form.querySelectorAll(`[name="${n}"]:checked`)].filter((el) => !el.disabled).map((el) => el.value);
  const ruimtes = gekozen('ruimte');
  const regels = [];
  for (const r of ruimtes) {
    if (r === 'anders') { regels.push(['Anders', waarde('anders')]); continue; }
    const delen = [];
    const onbekend = gekozen(`onbekend-${r}`).length > 0;
    const vloer = getal(waarde(`m2-${r}`));
    const wand = getal(waarde(`wand-${r}`));
    if (!onbekend && vloer > 0) delen.push(`vloer ±${formatGetal(vloer)} m²`);
    if (!onbekend && wand > 0) delen.push(`wanden ±${formatGetal(wand)} m²`);
    if (!delen.length) delen.push('oppervlak nog onbekend');
    const extra = gekozen(`extra-${r}`);
    regels.push([LABELS[r] || r, delen.join(', ') + (extra.length ? ' · ' + extra.join(', ') : '')]);
  }
  const tegelStatus = { ja: 'al aangeschaft', nee: 'nog niet gekozen', orienteren: 'nog aan het oriënteren' }[gekozen('tegels')[0]] || '';
  const formaten = gekozen('formaat');
  regels.push(['Tegels', [formaten.join(', '), tegelStatus].filter(Boolean).join(' · ') + (bestanden.tegelfoto.length ? ' · foto van de tegel' : '')]);
  if (waarde('periode')) regels.push(['Gewenste periode', waarde('periode')]);
  const n = bestanden.fotos.length;
  regels.push(['Bijlagen', `${n} ${n === 1 ? 'foto' : "foto's"}${bestanden.plattegrond.length ? ' + plattegrond' : ''}`]);
  regels.push(['Naam', waarde('naam')]);
  if (waarde('telefoon')) regels.push(['Telefoon', waarde('telefoon')]);
  if (waarde('email')) regels.push(['E-mail', waarde('email')]);
  regels.push(['Postcode', waarde('postcode')]);
  if (waarde('toelichting')) regels.push(['Toelichting', waarde('toelichting')]);

  const titel = `Nieuwe aanvraag – ${ruimtes.map((r) => (r === 'anders' ? 'Anders' : LABELS[r])).join(', ')}${waarde('postcode') ? ', ' + waarde('postcode') : ''}`;
  const tekst = [titel, '', ...regels.map(([k, w]) => `${k}: ${w}`)].join('\n');
  return { titel, regels, tekst };
}

/** Kanalen voor de handmatige route, alleen als ze echt in data/site.json staan. */
async function zetKanalen(tekst) {
  let d = {};
  try { d = await (await fetch('/data/site.json', { cache: 'no-cache' })).json(); } catch { /* geen gegevens */ }
  const b = d.bedrijf || {};
  const zet = (soort, href) => {
    const a = document.querySelector(`[data-stuur="${soort}"]`);
    if (!a || !href) return;
    a.href = href;
    a.hidden = false;
    if (soort === 'whatsapp') { a.target = '_blank'; a.rel = 'noopener'; }
  };
  const onderwerp = tekst.split('\n')[0];
  if (b.whatsapp) zet('whatsapp', `https://wa.me/${cijfersVan(b.whatsapp)}?text=${encodeURIComponent(tekst)}`);
  if (b.email) zet('email', `mailto:${b.email}?subject=${encodeURIComponent(onderwerp)}&body=${encodeURIComponent(tekst)}`);
  if (b.telefoon) zet('telefoon', `tel:${b.telefoon.replace(/\s/g, '')}`);
}

/* -- hulpjes ------------------------------------------------------------------- */
function vulPeriodes(select) {
  if (!select) return;
  // de komende zes maanden, na "Zo snel mogelijk"
  const nu = new Date();
  const opties = Array.from({ length: 6 }, (_, i) => {
    const d = new Date(nu.getFullYear(), nu.getMonth() + i + 1, 1);
    const maand = d.toLocaleDateString('nl-NL', { month: 'long' });
    return d.getFullYear() === nu.getFullYear() ? maand : `${maand} ${d.getFullYear()}`;
  });
  const voor = select.options[2]; // vóór "Nog niet bekend"
  for (const m of opties) select.insertBefore(new Option(m.charAt(0).toUpperCase() + m.slice(1)), voor);
}
function getal(s) { return Number(String(s || '').replace(/\s/g, '').replace(',', '.')); }
function formatGetal(n) { return n.toLocaleString('nl-NL', { maximumFractionDigits: 1 }); }
function cijfersVan(s) { return String(s || '').replace(/[^\d]/g, ''); }
