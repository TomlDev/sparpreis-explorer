<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img alt="Sparpreis-Explorer" src="docs/logo.svg" width="580">
  </picture>
</p>

# Sparpreis-Explorer

Findet günstige Bahn-Tickets für deine Stammstrecke, die man bei bahn.de so nicht angezeigt
bekommt.

Die Idee: Ein Sparpreis gilt nur für Verbindungen mit Fernverkehr. Oft reicht aber schon
**ein kurzes ICE-Stück**, der Rest der Strecke läuft im Nahverkehr, und trotzdem ist alles
**ein durchgehendes Ticket** zum Sparpreis. Solche Verbindungen sind häufig deutlich billiger
als die Standardvorschläge der DB. Die App sucht sie gezielt, prüft die echten Preise und
zeigt dir nur, was tatsächlich buchbar ist.

> **Hinweis:** Privates Hobbyprojekt, nicht mit der Deutschen Bahn verbunden. Preise ohne
> Gewähr, maßgeblich ist die Buchung bei der DB. Das Logo ist nur an die Farben der DB
> angelehnt.

## Was die App kann

- **Günstigere Alternativen zu deiner Wunschverbindung:** Du wählst eine Verbindung als
  Referenz, die App sucht alle billigeren Varianten mit denselben ersten Zügen.
- **Echte Sparpreise:** Jeder angezeigte Preis kommt direkt von der DB, inklusive BahnCard,
  Klasse und Deutschland-Ticket aus deinen Einstellungen.
- **Nur gültige Tickets:** Ein grüner Haken bedeutet: ein Ticket für die ganze Strecke.
- **„Bei DB prüfen“:** öffnet die Verbindung vorausgefüllt auf bahn.de zum Buchen.
- **Kalender:** zeigt den günstigsten Preis pro Tag.
- **Umstiege im Blick:** knappe Umstiege sind rot markiert, Fußwege und echte Wartezeiten
  stehen im Fahrtverlauf.
- **Pünktlichkeit aus echten Daten:** wie oft Anschlüsse in den letzten Monaten geklappt
  haben und wie wahrscheinlich du ≥ 20 min zu spät ankommst (siehe unten).
- **Filter und Sortierung:** Preis, Dauer, Umstiege, ICE-Anteil, „Nur Original (DB)“,
  Ankunfts- statt Abfahrtszeit, „Unzuverlässigste zuerst“ und mehr.
- **Teilen:** Die komplette Ansicht steckt in der URL, ein Link zeigt genau das, was du siehst.
- **Merken und Vergleichen** einzelner Verbindungen.
- **Wird mit der Zeit besser:** Die App merkt sich Strecken, Umstiegsbahnhöfe und Preise
  deiner Suchen und findet auf der Stammstrecke schneller Treffer.

## So benutzt du sie

1. **Stammstrecke einrichten:** In den Einstellungen Start und Ziel eintragen. Pro Seite
   kannst du mehrere Bahnhöfe anlegen (z. B. einen Hauptbahnhof als Ausweich-Start),
   sortieren und einzeln abschalten.
2. **Suchen:** Datum und Zeitfenster wählen. Du siehst zuerst die normalen DB-Verbindungen.
   - **Schnell:** nutzt vor allem den Cache, sofort Ergebnisse
   - **Gründlich:** Standard, sucht kurze ICE-Stücke und Alternativen
   - **Tiefensuche:** systematisch über mehrere Zeitfenster, dauert länger
3. **Referenz wählen:** Bei deiner Wunschverbindung auf **„Als Referenz“** tippen. Die App
   sucht dann alle günstigeren Alternativen, die mit denselben Zügen starten.
4. **Buchen:** Mit **„Bei DB prüfen“** die Verbindung auf bahn.de öffnen und dort buchen.

### Pünktlichkeit

Unter **Einstellungen → Pünktlichkeit** lädt ein Knopfdruck die echten Ist-Zeiten
vergangener Monate für die Bahnhöfe deiner Strecken. Du wählst, wie viele Monate zählen
und ob dieselbe Jahreszeit aus den Vorjahren dazukommt. Die Daten werden einmal
ausgewertet und gespeichert, die Suche selbst lädt nichts nach.

Danach zeigt jede Verbindung:

- **Anschluss X %:** wie oft alle Umstiege geklappt hätten
- **N % weg:** pro Umstieg, wie oft der Anschluss verpasst worden wäre
- **🎲 Flex Y %:** geschätzte Chance, ≥ 20 min zu spät anzukommen. Dann ist beim Sparpreis
  die Zugbindung aufgehoben und du darfst einen anderen Zug nehmen.

Das sind Statistiken über die Vergangenheit, keine Vorhersage für einen konkreten Zug.

## Installation

Du brauchst **Node.js 20 oder neuer** (empfohlen 24) und **Python 3**.

```bash
git clone https://github.com/TomlDev/sparpreis-explorer.git
cd sparpreis-explorer
npm install
python3 -m venv .venv && .venv/bin/pip install curl_cffi duckdb
cp .env.example .env
```

In der `.env` mindestens diese zwei Werte setzen, sonst kann sich niemand einloggen:

```bash
APP_PASSWORD=ein-langes-passwort
AUTH_SECRET=...   # erzeugen mit: openssl rand -hex 32
```

Starten:

```bash
npm run build
npm run start             # http://localhost:3005
```

Zum Ausprobieren ganz ohne Netzabfragen gibt es Demodaten:
`ROUTING_PROVIDER=mock` und `DB_VENDO_MODE=mock` in der `.env`.

**Auf einem Server:** Die App sollte nur lokal lauschen (`npm run start -- -H 127.0.0.1`) und
über einen Reverse-Proxy mit HTTPS erreichbar sein (z. B. Apache oder nginx). Das Login-Cookie
funktioniert nur über HTTPS oder auf `localhost`. Für den Dauerbetrieb liegt eine
PM2-Konfiguration bei (`pm2 start ecosystem.config.cjs`).

## Einstellungen in der `.env`

| Variable | Bedeutung |
|---|---|
| `APP_PASSWORD` | Passwort für den Login |
| `AUTH_SECRET` | Geheimer Schlüssel für das Login-Cookie (mind. 32 Zeichen) |
| `DB_VENDO_MODE` | Preisquelle: `direct` (echte DB-Preise, Standard), `mock` (Demo), `off` (nur Fahrplan) |
| `ROUTING_PROVIDER` | Fahrplanquelle: `motis` (Transitous, Standard) oder `mock` |
| `RAIL_USER_AGENT` | Kennung für Anfragen, bitte mit eigener Kontaktadresse |

Die App fragt die DB nur sparsam ab: Ergebnisse werden zwischengespeichert, und es gibt ein
Tageslimit. Wer sie selbst betreibt, ist für die Einhaltung der Nutzungsbedingungen der
genutzten Dienste verantwortlich.

## Für Entwickler

```bash
npm run dev                          # Entwicklungsserver
npm test                             # Tests
npm run view -- '<geteilter Link>'   # zeigt eine geteilte Ansicht im Terminal an
```

## Datenquellen und Lizenz

- Fahrpläne: [Transitous](https://transitous.org) (MOTIS)
- Preise: DB-Schnittstellen über [db-vendo-client](https://github.com/public-transport/db-vendo-client)
- Pünktlichkeit: [piebro/deutsche-bahn-data](https://huggingface.co/datasets/piebro/deutsche-bahn-data)
  (Deutsche Bahn, CC BY 4.0)

Code unter [MIT-Lizenz](LICENSE) © 2026 TomlDev
