// Small geodesy helpers. Drift happens over a few hundred meters to a few
// kilometers, so a local flat-earth (equirectangular) projection is accurate
// to well under a meter and keeps the math simple.

export const EARTH_RADIUS_M = 6371008.8;
export const MS_PER_KNOT = 1852 / 3600; // 0.5144 m/s

export const toRad = (deg) => (deg * Math.PI) / 180;
export const toDeg = (rad) => (rad * 180) / Math.PI;

export function normalizeDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

/** Smallest signed difference a - b, in degrees, in the range [-180, 180). */
export function angleDiff(a, b) {
  return normalizeDeg(a - b + 180) - 180;
}

/** Position `p` as meters east/north of `origin`. */
export function toLocalMeters(origin, p) {
  const east = toRad(p.lon - origin.lon) * Math.cos(toRad(origin.lat)) * EARTH_RADIUS_M;
  const north = toRad(p.lat - origin.lat) * EARTH_RADIUS_M;
  return { east, north };
}

/** Inverse of toLocalMeters. */
export function fromLocalMeters(origin, east, north) {
  return {
    lat: origin.lat + toDeg(north / EARTH_RADIUS_M),
    lon: origin.lon + toDeg(east / (EARTH_RADIUS_M * Math.cos(toRad(origin.lat)))),
  };
}

/** Compass bearing (0 = north, 90 = east) of a vector. */
export function bearingFromVector(east, north) {
  return normalizeDeg(toDeg(Math.atan2(east, north)));
}

/** Vector of the given length pointing along a compass bearing. */
export function vectorFromBearing(bearingDeg, magnitude) {
  const r = toRad(bearingDeg);
  return { east: magnitude * Math.sin(r), north: magnitude * Math.cos(r) };
}

/** Point `distanceM` meters from `origin` along `bearingDeg` (short distances). */
export function destination(origin, bearingDeg, distanceM) {
  const v = vectorFromBearing(bearingDeg, distanceM);
  return fromLocalMeters(origin, v.east, v.north);
}

const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** 16-point compass name for a bearing, e.g. 215 -> "SW". */
export function compassPoint(deg) {
  return POINTS[Math.round(normalizeDeg(deg) / 22.5) % 16];
}
