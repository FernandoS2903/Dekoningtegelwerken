#!/usr/bin/env bash
# Nachtelijke back-up van het portaal van De Koning Tegelwerken naar
# /var/backups/dekoning (zelfde opzet als hfd-portaal en tuinplan op deze server):
#   db/facturen-<stempel>.db.gz   sqlite3 .backup van facturen.db, 30 dagen bewaard
#   bestanden/                    spiegel van PDF's, aanvragen en projectfoto's
# Draait als root (dekoning-backup.timer, 03:15). Zie deploy/PROJECTEN-INSTALLATIE.md §10.
set -euo pipefail
DATA=/var/lib/dekoning-facturen
UPLOADS=/var/lib/dekoning/uploads/projecten
DOEL=/var/backups/dekoning
STEMPEL=$(date +%Y%m%d-%H%M)
install -d -m 700 "$DOEL" "$DOEL/db" "$DOEL/bestanden"
UIT="$DOEL/db/facturen-$STEMPEL.db"
sqlite3 "$DATA/facturen.db" ".backup '$UIT'"
sqlite3 "$UIT" 'PRAGMA integrity_check;' | grep -qx ok
gzip -f "$UIT"
for map in pdfs aanvragen; do
  [ -d "$DATA/$map" ] && rsync -a --delete "$DATA/$map/" "$DOEL/bestanden/$map/"
done
[ -d "$UPLOADS" ] && rsync -a --delete "$UPLOADS/" "$DOEL/bestanden/projecten/"
find "$DOEL/db" -name 'facturen-*.db.gz' -mtime +30 -delete
echo "$(date -Is) back-up klaar: $UIT.gz ($(du -sh "$DOEL" | cut -f1) totaal)"
