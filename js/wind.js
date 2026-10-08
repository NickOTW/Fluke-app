// Forecast wind from Open-Meteo (free, no API key). For US waters its default
// model blend includes NOAA's high-resolution HRRR model.
//
// We request a small grid of points covering the map, get hourly wind for
// each, and interpolate in space and time. Wind is reported meteorologically
// ("from" direction); particles flow the opposite way (downwind).

import { normalizeDeg, toRad, bearingFromVector } from './geo.js';

const API = 'https://api.open-meteo.com/v1/forecast';
const MIN_SPAN_DEG = 0.3; // sample at least ~30 km so the grid is meaningful
const CACHE_KEY = 'fluke.wind.v1';
const HOUR_MS = 3600 * 1000;

/** Build the request for a grid of points covering `bounds`. */
export function windGridRequest(bounds, n = 5) {
  const b = expandToMinSpan(bounds, MIN_SPAN_DEG);
  const lats = [];
  const lons = [];
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      lats.push((b.south + ((b.north - b.south) * r) / (n - 1)).toFixed(3));
      lons.push((b.west + ((b.east - b.west) * c) / (n - 1)).toFixed(3));
    }
  }
  const params = new URLSearchParams({
    latitude: lats.join(','),
    longitude: lons.join(','),
    hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
    wind_speed_unit: 'kn',
    timeformat: 'unixtime',
    forecast_days: '2', // hourly from 00:00 UTC today, 48 hours
  });
  return { url: `${API}?${params}`, bounds: b, rows: n, cols: n };
}

export async function fetchWind(bounds, { n = 5, fetchFn = fetch } = {}) {
  const req = windGridRequest(bounds, n);
  const res = await fetchFn(req.url);
  if (!res.ok) throw new Error(`Wind forecast request failed (${res.status})`);
  const json = await res.json();
  const fetchedAt = Date.now();
  saveCache({ json, req, fetchedAt });
  return WindField.fromOpenMeteo(json, req, fetchedAt);
}

/** Last successful forecast, for offline use. */
export function loadCachedWind() {
  try {
    const saved = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (!saved) return null;
    return WindField.fromOpenMeteo(saved.json, saved.req, saved.fetchedAt);
  } catch {
    return null;
  }
}

function saveCache(entry) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // Storage full or blocked (private browsing) - not critical.
  }
}

export class WindField {
  /**
   * @param bounds   {south, west, north, east}
   * @param rows/cols grid size; row 0 is the south edge, col 0 the west edge
   * @param times    hourly timestamps (ms)
   * @param cells    cells[row][col] = { u: [], v: [], gust: [] } per hour,
   *                 u/v = downwind flow east/north in knots
   */
  constructor({ bounds, rows, cols, times, cells, fetchedAt }) {
    Object.assign(this, { bounds, rows, cols, times, cells, fetchedAt });
  }

  static fromOpenMeteo(json, req, fetchedAt = Date.now()) {
    const list = Array.isArray(json) ? json : [json];
    if (list.length !== req.rows * req.cols) {
      throw new Error(`Expected ${req.rows * req.cols} wind points, got ${list.length}`);
    }
    const times = list[0].hourly.time.map((s) => s * 1000);
    const cells = [];
    for (let r = 0; r < req.rows; r += 1) {
      const row = [];
      for (let c = 0; c < req.cols; c += 1) {
        const h = list[r * req.cols + c].hourly;
        const u = []; const v = []; const gust = [];
        for (let i = 0; i < times.length; i += 1) {
          const flow = flowFromMet(h.wind_speed_10m[i] ?? 0, h.wind_direction_10m[i] ?? 0);
          u.push(flow.u); v.push(flow.v); gust.push(h.wind_gusts_10m?.[i] ?? NaN);
        }
        row.push({ u, v, gust });
      }
      cells.push(row);
    }
    return new WindField({ bounds: req.bounds, rows: req.rows, cols: req.cols, times, cells, fetchedAt });
  }

  /** True if `bounds` lies inside the area this forecast covers. */
  covers(bounds) {
    const b = this.bounds;
    return bounds.south >= b.south && bounds.north <= b.north
      && bounds.west >= b.west && bounds.east <= b.east;
  }

  /** True if the forecast has data for time `tMs`. */
  hasTime(tMs) {
    return tMs >= this.times[0] && tMs <= this.times[this.times.length - 1];
  }

  /**
   * Wind at a point and time:
   *   { u, v } downwind flow (kt east/north), speedKt, fromDeg, gustKt
   */
  at(lat, lon, tMs = Date.now()) {
    const { i, f } = this._timeIndex(tMs);
    const gy = clamp(((lat - this.bounds.south) / (this.bounds.north - this.bounds.south)) * (this.rows - 1), 0, this.rows - 1);
    const gx = clamp(((lon - this.bounds.west) / (this.bounds.east - this.bounds.west)) * (this.cols - 1), 0, this.cols - 1);
    const r0 = Math.min(Math.floor(gy), this.rows - 2); const fy = gy - r0;
    const c0 = Math.min(Math.floor(gx), this.cols - 2); const fx = gx - c0;

    const sample = (key) => {
      const at = (r, c) => lerp(this.cells[r][c][key][i], this.cells[r][c][key][i + 1] ?? this.cells[r][c][key][i], f);
      return lerp(
        lerp(at(r0, c0), at(r0, c0 + 1), fx),
        lerp(at(r0 + 1, c0), at(r0 + 1, c0 + 1), fx),
        fy,
      );
    };
    const u = sample('u');
    const v = sample('v');
    return {
      u,
      v,
      speedKt: Math.hypot(u, v),
      fromDeg: normalizeDeg(bearingFromVector(u, v) + 180),
      gustKt: sample('gust'),
    };
  }

  /** Hourly forecast at a point: [{ t, speedKt, fromDeg, gustKt }]. */
  hourly(lat, lon) {
    return this.times.map((t) => ({ t, ...this.at(lat, lon, t) }));
  }

  _timeIndex(tMs) {
    const n = this.times.length;
    if (n === 1 || tMs <= this.times[0]) return { i: 0, f: 0 };
    if (tMs >= this.times[n - 1]) return { i: n - 1, f: 0 };
    const i = Math.min(Math.floor((tMs - this.times[0]) / HOUR_MS), n - 2);
    return { i, f: clamp((tMs - this.times[i]) / (this.times[i + 1] - this.times[i]), 0, 1) };
  }
}

/** Meteorological (speed, from-direction) -> downwind flow components. */
export function flowFromMet(speed, fromDeg) {
  const r = toRad(fromDeg);
  return { u: -speed * Math.sin(r), v: -speed * Math.cos(r) };
}

function expandToMinSpan(b, span) {
  const out = { ...b };
  if (out.north - out.south < span) {
    const mid = (out.north + out.south) / 2;
    out.south = mid - span / 2; out.north = mid + span / 2;
  }
  if (out.east - out.west < span) {
    const mid = (out.east + out.west) / 2;
    out.west = mid - span / 2; out.east = mid + span / 2;
  }
  return out;
}

const lerp = (a, b, f) => a + (b - a) * f;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
