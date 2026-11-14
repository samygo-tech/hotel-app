# Hotel & Booking Management System

Node.js + Express + SQLite. Manage hotels, room types, seasonal rates, guests and bookings
(with availability checks, price suggestions and margins) from one password-protected page.

## Project layout
```
server.js        Express server: login, security headers, static files, API routing
api.js           SQLite schema, validation and CRUD logic
public/          index.html, style.css, app.js (the single-page interface)
render.yaml      Render blueprint (service, disk, environment variables)
package.json     dependencies and "npm start"
```

## Run it locally
```
npm install
ADMIN_PASSWORD=choose-a-password npm start      # Windows PowerShell: $env:ADMIN_PASSWORD="..."; npm start
```
Open http://localhost:3000. Data is stored in `data/hotel.db`.

## Deploy on Render (auto-redeploys on every push)
1. Create a GitHub repository and push this folder to it (`git init`, `git add .`, `git commit`, `git push`).
2. In Render choose **New > Blueprint**, connect your GitHub account and select the repository.
   Render reads `render.yaml`, which sets up the web service, a 1 GB persistent disk and the environment variables.
3. When asked, enter a strong **ADMIN_PASSWORD**. (`SESSION_SECRET` is generated for you.)
4. Click **Apply**. When the build finishes, open the `onrender.com` address Render shows and sign in.
5. From now on, every `git push` to the connected branch redeploys the app automatically,
   and your data is kept because the database file is on the disk.

Prefer manual setup? New > Web Service, build command `npm install`, start command `npm start`,
plan Starter or higher, add a Disk mounted at `/var/data`, and set `DB_PATH=/var/data/hotel.db`,
`ADMIN_PASSWORD`, `SESSION_SECRET` and `NODE_VERSION=22`.

**Important:** Render's free plan cannot attach a disk, so the database would be wiped on each deploy or restart.
Use a paid plan for real bookings.

## Backups
Use **Download backup** in the app header regularly (it saves all data as a JSON file),
and keep an eye on Render's disk snapshot settings for your service.

## Notes
- One shared admin password; sessions last 12 hours; 10 wrong attempts per IP are blocked for 15 minutes.
- A room is counted as occupied for Pending, Confirmed and Checked-in bookings. Checked-out and Cancelled bookings free it.
- Prices are plain numbers (no currency symbol), per room per night.
