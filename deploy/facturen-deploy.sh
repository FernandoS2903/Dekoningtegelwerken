#!/usr/bin/env bash
# Zet een branch van dekoning-tegelwerken als factuurdashboard neer in
# /opt/dekoning-facturen (zie deploy/dekoning-facturen.service).
#
#   sudo deploy/facturen-deploy.sh                        huidige branch van deze repo
#   sudo deploy/facturen-deploy.sh feature/factuurdashboard   een andere branch
#   deploy/facturen-deploy.sh --droog [branch]            alleen laten zien wat er zou gebeuren
#
# Veilig door opzet:
#  - Er wordt een schone kopie van de gecommitte branch gemaakt (git archive);
#    niet-gecommitte bestanden in de werkmap gaan dus nooit mee.
#  - Alleen wat de dienst nodig heeft: service/ en assets/fonts/ (het dashboard
#    levert de lettertypen van de site zelf uit). De rest van de site, docs/,
#    deploy/ en test/ blijven erbuiten.
#  - rsync --delete werkt alleen binnen de doelmap, en het script weigert elk
#    ander doel dan /opt/dekoning-facturen.
#  - De gegevens (database, PDF's, bunq-state) staan in /var/lib/dekoning-facturen
#    en worden door dit script niet aangeraakt.
#  - Geen systemctl: herstarten blijft handwerk. Het commando staat onderaan.

set -euo pipefail

DOEL="/opt/dekoning-facturen"
DIENST="dekoning-facturen"
GEBRUIKER="${FACTUREN_GEBRUIKER:-dekoning-facturen}"

droog=0
if [[ "${1:-}" == "--droog" ]]; then droog=1; shift; fi

repo="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
branch="${1:-$(git -C "$repo" rev-parse --abbrev-ref HEAD)}"

# Vaste bestemming; nooit een variabel pad met --delete.
if [[ "$DOEL" != "/opt/dekoning-facturen" ]]; then
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

# Node 22 of hoger: de dienst gebruikt node:sqlite.
node_versie="$(node -p 'process.versions.node.split(".")[0]')"
if (( node_versie < 22 )); then
  echo "Node 22 of hoger is nodig (node:sqlite); gevonden: $(node -v)." >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Branch $branch ($(git -C "$repo" rev-parse --short "$branch")) uitpakken..."
git -C "$repo" archive --format=tar "$branch" | tar -x -C "$tmp"

if [[ ! -f "$tmp/service/facturen/server.mjs" ]]; then
  echo "Deze branch bevat geen service/facturen/server.mjs." >&2
  exit 1
fi

echo "Syntaxcontrole van de dienst..."
while IFS= read -r -d '' bestand; do
  node --check "$bestand" >/dev/null
done < <(find "$tmp/service/facturen" -name '*.mjs' -print0)

rsync_opties=(
  --recursive --times --delete --delete-excluded --checksum
  --chmod=D755,F644
  --include='/service/'
  --include='/service/facturen/***'
  --include='/assets/'
  --include='/assets/fonts/***'
  --exclude='*'
)

if (( droog )); then
  echo "Droog: dit zou er veranderen in $DOEL"
  rsync "${rsync_opties[@]}" --dry-run --itemize-changes "$tmp/" "$DOEL/"
  exit 0
fi

mkdir -p "$DOEL"
rsync "${rsync_opties[@]}" "$tmp/" "$DOEL/"

# De code wordt alleen gelezen door de dienst; eigenaar root is prima en
# voorkomt dat de dienst zijn eigen bestanden kan wijzigen.
chown -R root:root "$DOEL"
chmod 755 "$DOEL"

echo
echo "Klaar: $branch staat in $DOEL"
echo
if ! id -u "$GEBRUIKER" >/dev/null 2>&1; then
  echo "Let op: de gebruiker '$GEBRUIKER' bestaat nog niet. Zie deploy/README.md."
  echo
fi
echo "Herstarten doe je zelf:"
echo "  systemctl restart $DIENST && systemctl status $DIENST --no-pager"
