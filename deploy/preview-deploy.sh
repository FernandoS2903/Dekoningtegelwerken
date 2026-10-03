#!/usr/bin/env bash
# Zet een branch van dekoning-tegelwerken als preview neer in
# /var/www/preview.dekoningtegelwerken (zie deploy/preview.dekoningtegelwerken.nl.conf).
#
#   sudo deploy/preview-deploy.sh                          huidige branch van deze repo
#   sudo deploy/preview-deploy.sh feature/fase-1-frontend  een andere branch
#   deploy/preview-deploy.sh --droog [branch]              alleen laten zien wat er zou gebeuren
#
# Veilig door opzet:
#  - Er wordt een schone kopie van de gecommitte branch gemaakt (git archive);
#    niet-gecommitte bestanden in de werkmap gaan dus nooit mee.
#  - Alleen de publieke site gaat mee. .git, docs/, deploy/, _sjablonen/,
#    service/, test/ en markdown blijven buiten de webroot.
#  - Eerst controleren dat de gegenereerde pagina's bij de data passen; zo
#    niet, dan stopt het script zonder iets te wijzigen.
#  - rsync --delete werkt alleen binnen de doelmap, en het script weigert elk
#    ander doel dan /var/www/preview.dekoningtegelwerken.
#  - Geen nginx-herlaad, geen systemctl: dat blijft handwerk.

set -euo pipefail

DOEL="/var/www/preview.dekoningtegelwerken"
# Optioneel: eigenaar van de bestanden (bijv. PREVIEW_EIGENAAR=www-data). Op hfd-web01
# draait nginx als root en zijn de bestanden met mode 644 al leesbaar.
EIGENAAR="${PREVIEW_EIGENAAR:-}"

droog=0
if [[ "${1:-}" == "--droog" ]]; then droog=1; shift; fi

repo="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
branch="${1:-$(git -C "$repo" rev-parse --abbrev-ref HEAD)}"

# Vaste bestemming; nooit een variabel pad met --delete.
if [[ "$DOEL" != "/var/www/preview.dekoningtegelwerken" ]]; then
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
  echo "$DOEL bestaat niet. Maak hem eerst aan (zie deploy/README.md)." >&2
  exit 1
fi

rsync "${rsync_opties[@]}" "$tmp/" "$DOEL/"
if [[ -n "$EIGENAAR" ]]; then
  chown -R "$EIGENAAR:$EIGENAAR" "$DOEL"
fi

echo "Klaar: $branch staat op https://preview.dekoningtegelwerken.nl/"
