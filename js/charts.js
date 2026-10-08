// NOAA nautical charts.
//
// NOAA's Chart Display Service renders the official electronic navigational
// charts (ENC, updated weekly) in traditional paper-chart symbology. It's an
// ArcGIS "export" service: you ask for a bounding box and get an image back.
// We ask for one image per standard 256 px map tile, at 2x resolution so it's
// sharp on iPhone screens.

const EXPORT_URL = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/export';
const WEB_MERCATOR_HALF = 20037508.342789244; // meters, EPSG:3857

/** EPSG:3857 bounds [minX, minY, maxX, maxY] of map tile x/y at zoom z. */
export function tileBounds3857(x, y, z) {
  const size = (2 * WEB_MERCATOR_HALF) / 2 ** z;
  const minX = -WEB_MERCATOR_HALF + x * size;
  const maxY = WEB_MERCATOR_HALF - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

/** Image URL for one map tile of the NOAA chart. */
export function noaaChartTileUrl(x, y, z, scale = 2) {
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
  return `${EXPORT_URL}?${params}`;
}

/** Leaflet layer for the NOAA chart. */
export function noaaChartLayer(L) {
  const NoaaLayer = L.TileLayer.extend({
    getTileUrl: (coords) => noaaChartTileUrl(coords.x, coords.y, coords.z),
  });
  return new NoaaLayer('', {
    maxZoom: 18,
    minZoom: 3,
    attribution: 'Charts: <a href="https://nauticalcharts.noaa.gov/" target="_blank" rel="noopener">NOAA Office of Coast Survey</a>',
  });
}
