# DocFlow Studio für Windows

Scannen, Mitschreiben und Arbeitsblätter ausfüllen auf dem Handy mit der DocFlow-App – und
**am Windows-Laptop mit dem Stift weiterschreiben**. Gebaut für Touch-Laptops wie das
Galaxy Book mit S Pen, läuft aber auf jedem Windows-10/11-PC (Stift, Maus oder Touchpad).

## So funktioniert's

```
 Handy (DocFlow)                  Cloud                      Windows (DocFlow Studio)
 ───────────────                  ─────                      ────────────────────────
 scannen / schreiben  ──►  OneDrive oder Google Drive  ◄──►  Ordner „DocFlow Studio“
 Notizbuch speichern       Ordner „DocFlow Studio“           mit dem S Pen bearbeiten
         ◄────────── Änderungen kommen automatisch zurück ──────────┘
```

* Die Handy-App lädt jedes Notizbuch als `.docflownote` (plus PDF) in den Cloud-Ordner
  **„DocFlow Studio“**.
* OneDrive (in Windows eingebaut) bzw. **Google Drive für den Desktop** spiegelt diesen
  Ordner auf den PC. DocFlow Studio öffnet die Dateien direkt dort – ohne eigene Anmeldung.
* Was du am PC schreibst, wird automatisch gespeichert; der Sync-Client lädt es hoch und
  die Handy-App übernimmt die Änderungen seitenweise.
* Neben jedem Notizbuch liegt ein aktuelles **PDF** – zum Teilen oder Drucken.

> **OneDrive empfohlen.** Mit Google Drive sieht die Handy-App aus Datenschutzgründen nur
> Dateien, die sie selbst angelegt hat: Notizbücher vom Handy kannst du am PC bearbeiten,
> **neu am PC angelegte** Notizbücher erscheinen am Handy aber nur über OneDrive.

## Funktionen

* **S Pen / Windows Ink**: Druckstärke, Neigung (Bleistift-Schattierung, Kalligrafie-Feder),
  Seitentaste = Radierer (abschaltbar), Radierer-Ende des Stifts
* **Handballenerkennung**: Solange der Stift aufliegt, werden Berührungen ignoriert;
  mit den Fingern wird gescrollt und mit zwei Fingern gezoomt
* **Stifte wie am Handy**: Füller, Fineliner, Kugelschreiber, Bleistift, Pinselstift,
  Kalligrafie, Textmarker – gleiche Darstellung wie in der App
* **Radierer, Lasso** (Auswahl verschieben/löschen), **Rückgängig/Wiederholen**
* **Ebenen** wie in Photoshop: „Hintergrund“, „Ebene 1“, „Ebene 2“ … – ein-/ausblenden,
  sperren, umbenennen, hinzufügen, löschen
* **Gescannte PDFs** und Arbeitsblätter als Hintergrund (scharf in jeder Zoomstufe)
* **PDF öffnen** → wird ein neues Notizbuch; **Neues Notizbuch** mit Papiervorlage
  (kariert, liniert, gepunktet, Cornell, Koordinaten, Noten)
* **Als PDF speichern** (Vektor-PDF, Text im Arbeitsblatt bleibt markierbar)
* Gleichzeitige Änderungen am Handy werden beim Speichern zusammengeführt statt
  überschrieben
* Hell/Dunkel nach Windows-Einstellung, Deutsch/Englisch

**Nicht auf Windows:** Scannen (macht das Handy). Bilder, Audio und Textfelder aus der
Handy-App bleiben beim Bearbeiten erhalten, Bilder werden aber noch nicht angezeigt.

### Tastenkürzel

| Taste | Aktion |
|---|---|
| `P` / `H` / `E` / `L` | Stift / Textmarker / Radierer / Lasso |
| `Strg+Z`, `Strg+Y` | Rückgängig, Wiederholen |
| `Strg+S` | Sofort speichern |
| `Strg +` / `Strg -` / `Strg 0` | Zoom / Seitenbreite |
| `Leertaste` gedrückt + ziehen | Verschieben |
| `Bild↑` / `Bild↓` | Vorherige / nächste Seite |
| `Entf` | Auswahl löschen |
| `F11` | Vollbild |

Zweimal auf das Stift-Symbol tippen öffnet die Auswahl der Stiftarten. Doppelklick auf den
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

## Entwickeln

```bash
npm install      # lädt Electron und kopiert pdf.js / pdf-lib / fflate nach src/vendor
npm start        # App starten
npm test         # Tests für Dateiformat, Zusammenführen und PDF-Export
npx electron-builder --win --x64   # Installer bauen (unter Windows)
```

Im Browser lässt sich die Oberfläche ohne Electron ausprobieren
(`python -m http.server` in `src/`) – dann mit Demo-Notizbüchern im Speicher.

Aufbau:

| Datei | Inhalt |
|---|---|
| `main.js`, `preload.js` | Fenster, Ordnerwahl, Dateizugriff (nur Dateinamen im gewählten Ordner) |
| `src/js/model.js` | `.docflownote` lesen/schreiben (verlustfrei), Seiten/Ebenen, Zusammenführen |
| `src/js/render.js` | Stifte, Papiervorlagen, Treffertest – portiert aus der Android-App |
| `src/js/editor.js` | Zeichenfläche, Stifteingabe, Gesten, Werkzeuge, Rückgängig |
| `src/js/export.js` | Vektor-PDF mit pdf-lib |
| `src/js/pdfbg.js` | PDF-Hintergründe mit pdf.js |
| `src/js/app.js` | Bibliothek, Einrichtung, Werkzeugleiste, Ebenen, Speichern |

Das Dateiformat ist mit der Android-App
([DocFlow](https://github.com/paulhoehne2006-a11y/DocFlow)) abgestimmt: Unbekannte Felder
und Dateien bleiben erhalten, bearbeitete Seiten bekommen einen neuen `updatedAt`-Zeitstempel,
und `deviceId` im Manifest zeigt der Handy-App, dass die Datei woanders geändert wurde.
