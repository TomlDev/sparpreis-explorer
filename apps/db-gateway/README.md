# DB-Vendo Gateway (residential)

Winziger Dienst, der `db-vendo-client` kapselt und **nur** die für den
Sparpreis-Explorer nötigen Operationen anbietet. Er läuft auf einer **normalen
privaten Internetverbindung** (z. B. Raspberry Pi zuhause), damit DB-Preis-/
Ticketabfragen nicht am Rechenzentrums-IP-Block scheitern.

## Warum
Die direkten DB-Endpunkte blocken Rechenzentrums-IPs (`OPS_BLOCKED`/403). Über
dieses Gateway laufen nur wenige, gezielte Preis-/Ticketanfragen über eine
Wohnanschluss-IP. Die gesamte Routing-/Graph-Intelligenz bleibt bei MOTIS.

## Endpunkte
```
GET  /health
GET  /api/locations?query=&results=
POST /api/journeys   { from, to, opts }
POST /api/refresh    { refreshToken, opts }
GET  /api/trip?id=
```
Alle `/api/*` erfordern `Authorization: Bearer $GATEWAY_TOKEN`.

## Start (Docker, empfohlen)
Auf dem Heimserver/Pi (arm64 & amd64):
```bash
export GATEWAY_TOKEN=$(openssl rand -hex 24)
# aus dem Repo-Root:
docker compose -f docker-compose.gateway.yml up -d --build
curl -s localhost:3009/health
```

## Start (ohne Docker)
```bash
cd apps/db-gateway
npm install
GATEWAY_TOKEN=$(openssl rand -hex 24) DB_PROFILE=db node server.mjs
```

## Mit der Haupt-App verbinden — Tailscale (bevorzugt)
Kein offener Port im Router nötig (auch mit DS-Lite).

1. Tailscale auf Pi **und** auf dem Server (VM) installieren, beide im selben Tailnet.
2. Auf dem Pi den Tailscale-Namen/Hostnamen prüfen (z. B. `pi-bahn`), Port 3009.
3. In der **Haupt-App** (`/srv/bahn-finder/.env`):
   ```env
   DB_VENDO_MODE=gateway
   DB_VENDO_GATEWAY_URL=http://pi-bahn:3009
   DB_VENDO_GATEWAY_TOKEN=<derselbe GATEWAY_TOKEN>
   ```
4. `pm2 restart bahnfinder --update-env`

Der Gateway-Port muss dann nur im Tailnet erreichbar sein — keine Portfreigabe,
kein öffentliches Exposé.

### Alternative: Reverse-Tunnel
Wenn kein Tailscale gewünscht ist, ein Reverse-Tunnel vom Pi zum Server
(z. B. `ssh -N -R 3009:localhost:3009 server`) oder ein Cloudflare-Tunnel.
Dann `DB_VENDO_GATEWAY_URL=http://127.0.0.1:3009` auf dem Server.

## Sicherheit
- Bearer-Token Pflicht; ohne/falsch → 401.
- Begrenzte Parallelität, Request-Dedup, kurzer Cache (schont die DB-API).
- Keine Tokens/Responses im Log.
- Keine generische Proxy-Funktion — nur die vier Endpunkte.
