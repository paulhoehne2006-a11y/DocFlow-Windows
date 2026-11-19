Notizbücher vom Handy am Windows-Laptop mit dem Stift weiterschreiben – gebaut für Touch-Laptops mit S Pen (z. B. Galaxy Book), läuft auf jedem Windows-10/11-PC.

## Installieren
1. **DocFlow-Studio-Setup-x.y.z.exe** herunterladen und ausführen (oder die **…-portable.exe** ohne Installation).
2. Die App ist nicht signiert: Bei SmartScreen **Weitere Informationen → Trotzdem ausführen**. Ist *Smart App Control* aktiv, blockiert Windows die App – dann unter Windows-Sicherheit → App- & Browsersteuerung → Smart App Control ausschalten.
3. Beim ersten Start den Ordner **„DocFlow Studio“** in OneDrive, Google Drive (*Meine Ablage*), Nextcloud, Dropbox oder iCloud Drive wählen.
4. Am Handy in DocFlow: **Studio → Cloud → „Notizbücher automatisch syncen“** einschalten.

Für Offline-Arbeit mit Google Drive: Rechtsklick auf den Ordner → *Offlinezugriff → Offline verfügbar*.

## Neu in v2.0.1 (Abgleich PC ↔ Handy)
- **Ordner und Favoriten gleichen sich jetzt zwischen PC und Handy ab.** Verschieben, Stern setzen, Ordner umbenennen oder löschen wird direkt in die Notizbuch-Datei geschrieben. Am Handy angelegte Ordner erscheinen am PC automatisch. Beim ersten Start übernimmt die App bestehende PC-Ordner und -Favoriten einmalig in die Dateien.
- **Doppelklick auf eine `.docflownote`-Datei öffnet das Notizbuch.** Dateien außerhalb des DocFlow-Ordners werden als Kopie übernommen und überschreiben nie ein anderes Notizbuch.
- **Ein offenes Notizbuch übernimmt Änderungen vom Handy**, ohne sie mit eigenen alten Werten zu überschreiben. Nur am PC geänderte Angaben haben Vorrang.
- **Randnotizen wie am Handy:** auf jeder Seite (nicht nur bei PDFs) und 42 % der Seitenbreite breit.
- **Audio-Marken vom Handy** starten an der richtigen Stelle der Aufnahme.
- Das Symbol des Maximieren-Knopfs wechselt jetzt mit dem Fensterzustand.

## Highlights in v2.0.0 (Flagship Release)
- **Editorial Design & Pro-Shell**: Anthracite Dark, Crisp Light & Pure OLED Themes, rahmenlose Titelleiste mit **Multi-Tab-Leiste**, **Split-Screen** (2 Notizbücher parallel mit ziehbarem Teiler) und **Befehlspalette (`Strg+K`)**
- **S Pen & Geometrie**: 7 Stifte + **Favoriten-Stiftleiste**, Laserpointer, Strich- & Bereichs-Radierer, Lasso (Verschieben, Duplizieren, Umfärben, OCR), **Hold-to-Snap Formerkennung**, **Scribble-to-Erase** und **virtuelles Geodreieck**
- **Papier & Arbeitsblätter**: 7 Papiervorlagen im **A4-Seitenmodus** und als **Endlos-Fläche (Infinite Canvas)**, **Dark Paper (Nachtpapier)**, ausklappbare **Randnotizen** und PDF-Seiten anhängen
- **Lernen, Medien & Audio**: **Lern-Abdeckbänder (Study Mode)**, **Textboxen / Sticky Notes / Checklisten**, **eingebettete Bilder** (inkl. Skalieren & Drehen) und **Vorlesungs-Audio** mit Stift-Sprung (`audioOffsetMs`)
- **Offline-Handschrift-OCR**: lokale Texterkennung über `Windows.Media.Ocr` + PDF-Textsuche komplett ohne Cloud-Zwang
- **Organisation & Export-Studio**: verschachtelte Ordner-Hierarchie, Favoriten, 30-Tage-Papierkorb, automatische Sicherheits-Backups sowie selektiver Vektor-PDF-, PNG- und `.docflownote`-Export (inkl. *Blanko zum Üben* und *Nur eigene Notizen*)

## Hinweise
- Kein Kamera-Scanner unter Windows (Scannen erfolgt über die DocFlow-Android-App).
- Ordner und Favoriten gleichen sich nur mit der aktuellen DocFlow-Android-Version ab; ältere Versionen ignorieren diese Angaben einfach.
- Mit Google Drive erscheinen **am PC neu angelegte** Notizbücher aus Datenschutzgründen nicht automatisch auf dem Handy – über OneDrive funktioniert der Sync in beide Richtungen.
