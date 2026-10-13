# Project-CMS live zetten (WEBSITE > Projecten)

Branch `feature/projecten-cms`. De projecten op dekoningtegelwerken.nl komen
uit het portaal (cms.dekoningtegelwerken.nl, onder WEBSITE > Projecten) in
plaats van uit `data/projecten.json`:

- het portaal (dienst `dekoning-facturen`, 127.0.0.1:8132) bewaart projecten en
  foto's (schema 5 in `facturen.db`) en zet foto's om naar WebP in
  `/var/lib/dekoning/uploads/projecten/`;
- nginx van de site stuurt `/projecten/<slug>/`, `/sitemap-projecten.xml` en de
  projectgrids (SSI, `/_fragment/projecten/...`) naar het portaal, en levert
  `/uploads/projecten/*.webp` rechtstreeks van schijf;
- de statische pagina's houden hun grid als terugval: ligt het portaal eruit,
  dan staat het oude grid er gewoon.

Alles als root op **hfd-web01**, in deze volgorde. Elk blok is los te kopiëren;
blokken die iets wijzigen vragen eerst om bevestiging. Geen stap draait een
migratie zonder back-up.

```bash
vraag() { local a; read -r -p "$1 (ja/nee) " a; [ "$a" = "ja" ]; }
REPO=/root/dekoning-tegelwerken
STEMPEL=$(date +%Y%m%d-%H%M)
```

## 0. Mergen (Bob)

`feature/projecten-cms` bevat sinds 13 oktober ook `feature/breakglass` en
`feature/relay-facturen` (allebei al live). Eén fast-forward naar main brengt
dus alles samen; de andere twee branches hoeven niet apart gemerged.

```bash
cd $REPO && git fetch origin
git log --oneline origin/main..origin/feature/projecten-cms   # wat er bijkomt
vraag "feature/projecten-cms naar main mergen (fast-forward)?" && {
  git checkout main && git merge --ff-only origin/feature/projecten-cms && git push origin main
}
```

## 1. jpegtran installeren

`cwebp` (pakket `webp`) staat er al. `cwebp` zet een telefoonfoto niet rechtop
(EXIF-oriëntatie); dat doet `jpegtran`, zonder kwaliteitsverlies. Zonder dit
pakket weigert het portaal staande telefoonfoto's met een duidelijke melding.

```bash
command -v jpegtran || { vraag "libjpeg-turbo-progs installeren (jpegtran)?" && apt-get install -y libjpeg-turbo-progs; }
jpegtran -version 2>&1 | head -1
```

## 2. Back-up van de database

De dienst zet het schema bij de start naar 6 (alleen nieuwe tabellen; de live database staat op 5 sinds break-glass).

```bash
mkdir -p /root/backups
sqlite3 /var/lib/dekoning-facturen/facturen.db ".backup /root/backups/facturen-voor-projecten-$STEMPEL.db"
sqlite3 /root/backups/facturen-voor-projecten-$STEMPEL.db 'PRAGMA integrity_check; PRAGMA user_version;'   # ok / 5
```

## 3. Uploadmap

Eigenaar de dienst, groep `www-data`, setgid zodat nieuwe bestanden de groep
erven. De dienst zet elk bestand zelf op 0640. Buiten de webroot: `live-deploy.sh`
(rsync `--delete`) raakt deze map nooit.

```bash
vraag "/var/lib/dekoning/uploads/projecten aanmaken?" && {
  install -d -o root -g root -m 0755 /var/lib/dekoning /var/lib/dekoning/uploads
  install -d -o dekoning-facturen -g www-data -m 2750 /var/lib/dekoning/uploads/projecten
}
ls -ld /var/lib/dekoning/uploads/projecten   # drwxr-s--- dekoning-facturen www-data
```

## 4. Unit bijwerken (schrijfrecht op de uploadmap)

```bash
diff /etc/systemd/system/dekoning-facturen.service $REPO/deploy/dekoning-facturen.service   # alleen ReadWritePaths erbij
vraag "unit vervangen en systemd herladen?" && {
  cp /etc/systemd/system/dekoning-facturen.service /root/backups/dekoning-facturen.service.bak-$STEMPEL
  cp $REPO/deploy/dekoning-facturen.service /etc/systemd/system/dekoning-facturen.service
  systemctl daemon-reload
}
```

## 5. Portaal uitrollen en herstarten

```bash
cd $REPO && deploy/facturen-deploy.sh --droog main | tail -20
vraag "portaal uitrollen naar /opt/dekoning-facturen en herstarten?" && {
  deploy/facturen-deploy.sh main
  systemctl restart dekoning-facturen && sleep 2
  journalctl -u dekoning-facturen --since '-1 min' --no-pager | tail -5
}
# Schema 6, en de journal noemt GEEN "projectfoto's (... niet schrijfbaar)":
sudo -u dekoning-facturen sqlite3 /var/lib/dekoning-facturen/facturen.db 'PRAGMA user_version;'   # 6
```

Geen env-wijziging nodig. Optioneel in `/etc/dekoning/facturen.env`:
`PROJECTEN_UPLOADS` (andere uploadmap), `CWEBP` en `JPEGTRAN` (andere paden).
De voorbeeldlinks gebruiken een sleutel die is afgeleid van `SESSION_SECRET`.

## 6. Huidige projecten overzetten

De zes huidige projecten zijn voorbeeldprojecten met AI-sfeerbeelden. Ze komen
over met het label "Voorbeeldkaart" (niet geïndexeerd) en "Sfeerbeeld" op de
foto's, zoals nu. Twee keer draaien kan geen kwaad: een bestaande slug wordt
overgeslagen.

Besluit Bob (13 oktober 2026): **als concept** overzetten. Na stap 8 toont de
site "Hier komen binnenkort projecten van De Koning Tegelwerken" tot er een
echt project is gepubliceerd; de voorbeeldprojecten staan in het portaal klaar
om te bekijken of te verwijderen. (`--publiceer` zou de site laten zoals nu.)

```bash
MIGREER="sudo -u dekoning-facturen node /opt/dekoning-facturen/service/cli/migreer-projecten.mjs --beelden /var/www/dekoningtegelwerken/assets/beelden"
$MIGREER --droog
vraag "projecten als concept overzetten?" && $MIGREER
ls /var/lib/dekoning/uploads/projecten | wc -l   # ongeveer 40 bestanden
```

## 7. nginx: cms en site

cms: een eigen location voor de upload (16 MB; de rest blijft 256 KB).
Site: `/uploads/projecten/`, `/projecten/` naar het portaal, de fragmenten
(internal) en `ssi on`. Beide voorbeelden zijn verder gelijk aan wat er nu staat.

```bash
diff /etc/nginx/sites-enabled/cms.dekoningtegelwerken.nl.conf $REPO/deploy/nginx/cms.dekoningtegelwerken.nl.conf
diff /etc/nginx/sites-enabled/dekoningtegelwerken.nl.conf $REPO/deploy/dekoningtegelwerken.nl.conf
vraag "beide vhosts vervangen, testen en nginx herladen?" && {
  mkdir -p /root/vhost-werk
  cp /etc/nginx/sites-enabled/cms.dekoningtegelwerken.nl.conf /root/vhost-werk/cms.dekoningtegelwerken.nl.conf.bak-$STEMPEL
  cp /etc/nginx/sites-enabled/dekoningtegelwerken.nl.conf /root/vhost-werk/dekoningtegelwerken.nl.conf.bak-$STEMPEL
  cp $REPO/deploy/nginx/cms.dekoningtegelwerken.nl.conf /etc/nginx/sites-enabled/
  cp $REPO/deploy/dekoningtegelwerken.nl.conf /etc/nginx/sites-enabled/
  nginx -t && systemctl reload nginx
}
```

## 8. Site uitrollen

De pagina's krijgen de SSI-opdrachten rond het projectgrid en `sitemap.xml`
wordt een index (`sitemap-paginas.xml` + `sitemap-projecten.xml`). De
voorcontrole faalt nog steeds op de voorbeeldprojecten en sfeerbeelden, net als
bij de vorige uitrollen; vandaar `--forceer`.

```bash
cd $REPO && deploy/live-deploy.sh --droog 2>&1 | tail -8
vraag "site uitrollen (met --forceer)?" && deploy/live-deploy.sh --forceer
```

## 9. Controle

```bash
S=https://dekoningtegelwerken.nl
curl -s -o /dev/null -w 'sitemap-index        %{http_code}\n' $S/sitemap.xml                     # 200
curl -s -o /dev/null -w 'sitemap-projecten    %{http_code}\n' $S/sitemap-projecten.xml           # 200 (leeg zolang alles voorbeeld is)
curl -s -o /dev/null -w 'fragment van buiten  %{http_code}\n' $S/_fragment/projecten/alle        # 404 (internal)
curl -s -o /dev/null -w 'onbekend project     %{http_code}\n' $S/projecten/bestaat-niet/        # 404, de 404-pagina van de site
curl -s $S/ | grep -c '<!--#'                                                                     # 0: nginx heeft de SSI verwerkt
curl -s $S/ | grep -o 'src="/uploads/projecten/[^"]*"' | head -1                                  # alleen met --publiceer (of na publiceren)
F=$(ls /var/lib/dekoning/uploads/projecten | head -1)
curl -s -o /dev/null -D - $S/uploads/projecten/$F | grep -i -E '^HTTP|content-type|cache-control'  # 200, image/webp, max-age=31536000
curl -s -o /dev/null -w 'upload zonder sessie %{http_code}\n' -X POST https://cms.dekoningtegelwerken.nl/website/projecten/1/fotos   # 302 of 401
```

In het portaal: WEBSITE > Projecten. Maak een testproject, upload een
telefoonfoto (staand), kijk via "Bekijk voorbeeld" en verwijder het daarna.

## 10. Back-up

Tot nu toe was er geen back-up van De Koning op deze server. Besluit Bob
(13 oktober 2026): een nachtelijke back-up zoals de andere projecten hier,
naar `/var/backups/dekoning`: de database met `sqlite3 .backup` (gecomprimeerd,
30 dagen bewaard), en de PDF's, aanvragen en projectfoto's als bestanden
(`deploy/dekoning-backup.sh`, timer 03:15).

```bash
vraag "nachtelijke back-up installeren (dekoning-backup.timer)?" && {
  install -m 755 $REPO/deploy/dekoning-backup.sh /usr/local/sbin/dekoning-backup.sh
  cp $REPO/deploy/systemd/dekoning-backup.service $REPO/deploy/systemd/dekoning-backup.timer /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now dekoning-backup.timer
  systemctl start dekoning-backup.service && ls -la /var/backups/dekoning /var/backups/dekoning/db | tail -5
}
```

Let op: dit is een back-up op dezelfde schijf. Een kopie naar een andere
machine (zoals de externe back-up van Offerteknop) is een volgende stap.

## Terugdraaien

```bash
vraag "vorige vhosts terugzetten en nginx herladen?" && {
  cp /root/vhost-werk/cms.dekoningtegelwerken.nl.conf.bak-$STEMPEL /etc/nginx/sites-enabled/cms.dekoningtegelwerken.nl.conf
  cp /root/vhost-werk/dekoningtegelwerken.nl.conf.bak-$STEMPEL /etc/nginx/sites-enabled/dekoningtegelwerken.nl.conf
  nginx -t && systemctl reload nginx
}
```

Zonder `ssi on` en zonder de proxy voor `/projecten/` toont de site weer de
statische grids en pagina's; de SSI-opdrachten zijn dan gewoon commentaar. De
tabellen van schema 6 kunnen blijven staan; de rest van het portaal gebruikt ze
niet.
