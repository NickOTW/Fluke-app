import { DriftTracker } from './drift.js';
import { DriftSimulator, gpsErrorMessage, startGps } from './position.js';
import { WindParticles } from './particles.js';
import { fetchWind, loadCachedWind } from './wind.js';
import { angleDiff, compassPoint, destination, normalizeDeg } from './geo.js';
import { noaaChartLayer, noaaLiveChartLayer } from './charts.js';
import {
  directionUncertaintyDeg, distanceBearing, formatDistance, formatDuration, planStatus, startPoint,
} from './planner.js';

const { L } = window;
const $ = (id) => document.getElementById(id);

const PROJECTION_MINUTES = [5, 10, 15];
const WIND_MAX_AGE_MS = 30 * 60 * 1000;
const GPS_STALE_MS = 10000;
const RUN_START_KT = 5; // faster than this over the last ~15 s = running under power
const RUN_END_KT = 3.5; // back below this = drifting again
const LEAD_OPTIONS_MIN = [1, 2, 3, 5];
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
const noaaLiveChart = noaaLiveChartLayer(L);
const baseLayers = {
  'NOAA Chart': noaaChart,
  'NOAA Chart (live)': noaaLiveChart,
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
const LIGHT_LAYERS = ['NOAA Chart', 'NOAA Chart (live)', 'Streets'];
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
for (const layer of [noaaChart, noaaLiveChart]) {
  layer.on('tileerror', () => {
    chartErrors += 1;
    if (chartErrors === 6) toast('NOAA charts aren\'t loading right now. Try another map from the layers button (top right).', 8000);
  });
  layer.on('tileload', () => { chartErrors = 0; });
}

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

// Drift plan overlays: target, start point, drift lane, and uncertainty cone.
const PLAN_COLOR = '#12b76a';
const planCone = L.polygon([], { color: PLAN_COLOR, weight: 1, opacity: 0.5, fillOpacity: 0.12, interactive: false });
const planLaneCasing = L.polyline([], { color: '#ffffff', weight: 7, opacity: 0.8, interactive: false });
const planLane = L.polyline([], { color: PLAN_COLOR, weight: 3, opacity: 1, interactive: false });
const startMarker = L.marker([0, 0], {
  interactive: false,
  icon: L.divIcon({ className: '', iconSize: [0, 0], html: '<span class="plan-start-dot"></span><span class="plan-start">START</span>' }),
});
const targetMarker = L.marker([0, 0], {
  draggable: true,
  zIndexOffset: 900,
  icon: L.divIcon({ className: 'plan-target', iconSize: [30, 30], iconAnchor: [15, 15], html: '<span></span>' }),
});
targetMarker.on('dragend', () => setTarget(targetMarker.getLatLng()));

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
let running = false;
let recentKt = null;
let sim = null; // demo simulator

const plan = { target: null, leadMin: 2, drift: null, picking: false, ...loadPlan() };

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

  running = false;
  recentKt = null;
  if (mode === 'demo') {
    const fast = Number(params.get('fast')) || 1;
    sim = new DriftSimulator({ timeScale: fast });
    stopSource = sim.start(onFix);
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
  sim = null;
  mode = null;
  plan.picking = false;
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
  // Running under power vs. drifting. Restart the drift measurement when the
  // boat comes off plane so the run doesn't pollute it.
  recentKt = tracker.recentSpeedKt(15);
  if (!running && recentKt !== null && recentKt > RUN_START_KT) {
    running = true;
  } else if (running && recentKt !== null && recentKt < RUN_END_KT) {
    running = false;
    tracker.restartDrift();
    tracker.addFix(fix);
  }

  lastEstimate = running ? null : tracker.estimate();
  if (lastEstimate?.quality === 'good') updatePlanDrift(lastEstimate);
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
    if (mode && running) {
      $('drift-dir').textContent = `Running ${Math.round(recentKt ?? 0)} kt · drift paused`;
    } else if (mode && fix) {
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
    $('wind-text').textContent = `${compassPoint(wind.fromDeg)} ${Math.round(wind.speedKt)} kt${gust}`;
    windArrow.setAttribute('visibility', 'visible');
    windArrow.style.transform = `rotate(${smoothRotation('wind', normalizeDeg(wind.fromDeg + 180))}deg)`;
  } else {
    $('wind-text').textContent = windFetching ? 'loading…' : '—';
    windArrow.setAttribute('visibility', 'hidden');
  }

  renderRelation(est, wind);
  renderPlan(est);
  renderStatus();
}

/** Plain-language read on what's driving the drift. */
function renderRelation(est, wind) {
  const chip = $('relation');
  if (!est || !wind || est.quality === 'poor' || planVisible()) { chip.hidden = true; return; }
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

// ---------- Drift planner ----------
// Tap a target; the app uses your measured drift to show where to start so
// the drift carries you over it, then guides you there and along the drift.

function loadPlan() {
  try {
    const saved = JSON.parse(localStorage.getItem('fluke.plan')) || {};
    return { target: saved.target ?? null, leadMin: saved.leadMin ?? 2, drift: saved.drift ?? null };
  } catch { return {}; }
}
function savePlan() {
  try {
    localStorage.setItem('fluke.plan', JSON.stringify({ target: plan.target, leadMin: plan.leadMin, drift: plan.drift }));
  } catch { /* not critical */ }
}

const planVisible = () => !!mode && (plan.picking || !!plan.target);

function setTarget(latlng) {
  plan.target = { lat: latlng.lat, lon: latlng.lng ?? latlng.lon };
  plan.picking = false;
  savePlan();
  render();
  zoomToPlan();
}

// Zoom to the drift lane (start → target), clear of the top bar and HUD.
// The HUD says where the start is relative to the boat.
function zoomToPlan() {
  const pts = [[plan.target.lat, plan.target.lon]];
  if (plan.drift) {
    const s = startPoint(plan.target, plan.drift, plan.leadMin * 60);
    const beyond = destination(plan.target, plan.drift.bearing, 30);
    pts.push([s.lat, s.lon], [beyond.lat, beyond.lon]);
  } else if (tracker.latestFix) {
    pts.push([tracker.latestFix.lat, tracker.latestFix.lon]);
  }
  follow = false;
  map.fitBounds(pts, {
    paddingTopLeft: [40, 90],
    paddingBottomRight: [40, $('hud').offsetHeight + 30],
    maxZoom: 17,
  });
}

function clearPlan() {
  plan.target = null;
  plan.picking = false;
  savePlan();
  render();
}

let planSavedAt = 0;
function updatePlanDrift(est) {
  plan.drift = {
    east: est.east, north: est.north, speedKt: est.speedKt, bearing: est.bearing, uncertaintyKt: est.uncertaintyKt,
  };
  if (Date.now() - planSavedAt > 10000) { planSavedAt = Date.now(); savePlan(); }
}

map.on('click', (e) => { if (plan.picking && mode) setTarget(e.latlng); });

$('btn-plan').addEventListener('click', () => {
  plan.picking = true;
  render();
});
$('btn-plan-clear').addEventListener('click', clearPlan);
$('btn-demo-run').addEventListener('click', () => {
  if (!sim || !plan.target || !plan.drift) return;
  sim.runTo(startPoint(plan.target, plan.drift, plan.leadMin * 60), 20);
  follow = true;
});

const leadSelect = $('lead-select');
LEAD_OPTIONS_MIN.forEach((m) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = `${m} min`;
  b.addEventListener('click', () => { plan.leadMin = m; savePlan(); render(); zoomToPlan(); });
  leadSelect.appendChild(b);
});

function renderPlan(est) {
  const panel = $('plan');
  const show = planVisible();
  panel.hidden = !show;
  $('btn-plan').textContent = plan.target ? 'New target' : 'Plan drift';
  [...leadSelect.children].forEach((b, i) => b.classList.toggle('on', LEAD_OPTIONS_MIN[i] === plan.leadMin));
  $('plan-controls').hidden = !plan.target;

  const fix = tracker.latestFix;
  const haveDrift = !!(plan.target && plan.drift);
  const start = haveDrift ? startPoint(plan.target, plan.drift, plan.leadMin * 60) : null;
  $('btn-demo-run').hidden = !(mode === 'demo' && haveDrift && !running);

  // Map overlays
  if (show && plan.target) {
    targetMarker.setLatLng([plan.target.lat, plan.target.lon]).addTo(map);
  } else {
    targetMarker.remove();
  }
  if (show && start) {
    const lane = distanceBearing(start, plan.target);
    const beyond = destination(plan.target, lane.bearing, Math.max(30, lane.distanceM * 0.4));
    const pts = [[start.lat, start.lon], [beyond.lat, beyond.lon]];
    planLaneCasing.setLatLngs(pts).addTo(map);
    planLane.setLatLngs(pts).addTo(map);
    startMarker.setLatLng([start.lat, start.lon]).addTo(map);

    const half = Math.max(3, Math.min(45, directionUncertaintyDeg(plan.drift.speedKt, plan.drift.uncertaintyKt)));
    const len = lane.distanceM * 1.4;
    const cone = [[start.lat, start.lon]];
    for (let a = -half; a <= half + 0.01; a += half / 4) {
      const p = destination(start, lane.bearing + a, len);
      cone.push([p.lat, p.lon]);
    }
    planCone.setLatLngs(cone).addTo(map);
  } else {
    [planLaneCasing, planLane, startMarker, planCone].forEach((l) => l.remove());
  }

  if (!show) return;

  // Panel text
  const status = $('plan-status');
  const sub = $('plan-sub');
  status.className = 'plan-status';
  sub.textContent = '';
  if (!plan.target) {
    status.textContent = 'Tap the spot on the chart you want to drift over';
    return;
  }
  if (!plan.drift || !fix) {
    status.textContent = running
      ? 'Stop and drift for a minute so I can measure your drift'
      : 'Measuring your drift… engine in neutral for about a minute';
    return;
  }

  const unc = Math.round(directionUncertaintyDeg(plan.drift.speedKt, plan.drift.uncertaintyKt));
  sub.textContent = `Using your ${plan.drift.speedKt.toFixed(1)} kt ${compassPoint(plan.drift.bearing)} drift (±${unc}°)`;

  const pos = est ? est.position : fix;
  const live = est && est.quality !== 'poor' ? est : null;
  const st = planStatus({ pos, target: plan.target, start, live, running });
  if (st.phase === 'drifting') {
    const t = formatDuration(st.approach.timeSec);
    if (st.onTarget) {
      status.textContent = `On line · over target in ${t}`;
      status.classList.add('good');
    } else {
      status.textContent = `Passing ${formatDistance(st.approach.distanceM)} ${compassPoint(st.approach.sideBearing)} of target · ${t}`;
      status.classList.add('off');
    }
  } else if (st.phase === 'past') {
    status.textContent = `Past the target · start is ${formatDistance(st.distanceM)} ${compassPoint(st.bearing)}`;
  } else if (!running && st.distanceM < 30) {
    status.textContent = 'At the start · let her drift';
    status.classList.add('good');
  } else {
    status.textContent = `Run to start · ${formatDistance(st.distanceM)} ${compassPoint(st.bearing)} (${Math.round(st.bearing)}°)`;
  }
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
