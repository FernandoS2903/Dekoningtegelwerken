# deploy/ — voorbeelden voor Bob

Niets in deze map wordt door de site of door scripts automatisch gebruikt of
geïnstalleerd. Het zijn voorbeelden die Bob op hfd-web01 zelf neerzet; nginx
herladen en certificaten aanvragen blijft handwerk.

| Bestand | Wat |
|---|---|
| `preview.dekoningtegelwerken.nl.conf` | nginx-vhost voor de preview: wachtwoord, `X-Robots-Tag: noindex`, een robots.txt die alles weigert, strikte CSP. Root `/var/www/preview.dekoningtegelwerken`. |
| `dekoningtegelwerken.nl.conf` | nginx-vhost voor de **live site**: openbaar en indexeerbaar, `www` stuurt door naar het kale domein, HSTS, dezelfde strikte CSP, fonts en beelden 30 dagen in de cache. Root `/var/www/dekoningtegelwerken`. |
| `live-deploy.sh` | Zet **alleen `main`** live, op dezelfde manier als `preview-deploy.sh`, maar pas na een voorcontrole: weigert zolang `placeholdersTonen` aan staat, telefoon/e-mail/KvK leeg zijn, er voorbeeldprojecten zijn of sfeerbeelden als project op de site staan. Herlaadt niets. |
| `preview-deploy.sh` | Zet een branch (gecommitte staat, via `git archive`) met rsync in de preview-map, zonder `.git`, `docs/`, `deploy/`, `_sjablonen/`, `service/`, `test/` en markdown. Stopt als de gegenereerde pagina's niet actueel zijn. Herlaadt niets. |

Het **factuurdashboard** is een losse interne dienst die niets met de website te
maken heeft. De stappen daarvoor staan apart in
[`README-factuurdashboard.md`](README-factuurdashboard.md); de bestanden zijn
`dekoning-facturen.service`, `facturen.env.voorbeeld`, `facturen-deploy.sh` en
`Setup-MailboxScope.ps1`.

## Preview zichtbaar maken (eenmalig)

Alle commando's als root op **hfd-web01**.

1. **DNS** — bij de registrar van dekoningtegelwerken.nl een A-record (en zo
   mogelijk AAAA) voor `preview` naar het publieke adres van hfd-web01. Wachten
   tot `dig +short preview.dekoningtegelwerken.nl` dat adres teruggeeft.

2. **Map voor de site**

   ```bash
   mkdir -p /var/www/preview.dekoningtegelwerken
   ```

3. **Wachtwoordbestand** (gebruikersnaam naar keuze; `openssl` vraagt het wachtwoord):

   ```bash
   printf 'dekoning:%s\n' "$(openssl passwd -apr1)" > /etc/nginx/.htpasswd-dekoning-preview
   chmod 640 /etc/nginx/.htpasswd-dekoning-preview
   ```

4. **Certificaat** — de vhost verwijst naar een certificaat dat er nog niet is,
   dus eerst alleen het poort-80-deel aanzetten:

   ```bash
   sed -n '1,/^}/p' /root/dekoning-tegelwerken/deploy/preview.dekoningtegelwerken.nl.conf \
     > /etc/nginx/sites-enabled/preview.dekoningtegelwerken.nl.conf
   nginx -t && systemctl reload nginx
   certbot certonly --webroot -w /var/www/html -d preview.dekoningtegelwerken.nl
   ```

5. **Volledige vhost**

   ```bash
   cp /root/dekoning-tegelwerken/deploy/preview.dekoningtegelwerken.nl.conf /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   ```

6. **Branch uitrollen** (eerst droog kijken mag ook, met `--droog`):

   ```bash
   /root/dekoning-tegelwerken/deploy/preview-deploy.sh feature/fase-1-frontend
   ```

7. **Controleren**

   ```bash
   curl -sI https://preview.dekoningtegelwerken.nl/ | head -1          # 401 zonder wachtwoord
   curl -sI -u dekoning https://preview.dekoningtegelwerken.nl/ | grep -i -e '^HTTP' -e x-robots-tag
   curl -s https://preview.dekoningtegelwerken.nl/robots.txt            # Disallow: / zonder wachtwoord
   ```

   Daarna in de browser openen. Op de preview staan alle ontbrekende gegevens
   als gemarkeerde placeholder (`[TELEFOONNUMMER]`, "Projectfoto volgt", …).

## Bijwerken na nieuwe commits

```bash
/root/dekoning-tegelwerken/deploy/preview-deploy.sh feature/fase-1-frontend
```

Het script neemt de gecommitte staat van de branch; lokale, niet-gecommitte
wijzigingen gaan niet mee.

## Live site (dekoningtegelwerken.nl)

DNS staat al goed: `dekoningtegelwerken.nl` en `www` wijzen naar hfd-web01.
Alle commando's als root op **hfd-web01**, door Bob.

**Eerst klaar voor livegang** (zie CLAUDE.md en docs/PLAN.md). `live-deploy.sh`
controleert dit en weigert anders:

- echte bedrijfsgegevens in `data/site.json` en `placeholdersTonen: false`;
- echte projecten in `data/projecten.json` (geen `placeholder: true`);
- echte projectfoto's in plaats van de sfeerbeelden op projectkaarten en
  projectpagina's (sfeerbeelden mogen alleen blijven als algemeen sfeerbeeld,
  zonder het label "Sfeerbeeld" als project);
- dienstteksten door De Koning gecontroleerd; branch door Bob in `main` gemerged.

Wat er nog ontbreekt laat `deploy/live-deploy.sh --droog` zien.

1. **Map en tijdelijke http-vhost**

   ```bash
   mkdir -p /var/www/dekoningtegelwerken
   sed -n '1,/^}/p' /root/dekoning-tegelwerken/deploy/dekoningtegelwerken.nl.conf \
     > /etc/nginx/sites-enabled/dekoningtegelwerken.nl.conf
   nginx -t && systemctl reload nginx
   ```

2. **Certificaat** voor beide namen:

   ```bash
   certbot certonly --webroot -w /var/www/html -d dekoningtegelwerken.nl -d www.dekoningtegelwerken.nl
   ```

3. **Uitrollen** (`main`), daarna de volledige vhost:

   ```bash
   /root/dekoning-tegelwerken/deploy/live-deploy.sh --droog
   /root/dekoning-tegelwerken/deploy/live-deploy.sh
   cp /root/dekoning-tegelwerken/deploy/dekoningtegelwerken.nl.conf /etc/nginx/sites-enabled/
   nginx -t && systemctl reload nginx
   ```

4. **Controleren**

   ```bash
   curl -sI https://dekoningtegelwerken.nl/ | grep -i -e '^HTTP' -e strict-transport -e x-robots-tag   # 200, HSTS, géén X-Robots-Tag
   curl -sI https://www.dekoningtegelwerken.nl/ | grep -i -e '^HTTP' -e '^location'                   # 301 naar het kale domein
   curl -s https://dekoningtegelwerken.nl/robots.txt
   ```

Bijwerken na een nieuwe merge naar `main`: alleen stap 3 (`live-deploy.sh`).
