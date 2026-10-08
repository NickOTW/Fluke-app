import test from 'node:test';
import assert from 'node:assert/strict';
import { noaaChartTileUrl, tileBounds3857 } from '../js/charts.js';

const HALF = 20037508.342789244;

test('zoom 0 tile covers the whole web mercator world', () => {
  const [minX, minY, maxX, maxY] = tileBounds3857(0, 0, 0);
  assert.ok(Math.abs(minX + HALF) < 1e-6 && Math.abs(maxX - HALF) < 1e-6);
  assert.ok(Math.abs(minY + HALF) < 1e-6 && Math.abs(maxY - HALF) < 1e-6);
});

test('tile y counts down from the top', () => {
  // Zoom 1, tile (1,1) is the south-east quarter.
  assert.deepEqual(tileBounds3857(1, 1, 1).map(Math.round), [0, -Math.round(HALF), Math.round(HALF), 0]);
});

test('tile URL asks for a 2x image of the right box', () => {
  // Zoom 15 tile containing a spot off Montauk.
  const url = new URL(noaaChartTileUrl(9838, 12337, 15));
  assert.equal(url.searchParams.get('size'), '512,512');
  assert.equal(url.searchParams.get('dpi'), '192');
  assert.equal(url.searchParams.get('f'), 'image');
  const [minX, minY, maxX, maxY] = url.searchParams.get('bbox').split(',').map(Number);
  assert.ok(Math.abs(maxX - minX - (2 * HALF) / 2 ** 15) < 0.02);
  assert.ok(Math.abs(maxY - minY - (2 * HALF) / 2 ** 15) < 0.02);
  // Montauk is around x = -8.0e6 m, y = 5.0e6 m.
  assert.ok(minX < -7.9e6 && minX > -8.1e6, `minX ${minX}`);
  assert.ok(minY > 4.9e6 && minY < 5.1e6, `minY ${minY}`);
});
