# Fluke Drift

See your boat's drift at a glance while drift fishing: a big arrow showing
which way and how fast you're moving, a projected line showing where you'll be
in 5, 10, and 15 minutes, and Windy-style animated wind across the map.

It's a web app: open it in Safari on your iPhone, then **Share → Add to Home
Screen** to launch it full screen like a regular app.

## How it works

| Piece | Source |
| --- | --- |
| **Drift** (speed + direction) | Your phone's GPS. Fixes from the last 30 s / 1 min / 2 min are fit with a straight line, so GPS jitter averages out. The *steady / settling / rough estimate* label shows how much to trust it. |
| **Wind** | [Open-Meteo](https://open-meteo.com/) forecast (free, no key). Its US blend includes NOAA's HRRR model. This is a **forecast**, not a live reading. |
| **"Drifting with the wind" / "Wind against current"** | Compares the drift direction with the downwind direction. |
| **Map** | **NOAA nautical chart** (default): NOAA's official charts from its pre-drawn tile cache. **NOAA Chart (live)** is a backup drawn on request by NOAA's Maritime Chart Service. Also: Esri Ocean basemap, satellite, or OpenStreetMap (layers button, top right). |

### Drift planner

Tap **Plan drift**, then tap the spot you want to fish over (a lump, wreck,
or edge on the chart). Using your measured drift, the app shows:

- a **START** point up-drift of the target, with the drift lane and a cone
  showing how sure it is of the direction
- **Run to start · 0.3 nm NW (323°)** while you get into position
- once you're drifting: **On line · over target in 1:20**, or
  **Passing 40 ft SE of target**, so you know which way to shift next time
- **Past the target** when it's time to run back up

Choose how long to drift before reaching the target (1–5 min) so baits are
on the bottom when you get there. The target can be dragged to adjust it.
The app notices when you're running under power (over ~5 kt) and starts a
fresh drift measurement when you stop.

The phone's motion sensors aren't used: they can't measure a steady drift.
GPS does that job.

### Limitations
- The app has to stay **open on screen**. iPhone pauses GPS for web apps when
  the screen locks. The app asks the phone to keep the screen awake while a
  drift is running.
- Wind is a forecast for the area, so it won't show a local gust or sea breeze
  the model missed.
- Offline: map tiles you've already looked at and the last wind forecast are
  saved on the phone, so it keeps working if you lose signal offshore.
- **Not for navigation.**

## Try it without a boat

Tap **Try demo (simulated)**, or open `…/?demo`. In the demo, after planning
a drift, **Run to start (demo)** motors the simulated boat to the start. Add `&fast=10` to speed up
the simulated clock.

## Project layout

```
index.html          the page
css/app.css         styling
js/app.js           wires everything together (map, HUD, settings)
js/drift.js         GPS fixes -> drift speed/direction (the core math)
js/wind.js          Open-Meteo wind forecast + interpolation
js/charts.js        NOAA nautical chart layers
js/planner.js       drift planner math (start point, closest approach)
js/particles.js     animated wind streaks
js/position.js      real GPS + demo simulator
js/geo.js           small geometry helpers
sw.js               offline support
vendor/leaflet/     map library (Leaflet 1.9.4, BSD-2-Clause)
tests/              unit tests (run: npm test, needs Node 18+)
```

There's no build step. To run locally: `npm run serve`, then open
http://localhost:8000 (location needs `localhost` or HTTPS).

## Hosting

Served as static files by GitHub Pages: **Settings → Pages → Deploy from a
branch → `main` / root**.

## Ideas for later
- NOAA tidal current predictions, with the current shown as its own arrow
- A time slider to preview wind and current over the next few hours
- Save good drifts and replay them
