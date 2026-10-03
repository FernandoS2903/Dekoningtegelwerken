#!/usr/bin/env bash
# Zet main van dekoning-tegelwerken live in /var/www/dekoningtegelwerken
# (zie deploy/dekoningtegelwerken.nl.conf). Afgeleid van preview-deploy.sh.
#
#   sudo deploy/live-deploy.sh            main uitrollen
#   deploy/live-deploy.sh --droog         alleen laten zien wat er zou gebeuren
#
# Veilig door opzet:
#  - Alleen main, nooit een featurebranch: wat live staat is door Bob gemerged.
#  - Voorcontrole: weigert zolang de site nog niet klaar is voor livegang
#    (placeholders aan, bedrijfsgegevens leeg, voorbeeldprojecten, of
#    sfeerbeelden die als project gelezen kunnen worden; zie CLAUDE.md en
#    docs/PLAN.md). Ook --droog stopt dan, met de lijst van wat ontbreekt.
#  - Er wordt een schone kopie van de gecommitte branch gemaakt (git archive);
#    niet-gecommitte bestanden in de werkmap gaan dus nooit mee.
#  - Alleen de publieke site gaat mee. .git, docs/, deploy/, _sjablonen/,
#    service/, test/ en markdown blijven buiten de webroot.
#  - Eerst controleren dat de gegenereerde pagina's bij de data passen; zo
#    niet, dan stopt het script zonder iets te wijzigen.
#  - rsync --delete werkt alleen binnen de doelmap, en het script weigert elk
#    ander doel dan /var/www/dekoningtegelwerken.
#  - Geen nginx-herlaad, geen systemctl: dat blijft handwerk.

set -euo pipefail

DOEL="/var/www/dekoningtegelwerken"
# Optioneel: eigenaar van de bestanden (bijv. LIVE_EIGENAAR=www-data).
EIGENAAR="${LIVE_EIGENAAR:-}"

droog=0
if [[ "${1:-}" == "--droog" ]]; then droog=1; shift; fi

repo="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
branch="main"
if [[ -n "${1:-}" && "$1" != "main" ]]; then
  echo "Live gaat alleen main uit (gevraagd: $1). Een branch bekijken kan op de preview." >&2
  exit 1
fi

# Vaste bestemming; nooit een variabel pad met --delete.
if [[ "$DOEL" != "/var/www/dekoningtegelwerken" ]]; then
  echo "Onverwacht doel: $DOEL" >&2
  exit 1
fi

if ! git -C "$repo" rev-parse --verify --quiet "$branch^{commit}" >/dev/null; then
  echo "Branch of commit '$branch' bestaat niet in $repo." >&2
  exit 1
fi

for nodig in rsync git node; do
  command -v "$nodig" >/dev/null || { echo "$nodig ontbreekt." >&2; exit 1; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Branch $branch ($(git -C "$repo" rev-parse --short "$branch")) uitpakken..."
git -C "$repo" archive --format=tar "$branch" | tar -x -C "$tmp"

echo "Controleren of de gegenereerde pagina's actueel zijn..."
if ! node "$tmp/service/cli/genereer.mjs" --controleer; then
  echo "Niet uitgerold: draai eerst node service/cli/genereer.mjs en commit het resultaat." >&2
  exit 1
fi

echo "Voorcontrole livegang..."
if ! node - "$tmp" <<'JS'
const fs = require('node:fs'), path = require('node:path');
const map = process.argv[2];
const lees = (p) => JSON.parse(fs.readFileSync(path.join(map, p), 'utf8'));
const fouten = [];
const site = lees('data/site.json');
if (site.placeholdersTonen !== false) fouten.push('data/site.json: placeholdersTonen staat niet op false');
for (const veld of ['telefoon', 'email', 'kvk'])
  if (!site.bedrijf?.[veld]) fouten.push(`data/site.json: bedrijf.${veld} is leeg`);
const voorbeelden = lees('data/projecten.json').projecten.filter((p) => p.placeholder);
if (voorbeelden.length) fouten.push(`data/projecten.json: ${voorbeelden.length} voorbeeldproject(en) met placeholder: true`);
// Sfeerbeelden met het label "Sfeerbeeld" (.foto--sfeer) staan op plekken waar ze
// als project gelezen worden; die moeten vóór livegang echte foto's zijn.
const html = [];
(function loop(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
  const p = path.join(d, e.name);
  if (e.isDirectory() && !['_sjablonen', 'service', 'test', 'docs', 'deploy'].includes(e.name) && !e.name.startsWith('.')) loop(p);
  else if (e.name.endsWith('.html')) html.push(p);
} })(map);
const sfeer = html.filter((p) => fs.readFileSync(p, 'utf8').includes('foto--sfeer'));
if (sfeer.length) fouten.push(`${sfeer.length} pagina('s) tonen sfeerbeelden als project (.foto--sfeer), o.a. ${path.relative(map, sfeer[0])}`);
if (fouten.length) { console.error('Nog niet klaar voor livegang:\n  - ' + fouten.join('\n  - ')); process.exit(1); }
console.log('Voorcontrole geslaagd.');
JS
then
  echo "Niet uitgerold." >&2
  exit 1
fi

rsync_opties=(
  --recursive --times --delete --delete-excluded --checksum
  --chmod=D755,F644
  --exclude='.git*'
  --exclude='/docs/'
  --exclude='/deploy/'
  --exclude='/_sjablonen/'
  --exclude='/service/'
  --exclude='/test/'
  --exclude='*.md'
  --exclude='.DS_Store'
)

if (( droog )); then
  echo "Droog: dit zou er veranderen in $DOEL"
  rsync "${rsync_opties[@]}" --dry-run --itemize-changes "$tmp/" "$DOEL/"
  exit 0
fi

if [[ ! -d "$DOEL" ]]; then
  echo "$DOEL bestaat niet. Maak hem eerst aan (zie deploy/README.md, "Live site")." >&2
  exit 1
fi

rsync "${rsync_opties[@]}" "$tmp/" "$DOEL/"
if [[ -n "$EIGENAAR" ]]; then
  chown -R "$EIGENAAR:$EIGENAAR" "$DOEL"
fi

echo "Klaar: $branch staat op https://dekoningtegelwerken.nl/"
