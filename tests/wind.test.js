import test from 'node:test';
import assert from 'node:assert/strict';
import { WindField, flowFromMet, windGridRequest } from '../js/wind.js';

function fakeResponse(req, { speed = 10, from = 180, gust = 15, hours = 3 } = {}) {
  const t0 = 1_700_000_000;
  return Array.from({ length: req.rows * req.cols }, () => ({
    hourly: {
      time: Array.from({ length: hours }, (_, i) => t0 + i * 3600),
      wind_speed_10m: Array.from({ length: hours }, (_, i) => speed + i * 2),
      wind_direction_10m: Array(hours).fill(from),
      wind_gusts_10m: Array(hours).fill(gust),
    },
  }));
}

test('south wind flows north', () => {
  const f = flowFromMet(10, 180);
  assert.ok(Math.abs(f.u) < 1e-9);
  assert.ok(Math.abs(f.v - 10) < 1e-9);
});

test('grid request covers a minimum area and has n*n points', () => {
  const req = windGridRequest({ south: 41, north: 41.01, west: -72, east: -71.99 }, 5);
  assert.ok(req.bounds.north - req.bounds.south >= 0.3 - 1e-9);
  const url = new URL(req.url);
  assert.equal(url.searchParams.get('latitude').split(',').length, 25);
  assert.equal(url.searchParams.get('wind_speed_unit'), 'kn');
});

test('field reports speed, direction and interpolates in time', () => {
  const req = windGridRequest({ south: 40, north: 41, west: -73, east: -72 }, 3);
  const field = WindField.fromOpenMeteo(fakeResponse(req), req);
  const t0 = 1_700_000_000_000;
  const w = field.at(40.5, -72.5, t0);
  assert.ok(Math.abs(w.speedKt - 10) < 1e-6);
  assert.ok(Math.abs(w.fromDeg - 180) < 1e-6);
  assert.equal(w.gustKt, 15);
  const half = field.at(40.5, -72.5, t0 + 1800 * 1000);
  assert.ok(Math.abs(half.speedKt - 11) < 1e-6);
  // Outside the time range clamps to the ends.
  assert.ok(Math.abs(field.at(40.5, -72.5, t0 + 99 * 3600 * 1000).speedKt - 14) < 1e-6);
});

test('covers() and wrong point count', () => {
  const req = windGridRequest({ south: 40, north: 41, west: -73, east: -72 }, 3);
  const field = WindField.fromOpenMeteo(fakeResponse(req), req);
  assert.equal(field.covers({ south: 40.2, north: 40.8, west: -72.8, east: -72.2 }), true);
  assert.equal(field.covers({ south: 39, north: 40.8, west: -72.8, east: -72.2 }), false);
  assert.throws(() => WindField.fromOpenMeteo(fakeResponse(req).slice(1), req));
});
