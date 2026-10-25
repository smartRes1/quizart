# Quiz-Party

Selbst gehostetes Party-Quiz: Die Spielleitung steuert am Beamer oder TV, die Teams spielen am Handy. Gescannt wird nur einmal zu Beginn, nach jeder Runde gibt es ein Zwischenergebnis, am Ende ein Siegerpodest.

Keine Datenbank, keine Cloud, keine Tracker, keine externen Schriften. Ein Container, ein Ordner mit JSON-Dateien.

## Starten

```bash
# Ordner data/ muss für den Container-Benutzer (UID 1000) beschreibbar sein
sudo chown -R 1000:1000 data

# PIN festlegen: Vorlage kopieren und HOST_PIN in .env ändern
cp .env.example .env

docker compose up -d --build
```

- **Startseite:** `https://<deine-domain>/` zeigt alle Spielmodi. Fertig sind Party und Solo (`/solo`, ohne Anmeldung), Battle und Match folgen.
- **Spielleitung:** `https://<deine-domain>/host` (PIN aus `.env`)
- **Teams:** scannen nur den QR-Code am Bildschirm, keine Adresse nötig

Der Container lauscht auf Port 3000. Hinter Caddy, Traefik oder nginx einfach auf diesen Port weiterleiten. Der QR-Code verwendet die Adresse, unter der du `/host` aufrufst. Läuft das hinter einem Proxy mit anderer Adresse, `PUBLIC_URL` in `docker-compose.yml` setzen (z. B. `https://quiz.example.at`).

**Lokal ohne Server** (z. B. im WLAN der Party): Laptop mit Docker, `docker compose up -d --build`, dann `/host` über die WLAN-IP aufrufen, also `http://192.168.x.x:3000/host`, nicht über `localhost`. Sonst steht `localhost` im QR-Code und die Handys finden nichts.

## Ablauf am Abend

1. `/host` am Beamer öffnen, PIN eingeben, **F** für Vollbild. Im **Menü** Thema und Länge wählen.
2. Runde 1 zeigt Titel und QR-Code. Teams scannen, geben ihren Namen ein und erscheinen als grüne Chips.
3. **Leertaste** (oder „Quiz starten“) startet die erste Frage. Die Handys zeigen die Antwortknöpfe, der Beamer Frage und Countdown.
4. Wenn alle Teams geantwortet haben oder die Zeit um ist, wird automatisch aufgelöst: richtige Antwort, Verteilung der Antworten, Funfact.
5. Nach der letzten Frage einer Runde: Zwischenergebnis mit Auf- und Absteigern.
6. Nächste Runde: Alle Teams spielen automatisch weiter, kein erneutes Scannen nötig.
7. Nach der letzten Runde: Siegerehrung mit Podest.

**Tasten:** Leertaste / Enter / → = weiter · Q = QR-Code groß einblenden (für Nachzügler) · F = Vollbild

Über **Teams** kannst du Teams entfernen (z. B. bei unpassenden Namen), über **Menü** ein neues Spiel starten.

## Punkte

- 1 Punkt pro richtiger Antwort (änderbar, siehe unten).
- Bei Punktegleichstand gewinnt das Team, das seine richtigen Antworten insgesamt schneller abgegeben hat.
- Eine abgegebene Antwort ist endgültig.

## Quiz-Pool

Die Quizze liegen nach Thema und Länge sortiert in `data/quizzes/`:

```
data/quizzes/
  allgemeinwissen/
    short.json   1 Runde, 2–6 Min
    mid.json     3–4 Runden, 7–15 Min
  wien-oesterreich-suedafrika/
    short.json
    mid.json
    long.json    mehr als 15 Min
```

Ein Thema ist ein Ordner (Kleinbuchstaben, Ziffern, `-`), darin `short.json`, `mid.json` und/oder `long.json`, nicht jede Länge muss es geben. Im Menü wählt die Spielleitung Thema und Länge. Vor der ersten Frage wird das sofort übernommen und die angemeldeten Teams bleiben dabei. Läuft das Spiel schon, gilt die Auswahl ab „Neues Spiel“. Als Themenname zeigt das Menü den `title` aus der Datei.

Die Dauer schätzt der Server so: pro Frage die Fragezeit plus 20 Sekunden für Auflösung und Funfact, pro Runde 45 Sekunden für Intro und Zwischenergebnis.

```bash
npm run check   # prüft alle Quizze und zeigt, ob die geschätzte Dauer zur Länge passt
```

## Fragen bearbeiten

Aufbau einer Frage:

```json
{
  "q": "Wie viele Hauptstädte hat Südafrika?",
  "options": ["Eine", "Zwei", "Drei"],
  "correct": "C",
  "fact": "Pretoria, Kapstadt und Bloemfontein."
}
```

- `options`: 2 bis 4 Antworten, `correct` ist der Buchstabe der richtigen (A, B, C, D).
- `fact`: wird bei der Auflösung am Beamer und am Handy gezeigt (optional).
- Optional pro Frage: `"seconds": 40` (mehr Zeit) oder `"points": 2` (doppelte Punkte, z. B. Schätzfragen).
- Global in `settings`: `secondsPerQuestion` und `pointsPerCorrect`.
- Eine neue Runde ist ein weiterer Block in `rounds` mit `name`, `subtitle` und `questions`.
- `title` ist der Name des Themas und sollte in allen Längen eines Themas gleich sein.

Nach dem Ändern im Menü auf **„Fragen neu laden“** klicken (geht nur vor dem Start der ersten Frage) oder **„Neues Spiel“** wählen. Neue Dateien und Themen erscheinen beim nächsten Öffnen des Menüs. Ist eine Datei fehlerhaft, zeigt das Menü genau an, wo (z. B. „Runde 2, Frage 4: correct muss A/B/C sein“).

Tipps gegen verräterische Fragen:
- Die richtige Antwort nicht länger oder genauer formulieren als die falschen.
- Keine Wörter aus der Antwort in der Frage verwenden.
- Den Buchstaben der richtigen Antwort über die Runde verteilen.

## Spielstand

Liegt in `data/state.json` und überlebt einen Neustart des Containers. Zum kompletten Zurücksetzen: Menü → „Neues Spiel, alles löschen“ (oder die Datei löschen und den Container neu starten).

## Ohne Docker

```bash
npm install
HOST_PIN=<eigene-PIN> node server.js
npm test   # automatische Tests
```

Node.js 22.13 oder neuer.
