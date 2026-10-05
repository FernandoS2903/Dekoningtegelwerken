// Eén plek voor het netwerkgedrag dat Graph, Claude en bunq delen:
// een time-out, en opnieuw proberen bij 429 en 5xx met respect voor
// Retry-After. `fetch` komt als argument mee, zodat de tests niets
// hoeven te onderscheppen.

export const HERHAALBAAR = new Set([429, 500, 502, 503, 504]);

export const slaap = (ms) => new Promise((klaar) => setTimeout(klaar, ms));

export class HttpFout extends Error {
  constructor(status, tekst, url) {
    // Een antwoordlichaam kan een token of een sleutel bevatten; daarom
    // knippen we het af en zetten het nooit in een logregel zonder nadenken.
    super(`${status} bij ${url}: ${String(tekst).slice(0, 300)}`);
    this.name = 'HttpFout';
    this.status = status;
    this.lichaam = tekst;
  }
}

// Doet het verzoek en geeft het Response-object terug zodra de status
// definitief is (dus niet meer herhaalbaar). Gooit HttpFout nooit zelf;
// dat doet de aanroeper, die weet wat een fout betekent.
export async function vraag(fetchFn, url, opties = {}, { pogingen = 3, timeoutMs = 30000, wacht = slaap } = {}) {
  let laatste;
  for (let poging = 1; poging <= pogingen; poging++) {
    let antwoord;
    try {
      antwoord = await fetchFn(url, { ...opties, signal: AbortSignal.timeout(timeoutMs) });
    } catch (fout) {
      laatste = fout;
      if (poging === pogingen) throw fout;
      await wacht(wachttijd(poging, null));
      continue;
    }

    if (!HERHAALBAAR.has(antwoord.status) || poging === pogingen) return antwoord;

    const naHeader = Number(antwoord.headers?.get?.('retry-after'));
    await wacht(wachttijd(poging, Number.isFinite(naHeader) && naHeader > 0 ? naHeader : null));
    laatste = antwoord;
  }
  return laatste;
}

// Retry-After in seconden als de server die geeft, anders 1, 2, 4 seconden.
function wachttijd(poging, naSeconden) {
  if (naSeconden !== null) return Math.min(naSeconden, 60) * 1000;
  return Math.min(2 ** (poging - 1), 8) * 1000;
}

export async function jsonOfFout(antwoord, url) {
  if (!antwoord || !antwoord.ok) {
    const tekst = antwoord ? await antwoord.text().catch(() => '') : 'geen antwoord';
    throw new HttpFout(antwoord ? antwoord.status : 0, tekst, url);
  }
  return antwoord.json();
}
