<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/logo-dark.svg">
    <img alt="Sparpreis-Explorer" src="docs/logo.svg" width="580">
  </picture>
</p>

# Sparpreis-Explorer

Findet billige Sparpreise auf genau den Verbindungen, die **wahrscheinlich nicht klappen**,
und hilft dir, daraus das Beste zu machen.

Ein Sparpreis gilt nur für die gebuchten Züge (Zugbindung). Diese **Zugbindung entfällt aber,
sobald absehbar ist, dass du mindestens 20 Minuten später am Ziel ankommst**, zum Beispiel
weil ein Anschluss platzt. Dann darfst du jeden anderen Zug nehmen, auch einen schnelleren
ICE. Ab 60 Minuten Verspätung gibt es zusätzlich Geld zurück.

Die App schätzt aus echten Ist-Zeiten der letzten Monate für jede Verbindung, **wie oft ihre
Anschlüsse klappen** und **wie wahrscheinlich du ≥ 20 min zu spät ankommst**. So findest du
das billigste Ticket mit der besten Chance auf eine freie Zugwahl. Gesucht werden auch
Verbindungen, die bahn.de so nicht vorschlägt: oft reicht ein kurzes ICE-Stück, der Rest läuft
im Nahverkehr, und alles ist ein durchgehendes Ticket zum Sparpreis.

> **Hinweis:** Privates Hobbyprojekt, nicht mit der Deutschen Bahn verbunden. Preise und
> Wahrscheinlichkeiten ohne Gewähr. Ob die Zugbindung aufgehoben ist, entscheidet die
> tatsächliche Verspätung, nicht die Statistik. Das Logo ist nur an die Farben der DB angelehnt.

## Anschluss-Quote und Flex-Chance

Das Herz der App. Jede Verbindung trägt vorne zwei Werte:

| Wert | Bedeutung | Für die Flex-Suche gut, wenn … |
|---|---|---|
| **Anschluss X %** | Wie oft **alle** Umstiege der Verbindung in den letzten Monaten geklappt hätten | **niedrig** |
| **🎲 Flex Y %** | Geschätzte Chance, **≥ 20 min später** am Ziel zu sein: Zugbindung aufgehoben | **hoch** |

Die Anschluss-Quote ist farbig markiert, je eher etwas platzt, desto auffälliger:

- 🔴 **unter 5 %:** klappt so gut wie nie
- 🟢 **unter 10 %:** kräftiges Grün
- 🟢 **unter 15 %:** mittleres Grün
- 🟢 **unter 25 %:** dunkles Grün
- ⚪ **darüber:** grau

So entstehen die Zahlen:

- **Pro Umstieg** steht im Fahrtverlauf, wie oft er verpasst worden wäre („**N % weg**“).
  Gerechnet wird mit der geplanten Umstiegszeit, der Verspätungsverteilung des ankommenden
  Zugs und damit, wie pünktlich der Anschlusszug selbst abfährt. Auch der Takt zählt: Bei
  einer Linie, die alle 10 min fährt, kostet ein verpasster Anschluss kaum Zeit.
- **Die Flex-Chance** setzt sich aus verpassten Anschlüssen, Zugausfällen und der Verspätung
  des letzten Zugs zusammen. Maßgeblich ist immer die Verspätung am Ziel: Ein verpasster
  Anschluss oder Ausfall zählt nur, wenn ihn kein späterer Umstieg mit genug Puffer wieder
  auffängt (wer 3 h in Mannheim wartet, ist trotz verpasster S-Bahn pünktlich).
- **Bauphasen zählen nicht als Ausfälle:** Fuhren an einem Bahnhof oder auf einer Linie in
  einem Monat massenhaft Züge nicht (mindestens 15 % und mindestens dreimal so viele wie im
  ruhigsten anderen Monat), war das meist eine Baustelle. Die „Ausfälle“ dieses Monats
  werden ignoriert, die Verspätungen der Züge, die fuhren, zählen weiter.
- **Die Datenbasis** ist so genau wie möglich: erst die Zugnummer, sonst die Linie zur selben
  Uhrzeit, dann die Linie, zuletzt der Bahnhof. Ältere Monate zählen weniger, dieselbe
  Jahreszeit und derselbe Wochentag können stärker gewichtet werden.
- **Nur Umstiege im Ticket zählen:** Oft gilt der Sparpreis nur für einen Teil der Strecke
  („Gilt nur für …“), etwa ohne die Straßenbahn am Anfang. Ein Umstieg außerhalb des Tickets
  hebt keine Zugbindung auf und ist ungeschützt. Die App liest den echten Geltungsbereich bei
  der DB aus, zeigt ihn an jeder Verbindung („🎫 Gilt nur für Essen-Steele – Freiburg“),
  markiert solche Abschnitte („nicht im Ticket“) und warnt vor knappen
  ungeschützten Umstiegen, je nach Verkehrsmittel: nach Tram und U-Bahn unter 3 min, nach
  Bussen unter 7 min, nach Zügen unter 10 min. Fehlt ein Zug im Ticket, ist die Verbindung rot
  und fliegt aus der Liste (außer das Deutschland-Ticket deckt den Nahverkehr ab). Die Suche
  prüft das für alle angezeigten Preise; ist einer noch nicht geprüft, steht
  „⚠ Geltungsbereich ungeprüft“ daran, und Aufklappen holt die Prüfung sofort nach.

Die Daten stammen aus dem offenen Datensatz
[piebro/deutsche-bahn-data](https://huggingface.co/datasets/piebro/deutsche-bahn-data) und
werden unter **Einstellungen → Pünktlichkeit** einmal geladen und ausgewertet. Die Suche
selbst lädt dafür nichts nach.

## Flex-Tag: der günstigste Flex-Preis eines Tages

Der Modus für die eigentliche Jagd. In der Suche **„Ganzer Tag: günstigste
Flex-Verbindung“** einschalten und ein Datum wählen:

1. Die App sucht den ganzen Tag ab 05 Uhr in **6 Zeitfenstern** nacheinander (schont die
   DB-Schnittstellen, dauert ein paar Minuten).
2. Sie nimmt nur Tickets mit **genau einem Fernverkehrs-Abschnitt**: das kurze ICE-Stück,
   das den Sparpreis möglich macht.
3. Vorab wird ausgesiebt: **Min. Flex** (Standard 65 %), **Max. Anschluss** (30 %) und
   **Max. Preis** (40 €) stehen direkt in der Suche und bestimmen schon, welche Kandidaten
   überhaupt einen Preis abfragen.
4. Das Ergebnis ist **nach Preis gruppiert**: je Preis eine Zeile pro Verbindung mit
   Anschluss- und Flex-Wert ganz vorne. Bei gleichem Preis steht die Verbindung zuerst, die
   eher platzt (niedrigere Anschluss-Quote, dann höhere Flex-Chance).
5. Antippen öffnet die Details, **„Bei DB prüfen“** öffnet genau dieses Ticket auf bahn.de
   (mit Zwischenhalten und BahnCard), dort buchen.

Gezeigt werden nur Züge des gesuchten Tages. Was gerade ausgeblendet ist, steht unter der
Liste („12 ausgeblendet: 7 ohne Preis · 3 Ticket deckt nicht die ganze Strecke …“): Während
der Suche fallen Treffer heraus, sobald sie einen Preis haben (dann die ohne Preis), sich als
Teilticket entpuppen oder über eine Grenze rutschen. Die Sortierung **🎯 Günstig & oft Flex** zeigt
außerdem nur die Verbindungen, die nicht von einer billigeren *und* flexibleren geschlagen
werden; **🎲 Unzuverlässigste** sortiert rein nach Flex-Chance.

**Früher aussteigen:** Suchst du ein Ziel, das unterwegs auf einer schon gesuchten Strecke
liegt, zeigt die App passende Tickets aus diesen Suchen gleich mit, ohne neue Abfragen
(„🚪 Ticket bis X, du steigst in Y aus“). Fahrgastrechte zählen dabei am Ticketziel.

## Am Reisetag: Prognose und Ersatzverbindung

Gebucht ist ein günstiges Ticket mit hoher Flex-Chance, jetzt zählt der Tag selbst:

- **Früh hinschauen:** Für Fahrten, die nicht auf „Nehme ich“ stehen, fragt die App ab 3 h
  vor Abfahrt alle 15 min den Live-Stand *aller* Züge der Verbindung ab (nach der ersten
  Suche eine Anfrage pro Zug). Jeder Zug wird außerdem ab 1 h vor seiner Abfahrt am
  *Startbahnhof* verfolgt, nicht erst kurz vor deinem Einstieg.
- **Prognose:** Verspätung am Ticketziel, platzende Anschlüsse, Ausfälle – oben in der
  Heute-Leiste und auf der Fahrt-Seite.
- **Platzt ein Anschluss, entscheidet der schnellste Ersatz:** Die Zugbindung entfällt nur,
  wenn du am Ziel ≥ 20 min später bist. Deshalb sucht die App im DB-Live-Fahrplan die
  schnellste Weiterfahrt ab dem Bruchpunkt und prüft sie alle 10 min neu: „Anschluss in
  Mannheim platzt – Ersatz kommt +12 min an, Zugbindung bleibt“ oder eben „aufgehoben“.
  Jedes Ergebnis landet mit Uhrzeit als **Beleg** an der Fahrt.
- **Ersatzverbindung wählen:** Ist die Zugbindung weg, zeigt die Fahrt-Seite die nächsten
  Verbindungen ab dem Start (unterwegs ab dem Bruchpunkt) mit Echtzeit, Anschluss-Quote und
  Flex-Chance. Ein Tipp auf **„Nehme ich“** trägt sie als verknüpfte Ersatzfahrt ein; die
  Live-Verfolgung läuft dort weiter. Kommt auch die Ersatzfahrt ≥ 60 min zu spät, gibt es
  dafür die Entschädigung.

## Was die App sonst kann

**Günstige Tickets finden**

- **Günstigere Alternativen zu deiner Wunschverbindung:** Du wählst eine Verbindung als
  Referenz, die App sucht alle billigeren Varianten mit denselben ersten Zügen.
- **Echte Sparpreise:** Jeder Preis kommt direkt von der DB, inklusive BahnCard, Klasse und
  Deutschland-Ticket aus deinen Einstellungen. Auch Pro-Forma-Preise über Zwischenhalte.
- **Nur gültige Tickets:** Ein grüner Haken bedeutet: Das Ticket deckt alle Züge der
  Verbindung ab.
- **Kalender:** zeigt den günstigsten Preis pro Tag.
- **Gutscheine griffbereit:** Oben rechts in der Suche stehen deine offenen DB-Gutscheine;
  ein Tipp zeigt die Nummern mit Kopier-Knopf zum Einlösen auf bahn.de.
- **Filter und Sortierung:** Preis, Dauer, Umstiege, ICE-Anteil, Fernverkehrs-Abschnitte,
  Flex-Chance, Anschluss-Quote, Ankunfts- statt Abfahrtszeit und mehr.
- **Alles in der URL:** Suche, Filter, Sortierung, Gruppierung und aufgeklappte Verbindungen
  stehen jederzeit in der Adresse – Neuladen oder ein geteilter Link zeigt genau das, was du
  siehst (die Ergebnisse kommen dabei aus dem Cache, ohne neue Abfragen).
- **Wird mit der Zeit besser:** Die App merkt sich Strecken, Umstiegsbahnhöfe und Preise
  deiner Suchen und findet auf der Stammstrecke schneller Treffer.

**Reisen festhalten und Entschädigung holen**

- **Kalender mit all deinen Fahrten:** aus der Suche per „Gebucht“, von Hand, automatisch aus
  den Buchungsmails (IMAP) oder aus deinem **DB-Kundenkonto** (inklusive Preis je Richtung
  bei Hin- und Rückfahrt).
- **Echte Zeiten jeder Fahrt:** Die App verfolgt deine Züge am Reisetag live (alle 10 min
  und genau zur Abfahrt und Ankunft) und ergänzt später die offiziellen Ist-Zeiten aus den
  Open Data. Selbst gemessene Werte bleiben immer erhalten, auch wenn die DB ihre Daten
  nachträglich ändert.
- **Doppelt gebucht?** Zwei Fahrten am selben Tag in dieselbe Richtung werden erkannt; mit
  „✓ Nehme ich“ / „✗ Nehme ich nicht“ markierst du, welche du fährst. Die andere ist
  ausgegraut und taucht nicht als nächste Fahrt auf – außer ihre Zugbindung fällt weg, dann
  ist ihr Ticket wieder frei.
- **Mit dem Ticket später gefahren:** Ab 20 min angekündigter Verspätung darfst du laut DB
  auch an einem anderen Tag fahren (bis zu einem Jahr später). Die gebuchte Fahrt wird dann
  mit der tatsächlich gemachten verknüpft; Entschädigung gibt es pro Ticket nur einmal, für
  die Verspätung der Ersatzfahrt.
- **Heute-Leiste:** Hast du heute eine Fahrt, zeigt jede Seite oben, in welchem Zug du
  gerade sitzt und wie es weitergeht.
- **„Kontrolliert“:** speichert Zeit und Standort einer Fahrkartenkontrolle und hält fest,
  zwischen welchen Halten der Zug gerade war und wie viel Verspätung er hatte.
- **Screenshots und Belege** direkt vom Handy zur Fahrt hochladen.
- **Fahrgastrechte auf Knopfdruck:** Die App rechnet nach den Regeln der DB aus, was dir
  zusteht (25 % ab 60 min, 50 % ab 120 min, Erstattung bei Nichtantritt oder Abbruch). Sie
  erzeugt das **offizielle DB-Formular fertig ausgefüllt und unterschrieben** oder reicht den
  Antrag **direkt online über dein DB-Konto** ein. Name, Adresse, IBAN und Zugangsdaten liegen
  verschlüsselt auf dem Server.

## So benutzt du sie

1. **Einrichten:** Unter **Einstellungen** BahnCard und Klasse wählen, unter **Start & Ziele**
   deine Orte anlegen und ihre Haltestellen direkt aus der Haltestellensuche wählen (pro Ort
   mehrere, z. B. ein Hauptbahnhof als Ausweich-Start) und unter **Pünktlichkeit** die Daten
   laden. Fertig eingerichtete
   Bereiche klappen sich zu, offene Punkte sind markiert.
2. **Flex-Tag suchen:** „Ganzer Tag“ einschalten, Datum und Grenzen (Min. Flex, Max.
   Anschluss, Max. Preis) wählen, warten, das günstigste Ticket mit niedriger
   Anschluss-Quote nehmen (siehe oben).
3. **Oder normal suchen:** Datum und Zeitfenster wählen.
   - **Schnell:** nutzt vor allem den Cache, sofort Ergebnisse
   - **Gründlich:** Standard, sucht kurze ICE-Stücke und Alternativen
   - **Tiefensuche:** systematisch über mehrere Zeitfenster, dauert länger
4. **Buchen:** Mit **„Bei DB prüfen“** das Ticket auf bahn.de öffnen und dort buchen, danach
   in der App als „Gebucht“ markieren (oder die Buchungsmail kommt von selbst).
5. **Am Reisetag:** Die App beobachtet alle Züge schon vorher. Ist die Zugbindung weg, wählst
   du auf der Fahrt-Seite eine Ersatzverbindung; nach der Reise ist der
   Entschädigungsantrag einen Knopfdruck entfernt.

## Installation

Du brauchst **Node.js 20 oder neuer** (empfohlen 24) und **Python 3**.

```bash
git clone https://github.com/TomlDev/sparpreis-explorer.git
cd sparpreis-explorer
npm install
python3 -m venv .venv && .venv/bin/pip install curl_cffi duckdb
cp .env.example .env
npx playwright install --with-deps chromium   # nur für die Anbindung des DB-Kundenkontos
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

**Oder mit Docker** (bringt Node und Python schon mit, nur die `.env` wie oben anlegen):

```bash
docker compose up -d --build   # http://localhost:3005, Daten im Volume "bahnfinder-data"
```

(Das Docker-Image enthält keinen Browser; die Anbindung des DB-Kundenkontos geht dort nicht.)

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
- Pünktlichkeit und Ist-Zeiten: [piebro/deutsche-bahn-data](https://huggingface.co/datasets/piebro/deutsche-bahn-data)
  (Deutsche Bahn, CC BY 4.0)

Code unter [MIT-Lizenz](LICENSE) © 2026 TomlDev
