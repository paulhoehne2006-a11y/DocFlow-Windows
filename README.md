# DocFlow Studio für Windows

Scannen, Mitschreiben und Arbeitsblätter ausfüllen auf dem Handy mit der DocFlow-App – und
**am Windows-Laptop mit dem Stift weiterschreiben**. Gebaut für Touch-Laptops wie das
Galaxy Book mit S Pen, läuft aber auf jedem Windows-10/11-PC (Stift, Maus oder Touchpad).

## So funktioniert's

```
 Handy (DocFlow)                  Cloud                      Windows (DocFlow Studio)
 ───────────────                  ─────                      ────────────────────────
 scannen / schreiben  ──►  OneDrive / Google Drive     ◄──►  Ordner „DocFlow Studio“
 Notizbuch speichern       Nextcloud / Dropbox / iCloud      mit dem S Pen bearbeiten
         ◄────────── Änderungen kommen automatisch zurück ──────────┘
```

* Die Handy-App lädt jedes Notizbuch als `.docflownote` (plus PDF) in den Cloud-Ordner
  **„DocFlow Studio“**.
* OneDrive, Google Drive für den Desktop, Nextcloud, Dropbox oder iCloud Drive spiegeln diesen
  Ordner auf den PC. DocFlow Studio öffnet die Dateien direkt dort – ohne eigene Anmeldung.
* Was du am PC schreibst, wird automatisch gespeichert (inkl. rotierender Sicherheits-Backups);
  der Sync-Client lädt es hoch und die Handy-App übernimmt die Änderungen seitenweise.
* Verschachtelte Ordner, Favoriten und der OCR-Suchindex werden Android-kompatibel in
  `.docflow-workspace.json` und im Bundle-Manifest abgelegt, ohne Dateien in Unterordner zu
  verschieben.

> **OneDrive empfohlen.** Mit Google Drive sieht die Handy-App aus Datenschutzgründen nur
> Dateien, die sie selbst angelegt hat: Notizbücher vom Handy kannst du am PC bearbeiten,
> **neu am PC angelegte** Notizbücher erscheinen am Handy aber nur über OneDrive.

## Flagship-Funktionen (v2.0.0)

* **1:1 Android Editorial Design & Windows Pro-Shell**:
  * 3 Farbschemata: *Anthracite Dark (`#0E1117`)*, *Crisp Editorial Light (`#F5F6FA`)* und *Pure OLED Schwarz (`#000000`)*
  * Rahmenlose Titelleiste mit **Multi-Tab-Leiste**, **Split-Screen** (mit ziehbarem Teiler für 2 Notizbücher parallel) und **Befehlspalette (`Strg+K`)**
* **120Hz+ S Pen & Windows Ink**:
  * Druckstärke, Neigung (Bleistift-Schattierung, Kalligrafie-Feder), konfigurierbare S-Pen-Seitentaste (Radierer, Lasso, Rückgängig, Radial-Menü), Handballenerkennung
  * 7 Stifte (Füller, Fineliner, Kugelschreiber, Bleistift, Pinselstift, Kalligrafie, Textmarker) + **Favoriten-Stiftleiste** für 1-Klick-Wechsel
  * **Hold-to-Snap Formerkennung** (Linie, Pfeil, Rechteck, Kreis/Ellipse, Dreieck beim kurzen Halten am Strichende) & **Scribble-to-Erase** (Durchstreichen zum Radieren)
  * **Virtuelles Geodreieck**: Verschieben, Drehen (Ecken oder Mausrad), magnetisches Einrasten an der Zeichenkante
* **Lern- & Studienfunktionen**:
  * **Dark Paper (Nachtpapier)** mit intelligenter Tinten- und PDF-Kontrastanpassung
  * **PDF-Notizrand**: ausklappbare Notizspalte rechts neben PDF-Arbeitsblättern
  * **Seiten-Modus (A4) & Endlos-Fläche (Infinite Canvas)** mit 7 Papiervorlagen (Blanko, Kariert, Liniert, Gepunktet, Cornell, Koordinaten, Noten)
  * **Lern-Abdeckband (`TAPE_OCCLUSION`) & Lern-Modus**: Formeln oder Vokabeln abdecken und per Klick einzeln oder gesammelt aufdecken
  * **Textboxen, Sticky Notes & Checklisten** sowie **eingebettete Bilder** (Verschieben, Skalieren, Drehen) und **Laserpointer**
  * **Vorlesungs-Audio-Sync**: Audio aufnehmen oder Android-Aufnahmen (`.m4a`/`.webm`) abspielen – inkl. **Stift-Sprung** (`audioOffsetMs`) per Klick auf einen Strich
  * **100 % Offline-Handschrift-OCR**: lokale Texterkennung über `Windows.Media.Ocr` + PDF-Textextraktion für globale Volltextsuche und „Handschrift → Text“
* **Organisation, Sicherheit & Export-Studio**:
  * Verschachtelter Ordner-Baum, Favoriten, 30-Tage-Papierkorb (`.docflow-trash/`) und automatische Versions-Backups (bis zu 5 Kopien pro Notizbuch)
  * **Export-Studio**: Vektor-PDF, PNG-Einzelseite oder `.docflownote`-Bundle mit selektiver Ebenen-Auswahl (*Alle sichtbaren*, *Alle Ebenen*, *Nur Hintergrund / Blanko zum Üben*, *Ohne Hintergrund / Nur eigene Notizen*)

### Tastenkürzel

| Taste | Aktion |
|---|---|
| `Strg+K` | Befehlspalette & globale Handschrift-/Notizbuchsuche |
| `P` / `H` / `E` / `L` / `G` | Stift / Textmarker / Radierer / Lasso / Geodreieck |
| `Strg+Z`, `Strg+Y` | Rückgängig, Wiederholen |
| `Strg+S` | Sofort speichern |
| `Strg +` / `Strg -` / `Strg 0` | Zoom / Seitenbreite |
| `Leertaste` gedrückt + ziehen | Verschieben |
| `Bild↑` / `Bild↓` | Vorherige / nächste Seite |
| `Entf` | Auswahl löschen |
| `F11` | Vollbild |

Doppelklick auf das Stift-Symbol öffnet die Auswahl der Stiftarten. Doppelklick auf den
Titel oder einen Ebenennamen benennt um.

## Installieren

1. Unter **Actions → „Build Windows app“** den neuesten Lauf öffnen und das Artefakt
   **DocFlow-Studio-Windows** herunterladen (oder ein Release unter **Releases**).
2. `DocFlow-Studio-Setup-x.y.z.exe` ausführen. Da die App nicht signiert ist, zeigt
   Windows SmartScreen eine Warnung: **Weitere Informationen → Trotzdem ausführen**.
   Alternativ die `…-portable.exe` ohne Installation starten.
3. Beim ersten Start den Ordner **OneDrive\DocFlow Studio** (bzw. Google Drive →
   *Meine Ablage\DocFlow Studio*) wählen.
4. Am Handy in DocFlow: **Studio → Cloud → „Notizbücher automatisch syncen“** einschalten.

## Entwickeln & Testen

```bash
npm install               # lädt Abhängigkeiten und kopiert pdf.js / pdf-lib / fflate nach src/vendor
npm run build:icons       # erzeugt Multi-Size build/icon.ico
npm start                 # Electron-App starten
npm test                  # 48 Node-Unit- & Integrationstests
npx playwright test       # 45 Playwright-E2E- & Barrierefreiheits-Tests
npm run dist              # NSIS-Installer + Portable .exe bauen
```

Aufbau:

| Datei | Inhalt |
|---|---|
| `main.js`, `preload.js` | Rahmenloses Fenster, Cloud-Ordner, Backups, 30d-Papierkorb, WinRT-OCR, Updates |
| `src/js/model.js` | `.docflownote`-Bundle lesen/schreiben/mergen, Bilder, Audio, Seiten & Ebenen |
| `src/js/folders.js` | Verschachtelte Ordner-Hierarchie, Favoriten, Sortierung & Volltext-/OCR-Filter |
| `src/js/shapes.js` | Hold-to-Snap Formerkennung & Scribble-to-Erase Gestenerkennung |
| `src/js/geodreieck.js` | Virtuelles Geodreieck (Winkel-Snapping, Projektion, Canvas-Overlay) |
| `src/js/render.js` | 7 Stifte, 7 Vorlagen (A4 & Infinite), Dark Paper, Notizrand, Bilder, Textboxen, Tapes |
| `src/js/editor.js` | Multi-Instance 120Hz+ Canvas-Editor, S-Pen, Geodreieck, Audio-Sync, Undo/Redo |
| `src/js/audio.js` | Vorlesungs-Audio-Aufnahme & Wiedergabe mit `audioOffsetMs` Stift-Sprung |
| `src/js/ocr.js` | Offline-Handschrift-OCR & PDF-Text-Indizierung |
| `src/js/export.js` | Selektiver Vektor-PDF- & PNG-Export (`EXPORT_LAYER_MODES`) |
| `src/js/i18n.js` | Vollständige DE/EN-Lokalisierung mit Live-Umschaltung |
| `src/js/app.js` | Multi-Tab-Shell, Split-Screen, Bibliothek, Befehlspalette, Modals & Panels |
| `src/js/demo-bridge.js` | Browser- & Playwright-E2E-Stand-in für `window.docflow` |
