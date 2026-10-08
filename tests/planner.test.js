import test from 'node:test';
import assert from 'node:assert/strict';
import {
  closestApproach, directionUncertaintyDeg, distanceBearing, formatDistance, formatDuration,
  planStatus, startPoint,
} from '../js/planner.js';
import { MS_PER_KNOT, angleDiff, destination, vectorFromBearing } from '../js/geo.js';

const target = { lat: 41.0, lon: -71.9 };
const sw1kt = vectorFromBearing(225, 1 * MS_PER_KNOT); // 1 kt drift toward SW

test('start point is up-drift of the target by drift × lead time', () => {
  const start = startPoint(target, sw1kt, 120);
  const { distanceM, bearing } = distanceBearing(start, target);
  assert.ok(Math.abs(distanceM - MS_PER_KNOT * 120) < 0.5, `distance ${distanceM}`);
  assert.ok(Math.abs(angleDiff(bearing, 225)) < 0.5, `bearing ${bearing}`);
});

test('drifting from the start point passes right over the target', () => {
  const start = startPoint(target, sw1kt, 120);
  const ca = closestApproach(start, sw1kt, target);
  assert.ok(Math.abs(ca.timeSec - 120) < 0.5);
  assert.ok(ca.distanceM < 0.5);
});

test('offset start passes beside the target on the correct side', () => {
  // Start 30 m east of the planned start, drifting south: pass 30 m east.
  const south = vectorFromBearing(180, 1 * MS_PER_KNOT);
  const start = destination(startPoint(target, south, 120), 90, 30);
  const ca = closestApproach(start, south, target);
  assert.ok(Math.abs(ca.distanceM - 30) < 0.5, `pass ${ca.distanceM}`);
  assert.ok(Math.abs(angleDiff(ca.sideBearing, 90)) < 1, `side ${ca.sideBearing}`);
});

test('already past the target gives negative time', () => {
  const past = destination(target, 225, 100);
  assert.ok(closestApproach(past, sw1kt, target).timeSec < 0);
});

test('plan status phases', () => {
  const start = startPoint(target, sw1kt, 120);
  const far = destination(start, 45, 800);
  assert.equal(planStatus({ pos: far, target, start, live: sw1kt, running: true }).phase, 'run');
  assert.equal(planStatus({ pos: far, target, start, live: null, running: false }).phase, 'run');

  const onLine = planStatus({ pos: start, target, start, live: sw1kt, running: false });
  assert.equal(onLine.phase, 'drifting');
  assert.equal(onLine.onTarget, true);

  const beside = planStatus({ pos: destination(start, 135, 40), target, start, live: sw1kt, running: false });
  assert.equal(beside.phase, 'drifting');
  assert.equal(beside.onTarget, false);

  const past = planStatus({ pos: destination(target, 225, 60), target, start, live: sw1kt, running: false });
  assert.equal(past.phase, 'past');
});

test('direction uncertainty', () => {
  assert.ok(directionUncertaintyDeg(1, 0.1) < 6);
  assert.equal(directionUncertaintyDeg(0, 0.1), 90);
});

test('formatting', () => {
  assert.equal(formatDistance(30), '100 ft');
  assert.equal(formatDistance(1852 * 0.42), '0.4 nm');
  assert.equal(formatDuration(125), '2:05');
});
