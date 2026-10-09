# Portaal live op cms.dekoningtegelwerken.nl (fase C)

Stappen om het portaal (factuurdashboard + mailsorteerder, dienst
`dekoning-facturen` op `127.0.0.1:8132`) publiek te zetten op
`https://cms.dekoningtegelwerken.nl`, achter inloggen met Microsoft.
Alles als root op **hfd-web01**. Elk blok is los te kopiëren; blokken die iets
wijzigen vragen eerst om bevestiging.

Hulpfunctie voor de bevestigingsvragen (eenmalig plakken in de shell):

```bash
vraag() { local a; read -r -p "$1 (ja/nee) " a; [ "$a" = "ja" ]; }
REPO=/root/dekoning-tegelwerken
ENV=/etc/dekoning/facturen.env
```

> **Mailtoegang.** De mail-app (`M365_CLIENT_ID`) heeft `Mail.ReadWrite` en
> `Mail.Send` alleen via de Exchange RBAC-scope `Scope-FactuurdashboardDKT` op
> `info@dekoningtegelwerken.nl`. De tenant wordt gedeeld met andere mailboxen en
> domeinen: toegang via RBAC-scope op één mailbox; **nooit Entra Mail-rechten
> toevoegen** — niet aan de mail-app en niet aan `DKT Portaal`. Het token heeft
> met RBAC geen roles-claim; de verbindingstest kijkt echt in de mailbox.

## 1. DNS controleren

Bob zet zelf een A-record `cms.dekoningtegelwerken.nl → 178.104.144.203`.
Controle (alleen lezen):

```bash
VERWACHT=178.104.144.203
echo "publiek IP van deze server: $(curl -4 -s https://ifconfig.me)"
for r in 1.1.1.1 8.8.8.8; do echo "A via $r: $(dig +short cms.dekoningtegelwerken.nl A @$r | tr '\n' ' ')"; done
echo "AAAA: $(dig +short cms.dekoningtegelwerken.nl AAAA @1.1.1.1 | tr '\n' ' ')(hoort leeg te zijn)"
[ "$(dig +short cms.dekoningtegelwerken.nl A @1.1.1.1)" = "$VERWACHT" ] && echo "DNS in orde" || echo "STOP: DNS wijst nog niet naar $VERWACHT"
```

Wijst hij nog niet goed: stoppen en later opnieuw. Een AAAA-record naar een
ander adres laat certbot mislukken.

## 2. Certificaat (zoals bij de site, webroot `/var/www/html`)

De vhost verwijst naar een certificaat dat er nog niet is. Daarom eerst alleen
het poort-80-deel (met de `limit_req_zone`-regels erboven):

```bash
sed -n '1,/^}/p' $REPO/deploy/nginx/cms.dekoningtegelwerken.nl.conf
vraag "Dit poort-80-deel neerzetten en nginx herladen?" && {
  sed -n '1,/^}/p' $REPO/deploy/nginx/cms.dekoningtegelwerken.nl.conf \
    > /etc/nginx/sites-enabled/cms.dekoningtegelwerken.nl.conf
  nginx -t && systemctl reload nginx
}
```

```bash
vraag "Certificaat aanvragen voor cms.dekoningtegelwerken.nl?" && \
  certbot certonly --webroot -w /var/www/html -d cms.dekoningtegelwerken.nl
ls -l /etc/letsencrypt/live/cms.dekoningtegelwerken.nl/
```

Zolang alleen het poort-80-deel staat, stuurt nginx alles door naar https,
waar nog niets luistert voor deze naam. Dat is de bedoeling: het portaal is
nog niet bereikbaar.

## 3. Entra: app registration `DKT Portaal` (Bob, in de browser)

Een **aparte** app, los van de mail-app. Op entra.microsoft.com:

1. **App registrations › New registration**
   - Naam: `DKT Portaal`
   - Supported account types: *Accounts in this organizational directory only*
     (single tenant)
   - Redirect URI: platform **Web**,
     `https://cms.dekoningtegelwerken.nl/auth/callback`
2. **Authentication**: voeg een tweede Web-redirect-URI toe:
   `https://cms.dekoningtegelwerken.nl/auth/uitgelogd` (daar komt Microsoft
   terug na uitloggen). Laat *Access tokens* en *ID tokens* (implicit) **uit**.
3. **Certificates & secrets › New client secret**. Noteer de **Value** meteen
   en zet een herinnering voor de vervaldatum.
4. **API permissions**: alleen Microsoft Graph, **Delegated**: `openid`,
   `profile`, `email`. Verwijder het standaard `User.Read`. Geen
   Application-permissions en **geen Mail-rechten**. Daarna *Grant admin consent*.
5. **Enterprise applications › DKT Portaal › Properties**:
   *Assignment required?* = **Yes**. Daarna **Users and groups › Add user**:
   alleen de mensen die erin mogen (Bob).
6. Noteer de **Application (client) ID** van `DKT Portaal`. De tenant is
   dezelfde als die van de mail-app (`M365_TENANT_ID`, als GUID).

Daarna de env aanvullen. Waarden typ je zelf in de editor; de twee geheimen
kunnen met het tweede blok worden aangemaakt zonder dat ze in beeld komen:

```bash
${EDITOR:-nano} $ENV
#   PORTAL_BASE_URL=https://cms.dekoningtegelwerken.nl
#   ENTRA_PORTAL_CLIENT_ID=<client-id van DKT Portaal>
#   ENTRA_PORTAL_CLIENT_SECRET=<Value van het secret>
#   PORTAL_ALLOWED_EMAILS=<e-mailadres(sen), komma-gescheiden>
#   OFFERTES_URL=https://de-koning-tegelwerken.offerteknop.nl/offertes/
#   SORT_MODEL=claude-haiku-4-5
#   SORT_INTERVAL_MIN=5
#   MAIL_PROVIDER=m365
```

```bash
# Alleen aanmaken als ze nog leeg zijn of ontbreken; toont niets.
vraag "SESSION_SECRET en GRAPH_WEBHOOK_SECRET aanmaken waar ze leeg zijn?" && {
  for naam in SESSION_SECRET GRAPH_WEBHOOK_SECRET; do
    if ! grep -q "^$naam=." $ENV; then
      sed -i "/^$naam=\$/d" $ENV
      printf '%s=%s\n' "$naam" "$(openssl rand -hex 32)" >> $ENV
    fi
  done
  chmod 600 $ENV && chown root:root $ENV
}
```

Controle, alleen gevuld/leeg, nooit een waarde:

```bash
stat -c '%a %U:%G %n' $ENV
( set -a; . $ENV; set +a
  for v in M365_TENANT_ID M365_CLIENT_ID M365_CLIENT_SECRET M365_MAILBOX MAIL_PROVIDER \
           ANTHROPIC_API_KEY SORT_MODEL PORTAL_BASE_URL ENTRA_PORTAL_CLIENT_ID \
           ENTRA_PORTAL_CLIENT_SECRET PORTAL_ALLOWED_EMAILS SESSION_SECRET \
           GRAPH_WEBHOOK_SECRET OFFERTES_URL; do
    [ -n "${!v}" ] && echo "$v: gevuld" || echo "$v: LEEG"
  done
  [[ "$M365_TENANT_ID" =~ ^[0-9a-fA-F-]{36}$ ]] && echo "tenant-id is een GUID" || echo "LET OP: tenant-id is geen GUID"
  [ ${#SESSION_SECRET} -ge 32 ] && echo "SESSION_SECRET lang genoeg" || echo "LET OP: SESSION_SECRET te kort" )
```

## 4. Code neerzetten en de dienst herstarten

```bash
$REPO/deploy/facturen-deploy.sh --droog feature/mailsorteerder-portaal
vraag "Echt neerzetten in /opt/dekoning-facturen en de dienst herstarten?" && {
  $REPO/deploy/facturen-deploy.sh feature/mailsorteerder-portaal
  cp $REPO/deploy/dekoning-facturen.service /etc/systemd/system/
  systemctl daemon-reload
  systemctl restart dekoning-facturen
}
systemctl status dekoning-facturen --no-pager | head -12
journalctl -u dekoning-facturen -n 30 --no-pager
```

In de journal hoort te staan: `inloggen: Microsoft (SSO) voor
https://cms.dekoningtegelwerken.nl`. Staat er `Basic Auth ... (SSO mist: ...)`,
dan noemt de regel wat er nog ontbreekt; terug naar stap 3.

Lokaal (nog zonder nginx):

```bash
curl -s -o /dev/null -w '/ -> %{http_code} %{redirect_url}\n' http://127.0.0.1:8132/   # 302 naar /auth/login
curl -s -o /dev/null -w '/auth/check -> %{http_code}\n' http://127.0.0.1:8132/auth/check   # 401
```

## 5. nginx-vhost (en daarna, apart, fail2ban)

```bash
diff <(sed -n '1,/^}/p' $REPO/deploy/nginx/cms.dekoningtegelwerken.nl.conf) \
     /etc/nginx/sites-enabled/cms.dekoningtegelwerken.nl.conf && echo "poort-80-deel ongewijzigd"
vraag "Volledige vhost plaatsen, nginx -t en bij succes herladen?" && {
  cp $REPO/deploy/nginx/cms.dekoningtegelwerken.nl.conf /etc/nginx/sites-enabled/
  nginx -t && systemctl reload nginx
}
```

Bestaande vhosts worden niet aangeraakt. Faalt `nginx -t`, dan wordt er niet
herladen; zet dan het poort-80-deel terug (zie stap 2) of haal het bestand weg.

fail2ban **alleen na akkoord van Bob**:

```bash
fail2ban-regex /var/log/nginx/cms.dekoningtegelwerken.nl.access.log $REPO/deploy/fail2ban/dekoning-cms.conf | tail -5
vraag "fail2ban-filter en jail dekoning-cms plaatsen?" && {
  cp $REPO/deploy/fail2ban/dekoning-cms.conf /etc/fail2ban/filter.d/
  cp $REPO/deploy/fail2ban/dekoning-cms.local /etc/fail2ban/jail.d/
  fail2ban-client reload && fail2ban-client status dekoning-cms
}
```

## 6. Van buitenaf testen

```bash
H=cms.dekoningtegelwerken.nl
curl -s -o /dev/null -w 'http  -> %{http_code} %{redirect_url}\n' http://$H/              # 301 naar https
curl -s -o /dev/null -w 'https -> %{http_code} %{redirect_url}\n' https://$H/             # 302 naar /auth/login?terug=%2F
curl -s -o /dev/null -w 'login -> %{http_code} %{redirect_url}\n' https://$H/auth/login | cut -c1-110   # 302 naar login.microsoftonline.com
curl -s -o /dev/null -w 'check -> %{http_code}\n' https://$H/auth/check                    # 401
curl -s -o /dev/null -w 'notify fout -> %{http_code}\n' -X POST -H 'content-type: application/json' \
  -d '{"value":[{"clientState":"fout"}]}' https://$H/graph/notify                          # 401
curl -sI https://$H/ | grep -i -E '^(strict-transport-security|x-robots-tag|content-security-policy):'
```

## 7. Inloggen en de eerste gesorteerde mail

1. Bob opent `https://cms.dekoningtegelwerken.nl`, logt in met Microsoft en ziet
   de startpagina met de tegels Facturen, Mail en Offertes.
2. Binnen vijf minuten (`SORT_INTERVAL_MIN`) maakt de dienst de
   webhook-subscription aan. Controle:

   ```bash
   journalctl -u dekoning-facturen --since '-15 min' --no-pager | grep -i -E 'webhook|sorteer'
   sqlite3 -readonly /var/lib/dekoning-facturen/facturen.db \
     "SELECT sleutel, CASE WHEN sleutel = 'delta_link' THEN '(gevuld)' ELSE waarde END FROM sorteer_staat;"
   ```

   Verwacht: `sub_id` en `sub_verloopt` (ongeveer drie dagen vooruit), geen
   `sub_fout`. Ook te zien onder **Mail › Instellingen › Seintjes van Microsoft**.
3. Stuur een testmail naar `info@dekoningtegelwerken.nl` (bijvoorbeeld een
   nieuwsbrief-achtige mail van een eigen adres buiten het domein). Binnen een
   minuut hoort hij in het logboek onder **Mail** te staan.
4. **Mail › Instellingen › Verbindingen testen**: mailbox in orde, de mappen
   bestaan (ontbrekende worden bij de eerste ronde aangemaakt), Claude in orde.

## Terugdraaien

```bash
vraag "cms-vhost weghalen en nginx herladen?" && {
  rm /etc/nginx/sites-enabled/cms.dekoningtegelwerken.nl.conf
  nginx -t && systemctl reload nginx
}
```

Zonder vhost is het portaal weer alleen lokaal. Maak je `ENTRA_PORTAL_CLIENT_ID`
leeg en herstart je de dienst, dan geldt weer Basic Auth (`DASHBOARD_USER` /
`DASHBOARD_PASSWORD`). De subscription bij Microsoft verloopt dan vanzelf binnen
drie dagen; de polling blijft sorteren.
