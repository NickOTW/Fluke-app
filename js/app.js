import { DriftTracker } from './drift.js';
import { DriftSimulator, gpsErrorMessage, startGps } from './position.js';
import { WindParticles } from './particles.js';
import { fetchWind, loadCachedWind } from './wind.js';
import { angleDiff, compassPoint, normalizeDeg } from './geo.js';
import { noaaChartLayer } from './charts.js';

const { L } = window;
const $ = (id) => document.getElementById(id);

const PROJECTION_MINUTES = [5, 10, 15];
const WIND_MAX_AGE_MS = 30 * 60 * 1000;
const GPS_STALE_MS = 10000;
const params = new URLSearchParams(location.search);

// ---------- Settings (remembered on this device) ----------
const settings = { windowSec: 60, particles: true, baseLayer: 'NOAA Chart', ...loadSettings() };

function loadSettings() {
  try { return JSON.parse(localStorage.getItem('fluke.settings')) || {}; } catch { return {}; }
}
function saveSettings() {
  try { localStorage.setItem('fluke.settings', JSON.stringify(settings)); } catch { /* not critical */ }
}

// ---------- Map ----------
const map = L.map('map', { zoomControl: false, attributionControl: true }).setView([40.6, -73.5], 9);

const esriAttribution = 'Tiles &copy; Esri &mdash; Esri, GEBCO, NOAA, and contributors';
const noaaChart = noaaChartLayer(L);
const baseLayers = {
  'NOAA Chart': noaaChart,
  Ocean: L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 13, maxZoom: 18, attribution: esriAttribution,
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 13, maxZoom: 18,
    }),
  ]),
  Satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxNativeZoom: 18, maxZoom: 18, attribution: 'Tiles &copy; Esri &mdash; Esri, Maxar, Earthstar Geographics',
  }),
  Streets: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }),
};
// Light-colored maps (the chart, streets) need dark wind streaks to be visible.
const LIGHT_LAYERS = ['NOAA Chart', 'Streets'];
const particles = new WindParticles(map);
particles.setEnabled(settings.particles);

if (!baseLayers[settings.baseLayer]) settings.baseLayer = 'NOAA Chart';
baseLayers[settings.baseLayer].addTo(map);
particles.setLightBackground(LIGHT_LAYERS.includes(settings.baseLayer));
L.control.layers(baseLayers, null, { position: 'topright' }).addTo(map);
map.on('baselayerchange', (e) => {
  settings.baseLayer = e.name;
  saveSettings();
  particles.setLightBackground(LIGHT_LAYERS.includes(e.name));
});

// NOAA's chart server is occasionally slow or down; say so instead of
// leaving a blank map.
let chartErrors = 0;
noaaChart.on('tileerror', () => {
  chartErrors += 1;
  if (chartErrors === 6) toast('NOAA charts aren\'t loading right now. Try another map from the layers button (top right).', 8000);
});
noaaChart.on('tileload', () => { chartErrors = 0; });

// Boat, trail, and projected drift overlays.
const trailLine = L.polyline([], { color: '#1e90ff', weight: 3, opacity: 0.85 }).addTo(map);
const accuracyCircle = L.circle([0, 0], { radius: 0, color: '#8899aa', weight: 1, opacity: 0.6, fillOpacity: 0.08, interactive: false });
const boatMarker = L.marker([0, 0], {
  icon: L.divIcon({ className: '', html: '<div class="boat"></div>', iconSize: [22, 22] }),
  interactive: false,
  zIndexOffset: 1000,
});
const projLine = L.polyline([], { color: '#ff8a3d', weight: 5, opacity: 0.95, dashArray: '10 8', lineCap: 'round' });
const projTicks = PROJECTION_MINUTES.map(() => L.marker([0, 0], { interactive: false }));

// Time label beside the projection line (offset to the right of travel so it
// never sits on the line or the arrowhead), with a dot on the line itself.
function tickIcon(minutes, bearing) {
  const side = ((bearing + 90) * Math.PI) / 180;
  const dx = Math.round(Math.sin(side) * 30);
  const dy = Math.round(-Math.cos(side) * 30);
  return L.divIcon({
    className: '',
    iconSize: [0, 0],
    html: `<span class="proj-dot"></span><span class="proj-tick" style="transform:translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))">${minutes} min</span>`,
  });
}
const projHead = L.marker([0, 0], { interactive: false, icon: arrowHeadIcon(0) });

function arrowHeadIcon(bearing) {
  return L.divIcon({
    className: 'proj-head',
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: `<svg width="28" height="28" viewBox="-14 -14 28 28" style="transform:rotate(${bearing}deg)">
      <path d="M0 -13 L-10 8 L0 3 L10 8 Z" fill="#ff8a3d" stroke="#fff" stroke-width="1.5"/></svg>`,
  });
}

// ---------- State ----------
const tracker = new DriftTracker({ windowSec: settings.windowSec });
let stopSource = null;
let mode = null; // 'gps' | 'demo' | null
let lastFixAt = 0;
let lastAccuracy = null;
let follow = true;
let firstFix = true;
let windField = loadCachedWind();
let windFetching = false;
let lastEstimate = null;

if (windField) particles.setField(windField);

// ---------- Start / stop ----------
$('btn-start').addEventListener('click', () => start('gps'));
$('btn-demo').addEventListener('click', () => start('demo'));
$('btn-stop').addEventListener('click', stop);
$('btn-reset').addEventListener('click', () => {
  tracker.reset();
  lastEstimate = null;
  render();
  toast('Started a new drift');
});

function start(newMode) {
  stop();
  mode = newMode;
  firstFix = true;
  follow = true;
  tracker.reset();
  $('start').hidden = true;
  $('hud').hidden = false;
  $('hud-actions').hidden = false;
  $('drift-dir').textContent = 'Waiting for GPS…';

  if (mode === 'demo') {
    const fast = Number(params.get('fast')) || 1;
    stopSource = new DriftSimulator({ timeScale: fast }).start(onFix);
  } else {
    stopSource = startGps(onFix, (err) => {
      const msg = gpsErrorMessage(err);
      if (err?.code === 1) {
        stop();
        $('drift-dir').textContent = 'Location blocked';
      }
      toast(msg, err?.code === 1 ? 12000 : 4000);
    });
  }
  keepScreenOn(true);
  render();
}

function stop() {
  if (stopSource) stopSource();
  stopSource = null;
  mode = null;
  keepScreenOn(false);
  $('hud-actions').hidden = true;
  $('hud').hidden = true;
  $('start').hidden = false;
  render();
}

// ---------- GPS fixes ----------
function onFix(fix) {
  lastFixAt = Date.now();
  lastAccuracy = fix.accuracy;
  tracker.addFix(fix);

  const latlng = [fix.lat, fix.lon];
  if (firstFix) {
    firstFix = false;
    boatMarker.addTo(map);
    accuracyCircle.addTo(map);
    map.setView(latlng, 15, { animate: false });
    centerOnBoat(latlng, false);
    refreshWind();
  }
  lastEstimate = tracker.estimate();
  render();
  if (follow) keepBoatInView(lastEstimate?.position ? [lastEstimate.position.lat, lastEstimate.position.lon] : latlng);
}

// ---------- Rendering ----------
function render() {
  const est = lastEstimate;
  const fix = tracker.latestFix;

  // Map overlays
  if (fix && mode) {
    const pos = est ? [est.position.lat, est.position.lon] : [fix.lat, fix.lon];
    boatMarker.setLatLng(pos);
    accuracyCircle.setLatLng([fix.lat, fix.lon]).setRadius(fix.accuracy);
    trailLine.setLatLngs(tracker.trail.map((p) => [p.lat, p.lon]));
  } else {
    trailLine.setLatLngs([]);
    boatMarker.remove();
    accuracyCircle.remove();
  }

  if (est && mode) {
    const pts = PROJECTION_MINUTES.map((m) => DriftTracker.project(est, m));
    const start = [est.position.lat, est.position.lon];
    const end = pts[pts.length - 1];
    projLine.setLatLngs([start, [end.lat, end.lon]]).addTo(map);
    pts.forEach((p, i) => projTicks[i].setLatLng([p.lat, p.lon]).setIcon(tickIcon(PROJECTION_MINUTES[i], est.bearing)).addTo(map));
    projHead.setLatLng([end.lat, end.lon]).setIcon(arrowHeadIcon(est.bearing)).addTo(map);
  } else {
    projLine.remove();
    projTicks.forEach((t) => t.remove());
    projHead.remove();
  }

  // HUD: drift
  const driftArrow = $('dial-drift');
  if (est) {
    $('drift-speed').textContent = est.speedKt.toFixed(est.speedKt < 10 ? 1 : 0);
    const q = { good: 'steady', fair: 'settling', poor: 'rough estimate' }[est.quality];
    $('drift-dir').innerHTML = `${compassPoint(est.bearing)} ${Math.round(est.bearing)}°<span class="quality">${q}</span>`;
    driftArrow.setAttribute('visibility', 'visible');
    driftArrow.style.transform = `rotate(${smoothRotation('drift', est.bearing)}deg)`;
  } else {
    $('drift-speed').textContent = '—';
    if (mode && fix) {
      const need = Math.min(15, settings.windowSec / 2);
      $('drift-dir').textContent = `Measuring… (~${need}s)`;
    } else if (!mode) {
      $('drift-dir').textContent = 'Tap Start to begin';
    }
    driftArrow.setAttribute('visibility', 'hidden');
  }

  // HUD: wind
  const wind = windHere();
  const windArrow = $('dial-wind');
  if (wind) {
    const gust = Number.isFinite(wind.gustKt) ? ` · gusts ${Math.round(wind.gustKt)}` : '';
    $('wind-text').textContent = `${Math.round(wind.speedKt)} kt from ${compassPoint(wind.fromDeg)}${gust}`;
    windArrow.setAttribute('visibility', 'visible');
    windArrow.style.transform = `rotate(${smoothRotation('wind', normalizeDeg(wind.fromDeg + 180))}deg)`;
  } else {
    $('wind-text').textContent = windFetching ? 'loading…' : '—';
    windArrow.setAttribute('visibility', 'hidden');
  }

  renderRelation(est, wind);
  renderStatus();
}

/** Plain-language read on what's driving the drift. */
function renderRelation(est, wind) {
  const chip = $('relation');
  if (!est || !wind || est.quality === 'poor') { chip.hidden = true; return; }
  chip.hidden = false;
  chip.className = 'chip';
  if (wind.speedKt < 4) {
    chip.textContent = 'Light wind: current is driving';
    chip.classList.add('cross');
    return;
  }
  if (est.speedKt < 0.15) {
    chip.textContent = 'Barely moving: wind and current cancel';
    chip.classList.add('against');
    return;
  }
  const off = Math.abs(angleDiff(est.bearing, wind.fromDeg + 180));
  if (off <= 35) {
    chip.textContent = 'Drifting with the wind';
    chip.classList.add('with');
  } else if (off >= 135) {
    chip.textContent = 'Wind against current';
    chip.classList.add('against');
  } else {
    chip.textContent = 'Current pushing across the wind';
    chip.classList.add('cross');
  }
}

function renderStatus() {
  const gps = $('gps-status');
  const dot = gps.querySelector('.dot');
  const label = gps.querySelector('.label');
  dot.className = 'dot';
  if (!mode) {
    label.textContent = 'GPS off';
  } else if (mode === 'demo') {
    dot.classList.add('demo');
    label.textContent = 'Demo';
  } else if (!lastFixAt) {
    label.textContent = 'GPS…';
  } else if (Date.now() - lastFixAt > GPS_STALE_MS) {
    dot.classList.add('bad');
    label.textContent = 'GPS lost';
  } else {
    dot.classList.add(lastAccuracy <= 8 ? 'good' : lastAccuracy <= 20 ? 'fair' : 'bad');
    label.textContent = `GPS ±${Math.round(lastAccuracy)} m`;
  }

  const windLabel = $('wind-status').querySelector('.label');
  if (windField) {
    const age = Date.now() - windField.fetchedAt;
    const when = new Date(windField.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    windLabel.textContent = age > 3 * 3600 * 1000 ? `Wind (old: ${when})` : `Wind ${when}`;
  } else {
    windLabel.textContent = windFetching ? 'Wind…' : 'Wind —';
  }
  $('btn-follow').classList.toggle('active', follow && !!mode);
}

// Rotate arrows the short way round (e.g. 350° -> 10° turns 20°, not 340°).
const rotations = {};
function smoothRotation(key, target) {
  const prev = rotations[key];
  rotations[key] = prev === undefined ? target : prev + angleDiff(target, normalizeDeg(prev));
  return rotations[key];
}

// ---------- Wind ----------
function windHere() {
  if (!windField) return null;
  const fix = tracker.latestFix;
  const c = fix && mode ? { lat: fix.lat, lng: fix.lon } : map.getCenter();
  return windField.at(c.lat, c.lng);
}

async function refreshWind(force = false) {
  if (windFetching) return;
  const view = boundsOf(map.getBounds().pad(0.5));
  const stale = !windField || Date.now() - windField.fetchedAt > WIND_MAX_AGE_MS || !windField.hasTime(Date.now());
  if (!force && !stale && windField.covers(view)) return;

  windFetching = true;
  renderStatus();
  try {
    windField = await fetchWind(boundsOf(map.getBounds().pad(1)));
    particles.setField(windField);
    renderForecast();
  } catch (err) {
    console.warn(err);
    if (!windField) toast('Could not load the wind forecast (offline?).');
  } finally {
    windFetching = false;
    render();
  }
}

function boundsOf(b) {
  return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
}

let windTimer = 0;
map.on('moveend', () => {
  clearTimeout(windTimer);
  windTimer = setTimeout(() => { refreshWind(); render(); }, 800);
});
setInterval(() => {
  refreshWind();
  if (windField) particles.setField(windField); // re-sample for the new time
}, 5 * 60 * 1000);
setInterval(renderStatus, 3000);

function renderForecast() {
  const list = $('forecast');
  if (!windField) return;
  const fix = tracker.latestFix;
  const c = fix && mode ? { lat: fix.lat, lng: fix.lon } : map.getCenter();
  const now = Date.now();
  const hours = windField.hourly(c.lat, c.lng).filter((h) => h.t > now - 3600 * 1000).slice(0, 12);
  list.innerHTML = '';
  hours.forEach((h, i) => {
    const li = document.createElement('li');
    if (i === 0) li.className = 'now';
    const time = new Date(h.t).toLocaleTimeString([], { hour: 'numeric' });
    const gust = Number.isFinite(h.gustKt) ? ` (gusts ${Math.round(h.gustKt)})` : '';
    li.innerHTML = `<span>${time}</span>
      <span class="arrow" style="transform:rotate(${normalizeDeg(h.fromDeg + 180)}deg)">↑</span>
      <span>${Math.round(h.speedKt)} kt from ${compassPoint(h.fromDeg)}${gust}</span>`;
    list.appendChild(li);
  });
}

// ---------- Follow the boat ----------
function visibleCenterPoint() {
  const size = map.getSize();
  const top = 60;
  const bottom = size.y - $('hud').offsetHeight;
  return L.point(size.x / 2, (top + Math.max(bottom, top + 1)) / 2);
}

function centerOnBoat(latlng, animate = true) {
  const p = map.latLngToContainerPoint(latlng);
  const target = visibleCenterPoint();
  map.panBy([p.x - target.x, p.y - target.y], { animate });
}

// Only re-center when the boat nears the edge, so the map isn't constantly
// moving (which would also restart the wind animation every second).
function keepBoatInView(latlng) {
  const p = map.latLngToContainerPoint(latlng);
  const c = visibleCenterPoint();
  const size = map.getSize();
  const halfH = (size.y - $('hud').offsetHeight - 60) / 2;
  if (Math.abs(p.x - c.x) > size.x * 0.3 || Math.abs(p.y - c.y) > halfH * 0.6) centerOnBoat(latlng);
}

map.on('dragstart', () => { follow = false; renderStatus(); });
$('btn-follow').addEventListener('click', () => {
  const fix = tracker.latestFix;
  if (!fix || !mode) { toast('Start a drift first'); return; }
  follow = true;
  const pos = lastEstimate ? [lastEstimate.position.lat, lastEstimate.position.lon] : [fix.lat, fix.lon];
  if (map.getZoom() < 14) map.setView(pos, 15, { animate: false });
  centerOnBoat(pos);
  renderStatus();
});

// ---------- Settings sheet ----------
$('btn-settings').addEventListener('click', () => { renderForecast(); $('settings').hidden = false; });
$('wind-row').addEventListener('click', () => { renderForecast(); $('settings').hidden = false; });
$('btn-close-settings').addEventListener('click', () => { $('settings').hidden = true; });
$('settings').addEventListener('click', (e) => { if (e.target === $('settings')) $('settings').hidden = true; });

const windowButtons = [...$('window-select').querySelectorAll('button')];
function renderWindowButtons() {
  windowButtons.forEach((b) => b.classList.toggle('on', Number(b.dataset.sec) === settings.windowSec));
}
windowButtons.forEach((b) => b.addEventListener('click', () => {
  settings.windowSec = Number(b.dataset.sec);
  tracker.setWindow(settings.windowSec);
  saveSettings();
  renderWindowButtons();
  lastEstimate = tracker.estimate();
  render();
}));
renderWindowButtons();

$('particles-toggle').checked = settings.particles;
$('particles-toggle').addEventListener('change', (e) => {
  settings.particles = e.target.checked;
  particles.setEnabled(settings.particles);
  saveSettings();
});

// ---------- Keep the screen awake while drifting ----------
let wakeLock = null;
async function keepScreenOn(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch (err) {
    console.warn('Wake lock unavailable', err);
  }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && mode) keepScreenOn(true);
});

// ---------- Misc ----------
let toastTimer = 0;
function toast(msg, ms = 4000) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// Leaflet controls sit above the HUD; track its height.
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--hud-h', `${$('hud').offsetHeight}px`);
}).observe($('hud'));

// Compass ticks on the dial.
const ticks = $('dial-ticks');
for (let d = 0; d < 360; d += 30) {
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
  const major = d % 90 === 0;
  line.setAttribute('y1', -52);
  line.setAttribute('y2', major ? -44 : -47);
  line.setAttribute('transform', `rotate(${d})`);
  if (major) line.setAttribute('class', 'major');
  ticks.appendChild(line);
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.warn('SW registration failed', err));
}

render();
refreshWind();
if (params.has('demo')) start('demo');
