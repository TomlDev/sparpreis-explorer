# Sparpreis-Explorer / Pro-Forma-ICE-Finder

Findet ungewöhnlich günstige DB-Fernverkehrstickets für eine Stammstrecke – gezielt
Verbindungen mit **gültigem durchgehenden Ticket, mindestens einem ICE/IC/EC-Abschnitt
und möglichst kleinem Fernverkehrsanteil**. Die App lernt aus jeder Suche einen kleinen
Streckengraphen und wird auf der Stammstrecke mit der Zeit schneller und „schlauer“.

Beispielstrecke (Seed für eine leere Datenbank, in den Einstellungen änderbar):
**Bochum-Langendreer ⇄ Triberg** (Fallback-Start: Bochum Hbf).

> **Hinweis:** Privates Hobbyprojekt, nicht mit der Deutschen Bahn verbunden. Es fragt
> öffentliche Fahrplan- und Preis-Schnittstellen in geringem Umfang ab (Cache, Tageslimit,
> Rate-Limiter). Wer es selbst betreibt, ist für die Einhaltung der jeweiligen
> Nutzungsbedingungen verantwortlich. Preise ohne Gewähr — maßgeblich ist die Buchung bei der DB.

## Hybride Architektur (Fahrplan ≠ Preis)

Fahrplanwissen ist billig und cachebar; DB-Preisabfragen sind die knappe,
IP-geblockte Ressource. Deshalb sind sie getrennt:

```
MOTIS / Transitous  →  Routing, Zugläufe, kurze ICE/IC-Segmente, Hubs, Graph
        ↓                (unbegrenzt & cachebar — läuft von diesem Server)
lokaler SQLite-Streckengraph  →  Kandidaten erzeugen + vor-ranken
        ↓
nur die besten N Kandidaten  →  DB-Vendo (über Wohnanschluss-Gateway)
                                 →  echter Sparpreis + Ticketabdeckung
```

- **Routing-Provider** (`ROUTING_PROVIDER`): `motis` (Transitous, Default) | `mock`.
- **Pricing-Provider** (`DB_VENDO_MODE`): `gateway` | `direct` | `dbrest` | `mock` | `off`.
- Ist Preisprüfung nicht verfügbar, werden trotzdem **echte Fahrplan-Ergebnisse**
  angezeigt – gekennzeichnet als „Preis nicht geprüft" (kein Rückfall auf Mock).
- DB-Budget pro Suche ist klein (Schnell 5 / Gründlich 15 / Tief 30); MOTIS-Budget
  separat und großzügig.

## Stack

- Next.js 16 (App Router) · TypeScript · Tailwind
- SQLite (better-sqlite3) + Drizzle ORM als Wissensspeicher
- Provider-Abstraktion (`RailProvider`): `MotisProvider` (Routing),
  `DbGatewayProvider` / `DbVendoProvider` / `DbRestProvider` (Pricing), `MockProvider`
- Rate-Limiter (Concurrency, Spacing, Retry/Backoff+Jitter, Request-Dedup, Circuit-Breaker)
- Stale-while-revalidate-Caching mit gestaffelten TTLs
- App-Login (Passwort → signiertes Session-Cookie, 30 Tage gültig), Zugangsschutz in `src/proxy.ts`
- Residential **DB-Gateway** in `apps/db-gateway` (siehe dessen README + Tailscale-Anleitung)

## Entwicklung

```bash
npm install
cp .env.example .env      # APP_PASSWORD setzen, AUTH_SECRET erzeugen: openssl rand -hex 32
python3 -m venv .venv && .venv/bin/pip install curl_cffi duckdb   # curl_cffi: DB_VENDO_MODE=direct, duckdb: Pünktlichkeitsdaten
npm run db:generate       # Drizzle-Migrationen erzeugen (einmalig / bei Schemaänderung)
npm run db:migrate
npm run dev               # http://localhost:3005
npm test                  # Vitest
```

## Ansicht teilen & reproduzieren

Die Suchseite hält ihren **kompletten Zustand in der URL** (Schema: `src/lib/viewState.ts`):
Route `o`/`d`, `date`, Zeitfenster `tw`/`tt` (+ `tm=arrival`), `mode`, `sort`, alle vom
Standard abweichenden Filter als `f.<name>`, Referenz `ref`/`refp`, aufgeklappte Karten
`open`, Vergleich `cmp` und ein offener Dialog `view`. Der Link-Button in der Topbar kopiert
ihn; beim Öffnen wird genau diese Ansicht wiederhergestellt (die URL hat Vorrang vor der
„letzten Suche" im Browser).

Serverseitig lässt sich so ein Link nachvollziehen — nur aus dem Cache, ohne DB-/MOTIS-Abfragen,
mit derselben Filter-/Sortierlogik wie der Browser (`src/lib/viewFilter.ts`):

```bash
npm run view -- 'https://your-domain.example/?o=nrw&d=schwarzwald&date=2026-10-16&tw=03:00&tt=10:00&open=…'
npm run view -- '<url>' --all    # zusätzlich ausgeblendete Verbindungen mit Grund
npm run view -- '<url>' --json   # maschinenlesbar
```

## Produktion

```bash
npm run build
npm run start             # oder via PM2:
pm2 start ecosystem.config.cjs
```

Die App lauscht nur auf `127.0.0.1:3005` und ist ausschließlich über Apache (TLS,
`ProxyPreserveHost On`) erreichbar. Das ist Voraussetzung für den Login-Schutz: Die Sperre
nach 10 Fehlversuchen nimmt die IP aus dem **letzten** `X-Forwarded-For`-Eintrag, den
Apache anhängt. Sicherheits-Header (CSP, HSTS, Permissions-Policy …) setzt `next.config.mjs`.

PM2 läuft als systemd-Dienst (`pm2-<user>`) mit `NoNewPrivileges` — nie `pm2 kill`, sondern
`pm2 restart bahnfinder` bzw. bei geänderten Start-Argumenten
`pm2 delete bahnfinder && pm2 start ecosystem.config.cjs --only bahnfinder && pm2 save`.

Docker:

```bash
docker compose up -d --build
```

## Provider-Konfiguration

Routing (`ROUTING_PROVIDER`): `motis` (Default, läuft von diesem Server) | `mock`.

Pricing (`DB_VENDO_MODE`):

| Wert      | Quelle                                   | Hinweis |
|-----------|------------------------------------------|---------|
| `gateway` | Residential DB-Gateway (`DB_VENDO_GATEWAY_URL`+`_TOKEN`) | Empfohlen. Umgeht den IP-Block. |
| `direct`  | Direkt DB via `db-vendo-client`          | Aus Rechenzentrums-IPs `OPS_BLOCKED`. |
| `dbrest`  | `db-rest` v6-Instanz (`DB_REST_BASE`)    | Nur wenn erreichbare Instanz vorhanden. |
| `mock`    | Offline-Demodaten                        | Tests & Dev. |
| `off`     | keine Preisprüfung                       | Nur Fahrplan, „Preis nicht geprüft". |

> **Aktueller Livebetrieb:** `ROUTING_PROVIDER=motis` + `DB_VENDO_MODE=direct` →
> echte Fahrpläne **und echte DB-Sparpreise direkt vom Server.**
>
> **Wichtig – `OPS_BLOCKED` war kein IP-Block:** Akamai blockt den *TLS-Fingerprint*
> von Node/plain-curl (HTTP 452), unabhängig von der IP. Lösung: db-vendo-client
> schickt seine Requests über einen **TLS-impersonierenden Transport**
> (`curl_cffi`/Chrome via `scripts/db_impersonate.py`, eingehängt über
> `profile.request` in `src/lib/rail/impersonate.ts`, dbnav-Profil). curl_cffi liegt
> im venv `/srv/bahn-finder/.venv` (`DB_IMPERSONATE_PYTHON`). Kein Gateway/VPN/
> Mobilfunk nötig. Setup: `python3 -m venv .venv && .venv/bin/pip install curl_cffi`.
> Kein VPN einsetzen – VPN-/Rechenzentrums-Ranges sind genau das, was DB reaktiv
> IP-sperrt; Impersonation + sparsames, gecachtes Volumen ist der bessere Schutz.
> Fallback bleibt das Residential-Gateway (`apps/db-gateway`, `DB_VENDO_MODE=gateway`).

## Suchmodi & Budget

- **Schnell** (≈10 Requests): Cache + wenige Abfragen, erste Ergebnisse sofort.
- **Gründlich** (≈40): Standard – Fallback-Start, bekannte kurze ICE/IC-Segmente, VIA-Varianten.
- **Tiefensuche** (≈120): systematisch, mehrere Zeitfenster, Fortschrittsanzeige, abbrechbar.

Der Preis in der App ist **keine verbindliche Buchungsgarantie** – „Bei DB prüfen“
öffnet bahn.de mit vorbelegter Verbindung.

## Pünktlichkeit (Open Data)

Unter **Einstellungen → Pünktlichkeit** lädt ein Knopfdruck die echten Ist-Zeiten
vergangener Monate aus [piebro/deutsche-bahn-data](https://huggingface.co/datasets/piebro/deutsche-bahn-data)
(DB Timetables API, CC BY 4.0). Wählbar sind die letzten 1–12 Monate und optional dieselbe
Jahreszeit aus Vor- und Vorvorjahr. `scripts/delay_ingest.py` (Python + DuckDB) lädt jeden
Monat (~600 MB) temporär nach `data/delay-tmp/`, aggregiert ihn für die Bahnhöfe aus deinen
Suchen zu kompakten Verspätungs-Histogrammen (Zug → Linie+Stunde → Linie → Bahnhof,
Wochentagsgruppe, Ausfälle) in SQLite und löscht die Rohdatei wieder. Die Suche liest nur
noch diese Tabellen.

Pro Verbindung zeigt die App daraus **Anschluss-Chance**, Verpass-Wahrscheinlichkeit je
Umstieg und **Flex-Chance**, also die geschätzte Wahrscheinlichkeit, ≥ 20 min zu spät
anzukommen (dann ist die Zugbindung aufgehoben). Dazu gibt es die Sortierung „Unzuverlässigste“
und einen Mindest-Flex-Filter. Die Gewichtung (Halbwertszeit, Saison, Wochentag,
Mindest-Beobachtungen) lässt sich ohne neuen Import ändern. Alles sind Schätzungen aus
vergangenen Monaten, keine Aussage über einen konkreten Zug. Python-Pfad: `DELAY_PYTHON`
(Standard `DB_IMPERSONATE_PYTHON`).

## Lizenz

[MIT](LICENSE) © 2026 TomlDev
