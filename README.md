# CashCtrl-AI

Lokale Web-Anwendung für das Review von CashCtrl-Buchungen und den automatisierten Beleg-Upload.

## Start

```bash
npm install
npm start
```

Danach im Browser öffnen: [http://localhost:3000](http://localhost:3000) (falls belegt: [http://localhost:3847](http://localhost:3847))

## Einrichtung

1. In CashCtrl unter **Einstellungen → Benutzer & Rollen** einen API-Benutzer anlegen.
2. In CashCtrl-AI unter **Einstellungen** Subdomain und API-Key speichern.
3. Verbindung testen (Abruf von `/api/v1/account/list.json`).

Der API-Key wird lokal per AES-256-GCM verschlüsselt in `data/cashctrl-ai.db` abgelegt. Der Schlüssel liegt in `data/.key`.

## Module

- **Dashboard:** Status, offene Reviews, zuletzt verarbeitete Belege
- **Buchhaltungs-Review:** Journal-Einträge eines Zeitraums prüfen, Auffälligkeiten freigeben oder als Korrektur nach CashCtrl senden
- **Beleg-Upload:** PDF/Scan analysieren, Buchungsvorschlag prüfen, erst nach «Manuelles Okay & Buchen» in CashCtrl schreiben
- **Einstellungen:** API-Zugang und Standardkonten

## Technik

- Node.js, Express, Axios
- SQLite (eingebautes `node:sqlite`)
- Vanilla JS + Tailwind CSS
