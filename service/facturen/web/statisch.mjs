// Statische bestanden van het portaal en het factuurdashboard: css, js en
// de lettertypen van de site. Het portaal levert ze op de root uit, het losse
// dashboard onder zijn eigen prefix.

import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
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

export function stuurStatisch(res, pad) {
  const [bestand, type] = STATISCH[pad];
  if (!existsSync(bestand)) return stuurTekst(res, 404, 'Niet gevonden.');
  kop(res, 200, type, { 'cache-control': 'private, max-age=3600' });
  createReadStream(bestand).pipe(res);
  return undefined;
}
