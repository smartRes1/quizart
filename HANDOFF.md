# Übergabe: Online-Modi (Branch `feature/online-modes`)

Stand: 26.10.2026. Wie der Code aufgebaut ist und welche Befehle es gibt, steht in `CLAUDE.md`, die Bedienung im `README.md`. Diese Datei hält fest, was entschieden ist, was fertig ist und was noch offen ist.

## Ziel

Aus der Party-Quiz-App wird eine Plattform mit vier Modi:

- **Solo:** gegen eine Bestenliste
- **Duell:** 1 gegen 1, abwechselnd
- **Match:** 3–10 Spieler live, ohne Moderator
- **Party:** unverändert, mit Moderator am Beamer

Party muss weiter offline und ohne jede Konfiguration laufen. Getestet wird vorerst nur lokal bzw. verborgen.

## Fertig (alles committet, `npm test`: 50 Tests grün)

| Commit | Inhalt |
|---|---|
| `0424b26` | Umbau in `lib/*`, Startseite, SQLite (`node:sqlite`), Test-Suite |
| `525612a` | Solo für Gäste: vom Server getaktete Durchgänge (`lib/runs.js`), `play.html` |
| `7bb398e` | Anmeldung (E-Mail-Link, Google, Facebook), Konto, Bestenliste |
| `b4c8fde` | Duell (`lib/battle.js`), Anmeldung nur mit Namen + QR-Code für weitere Geräte, neue Startseite, Moderator per PIN |

## Entscheidungen des Nutzers

- **Duell ist abwechselnd** (jeder spielt, wann er Zeit hat). In der Oberfläche heißt es **„Duell“**, im Code, in den Routen und Tabellen weiter `battle`.
- **Bestenliste:**
  - Nur der **erste Versuch** je Quiz zählt.
  - Gäste dürfen Solo spielen, stehen aber nicht in der Liste.
  - Wer ein Quiz aus einem Duell kennt, kommt mit diesem Quiz nicht mehr in die Bestenliste.
- **Anmeldung vorerst nur mit Namen.**
  - Die Startseite fragt zuerst „Wie heißt du?“. Der Name hängt per Cookie am Browser, die Sitzung gilt 365 Tage.
  - Weitere Geräte meldet man unter „Mein Konto“ per QR-Code an (gilt 10 Minuten, nur einmal).
  - Die E-Mail-Anmeldung kommt später. Sie ist ausgeblendet, solange `SMTP_URL` fehlt; `MAIL_LOG=1` schreibt die Links zum Testen ins Log.
  - Google und Facebook sind fertig, aber nur mit Stub-Tests geprüft. Für einen echten Test braucht es eine Domain und registrierte Apps.
- **Moderator:**
  - Die 6-stellige PIN kommt aus `HOST_PIN` oder aus `data/host-pin` und steht beim Start im Terminal.
  - Wer die PIN kennt, kann `/host` direkt öffnen oder auf der Startseite „Moderator werden“ wählen. Dann wird `users.is_host` gesetzt, und `/host` geht ohne PIN.
  - Nach 10 falschen Versuchen ist die IP 15 Minuten gesperrt.
  - Ein langer Schlüssel per QR-Code wurde probiert und auf Wunsch wieder entfernt.
- **Startseite:** zuerst der Name, dann Kacheln für Solo, Duell und Party. Die Party-Kachel hat ein Feld für den Code und für Moderatoren „Party moderieren“. Match wird erst angezeigt, wenn es gebaut ist.

## Offen

1. **Konzept „feste Quiz und Zufallsfragen“.** Der Vorschlag ist besprochen, aber noch **nicht entschieden**:
   - **Wertungsquiz (fest):** einmal spielbar, Bestenliste, z. B. als „Quiz der Woche“. Danach wandern seine Fragen in den Pool.
   - **Zufallsquiz:** Fragen aus einem Pool je Thema, beliebig oft spielbar, bei Duell und Match für alle dieselbe Ziehung.
   - Die Wertung bei Zufallsquiz läuft über eine Elo-Zahl aus Duellen und Matches statt über eine Bestenliste. Solo-Zufall wäre Training mit persönlichem Rekord.
   - Fragen eines laufenden Wertungsquiz dürfen nie im Pool stehen.
   - **Offene Fragen an den Nutzer:**
     - Wochen- oder Tagesquiz?
     - Ein Pool je Thema oder auch gemischt?
     - Wer schreibt die Fragen? Für einen Pool braucht man grob 150 oder mehr pro Thema.
   - Wird das umgesetzt, zieht Duell künftig aus dem Pool, und die Logik „ungespieltes Quiz suchen“ und „Duell sperrt Bestenliste“ fällt weg.
2. **Phase 5, Match**, laut Plan:
   - Es gibt je Länge (short/mid) eine Warteschlange bzw. Lobby.
   - Start ab 3 Spielern nach einem 30-s-Countdown, der bei jedem Beitritt neu beginnt (höchstens 60 s), oder sofort bei 10 Spielern.
   - Der Ablauf läuft automatisch: Intro 5 s, Auflösung 8 s, Zwischenstand 8 s. Aufgelöst wird, wenn alle geantwortet haben oder die Zeit um ist.
   - Die Zeit zählt für jeden Spieler ab seinem ersten Abruf der Frage.
   - Laufende Matches liegen nur im Speicher, das Ergebnis kommt in die Tabelle `matches`.
   - Ist nach 2 Minuten niemand da, bietet die Seite „Stattdessen Duell spielen“ an. Dazu kommt die Seite `match.html`.
   - Am besten gleich auf den Zufallspool aus Punkt 1 aufbauen, falls der entschieden ist.
3. **Phase 6, Doku:** README um alle neuen Modi ergänzen.
4. `datenschutz.html` und `impressum.html` enthalten noch Platzhalter, die der Nutzer selbst ausfüllt.
5. Der Branch ist noch nicht nach `main` gemerged; einen PR gibt es noch nicht.

## Zum Ausprobieren

```bash
npm install
node server.js        # zeigt Moderator-PIN und QR-Code zur Startseite
npm test
```

- Im WLAN über die LAN-IP aufrufen (z. B. `http://192.168.8.197:3000/`), nicht über `localhost`, sonst funktionieren die QR-Codes auf dem Handy nicht.
- Für ein Duell braucht man zwei Browser (normal + privat) mit zwei Namen.

## Stolpersteine

- Schemaänderungen nur als neuen Eintrag hinten an `MIGRATIONS` in `lib/db.js` anhängen, nie einen bestehenden ändern. Aktuell gibt es 5.
- `/api/state` nur aus `party.html` aufrufen. Der Aufruf startet die Antwortzeit eines Teams.
- Die Tests starten `server.js` als eigenen Prozess (`test/helpers.js`). `test/oauth.test.js` lädt `lib/auth.js` dagegen im selben Prozess. Deshalb darf `auth.js` nichts laden, das Intervalle startet (z. B. `party.js`); der PIN liegt dafür in `lib/hostpin.js`.
- Commits nur auf Wunsch des Nutzers. Oberfläche, Kommentare und Fehlermeldungen auf Deutsch.
