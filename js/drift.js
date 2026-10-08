// Turns a stream of noisy GPS fixes into a steady drift vector.
//
// A phone GPS fix wobbles by a few meters, while a boat drifting at 1 kt only
// moves ~0.5 m per second, so fix-to-fix differences are useless. Instead we
// fit a straight line (position vs. time) through every fix in a rolling
// window. The slope of that line is the drift velocity, and the scatter of the
// fixes around it tells us how much to trust it.

import {
  MS_PER_KNOT, bearingFromVector, fromLocalMeters, toLocalMeters,
} from './geo.js';

const MAX_PLAUSIBLE_SPEED_MS = 25; // ~50 kt; anything faster is a GPS glitch
const TRAIL_MIN_SPACING_M = 3;
const TRAIL_MAX_POINTS = 5000;

export class DriftTracker {
  constructor({ windowSec = 60, maxAccuracyM = 30 } = {}) {
    this.windowSec = windowSec;
    this.maxAccuracyM = maxAccuracyM;
    this.reset();
  }

  reset() {
    this.fixes = [];
    this.trail = [];
    this.rejected = 0;
  }

  setWindow(sec) {
    this.windowSec = sec;
  }

  /**
   * Add a GPS fix: { t: epoch ms, lat, lon, accuracy: meters }.
   * Returns true if the fix was accepted.
   */
  addFix(fix) {
    const last = this.fixes[this.fixes.length - 1];
    const accuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : this.maxAccuracyM;

    if (accuracy > this.maxAccuracyM) return this._reject();
    if (last && fix.t <= last.t) return this._reject();
    if (last) {
      const d = toLocalMeters(last, fix);
      const speed = Math.hypot(d.east, d.north) / ((fix.t - last.t) / 1000);
      if (speed > MAX_PLAUSIBLE_SPEED_MS) return this._reject();
    }

    const accepted = { t: fix.t, lat: fix.lat, lon: fix.lon, accuracy: Math.max(accuracy, 1) };
    this.fixes.push(accepted);
    this._addToTrail(accepted);

    // Keep a little more than one window so changing the window works instantly.
    const keepAfter = fix.t - Math.max(this.windowSec, 300) * 1000;
    while (this.fixes.length && this.fixes[0].t < keepAfter) this.fixes.shift();
    return true;
  }

  get latestFix() {
    return this.fixes[this.fixes.length - 1] ?? null;
  }

  /**
   * Current drift estimate, or null if there isn't enough data yet.
   *   speedMs / speedKt  speed over ground
   *   bearing            direction of travel, degrees true
   *   east / north       velocity components, m/s
   *   uncertaintyKt      rough 1-sigma uncertainty of the speed
   *   quality            'good' | 'fair' | 'poor'
   *   position           best-fit (smoothed) current position {lat, lon}
   *   spanSec, count     how much data went into the estimate
   */
  estimate() {
    const latest = this.latestFix;
    if (!latest) return null;

    const since = latest.t - this.windowSec * 1000;
    const win = this.fixes.filter((f) => f.t >= since);
    const spanSec = (latest.t - win[0].t) / 1000;
    const minSpan = Math.min(15, this.windowSec / 2);
    if (win.length < 4 || spanSec < minSpan) return null;

    // Weighted least squares, separately for east and north.
    // Weight = 1/accuracy² so sharp fixes count more than fuzzy ones.
    const origin = latest;
    let W = 0; let St = 0; let Sx = 0; let Sy = 0;
    const pts = win.map((f) => {
      const m = toLocalMeters(origin, f);
      const p = { t: (f.t - latest.t) / 1000, x: m.east, y: m.north, w: 1 / (f.accuracy * f.accuracy) };
      W += p.w; St += p.w * p.t; Sx += p.w * p.x; Sy += p.w * p.y;
      return p;
    });
    const tBar = St / W; const xBar = Sx / W; const yBar = Sy / W;

    let Stt = 0; let Stx = 0; let Sty = 0;
    for (const p of pts) {
      const dt = p.t - tBar;
      Stt += p.w * dt * dt;
      Stx += p.w * dt * (p.x - xBar);
      Sty += p.w * dt * (p.y - yBar);
    }
    if (Stt <= 0) return null;
    const vx = Stx / Stt;
    const vy = Sty / Stt;

    // Scatter around the fitted line -> uncertainty of the slope.
    let chi2 = 0;
    for (const p of pts) {
      const dt = p.t - tBar;
      const rx = p.x - (xBar + vx * dt);
      const ry = p.y - (yBar + vy * dt);
      chi2 += p.w * (rx * rx + ry * ry);
    }
    const dof = Math.max(1, 2 * pts.length - 4);
    const varSlope = (chi2 / dof) / Stt; // per axis
    const uncertaintyMs = Math.sqrt(2 * varSlope);

    const speedMs = Math.hypot(vx, vy);
    const uncertaintyKt = uncertaintyMs / MS_PER_KNOT;
    let quality = 'poor';
    if (uncertaintyKt < 0.1) quality = 'good';
    else if (uncertaintyKt < 0.25) quality = 'fair';

    // Smoothed position = fitted line evaluated at the latest fix time (t = 0).
    const position = fromLocalMeters(origin, xBar - vx * tBar, yBar - vy * tBar);

    return {
      speedMs,
      speedKt: speedMs / MS_PER_KNOT,
      bearing: bearingFromVector(vx, vy),
      east: vx,
      north: vy,
      uncertaintyKt,
      quality,
      position,
      spanSec,
      count: pts.length,
    };
  }

  /** Where the boat will be after `minutes` if the drift holds. */
  static project(estimate, minutes) {
    const s = minutes * 60;
    return fromLocalMeters(estimate.position, estimate.east * s, estimate.north * s);
  }

  _reject() {
    this.rejected += 1;
    return false;
  }

  _addToTrail(fix) {
    const last = this.trail[this.trail.length - 1];
    if (last) {
      const d = toLocalMeters(last, fix);
      if (Math.hypot(d.east, d.north) < TRAIL_MIN_SPACING_M) return;
    }
    this.trail.push({ lat: fix.lat, lon: fix.lon, t: fix.t });
    if (this.trail.length > TRAIL_MAX_POINTS) this.trail.shift();
  }
}
