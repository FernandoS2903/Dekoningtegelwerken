// De velden van het aanvraagformulier op dekoningtegelwerken.nl/offerte/:
// controle van wat de wizard stuurt (dezelfde regels als js/wizard.js, maar
// dan aan de serverkant), de samenvatting in de vorm waarin De Koning hem
// wil lezen, en de omzetting naar het contract van Offerteknop
// (POST /api/aanvragen/website, 11 oktober 2026).
//
// Niets hier verzint een waarde: wat de bezoeker niet invulde, blijft leeg.

export const RUIMTES = ['badkamer', 'toilet', 'vloer', 'keuken', 'xxl', 'anders'];
export const MET_WAND = new Set(['badkamer', 'toilet', 'keuken', 'xxl']);
export const LABELS = { badkamer: 'Badkamer', toilet: 'Toilet', vloer: 'Vloer', keuken: 'Keuken', xxl: 'XXL-tegels', anders: 'Anders' };
export const TEGELSTATUS = ['ja', 'nee', 'orienteren'];
export const SOORTEN_BESTAND = ['fotos', 'tegelfoto', 'plattegrond'];
const SOORT_NAAM = { fotos: 'foto', tegelfoto: 'tegelfoto', plattegrond: 'plattegrond' };

const IS_EMAIL = /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/;
const IS_POSTCODE = /^(\d{4})\s?([A-Za-z]{2})$/;
const cijfers = (s) => String(s || '').replace(/\D/g, '');
const schoon = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[^\S\n]+/g, ' ').trim().slice(0, max);
const eenRegel = (v, max) => schoon(v, max).replace(/\s*\n\s*/g, ' ');

// Nederlands decimaal ("8,5") naar getal; null als het geen getal is.
export function getal(s) {
  const t = String(s ?? '').replace(/\s/g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
}

// `velden` is een Map<naam, string[]> uit de multipart-lezer (of een gewoon
// object met strings/arrays). Geeft {velden} of {fout, veld}.
export function valideer(invoer) {
  const alle = (naam) => {
    const v = invoer instanceof Map ? invoer.get(naam) : invoer[naam];
    return v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]).map((x) => String(x));
  };
  const een = (naam) => (alle(naam)[0] ?? '');
  const fout = (tekst, veld) => ({ fout: tekst, veld });

  const ruimtes = [...new Set(alle('ruimte').filter((r) => RUIMTES.includes(r)))];
  if (!ruimtes.length) return fout('Kies minstens één ruimte.', 'ruimte');
  if (alle('ruimte').some((r) => !RUIMTES.includes(r))) return fout('Onbekende ruimte.', 'ruimte');

  const anders = schoon(een('anders'), 600);
  if (ruimtes.includes('anders') && !anders) return fout('Vertel kort wat je wilt laten tegelen.', 'anders');

  const perRuimte = [];
  for (const r of ruimtes) {
    if (r === 'anders') { perRuimte.push({ soort: r, onbekend: true, m2_vloer: null, m2_wand: null, extra: [] }); continue; }
    const onbekend = een(`onbekend-${r}`) === 'ja';
    const lees = (naam) => {
      const n = getal(een(naam));
      if (n === null) return null;
      if (Number.isNaN(n) || !(n > 0 && n < 2000)) return NaN;
      return Math.round(n * 10) / 10;
    };
    const vloer = onbekend ? null : lees(`m2-${r}`);
    const wand = onbekend || !MET_WAND.has(r) ? null : lees(`wand-${r}`);
    if (Number.isNaN(vloer) || Number.isNaN(wand)) return fout('Vul een oppervlak in vierkante meters in, bijvoorbeeld 8 of 12,5.', Number.isNaN(vloer) ? `m2-${r}` : `wand-${r}`);
    if (!onbekend && vloer === null) return fout(`Vul het oppervlak van ${LABELS[r].toLowerCase()} in, of kies "Weet ik nog niet".`, `m2-${r}`);
    const extra = [...new Set(alle(`extra-${r}`).map((x) => eenRegel(x, 60)).filter(Boolean))].slice(0, 10);
    perRuimte.push({ soort: r, onbekend, m2_vloer: vloer, m2_wand: wand, extra });
  }

  const tegels = een('tegels');
  if (!TEGELSTATUS.includes(tegels)) return fout('Kies een van de drie mogelijkheden.', 'tegels');
  const formaten = tegels === 'nee' ? [] : [...new Set(alle('formaat').map((x) => eenRegel(x, 40)).filter(Boolean))].slice(0, 12);

  const naam = eenRegel(een('naam'), 120);
  if (naam.length < 2) return fout('Vul je naam in.', 'naam');
  const telefoon = eenRegel(een('telefoon'), 30);
  const email = eenRegel(een('email'), 120).toLowerCase();
  if (!telefoon && !email) return fout('Vul een telefoonnummer of e-mailadres in, zodat we je kunnen bereiken.', 'telefoon');
  if (telefoon && cijfers(telefoon).length < 10) return fout('Vul een telefoonnummer in, bijvoorbeeld 06 12345678.', 'telefoon');
  if (email && !IS_EMAIL.test(email)) return fout('Vul een geldig e-mailadres in.', 'email');
  const pc = IS_POSTCODE.exec(een('postcode').trim());
  if (!pc) return fout('Vul een postcode in zoals 1971 RA.', 'postcode');
  const postcode = `${pc[1]} ${pc[2].toUpperCase()}`;
  if (een('privacy') !== 'ja') return fout('Ga akkoord met de privacyverklaring om je aanvraag te versturen.', 'privacy');

  return {
    velden: {
      ruimtes: perRuimte,
      anders: ruimtes.includes('anders') ? anders : '',
      tegels: { status: tegels, formaten },
      periode: eenRegel(een('periode'), 60),
      toelichting: schoon(een('toelichting'), 1500),
      naam, telefoon, email, postcode,
      privacy_akkoord: true,
    },
  };
}

// Aantal links in vrije tekst, voor de spamcontrole.
export function aantalLinks(velden) {
  const tekst = [velden.toelichting, velden.anders].join(' ');
  return (tekst.match(/https?:\/\/|www\./gi) || []).length;
}

const fmt = (n) => n.toLocaleString('nl-NL', { maximumFractionDigits: 1 });

// Zelfde opbouw als samenvatting() in js/wizard.js:
//   Nieuwe aanvraag – Badkamer, 1971 RA
//   Badkamer: vloer ±8 m², wanden ±31 m² · Inloopdouche
export function samenvatting(velden, bestanden = []) {
  const regels = [];
  for (const r of velden.ruimtes) {
    if (r.soort === 'anders') { regels.push(['Anders', velden.anders]); continue; }
    const delen = [];
    if (!r.onbekend && r.m2_vloer > 0) delen.push(`vloer ±${fmt(r.m2_vloer)} m²`);
    if (!r.onbekend && r.m2_wand > 0) delen.push(`wanden ±${fmt(r.m2_wand)} m²`);
    if (!delen.length) delen.push('oppervlak nog onbekend');
    regels.push([LABELS[r.soort], delen.join(', ') + (r.extra.length ? ' · ' + r.extra.join(', ') : '')]);
  }
  const tegelStatus = { ja: 'al aangeschaft', nee: 'nog niet gekozen', orienteren: 'nog aan het oriënteren' }[velden.tegels.status] || '';
  const tegelfoto = bestanden.some((b) => b.soort === 'tegelfoto');
  regels.push(['Tegels', [velden.tegels.formaten.join(', '), tegelStatus].filter(Boolean).join(' · ') + (tegelfoto ? ' · foto van de tegel' : '')]);
  if (velden.periode) regels.push(['Gewenste periode', velden.periode]);
  const n = bestanden.filter((b) => b.soort === 'fotos').length;
  regels.push(['Bijlagen', `${n} ${n === 1 ? 'foto' : "foto's"}${bestanden.some((b) => b.soort === 'plattegrond') ? ' + plattegrond' : ''}`]);
  regels.push(['Naam', velden.naam]);
  if (velden.telefoon) regels.push(['Telefoon', velden.telefoon]);
  if (velden.email) regels.push(['E-mail', velden.email]);
  regels.push(['Postcode', velden.postcode]);
  if (velden.toelichting) regels.push(['Toelichting', velden.toelichting]);

  const titel = `Nieuwe aanvraag – ${velden.ruimtes.map((r) => LABELS[r.soort]).join(', ')}, ${velden.postcode}`;
  const tekst = [titel, '', ...regels.map(([k, w]) => `${k}: ${w}`)].join('\n');
  return { titel, regels, tekst };
}

// Grenzen van Offerteknop voor bijlagen (contract): maximaal 10 stuks, 8 MB
// per stuk, 20 MB samen, alleen jpeg, png, webp en pdf.
export const OFFERTEKNOP_BIJLAGEN = Object.freeze({ aantal: 10, perStuk: 8 * 1024 * 1024, samen: 20 * 1024 * 1024 });
const OFFERTEKNOP_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

// Welke bestanden meekunnen binnen `grenzen` en welke niet (met reden).
// Volgorde: eerst de tegelfoto en de plattegrond (elk hooguit één, en niet
// te missen), dan de foto's van de situatie in de volgorde van de bezoeker.
export function verdeelBijlagen(bestanden, grenzen = OFFERTEKNOP_BIJLAGEN, types = OFFERTEKNOP_TYPES) {
  const volgorde = { tegelfoto: 0, plattegrond: 1, fotos: 2 };
  const gesorteerd = [...bestanden].sort((a, b) => (volgorde[a.soort] ?? 9) - (volgorde[b.soort] ?? 9));
  const mee = [];
  const niet = [];
  let totaal = 0;
  for (const b of gesorteerd) {
    if (!types.has(b.type)) { niet.push({ ...b, reden: 'bestandstype niet toegestaan' }); continue; }
    if (b.grootte > grenzen.perStuk) { niet.push({ ...b, reden: `groter dan ${Math.round(grenzen.perStuk / 1024 / 1024)} MB` }); continue; }
    if (mee.length >= grenzen.aantal) { niet.push({ ...b, reden: `meer dan ${grenzen.aantal} bijlagen` }); continue; }
    if (totaal + b.grootte > grenzen.samen) { niet.push({ ...b, reden: `samen meer dan ${Math.round(grenzen.samen / 1024 / 1024)} MB` }); continue; }
    totaal += b.grootte;
    mee.push(b);
  }
  return { mee, niet };
}

export const nietMeegestuurdTekst = (niet) => (niet.length
  ? 'Niet meegestuurd: ' + niet.map((b) => `${b.naam} (${SOORT_NAAM[b.soort] || b.soort}, ${b.reden})`).join('; ')
  : '');

// Het JSON-object voor Offerteknop. `bijlagen` zijn de bestanden die meegaan,
// elk met inhoud_b64; `niet` wat erbuiten viel (komt in de toelichting).
export function naarContract(aanvraag, { bijlagen = [], niet = [] } = {}) {
  const v = aanvraag.velden;
  const toelichting = [v.toelichting, nietMeegestuurdTekst(niet)].filter(Boolean).join('\n\n').slice(0, 2000);
  const klant = { naam: v.naam, postcode: v.postcode, type: 'particulier' };
  if (v.email) klant.email = v.email;
  if (v.telefoon) klant.telefoon = v.telefoon;
  const project = {
    ruimtes: v.ruimtes.slice(0, 10).map((r) => {
      const uit = { soort: r.soort, onbekend: Boolean(r.onbekend), extra: r.extra || [] };
      if (r.m2_vloer != null) uit.m2_vloer = r.m2_vloer;
      if (r.m2_wand != null) uit.m2_wand = r.m2_wand;
      return uit;
    }),
    tegels: { status: v.tegels.status, formaten: v.tegels.formaten },
  };
  if (v.anders) project.anders = v.anders;
  if (v.periode) project.periode = v.periode;
  if (toelichting) project.toelichting = toelichting;
  return {
    referentie: aanvraag.referentie,
    ingediend_op: aanvraag.tijd,
    klant,
    project,
    bijlagen: bijlagen.map((b) => ({ soort: b.soort === 'fotos' ? 'foto' : b.soort, naam: b.naam, type: b.type, inhoud_b64: b.inhoud_b64 })),
    honeypot: '',
  };
}
