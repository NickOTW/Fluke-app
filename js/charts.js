// NOAA nautical charts, from NOAA Office of Coast Survey's chart services.
//
// Two versions of the same official charts (ENC, updated weekly):
// - "NOAA Chart": NOAA's pre-drawn tile cache. Fast. Its zoom levels are
//   numbered 2 lower than standard web map zoom (its level 0 = web zoom 2).
// - "NOAA Chart (live)": drawn on request by NOAA's Maritime Chart Service.
//   Slower, but a useful backup if the tile cache is down.
//
// Note: the plain .../MapServer/export endpoints on these services return
// blank images; the chart must come from /tile or the MaritimeChartService
// extension's export.

const TILE_URL = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MarineChart_Services/NOAACharts/MapServer/tile/{z}/{y}/{x}';
const LIVE_EXPORT_URL = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/MapServer/export';
const WEB_MERCATOR_HALF = 20037508.342789244; // meters, EPSG:3857
const ATTRIBUTION = 'Charts: <a href="https://nauticalcharts.noaa.gov/" target="_blank" rel="noopener">NOAA Office of Coast Survey</a>';

/** EPSG:3857 bounds [minX, minY, maxX, maxY] of map tile x/y at zoom z. */
export function tileBounds3857(x, y, z) {
  const size = (2 * WEB_MERCATOR_HALF) / 2 ** z;
  const minX = -WEB_MERCATOR_HALF + x * size;
  const maxY = WEB_MERCATOR_HALF - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

/** URL of NOAA's cached chart tile for web map tile x/y/z. */
export function noaaChartTileUrl(x, y, z) {
  return TILE_URL.replace('{z}', z - 2).replace('{y}', y).replace('{x}', x);
}

/** URL of a live-drawn chart image covering web map tile x/y/z. */
export function noaaLiveChartUrl(x, y, z, scale = 2) {
  const px = 256 * scale;
  const params = new URLSearchParams({
    bbox: tileBounds3857(x, y, z).map((n) => n.toFixed(2)).join(','),
    bboxSR: '3857',
    imageSR: '3857',
    size: `${px},${px}`,
    dpi: String(96 * scale), // keep symbols and text the normal size
    format: 'png',
    transparent: 'false',
    f: 'image',
  });
  return `${LIVE_EXPORT_URL}?${params}`;
}

/** Leaflet layer for NOAA's cached chart tiles. */
export function noaaChartLayer(L) {
  const Layer = L.TileLayer.extend({
    getTileUrl: (coords) => noaaChartTileUrl(coords.x, coords.y, coords.z),
  });
  // 17 cached levels (0-16) = web zoom 2-18.
  return new Layer('', { minZoom: 2, maxZoom: 18, attribution: ATTRIBUTION });
}

/** Leaflet layer for live-drawn charts (backup). */
export function noaaLiveChartLayer(L) {
  const Layer = L.TileLayer.extend({
    getTileUrl: (coords) => noaaLiveChartUrl(coords.x, coords.y, coords.z),
  });
  // NOAA's live charts draw nothing when zoomed out further than ~5.
  return new Layer('', { minZoom: 5, maxZoom: 18, attribution: ATTRIBUTION });
}
