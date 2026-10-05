// Klein beetje JavaScript voor het factuurdashboard.
//
// De pagina's worden op de server gemaakt en werken zonder dit bestand: de
// formulieren versturen gewoon, de lijst en de filters zijn links. Dit script
// doet alleen twee dingen die in HTML niet kunnen:
//
//  1. breedtes zetten voor balkjes (zekerheid, top-leveranciers) — dat mag
//     niet als inline style vanwege de CSP, dus via setProperty;
//  2. om bevestiging vragen voordat er echt een mail de deur uit gaat.

document.documentElement.classList.add('js');

for (const el of document.querySelectorAll('[data-deel]')) {
  const deel = Number(el.dataset.deel);
  if (Number.isFinite(deel)) {
    el.style.setProperty('--deel', Math.min(100, Math.max(0, deel)) + '%');
  }
}

// Alles met data-bevestig vraagt eerst na. Doorsturen stuurt altijd echt een
// mail, ook opnieuw, dus daar staat het op.
for (const formulier of document.querySelectorAll('form[data-bevestig]')) {
  formulier.addEventListener('submit', (gebeurtenis) => {
    if (!window.confirm(formulier.dataset.bevestig)) gebeurtenis.preventDefault();
  });
}

// Het zoekveld verstuurt zijn formulier met Enter; de knop blijft voor wie
// liever tikt. Een leeg zoekveld haalt de parameter weg in plaats van hem
// leeg mee te sturen.
const zoekformulier = document.querySelector('form[data-zoek]');
if (zoekformulier) {
  zoekformulier.addEventListener('submit', () => {
    const veld = zoekformulier.querySelector('input[name="zoek"]');
    if (veld && !veld.value.trim()) veld.disabled = true;
  });
}
