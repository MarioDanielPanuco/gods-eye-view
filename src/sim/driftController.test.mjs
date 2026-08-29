import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeForcingGrid,
  frameForTime,
  createDriftController,
  DRIFT_OVERLAY_SOURCE_ID,
  DRIFT_DEFAULTS,
} from './driftController.js';

const HOURS = [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 29, 1, 0)];

/** Minimal 1x1 marine-grid payload (single node, two hours). */
function gridPayload() {
  return {
    status: 'ready',
    seed: { latitude: 33.5, longitude: -118.5 },
    grid: { lats: [33.5], lons: [-118.5] },
    hoursMs: HOURS,
    nodes: [{
      waveHeightM: [1, 1.1],
      currentKmh: [3.6, 7.2],
      currentDirDeg: [90, 90],
      windMs: [10, 10],
      windDirDeg: [180, 180],
    }],
  };
}

test('normalizeForcingGrid converts units and directions into u/v component fields', () => {
  const grid = normalizeForcingGrid(gridPayload());
  assert.deepEqual(grid.lats, [33.5]);
  assert.deepEqual(grid.lons, [-118.5]);
  assert.deepEqual(Array.from(grid.hoursMs), HOURS);
  // Current 3.6 km/h toward 90° → 1 m/s east at hour 0; 2 m/s at hour 1.
  assert.ok(Math.abs(grid.currentU[0] - 1) < 1e-9);
  assert.ok(Math.abs(grid.currentV[0]) < 1e-9);
  assert.ok(Math.abs(grid.currentU[1] - 2) < 1e-9);
  // Wind 10 m/s FROM 180° → blowing north: u≈0, v≈10.
  assert.ok(Math.abs(grid.windU[0]) < 1e-9);
  assert.ok(Math.abs(grid.windV[0] - 10) < 1e-9);
});

test('normalizeForcingGrid marks missing samples NaN and rejects malformed payloads', () => {
  const payload = gridPayload();
  payload.nodes[0].currentKmh[0] = null;
  const grid = normalizeForcingGrid(payload);
  assert.ok(Number.isNaN(grid.currentU[0]));
  assert.ok(Number.isFinite(grid.currentU[1]));

  assert.equal(normalizeForcingGrid(null), null);
  assert.equal(normalizeForcingGrid({ grid: { lats: [1], lons: [1] }, hoursMs: [], nodes: [] }), null);
  assert.equal(normalizeForcingGrid({ grid: { lats: [1], lons: [1] }, hoursMs: HOURS, nodes: [] }), null);
});

test('frameForTime clamps to the ensemble time range and picks the nearest frame', () => {
  const times = Float64Array.from([0, 600000, 1200000]);
  assert.equal(frameForTime(times, -5), 0);
  assert.equal(frameForTime(times, 250000), 0);
  assert.equal(frameForTime(times, 350000), 1);
  assert.equal(frameForTime(times, 9e12), 2);
  assert.equal(frameForTime(Float64Array.from([]), 0), -1);
});

function makeCollection() {
  const points = [];
  return {
    points,
    destroyCalls: 0,
    add(options) { const p = { ...options }; points.push(p); return p; },
    removeAll() { points.length = 0; },
    isDestroyed() { return Boolean(this.destroyed); },
    // Honor Cesium's contract: destroying a destroyed object throws
    // (DeveloperError from destroyObject) — the double must be as strict.
    destroy() {
      if (this.destroyed) throw new Error('This object was destroyed, i.e., destroy() was called.');
      this.destroyCalls += 1;
      this.destroyed = true;
    },
  };
}

function makeSeams() {
  const overlayCalls = [];
  const collection = makeCollection();
  const panel = { frames: [], destroyed: false };
  const seams = {
    overlayCalls,
    collection,
    panel,
    // Params the injected runEnsembleFn last received (landMask assertions).
    ensembleParams: null,
    // Per-test ETOPO response; default 503 so the bitmask fallback engages.
    etopoResponse: async () => ({ ok: false, status: 503 }),
    options: {
      viewer: {
        scene: {
          primitives: {
            added: [],
            add(c) { this.added.push(c); return c; },
            // Honor Cesium's contract: PrimitiveCollection.remove DESTROYS the
            // primitive (destroyPrimitives defaults to true) — the real-app
            // re-run bug lived exactly in this divergence of the old double.
            remove(c) {
              const present = this.added.includes(c);
              this.added = this.added.filter((x) => x !== c);
              if (present && !c.destroyed) c.destroy();
            },
            raiseToTop() {},
          },
        },
      },
      overlayHost: {
        setEntries: (...args) => overlayCalls.push(['entries', ...args]),
        clearSource: (...args) => overlayCalls.push(['clear', ...args]),
      },
      fetchImpl: async (url) => {
        if (String(url).includes('/api/ocean/etopo')) return seams.etopoResponse();
        return { ok: true, json: async () => gridPayload() };
      },
      maskLoaderFn: async () => ({ width: 4, height: 2, data: new Uint8Array([0b01, 0]) }),
      runEnsembleFn: async (params) => {
        seams.ensembleParams = params;
        // Two frames, params.n particles, all at the seed.
        const n = params.n;
        const frames = new Float32Array(2 * n * 2);
        for (let t = 0; t < 2; t += 1) {
          for (let i = 0; i < n; i += 1) {
            frames[(t * n + i) * 2] = params.seedLon + t * 0.01;
            frames[(t * n + i) * 2 + 1] = params.seedLat;
          }
        }
        return { timesMs: Float64Array.from(HOURS), frames, n, degraded: false };
      },
      collectionFactory: () => collection,
      panelFactory: () => ({
        setFrame: (i) => panel.frames.push(i),
        setPlaying: () => {},
        destroy: () => { panel.destroyed = true; },
      }),
    },
  };
  return seams;
}

test('start builds the particle cloud, publishes the SIMULATED banner, and setFrame scrubs it', async () => {
  const seams = makeSeams();
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, label: 'test seed', n: 16 });
  assert.equal(result.ok, true);

  assert.equal(seams.collection.points.length, 16);
  assert.equal(seams.options.viewer.scene.primitives.added.length, 1);

  const banner = seams.overlayCalls.find(([kind, sourceId]) => kind === 'entries' && sourceId === DRIFT_OVERLAY_SOURCE_ID);
  assert.ok(banner, 'drift banner published');
  assert.match(banner[2][0].title, /SIMULATED/i);

  const lonAtFrame0 = seams.collection.points[0].position;
  controller.setFrame(1);
  const lonAtFrame1 = seams.collection.points[0].position;
  assert.notDeepEqual(lonAtFrame1, lonAtFrame0, 'scrubbing moves the particles');

  controller.dispose();
  assert.equal(seams.collection.destroyed, true);
  assert.equal(seams.panel.destroyed, true);
  assert.ok(seams.overlayCalls.some(([kind, sourceId]) => kind === 'clear' && sourceId === DRIFT_OVERLAY_SOURCE_ID));
});

test('start reports failure when the forcing grid is unavailable', async () => {
  const seams = makeSeams();
  seams.options.fetchImpl = async () => ({ ok: false, status: 503 });
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, n: 8 });
  assert.equal(result.ok, false);
  assert.ok(result.reason);
  assert.equal(seams.options.viewer.scene.primitives.added.length, 0);
});

test('a second start disposes the first simulation', async () => {
  const seams = makeSeams();
  const first = makeCollection();
  const second = makeCollection();
  let call = 0;
  seams.options.collectionFactory = () => (call++ === 0 ? first : second);
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  await controller.start({ lat: 34.0, lon: -119.0, n: 4 });
  assert.equal(first.destroyed, true);
  assert.equal(second.destroyed, undefined);
  controller.dispose();
});

test('start passes a bathy landMask to the ensemble when ETOPO succeeds', async () => {
  const seams = makeSeams();
  seams.etopoResponse = async () => ({
    ok: true,
    json: async () => ({ status: 'ok', lats: [33, 34], lons: [-119, -118], z: [-10, -5, 0, 3] }),
  });
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  assert.equal(result.ok, true);
  const mask = seams.ensembleParams.landMask;
  assert.equal(mask?.type, 'bathy');
  assert.deepEqual(mask.lats, [33, 34]);
  assert.deepEqual(mask.lons, [-119, -118]);
  assert.ok(mask.z instanceof Float32Array, 'z coerced to Float32Array');
  assert.deepEqual(Array.from(mask.z), [-10, -5, 0, 3]);
  controller.dispose();
});

test('start falls back to the bundled bitmask when ETOPO is unavailable', async () => {
  const seams = makeSeams(); // default etopoResponse is a 503
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  assert.equal(result.ok, true);
  const mask = seams.ensembleParams.landMask;
  assert.equal(mask?.type, 'mask');
  assert.equal(mask.width, 4);
  assert.equal(mask.height, 2);
  assert.ok(mask.data instanceof Uint8Array);
  controller.dispose();
});

test('start still succeeds with a null landMask when ETOPO and the bitmask both fail', async () => {
  const seams = makeSeams();
  seams.etopoResponse = async () => { throw new Error('network down'); };
  seams.options.maskLoaderFn = async () => { throw new Error('asset missing'); };
  const controller = createDriftController(seams.options);
  const result = await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  assert.equal(result.ok, true);
  assert.equal(seams.ensembleParams.landMask, null);
  controller.dispose();
});

/** Seams whose ensemble beaches particles 1 and 2 at frames 1 and 2 of 3. */
function beachingSeams() {
  const seams = makeSeams();
  seams.options.runEnsembleFn = async (params) => {
    seams.ensembleParams = params;
    const n = params.n;
    const frames = new Float32Array(3 * n * 2);
    for (let t = 0; t < 3; t += 1) {
      for (let i = 0; i < n; i += 1) {
        frames[(t * n + i) * 2] = params.seedLon;
        frames[(t * n + i) * 2 + 1] = params.seedLat;
      }
    }
    return {
      timesMs: Float64Array.from([0, 600000, 1200000]),
      frames,
      n,
      degraded: false,
      beachedAtFrame: Int32Array.from([-1, 1, 2, -1]),
    };
  };
  return seams;
}

test('setFrame recolors beached particles per-frame and reverts on back-scrub', async () => {
  const seams = beachingSeams();
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  const points = seams.collection.points;
  const live = points[0].color;

  // Frame 0: nothing beached yet.
  assert.deepEqual(points[1].color, live);
  assert.deepEqual(points[2].color, live);

  controller.setFrame(1); // particle 1 beaches at frame 1
  assert.notDeepEqual(points[1].color, live);
  assert.deepEqual(points[2].color, live);

  controller.setFrame(2); // particle 2 beaches at frame 2
  assert.notDeepEqual(points[2].color, live);
  assert.deepEqual(points[1].color, points[2].color);
  assert.deepEqual(points[0].color, live);
  assert.deepEqual(points[3].color, live);

  controller.setFrame(0); // back-scrub restores the live color
  assert.deepEqual(points[1].color, live);
  assert.deepEqual(points[2].color, live);
  controller.dispose();
});

test('setFrame reports the beached count to the panel, frame-derived', async () => {
  const seams = beachingSeams();
  const calls = [];
  seams.options.panelFactory = () => ({
    setFrame: (i, offsetMs, beachedCount) => calls.push([i, beachedCount]),
    setPlaying: () => {},
    destroy: () => {},
  });
  const controller = createDriftController(seams.options);
  await controller.start({ lat: 33.5, lon: -118.5, n: 4 });
  assert.deepEqual(calls.at(-1), [0, 0]);
  controller.setFrame(1);
  assert.deepEqual(calls.at(-1), [1, 1]);
  controller.setFrame(2);
  assert.deepEqual(calls.at(-1), [2, 2]);
  controller.setFrame(0);
  assert.deepEqual(calls.at(-1), [0, 0]);
  controller.dispose();
});

test('the simulation can be re-run: start → start, and start → dispose → start', async () => {
  const seams = makeSeams();
  const collections = [];
  seams.options.collectionFactory = () => {
    const c = makeCollection();
    collections.push(c);
    return c;
  };
  const controller = createDriftController(seams.options);

  assert.equal((await controller.start({ lat: 33.5, lon: -118.5, n: 4 })).ok, true);
  assert.equal((await controller.start({ lat: 34.0, lon: -119.0, n: 4 })).ok, true, 'second start succeeds');
  assert.equal(collections[0].destroyCalls, 1, 'first collection destroyed exactly once');

  controller.dispose();
  assert.equal(collections[1].destroyCalls, 1, 'disposed collection destroyed exactly once');
  assert.equal((await controller.start({ lat: 33.5, lon: -118.5, n: 4 })).ok, true, 'start after dispose succeeds');
  controller.dispose();
});

test('defaults respect the frame-buffer memory budget', () => {
  // n · (60·horizonH/dtMin + 1) · 2 · 4 bytes — must stay ≈ tens of MB.
  const frames = DRIFT_DEFAULTS.n * (60 * DRIFT_DEFAULTS.horizonH / DRIFT_DEFAULTS.dtMin + 1) * 2 * 4;
  assert.ok(frames < 32 * 1024 * 1024, `frame buffer ${frames} bytes exceeds 32 MB`);
});
