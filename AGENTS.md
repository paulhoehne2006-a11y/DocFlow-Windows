# Regeln für DocFlow Studio für Windows

Diese Regeln gelten für dieses Repo und haben Vorrang vor globalen Regeln, wenn sie sich widersprechen.

## Technik
- Electron mit contextIsolation und sandboxed preload, kein Node im Renderer. Der Renderer besteht aus reinen ES-Modulen ohne Build-Schritt (`src/js/`).
- Keine Frameworks und keine UI-Bibliotheken (kein React, Tailwind, shadcn/ui, Radix o. Ä.). Die globalen Web-Design-Skills (taste_skill, awesome_design, Mobile-First) gelten hier nicht. Design-Änderungen nur mit vorhandenem CSS und nur auf meinen Wunsch.
- Neue Bibliotheken nur nach Rückfrage. Sie werden über `scripts/vendor.mjs` nach `src/vendor/` kopiert.

## Akku hat Vorrang
- Keine Dauerschleifen, kein Polling, keine requestAnimationFrame-Schleifen und keine Intervalle im Leerlauf. Gezeichnet wird nur bei Eingaben.
- Animationen sparsam einsetzen, keine Hover- oder Mikroanimationen nur der Optik wegen.
- Bei jeder neuen Funktion prüfen und im Bericht nennen, ob sie im Leerlauf CPU oder GPU verbraucht.

## Stift-Eingabe nicht verschlechtern
- Druck, Neigung und getCoalescedEvents bleiben erhalten.
- Die Stifttaste radiert, das Radierer-Ende ist Taste 5.
- Handballenerkennung und die desynchronized Wet-Ink-Ebene bleiben.

## Dateiformat `.docflownote` (geteilt mit der Android-App)
- Kompatibel halten: unbekannte ZIP-Einträge und JSON-Felder beim Schreiben unverändert übernehmen. Neue Felder nur hinzufügen, nie umbenennen oder entfernen.
- Beim Speichern im Manifest `deviceId` und `exportedAtMillis` setzen. Geänderte Seiten bekommen ein neues `updatedAt`.
- Alles, was das Handy sehen soll, gehört ins Manifest der Datei, nicht nur in `.docflow-workspace.json`. Dazu zählen Ordner (`folderId`, `folderPath` mit " / " als Trenner), Favorit, Titel, Cover, Randnotizen, OCR-Text, Ebenen und Audio. Die Workspace-Datei enthält nur, was das Handy nicht braucht: Ordnerfarben, leere Ordner und den Suchindex.
- Bestehende Dateien an Ort und Stelle überschreiben, nicht ersetzen, sonst verliert Google Drive die Datei-Identität.
- Eine Datei nur neu einlesen, wenn das Handy eine neue Version geschrieben hat (anderes `deviceId` bzw. `exportedAtMillis`). Eigene Schreibvorgänge ignorieren.
- Beim Zusammenführen mit einer Handy-Version gewinnen nur Felder, die am PC seit dem letzten Speichern geändert wurden (`dirtyMetaKeys`).

## Parität mit Android
- Android-Repo: github.com/paulhoehne2006-a11y/DocFlow, Branch `claude/eager-wozniak-so4azi`. Das Format lesen dort `StudioBundleMerge.kt` und `StudioCloudSyncCoordinator.kt` (`data/cloud/`).
- Konstanten und Verhalten müssen auf beiden Seiten gleich sein. Ändert sich eine davon, beide Apps anpassen:
  - Randnotizen auf jeder Seite (nicht im Endlos-Modus), 42 % der Seitenbreite
  - kleinste Ebenen-Deckkraft 10 %
  - Ordnerpfade werden ohne Beachtung von Groß- und Kleinschreibung zugeordnet
  - Audio-Marken mit `offsetMs` starten an dieser Stelle der Aufnahme
- Pinsel, Papiervorlagen und Farben aus dem Kotlin-Code übernehmen.
- Braucht ein neues Feature Unterstützung in Android, auch die Android-App ändern und dort Tests schreiben (`./gradlew testDebugUnitTest assembleDebug`).

## Schnittstellen
- Jede Funktion, die `src/js/app.js` auf `bridge` aufruft, muss mit exakt diesem Namen in `preload.js` UND in `src/js/demo-bridge.js` existieren, und umgekehrt. Nach jeder Änderung per Suche abgleichen.
- Für Pflicht-Funktionen der Bridge kein `?.`, weil das falsche Namen still verschluckt.

## Tests
- `npm test` muss grün sein. Neue Logik bekommt Tests in `test/`. Abgleich-Logik kommt nach `test/sync.test.mjs`, mit Dateien, die so aufgebaut sind wie die der Android-App.
- Neue Oberflächen- oder Betriebssystem-Wege bekommen einen Playwright-Test in `e2e/` (Demo-Bridge-Hooks: `_external`, `_triggerOpenExternal`).
- Vor „fertig“ einmal `npm start` ausführen und die Funktion selbst ausprobieren. Im Bericht trennen: selbst geprüft / nur durch Tests abgedeckt / nicht geprüft (z. B. echter Sync über Google Drive oder OneDrive).

## Release
- Version in `package.json` erhöhen und `RELEASE_NOTES.md` auf Deutsch aktualisieren.
- Vor Push, Tag oder Release fragen. Ein Release entsteht durch den Tag `vX.Y.Z` oder über workflow_dispatch mit dem Input `release`.
- Nicht umsetzen: Scannen, S-Pen-Air-Actions, direkter Cloud-Login.
