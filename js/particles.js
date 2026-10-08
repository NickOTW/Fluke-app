// Windy-style animated wind streaks drawn on a canvas above the map tiles.
//
// Each particle is moved by the local wind every frame and leaves a short
// fading trail. Particle speed on screen is tied to wind speed (not to map
// zoom), and color shows strength.

const { L } = window;

const CELL_PX = 24; // wind is sampled on a screen grid this coarse
const PX_PER_FRAME_PER_KT = 0.13; // 12 kt ≈ 90 px/s at 60 fps
const FADE = 0.93; // trail persistence per frame
const AREA_PER_PARTICLE = 1600; // px² of screen per particle
const MAX_PARTICLES = 1500;

// [max knots, color] - first bucket whose limit exceeds the speed wins.
// One palette for dark maps (ocean, satellite), one for light maps (charts).
const BUCKETS = [6, 12, 18, 25, Infinity];
const PALETTES = {
  dark: ['rgba(255,255,255,0.75)', 'rgba(176,236,255,0.9)', 'rgba(255,226,122,0.95)',
    'rgba(255,165,80,0.95)', 'rgba(255,100,100,0.95)'],
  light: ['rgba(30,45,80,0.65)', 'rgba(20,80,170,0.8)', 'rgba(150,40,170,0.85)',
    'rgba(205,70,0,0.9)', 'rgba(200,0,30,0.9)'],
};

export class WindParticles {
  constructor(map) {
    this.map = map;
    this.field = null;
    this.enabled = true;
    this.particles = [];
    this.raf = 0;
    this.colors = PALETTES.dark;

    const pane = map.createPane('wind');
    pane.style.zIndex = 350; // above tiles (200), below shapes/markers (400+)
    pane.style.pointerEvents = 'none';
    this.canvas = L.DomUtil.create('canvas', 'wind-canvas', pane);
    this.ctx = this.canvas.getContext('2d');

    map.on('movestart zoomstart', () => this._stop(true));
    map.on('moveend resize', () => this._restart());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._stop(false); else this._restart();
    });
  }

  setField(field) {
    this.field = field;
    this._restart();
  }

  setLightBackground(light) {
    this.colors = light ? PALETTES.light : PALETTES.dark;
  }

  setEnabled(on) {
    this.enabled = on;
    if (on) this._restart(); else this._stop(true);
  }

  _stop(clear) {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (clear) {
      const { width, height } = this.canvas;
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      this.ctx.clearRect(0, 0, width, height);
    }
  }

  _restart() {
    this._stop(true);
    if (!this.enabled || !this.field || document.hidden) return;

    const size = this.map.getSize();
    const dpr = window.devicePixelRatio || 1;
    this.width = size.x;
    this.height = size.y;
    this.canvas.width = Math.round(size.x * dpr);
    this.canvas.height = Math.round(size.y * dpr);
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The pane moves with the map while panning; pin the canvas to the viewport.
    L.DomUtil.setPosition(this.canvas, this.map.containerPointToLayerPoint([0, 0]));

    this._buildGrid();
    const count = Math.min(MAX_PARTICLES, Math.round((size.x * size.y) / AREA_PER_PARTICLE));
    this.particles = Array.from({ length: count }, () => this._spawn({}));
    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame((t) => this._frame(t));
  }

  _buildGrid() {
    const now = Date.now();
    this.gridCols = Math.ceil(this.width / CELL_PX) + 1;
    this.gridRows = Math.ceil(this.height / CELL_PX) + 1;
    this.grid = new Float32Array(this.gridCols * this.gridRows * 3);
    for (let r = 0; r < this.gridRows; r += 1) {
      for (let c = 0; c < this.gridCols; c += 1) {
        const ll = this.map.containerPointToLatLng([c * CELL_PX, r * CELL_PX]);
        const w = this.field.at(ll.lat, ll.lng, now);
        const k = (r * this.gridCols + c) * 3;
        this.grid[k] = w.u * PX_PER_FRAME_PER_KT;
        this.grid[k + 1] = -w.v * PX_PER_FRAME_PER_KT; // screen y points down
        this.grid[k + 2] = w.speedKt;
      }
    }
  }

  _sample(x, y) {
    const c = Math.max(0, Math.min(this.gridCols - 1, Math.round(x / CELL_PX)));
    const r = Math.max(0, Math.min(this.gridRows - 1, Math.round(y / CELL_PX)));
    const k = (r * this.gridCols + c) * 3;
    return [this.grid[k], this.grid[k + 1], this.grid[k + 2]];
  }

  _spawn(p) {
    p.x = Math.random() * this.width;
    p.y = Math.random() * this.height;
    p.age = 0;
    p.maxAge = 40 + Math.random() * 80;
    return p;
  }

  _frame(now) {
    const dt = Math.min(3, (now - this.lastFrame) / 16.7);
    this.lastFrame = now;
    const { ctx } = this;

    // Fade what's already drawn so old positions become trails.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0,0,0,${FADE ** dt})`;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.globalCompositeOperation = 'source-over';

    // Batch line segments by color for speed.
    const batches = BUCKETS.map(() => []);
    for (const p of this.particles) {
      const [vx, vy, kt] = this._sample(p.x, p.y);
      const nx = p.x + vx * dt;
      const ny = p.y + vy * dt;
      p.age += dt;
      const out = nx < 0 || ny < 0 || nx > this.width || ny > this.height;
      if (p.age > p.maxAge || out) {
        this._spawn(p);
        continue;
      }
      const bucket = BUCKETS.findIndex((max) => kt < max);
      batches[bucket].push(p.x, p.y, nx, ny);
      p.x = nx;
      p.y = ny;
    }

    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    batches.forEach((segs, i) => {
      if (!segs.length) return;
      ctx.strokeStyle = this.colors[i];
      ctx.beginPath();
      for (let j = 0; j < segs.length; j += 4) {
        ctx.moveTo(segs[j], segs[j + 1]);
        ctx.lineTo(segs[j + 2], segs[j + 3]);
      }
      ctx.stroke();
    });

    this.raf = requestAnimationFrame((t) => this._frame(t));
  }
}
