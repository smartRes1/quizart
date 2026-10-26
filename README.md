# Quiz-Party

Selbst gehostetes Party-Quiz: Die Spielleitung steuert am Beamer oder TV, die Teams spielen am Handy. Gescannt wird nur einmal zu Beginn, nach jeder Runde gibt es ein Zwischenergebnis, am Ende ein Siegerpodest.

Keine Cloud, keine Tracker, keine externen Schriften. Ein Container, ein Ordner mit JSON-Dateien. Party braucht weder Datenbank noch Anmeldung und läuft auch offline im WLAN; die Online-Modi speichern Konten und Ergebnisse in einer SQLite-Datei im selben Ordner.

## Starten

```bash
# Ordner data/ muss für den Container-Benutzer (UID 1000) beschreibbar sein
sudo chown -R 1000:1000 data

# Einstellungen: Vorlage kopieren und bei Bedarf anpassen
cp .env.example .env

docker compose up -d --build
```

- **Startseite:** `https://<deine-domain>/`: Name eintragen (bleibt im Browser), dann Solo, Duell oder Party wählen. Beim Start steht ein QR-Code zur Startseite im Terminal.
- **Moderator:** `/host` mit der Moderator-PIN, oder auf der Startseite „Moderator werden“, siehe unten
- **Teams:** scannen nur den QR-Code am Bildschirm, keine Adresse nötig

Der Container lauscht auf Port 3000. Hinter Caddy, Traefik oder nginx einfach auf diesen Port weiterleiten. Der QR-Code verwendet die Adresse, unter der du `/host` aufrufst. Läuft das hinter einem Proxy mit anderer Adresse, `PUBLIC_URL` in `.env` setzen (z. B. `https://quiz.example.at`).

**Moderator-PIN:** Ohne `HOST_PIN` erzeugt der Server beim ersten Start eine 6-stellige PIN in `data/host-pin` und schreibt sie beim Start ins Terminal (`docker compose logs quiz`). Wer Zugang zum Server hat, kennt also die PIN. Mit der PIN geht `/host` direkt; oder man trägt sie auf der Startseite unter „Moderator werden“ ein, dann bekommt das eigene Konto Moderator-Rechte (auch auf weiteren Geräten desselben Kontos) und `/host` geht ohne PIN. Nach 10 falschen Versuchen ist eine IP 15 Minuten gesperrt. Neue PIN: `data/host-pin` löschen und neu starten. Mit `HOST_PIN` gilt stattdessen dieser Wert.

**Lokal ohne Server** (z. B. im WLAN der Party): Laptop mit Docker, `docker compose up -d --build`, dann `/host` über die WLAN-IP aufrufen, also `http://192.168.x.x:3000/host`, nicht über `localhost`. Sonst steht `localhost` im QR-Code und die Handys finden nichts.

## Ablauf am Abend

1. `/host` am Beamer öffnen und die PIN eingeben (als Moderator angemeldet geht es ohne), **F** für Vollbild. Im **Menü** Thema und Länge wählen.
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

## Solo, Anmeldung und Bestenliste

Solo geht sofort, auch ohne Anmeldung. In die Bestenliste (`/bestenliste`, je Quiz) kommt nur, wer angemeldet ist, und zwar mit dem **ersten Versuch** je Quiz. Wer als Gast spielt und sich gleich danach anmeldet, bekommt dieses Ergebnis noch eingetragen, wenn es sein erster Versuch war. Spätere Versuche sind Training. Die Zeit misst der Server, die richtige Antwort sieht man erst nach dem Antworten.

Anmelden geht ohne Passwort:

- **Nur mit Namen:** immer verfügbar. Das Konto hängt am Gerät (Cookie, ein Jahr gültig). Unter `/konto` zeigt „Auf einem weiteren Gerät anmelden“ einen QR-Code (10 Minuten, einmal gültig); wer ihn scannt, ist mit demselben Konto angemeldet. Wer sich auf dem einzigen Gerät abmeldet, verliert das Konto.

Weitere Wege, in `.env` einzurichten (Vorlage: `.env.example`):

- **E-Mail-Link:** erscheint erst mit `SMTP_URL` (und `MAIL_FROM`). Zum Ausprobieren ohne Mailserver `MAIL_LOG=1`, dann stehen die Links nur im Server-Log.
- **Google:** in der Google Cloud Console einen OAuth-Client („Webanwendung“) anlegen, als Weiterleitungs-URI `<PUBLIC_URL>/auth/google/callback` eintragen, dann `GOOGLE_CLIENT_ID` und `GOOGLE_CLIENT_SECRET` setzen.
- **Facebook:** unter developers.facebook.com eine App mit „Facebook Login“ anlegen, `<PUBLIC_URL>/auth/facebook/callback` als gültige Weiterleitungs-URI eintragen, dann `FACEBOOK_APP_ID` und `FACEBOOK_APP_SECRET` setzen. Als Datenschutz-URL und Anleitung zur Datenlöschung `<PUBLIC_URL>/datenschutz` angeben.

Google und Facebook erscheinen nur, wenn ihre Werte gesetzt sind. Konten mit derselben bestätigten E-Mail-Adresse werden zusammengeführt. Spieler wählen selbst einen Namen für die Bestenliste und können ihr Konto unter `/konto` jederzeit löschen.

## Duell

1 gegen 1, abwechselnd: Beide spielen dieselben Fragen in derselben Reihenfolge, jeder wann er Zeit hat. Mehr Punkte gewinnt, bei Gleichstand die kürzere Zeit. Nur mit Anmeldung.

- **Freund herausfordern:** Quiz wählen, selbst spielen, Link (`/b/<code>`) z. B. per WhatsApp schicken. Wer ihn zuerst annimmt, ist der Gegner.
- **Zufälliger Gegner:** Länge wählen. Die Plattform sucht ein offenes Duell mit einem Quiz, das du noch nicht kennst; gibt es keines, startest du eines und der Nächste spielt gegen dich.
- Nach 7 Tagen ist ein Duell abgelaufen; wer bis dahin gespielt hat, gewinnt. Danach ist eine Revanche mit einem neuen Quiz möglich.
- Wer ein Quiz aus einem Duell kennt, kommt damit nicht mehr in die Solo-Bestenliste.
- Mit `SMTP_URL` bekommen Spieler eine E-Mail mit dem Ergebnis und bei einer Revanche (Links darin nur, wenn `PUBLIC_URL` gesetzt ist).

**Vor dem öffentlichen Betrieb** `public/datenschutz.html` und `public/impressum.html` ausfüllen (markierte Platzhalter).

## Spielstand

Party: liegt in `data/state.json` und überlebt einen Neustart des Containers. Konten und Ergebnisse der Online-Modi liegen in `data/quiz.db`. Zum kompletten Zurücksetzen: Menü → „Neues Spiel, alles löschen“ (oder die Datei löschen und den Container neu starten).

## Ohne Docker

```bash
npm install
node server.js   # Moderator-PIN und QR-Code zur Startseite stehen im Terminal
npm test   # automatische Tests
```

Node.js 22.13 oder neuer.
