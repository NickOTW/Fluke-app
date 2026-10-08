import test from 'node:test';
import assert from 'node:assert/strict';
import {
  angleDiff, bearingFromVector, compassPoint, destination, fromLocalMeters, toLocalMeters,
} from '../js/geo.js';

test('local meters round-trip', () => {
  const origin = { lat: 41, lon: -71.9 };
  const p = fromLocalMeters(origin, 350, -120);
  const m = toLocalMeters(origin, p);
  assert.ok(Math.abs(m.east - 350) < 1e-6);
  assert.ok(Math.abs(m.north + 120) < 1e-6);
});

test('bearings', () => {
  assert.equal(bearingFromVector(0, 1), 0);
  assert.equal(bearingFromVector(1, 0), 90);
  assert.equal(bearingFromVector(-1, -1), 225);
});

test('destination moves the right distance and direction', () => {
  const o = { lat: 41, lon: -71.9 };
  const d = toLocalMeters(o, destination(o, 135, 1000));
  assert.ok(Math.abs(Math.hypot(d.east, d.north) - 1000) < 0.01);
  assert.ok(Math.abs(bearingFromVector(d.east, d.north) - 135) < 1e-6);
});

test('angleDiff takes the short way round', () => {
  assert.equal(angleDiff(10, 350), 20);
  assert.equal(angleDiff(350, 10), -20);
  assert.equal(angleDiff(90, 90), 0);
});

test('compass points', () => {
  assert.equal(compassPoint(0), 'N');
  assert.equal(compassPoint(215), 'SW');
  assert.equal(compassPoint(359), 'N');
  assert.equal(compassPoint(100), 'E');
});
