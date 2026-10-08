import test from 'node:test';
import assert from 'node:assert/strict';
import { DriftTracker } from '../js/drift.js';
import { MS_PER_KNOT, angleDiff, destination, toLocalMeters } from '../js/geo.js';

// Deterministic pseudo-random noise so tests never flake.
function rng(seed) {
  let s = seed;
  return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
}

function drift({ speedKt, bearing, seconds, noiseM = 4, seed = 1 }) {
  const rand = rng(seed);
  const start = { lat: 41.02, lon: -71.86 };
  const t0 = 1_700_000_000_000;
  const fixes = [];
  for (let s = 0; s <= seconds; s += 1) {
    const truth = destination(start, bearing, speedKt * MS_PER_KNOT * s);
    const noisy = destination(truth, rand() * 360, rand() * noiseM * 1.5);
    fixes.push({ t: t0 + s * 1000, lat: noisy.lat, lon: noisy.lon, accuracy: noiseM });
  }
  return fixes;
}

test('no estimate until there is enough data', () => {
  const tr = new DriftTracker({ windowSec: 60 });
  drift({ speedKt: 1, bearing: 200, seconds: 5 }).forEach((f) => tr.addFix(f));
  assert.equal(tr.estimate(), null);
});

test('recovers a 1 kt SW drift through 4 m GPS noise', () => {
  const tr = new DriftTracker({ windowSec: 60 });
  drift({ speedKt: 1, bearing: 225, seconds: 90 }).forEach((f) => tr.addFix(f));
  const est = tr.estimate();
  assert.ok(est);
  assert.ok(Math.abs(est.speedKt - 1) < 0.15, `speed ${est.speedKt}`);
  assert.ok(Math.abs(angleDiff(est.bearing, 225)) < 10, `bearing ${est.bearing}`);
  assert.equal(est.quality, 'good');
});

test('slow 0.3 kt drift is still found with a 2 minute window', () => {
  const tr = new DriftTracker({ windowSec: 120 });
  drift({ speedKt: 0.3, bearing: 80, seconds: 150, seed: 7 }).forEach((f) => tr.addFix(f));
  const est = tr.estimate();
  assert.ok(Math.abs(est.speedKt - 0.3) < 0.1, `speed ${est.speedKt}`);
  assert.ok(Math.abs(angleDiff(est.bearing, 80)) < 20, `bearing ${est.bearing}`);
});

test('smoothed position is close to the true position', () => {
  const tr = new DriftTracker({ windowSec: 60 });
  const fixes = drift({ speedKt: 1, bearing: 225, seconds: 90, noiseM: 0 });
  drift({ speedKt: 1, bearing: 225, seconds: 90 }).forEach((f) => tr.addFix(f));
  const truth = fixes[fixes.length - 1];
  const d = toLocalMeters(truth, tr.estimate().position);
  assert.ok(Math.hypot(d.east, d.north) < 4);
});

test('rejects inaccurate fixes, time going backwards, and teleports', () => {
  const tr = new DriftTracker({ maxAccuracyM: 30 });
  const t = 1_700_000_000_000;
  assert.equal(tr.addFix({ t, lat: 41, lon: -71, accuracy: 5 }), true);
  assert.equal(tr.addFix({ t: t + 1000, lat: 41, lon: -71, accuracy: 80 }), false);
  assert.equal(tr.addFix({ t: t - 1000, lat: 41, lon: -71, accuracy: 5 }), false);
  assert.equal(tr.addFix({ t: t + 2000, lat: 41.01, lon: -71, accuracy: 5 }), false); // 1.1 km in 2 s
  assert.equal(tr.rejected, 3);
});

test('projection follows the drift', () => {
  const tr = new DriftTracker({ windowSec: 60 });
  drift({ speedKt: 1, bearing: 90, seconds: 60, noiseM: 0 }).forEach((f) => tr.addFix(f));
  const est = tr.estimate();
  const p = DriftTracker.project(est, 10);
  const d = toLocalMeters(est.position, p);
  assert.ok(Math.abs(d.east - 1 * MS_PER_KNOT * 600) < 1);
  assert.ok(Math.abs(d.north) < 1);
});
