// Drift planning: where to start so the drift carries you over a target,
// and live feedback on whether the current drift will pass over it.
//
// A "drift" here is a velocity { east, north } in m/s, as produced by
// DriftTracker#estimate.

import { bearingFromVector, fromLocalMeters, toDeg, toLocalMeters } from './geo.js';

export const ON_TARGET_M = 12; // ~40 ft: close enough to count as over it
const FEET_PER_M = 3.28084;
const METERS_PER_NM = 1852;

/** Start point that drifts over `target` after `leadSec` seconds. */
export function startPoint(target, drift, leadSec) {
  return fromLocalMeters(target, -drift.east * leadSec, -drift.north * leadSec);
}

/** Distance (m) and bearing (degrees true) from one point to another. */
export function distanceBearing(from, to) {
  const d = toLocalMeters(from, to);
  return { distanceM: Math.hypot(d.east, d.north), bearing: bearingFromVector(d.east, d.north) };
}

/**
 * Closest approach to `target` for a boat at `pos` moving with `drift`.
 *   timeSec      seconds until closest approach (negative = already past it)
 *   distanceM    how far from the target the boat will pass
 *   sideBearing  direction from the target to that pass point, so
 *                "passing 40 ft SE of target" = compassPoint(sideBearing)
 */
export function closestApproach(pos, drift, target) {
  const r = toLocalMeters(pos, target);
  const v2 = drift.east * drift.east + drift.north * drift.north;
  if (v2 < 1e-8) {
    return { timeSec: Infinity, distanceM: Math.hypot(r.east, r.north), sideBearing: bearingFromVector(-r.east, -r.north) };
  }
  const timeSec = (r.east * drift.east + r.north * drift.north) / v2;
  const dx = drift.east * timeSec - r.east;
  const dy = drift.north * timeSec - r.north;
  return { timeSec, distanceM: Math.hypot(dx, dy), sideBearing: bearingFromVector(dx, dy) };
}

/**
 * How unsure we are of the drift direction, as a half-angle in degrees,
 * from the speed and its uncertainty (both knots).
 */
export function directionUncertaintyDeg(speedKt, uncertaintyKt) {
  if (speedKt <= 0) return 90;
  return Math.min(90, toDeg(Math.atan2(uncertaintyKt, speedKt)));
}

/**
 * Where the plan stands for a boat at `pos`.
 *   live: current drift estimate (or null), running: true when under power.
 * Returns { phase, ... } where phase is one of
 *   'run'       go to the start point          (distanceM, bearing)
 *   'drifting'  in the lane, heading for target (approach)
 *   'past'      drifted past the target        (distanceM, bearing to start)
 */
export function planStatus({ pos, target, start, live, running }) {
  const toStart = distanceBearing(pos, start);
  const laneLength = distanceBearing(start, target).distanceM;
  const toTarget = distanceBearing(pos, target).distanceM;

  if (!running && live) {
    const approach = closestApproach(pos, live, target);
    const inLane = toTarget <= laneLength + Math.max(40, laneLength * 0.5);
    if (approach.timeSec >= 0 && approach.timeSec < 30 * 60 && inLane) {
      return { phase: 'drifting', approach, onTarget: approach.distanceM <= ON_TARGET_M };
    }
    if (approach.timeSec < 0 && toTarget < laneLength + 300) {
      return { phase: 'past', ...toStart };
    }
  }
  return { phase: 'run', ...toStart };
}

/** "350 ft" for short distances, "0.4 nm" for longer ones. */
export function formatDistance(m) {
  if (m < 0.1 * METERS_PER_NM) return `${Math.round((m * FEET_PER_M) / 10) * 10} ft`;
  return `${(m / METERS_PER_NM).toFixed(m < 10 * METERS_PER_NM ? 1 : 0)} nm`;
}

/** "2:05" */
export function formatDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
