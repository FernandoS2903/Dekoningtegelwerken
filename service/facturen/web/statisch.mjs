// Statische bestanden van het portaal en het factuurdashboard: css, js en
// de lettertypen van de site. Het portaal levert ze op de root uit, het losse
// dashboard onder zijn eigen prefix.

import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { kop, stuurTekst } from '../lib/web.mjs';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HIER, '..', '..', '..');

export const STATISCH = {
  '/dashboard.css': [path.join(HIER, 'dashboard.css'), 'text/css; charset=utf-8'],
  '/dashboard.js': [path.join(HIER, 'dashboard.js'), 'text/javascript; charset=utf-8'],
  // De lettertypen van de site hergebruiken we; ze staan in de repo-kopie
  // naast de dienst en worden alleen gelezen.
  '/fonts/fraunces-latin-opsz-wght.woff2': [path.join(REPO, 'assets/fonts/fraunces-latin-opsz-wght.woff2'), 'font/woff2'],
  '/fonts/inter-latin-wght.woff2': [path.join(REPO, 'assets/fonts/inter-latin-wght.woff2'), 'font/woff2'],
  // Het paarse origineel, overal hetzelfde (besluit Bob, 4 okt 2026).
  '/logo.svg': [path.join(REPO, 'assets/brand/logo.svg'), 'image/svg+xml'],
};

// Versie van css en js, afgeleid van de inhoud: de pagina's linken naar
// /dashboard.css?v=<versie>, zodat een browser na een uitrol nooit een oude
// stylesheet uit zijn cache blijft gebruiken.
export const VERSIE = (() => {
  const h = crypto.createHash('sha256');
  for (const pad of ['/dashboard.css', '/dashboard.js']) {
    try { h.update(readFileSync(STATISCH[pad][0])); } catch { /* ontbreekt: dan telt hij niet mee */ }
  }
  return h.digest('hex').slice(0, 10);
})();

export function stuurStatisch(res, pad, { versie = null } = {}) {
  const [bestand, type] = STATISCH[pad];
  if (!existsSync(bestand)) return stuurTekst(res, 404, 'Niet gevonden.');
  // Met het juiste versienummer mag de browser lang cachen; zonder kort.
  const lang = versie === VERSIE && (pad.endsWith('.css') || pad.endsWith('.js'));
  kop(res, 200, type, { 'cache-control': lang ? 'private, max-age=31536000, immutable' : 'private, max-age=300' });
  createReadStream(bestand).pipe(res);
  return undefined;
}
