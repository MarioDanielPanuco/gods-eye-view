import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LEEWAY_CLASSES,
  EARTH_RADIUS_M,
  makeRng,
  randn,
  metFromDirToUV,
  oceanToDirToUV,
  perStepJibeProbability,
  makeForcingSampler,
  makeLandTester,
  runEnsemble,
} from './leeway.js';
import { packMaskStates, MASK_WATER, MASK_LAND, MASK_COASTAL } from '../data/landSeaMaskCodec.js';

/** Uniform 2x2x2 forcing grid: constant current + wind everywhere. */
function constantGrid({ curU = 0, curV = 0, windU = 0, windV = 0 } = {}) {
  const nodes = 4;
  const hours = 2;
  const fill = (value) => Float32Array.from({ length: nodes * hours }, () => value);
  return {
    lats: [33, 34],
    lons: [-119, -118],
    hoursMs: [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 30, 0, 0)],
    currentU: fill(curU),
    currentV: fill(curV),
    windU: fill(windU),
    windV: fill(windV),
  };
}

const SEED_LAT = 33.5;
const SEED_LON = -118.5;
const M_PER_RAD = EARTH_RADIUS_M;

function meanDisplacementMeters(result, n) {
  const frames = result.frames;
  const T = result.timesMs.length;
  const last = (T - 1) * n * 2;
  let dLonDeg = 0;
  let dLatDeg = 0;
  for (let i = 0; i < n; i += 1) {
    dLonDeg += frames[last + i * 2] - SEED_LON;
    dLatDeg += frames[last + i * 2 + 1] - SEED_LAT;
  }
  dLonDeg /= n;
  dLatDeg /= n;
  const east = (dLonDeg * Math.PI / 180) * M_PER_RAD * Math.cos(SEED_LAT * Math.PI / 180);
  const north = (dLatDeg * Math.PI / 180) * M_PER_RAD;
  return { east, north };
}

test('PIW leeway coefficients are the published USCG taxonomy values', () => {
  const piw = LEEWAY_CLASSES.PIW;
  assert.equal(piw.downwind.slopePct, 0.96);
  assert.equal(piw.downwind.offsetCms, 0);
  assert.equal(piw.downwind.stdCms, 12.0);
  assert.equal(piw.crosswind.slopePct, 0.54);
  assert.equal(piw.crosswind.offsetCms, 0);
  assert.equal(piw.crosswind.stdCms, 9.4);
  assert.equal(piw.jibeRatePerHour, 0.04);
});

test('direction conventions: wind is FROM, current is TO', () => {
  const westWind = metFromDirToUV(10, 270); // FROM west → blowing east
  assert.ok(Math.abs(westWind.u - 10) < 1e-9);
  assert.ok(Math.abs(westWind.v) < 1e-9);
  const northWind = metFromDirToUV(5, 0); // FROM north → blowing south
  assert.ok(Math.abs(northWind.u) < 1e-9);
  assert.ok(Math.abs(northWind.v + 5) < 1e-9);
  const eastCurrent = oceanToDirToUV(1, 90); // TO east
  assert.ok(Math.abs(eastCurrent.u - 1) < 1e-9);
  assert.ok(Math.abs(eastCurrent.v) < 1e-9);
});

test('per-step jibe probability matches the exponential-rate closed form', () => {
  // λ = -ln(1 - 0.04)/3600 s⁻¹; p(600 s) = 1 - exp(-λ·600)
  const expected = 1 - Math.exp(Math.log(1 - 0.04) * 600 / 3600);
  assert.ok(Math.abs(perStepJibeProbability(0.04, 600) - expected) < 1e-12);
  assert.equal(perStepJibeProbability(0, 600), 0);
});

test('rng is deterministic and randn produces both signs', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 5; i += 1) assert.equal(a(), b());
  const rng = makeRng(7);
  const draws = Array.from({ length: 100 }, () => randn(rng));
  assert.ok(draws.some((x) => x > 0) && draws.some((x) => x < 0));
});

test('forcing sampler reproduces a bilinear field and interpolates time linearly', () => {
  const grid = constantGrid();
  // Make currentU vary linearly with lon index at hour 0: nodes are lat-major.
  grid.currentU = Float32Array.from([0, 1, 0, 1, /* hour 1: */ 2, 3, 2, 3]);
  const sampler = makeForcingSampler(grid);
  const midLon = sampler(33, -118.5, grid.hoursMs[0]);
  assert.ok(Math.abs(midLon.curU - 0.5) < 1e-6, 'spatial midpoint of 0..1');
  const midTime = sampler(33, -119, (grid.hoursMs[0] + grid.hoursMs[1]) / 2);
  assert.ok(Math.abs(midTime.curU - 1) < 1e-6, 'time midpoint of 0..2');
  assert.equal(midTime.degraded, false);
});

test('forcing sampler zero-fills NaN nodes and flags degradation', () => {
  const grid = constantGrid({ curU: 0.5 });
  grid.currentU[0] = NaN;
  const sampler = makeForcingSampler(grid);
  const sample = sampler(33, -119, grid.hoursMs[0]);
  assert.ok(Number.isFinite(sample.curU));
  assert.equal(sample.degraded, true);
});

test('same seed → identical ensemble; different seed → different ensemble', () => {
  const options = {
    n: 64, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 2, dtMin: 10,
    grid: constantGrid({ curU: 0.3, windV: 8 }), rngSeed: 1234,
  };
  const a = runEnsemble(options);
  const b = runEnsemble(options);
  assert.deepEqual(Array.from(a.frames), Array.from(b.frames));
  const c = runEnsemble({ ...options, rngSeed: 999 });
  assert.notDeepEqual(Array.from(a.frames), Array.from(c.frames));
});

test('constant current + wind: ensemble mean drift matches the hand-computed leeway expectation', () => {
  const n = 2000;
  const horizonH = 6;
  // Current 0.3 m/s east; wind 10 m/s blowing north (FROM south).
  const result = runEnsemble({
    n, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH, dtMin: 10,
    grid: constantGrid({ curU: 0.3, windV: 10 }), rngSeed: 42,
  });
  const T = horizonH * 3600;
  const { east, north } = meanDisplacementMeters(result, n);
  // East: current only (crosswind signs are balanced) → 0.3 · 21600 = 6480 m.
  assert.ok(Math.abs(east - 0.3 * T) < 300, `east ${east.toFixed(0)} m vs ${0.3 * T} m`);
  // North: downwind leeway 0.96 % of 10 m/s = 0.096 m/s → 2073.6 m.
  assert.ok(Math.abs(north - 0.096 * T) < 300, `north ${north.toFixed(0)} m vs ${(0.096 * T).toFixed(0)} m`);
});

test('crosswind spreads symmetrically and jibing tightens the crosswind spread', () => {
  const base = {
    n: 1000, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 6, dtMin: 10,
    grid: constantGrid({ windV: 10 }), rngSeed: 5,
  };
  const noJibe = runEnsemble({ ...base, classOverrides: { jibeRatePerHour: 0 } });
  const fastJibe = runEnsemble({ ...base, classOverrides: { jibeRatePerHour: 20 } });

  const spreadEast = (result) => {
    const frames = result.frames;
    const last = (result.timesMs.length - 1) * base.n * 2;
    const lons = [];
    for (let i = 0; i < base.n; i += 1) lons.push(frames[last + i * 2]);
    const mean = lons.reduce((s, x) => s + x, 0) / lons.length;
    const variance = lons.reduce((s, x) => s + (x - mean) ** 2, 0) / lons.length;
    return { mean, sd: Math.sqrt(variance) };
  };

  const still = spreadEast(noJibe);
  // Balanced ± crosswind signs: the mean east displacement stays near zero
  // relative to the per-particle crosswind excursion (~1.2 km at 6 h).
  const meanEastM = (still.mean - SEED_LON) * Math.PI / 180 * M_PER_RAD * Math.cos(SEED_LAT * Math.PI / 180);
  assert.ok(Math.abs(meanEastM) < 200, `mean east ${meanEastM.toFixed(0)} m`);
  // Rapid jibing decorrelates the crosswind sign → tighter spread.
  assert.ok(spreadEast(fastJibe).sd < still.sd * 0.7, 'jibing must shrink crosswind dispersion');
});

/**
 * Bathymetry landMask: 3 lats x 5 lons, uniform spacing, z >= 0 means land.
 * Columns at lon >= -118.4 are land (a wall east of the seed) unless zLand
 * overrides the per-cell depth outright.
 */
function bathyWall({ zWater = -50, zLand = 0, allZ = null } = {}) {
  const lats = [33.4, 33.5, 33.6];
  const lons = [-118.5, -118.45, -118.4, -118.35, -118.3];
  const z = new Float64Array(lats.length * lons.length);
  for (let r = 0; r < lats.length; r += 1) {
    for (let c = 0; c < lons.length; c += 1) {
      z[r * lons.length + c] = allZ !== null ? allZ : (lons[c] >= -118.4 ? zLand : zWater);
    }
  }
  return { type: 'bathy', lats, lons, z };
}

/** Uniform-state packed bitmask landMask covering the whole globe coarsely. */
function uniformMask(state, width = 8, height = 4) {
  const states = new Uint8Array(width * height).fill(state);
  return { type: 'mask', width, height, data: packMaskStates(states) };
}

const WALL_OPTIONS = {
  n: 32, seedLat: 33.5, seedLon: -118.5,
  startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 6, dtMin: 10,
  grid: constantGrid({ curU: 0.5 }), rngSeed: 77, posSigmaM: 10,
};

test('no-mask frames are bit-identical to the pre-beaching baseline and beachedAtFrame is all -1', () => {
  // Baseline captured by running the pre-change runEnsemble on this exact
  // scenario (scratch script, 2026-08-29). Any drift here means the step
  // loop's arithmetic changed — the no-mask path must stay byte-identical.
  const nodes = 4;
  const hours = 2;
  const fill = (v) => Float32Array.from({ length: nodes * hours }, () => v);
  const grid = {
    lats: [33, 34], lons: [-119, -118],
    hoursMs: [Date.UTC(2026, 7, 29, 0, 0), Date.UTC(2026, 7, 30, 0, 0)],
    currentU: fill(0.3), currentV: fill(-0.1), windU: fill(3), windV: fill(8),
  };
  const options = {
    n: 8, seedLat: 33.5, seedLon: -118.5,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 2, dtMin: 10,
    grid, rngSeed: 1234,
  };
  const omitted = runEnsemble(options);
  assert.equal(omitted.frames.length, 208);
  const baseline = [
    [0, -118.49951934814453],
    [1, 33.49940490722656],
    [16, -118.49752044677734],
    [17, 33.5006103515625],
    [100, -118.48316955566406],
    [101, 33.498687744140625],
    [206, -118.47135925292969],
    [207, 33.49552917480469],
  ];
  for (const [k, value] of baseline) assert.equal(omitted.frames[k], value);
  assert.ok(omitted.beachedAtFrame instanceof Int32Array);
  assert.equal(omitted.beachedAtFrame.length, options.n);
  for (const value of omitted.beachedAtFrame) assert.equal(value, -1);
  const explicitNull = runEnsemble({ ...options, landMask: null });
  assert.deepEqual(Array.from(explicitNull.frames), Array.from(omitted.frames));
});

test('makeLandTester bathy: z >= 0 is land, z = -0.5 is water, nearest-cell clamped', () => {
  const isLand = makeLandTester(bathyWall());
  assert.equal(isLand(33.5, -118.5), false);
  assert.equal(isLand(33.5, -118.35), true);
  // Nearest cell: -118.43 rounds to the -118.45 water column; -118.42 to -118.4 land.
  assert.equal(isLand(33.5, -118.43), false);
  assert.equal(isLand(33.5, -118.42), true);
  // Clamped outside the grid to the nearest edge cell.
  assert.equal(isLand(90, -140), false);
  assert.equal(isLand(-90, 170), true);
  // z = -0.5 is water; z = 0 is land (the >= 0 rule exactly).
  assert.equal(makeLandTester(bathyWall({ allZ: -0.5 }))(33.5, -118.35), false);
  assert.equal(makeLandTester(bathyWall({ allZ: 0 }))(33.5, -118.5), true);
});

test('makeLandTester mask: land only when the cell state is MASK_LAND', () => {
  assert.equal(makeLandTester(uniformMask(MASK_LAND))(33.5, -118.5), true);
  assert.equal(makeLandTester(uniformMask(MASK_WATER))(33.5, -118.5), false);
  assert.equal(makeLandTester(uniformMask(MASK_COASTAL))(33.5, -118.5), false);
  assert.equal(makeLandTester(null), null);
});

test('bathy wall: particles beach at their last water position and stay frozen forever', () => {
  const result = runEnsemble({ ...WALL_OPTIONS, landMask: bathyWall() });
  const isLand = makeLandTester(bathyWall());
  const n = WALL_OPTIONS.n;
  const T = result.timesMs.length;
  for (let i = 0; i < n; i += 1) {
    const b = result.beachedAtFrame[i];
    assert.ok(b >= 1 && b < T, `particle ${i} must beach (got ${b})`);
    const lastWater = (b - 1) * n * 2 + i * 2;
    const frozenLon = result.frames[lastWater];
    const frozenLat = result.frames[lastWater + 1];
    // Frozen position is the last WATER position, never a land cell.
    assert.equal(isLand(frozenLat, frozenLon), false);
    for (let f = b; f < T; f += 1) {
      const off = f * n * 2 + i * 2;
      assert.equal(result.frames[off], frozenLon, `particle ${i} lon frame ${f}`);
      assert.equal(result.frames[off + 1], frozenLat, `particle ${i} lat frame ${f}`);
    }
  }
});

test('z = -0.5 everywhere never beaches; z = 0 everywhere beaches on the first step', () => {
  const wet = runEnsemble({ ...WALL_OPTIONS, landMask: bathyWall({ allZ: -0.5 }) });
  for (const value of wet.beachedAtFrame) assert.equal(value, -1);
  const dry = runEnsemble({ ...WALL_OPTIONS, landMask: bathyWall({ allZ: 0 }) });
  const n = WALL_OPTIONS.n;
  for (let i = 0; i < n; i += 1) {
    assert.equal(dry.beachedAtFrame[i], 1);
    // Frozen at the seed-scatter position recorded in frame 0.
    assert.equal(dry.frames[n * 2 + i * 2], dry.frames[i * 2]);
    assert.equal(dry.frames[n * 2 + i * 2 + 1], dry.frames[i * 2 + 1]);
  }
});

test('coastal bitmask cells never beach and leave the trajectory untouched', () => {
  const coastal = runEnsemble({ ...WALL_OPTIONS, landMask: uniformMask(MASK_COASTAL) });
  for (const value of coastal.beachedAtFrame) assert.equal(value, -1);
  const open = runEnsemble({ ...WALL_OPTIONS, landMask: null });
  assert.deepEqual(Array.from(coastal.frames), Array.from(open.frames));
});

test('ensemble with a landMask is deterministic under a fixed seed', () => {
  const a = runEnsemble({ ...WALL_OPTIONS, landMask: bathyWall() });
  const b = runEnsemble({ ...WALL_OPTIONS, landMask: bathyWall() });
  assert.deepEqual(Array.from(a.frames), Array.from(b.frames));
  assert.deepEqual(Array.from(a.beachedAtFrame), Array.from(b.beachedAtFrame));
});

test('every frame stays finite even when forcing has NaN holes', () => {
  const grid = constantGrid({ curU: 0.4, windV: 6 });
  grid.currentU[1] = NaN;
  grid.windV[2] = NaN;
  const result = runEnsemble({
    n: 128, seedLat: SEED_LAT, seedLon: SEED_LON,
    startTimeMs: Date.UTC(2026, 7, 29, 0, 0), horizonH: 3, dtMin: 10,
    grid, rngSeed: 11,
  });
  assert.equal(result.frames.length, result.timesMs.length * 128 * 2);
  for (const value of result.frames) assert.ok(Number.isFinite(value));
});
