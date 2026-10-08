// Position sources: the phone's real GPS, and a simulator for trying the app
// from the couch. Both call onFix({ t, lat, lon, accuracy }).

import { MS_PER_KNOT, destination } from './geo.js';

/** Start watching real GPS. Returns a stop() function. */
export function startGps(onFix, onError) {
  if (!('geolocation' in navigator)) {
    onError(new Error('This browser has no GPS access.'));
    return () => {};
  }
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix({
      t: pos.timestamp,
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    }),
    (err) => onError(err),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/** Human-readable message for a geolocation error. */
export function gpsErrorMessage(err) {
  if (err && err.code === 1) {
    return 'Location is blocked. On iPhone: Settings → Privacy & Security → '
      + 'Location Services → Safari Websites → "While Using", then reload.';
  }
  if (err && err.code === 2) return 'No GPS signal yet. Try moving to open sky.';
  if (err && err.code === 3) return 'Waiting for GPS…';
  return err?.message || 'GPS error.';
}

/**
 * Simulated drift with realistic GPS noise. The drift slowly wanders in speed
 * and direction, like a real tide-plus-wind drift does.
 *
 * timeScale > 1 runs the clock faster (handy for testing).
 */
export class DriftSimulator {
  constructor({
    origin = { lat: 41.02, lon: -71.86 }, // off Montauk Point
    speedKt = 0.9,
    bearing = 225,
    noiseM = 4,
    intervalMs = 1000,
    timeScale = 1,
  } = {}) {
    Object.assign(this, { origin, speedKt, bearing, noiseM, intervalMs, timeScale });
  }

  start(onFix) {
    let truePos = { ...this.origin };
    let simT = Date.now();
    const t0 = simT;
    const stepSec = (this.intervalMs / 1000) * this.timeScale;

    const tick = () => {
      simT += stepSec * 1000;
      const minutes = (simT - t0) / 60000;
      const speed = this.speedKt + 0.15 * Math.sin(minutes / 4);
      const bearing = this.bearing + 12 * Math.sin(minutes / 7);
      truePos = destination(truePos, bearing, speed * MS_PER_KNOT * stepSec);

      const noisy = destination(truePos, Math.random() * 360, Math.abs(gaussian()) * this.noiseM);
      onFix({ t: simT, lat: noisy.lat, lon: noisy.lon, accuracy: this.noiseM + Math.random() * 2 });
    };
    tick();
    const id = setInterval(tick, this.intervalMs);
    return () => clearInterval(id);
  }
}

function gaussian() {
  // Box–Muller transform.
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
