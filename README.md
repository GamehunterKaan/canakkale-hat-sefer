# Çanakkale Hat & Sefer

A mobile-first progressive web app for Çanakkale's public bus network — live tracking, trip planning, schedules, and push notifications, all in a single HTML file with no app store required.

![Default Tab](screenshots/map.png)

---

## The Problem

Çanakkale's municipal bus system has no official app. Passengers are left with:

- A PDF timetable buried on the municipality website, updated seasonally
- No way to know where a bus actually is right now
- No trip planner — figuring out which bus to take from A to B requires knowing the network by memory
- No alerts when a bus is approaching

This app solves all of that.

---

## Features

### 📅 Seferler — Live Schedule

Automatically downloads and parses the municipality's PDF timetables. Shows all routes with departure times split by direction, highlights the next upcoming departure in blue, and greys out times that have already passed. Separate weekday and weekend tabs. Refreshes at midnight automatically.

Each route card has a **🚌 Canlı** button that jumps straight to the live tracker for that line.

![Schedule tab showing route cards with departure times](screenshots/seferler.png)

---

### 🗺 Rota & Durak — Trip Planner

Tap the map (or use GPS) to set your starting point and destination. The planner finds every direct route that connects them, sorted by **total ETA** — walking time + wait for the next bus + ride time + walking to destination.

- **Plan ahead** — use the time offset buttons (+30 dk, +1 sa, +2 sa) to plan for later
- **Live bus data** — shows which buses are approaching your boarding stop right now
- **Scheduled fallback** — when no live data is available, uses the timetable to estimate wait time

![Trip planner showing route options sorted by ETA](screenshots/planner.png)

---

### 🔍 Trip Detail

Tap any route to see a full breakdown:

- Walk to boarding stop
- ⏱ Wait time — live bus position or next scheduled departure with estimated arrival at your stop
- Ride (number of stops)
- Walk to destination
- Total estimated journey time
- Stop timeline with live bus positions marked

![Trip detail showing journey steps and live bus position](screenshots/trip-detail.png)

---

### 🔴 Live Bus Tracker

Opens from either the Seferler tab (🚌 Canlı button) or the trip planner. Draws the full route on the map and shows all active buses as moving dots. Direction buttons let you switch between outbound and inbound. Refreshes every 15 seconds automatically.

![Live tracker showing bus route on map with moving bus markers](screenshots/tracker.png)

---

### 🔔 Push Notifications

Tap **🔕 Bildir** on any trip detail to subscribe to arrival alerts. Notifications fire when your bus is **10, 5, and 2 stops away** — even when your phone screen is off.

Powered by a Cloudflare Worker (free tier) that polls the kentkart API every minute and delivers notifications through Google FCM / Apple APNs — the same always-on channel used by WhatsApp and email.

---

### ⭐ Saved Locations

Save home, work, or any frequent destination. Appears as a dropdown in the planner — tap 📍 or 🏁 to instantly set it as your start or end point without touching the map.

---

## Architecture

```
GitHub Pages          Cloudflare Worker (free)      Kentkart API
──────────────        ─────────────────────────      ────────────
app.html    ──────►  POST /subscribe                GET /pathInfo
sw.js                  stores in KV
                      
                      cron: every 1 min ──────────► GET /pathInfo
                        checks bus position
                        sends Web Push ──────────────────────────────►
                                                          Google FCM
                                                               │
                                                               ▼
                                                        Your phone 🔔
```

Everything except the notification worker runs entirely in the browser. No backend, no database, no user accounts.

---

## Tech

- **PDF parsing** — [pdf.js](https://mozilla.github.io/pdf.js/) runs in the browser, parses the municipality's timetable PDFs directly
- **Maps** — [Leaflet](https://leafletjs.com/) with OpenStreetMap tiles
- **Live data** — [Kentkart](https://kentkart.com) public API (same data used by physical stop displays)
- **Push** — Web Push (RFC 8030/8291/8292) via Cloudflare Workers
- **Zero dependencies** at runtime — no frameworks, no build step
