# Changelog

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [Unreleased] — 2026-08-28

### Added

- Added the Ocean Currents field layer (share token `n`): an animated
  streakline rendering of the surface-current field over the camera's view,
  served by `/api/ocean/field` as a two-tier ladder — IOOS HF-radar total
  vectors (0.5–6 km, hourly) put through QC gates and a two-pass Barnes objective
  analysis with holdout cross-validation where the network reaches, and NOAA
  CoastWatch's geostrophic-only 0.25° altimetric analysis everywhere else. The legend
  names the tier, its dataset, its age, its coverage over water, and (for
  radar) the holdout RMSE, so an observed 1 km field and a two-day-old 28 km
  model field are never presented as the same thing, and a view served by both
  is labeled `composite` and states the split. Coverage is measured over
  water cells using the bundled GSHHG mask, and cells with no data are drawn as
  nothing rather than as slack water. Tier logic and ingest live in
  `src/server/ocean/*` rather than in `vite.config.js` (issue #41).
- Added the Ocean Conditions layer: ~900 NOAA NDBC buoy stations from one
  server-cached bulk feed, of which the 20–30% that report significant wave
  height are color-banded by it (the reporting fraction varies by hour; three
  same-day samples gave 20.5%, 21.9% and 29.7%), with
  sparse observation cards, Open-Meteo Marine forecast lines (`FC`-labeled),
  ocean-point forecast cards, analyst-query coverage, voice aliases
  ("buoys", "sea state", "waves"), and share token `o`.
- Added a person-overboard drift Monte Carlo MVP: USCG PIW-1 leeway
  coefficients (Allen & Plourde 1999 / Allen 2005; Breivik & Allen 2008
  formulation), 10⁴-particle ensembles run in a worker over a 5×5
  Open-Meteo forecast grid, rendered as a scrubbable particle cloud labeled
  `SIMULATED DRIFT ENSEMBLE — NOT A SAR PRODUCT`, started from a `▶ DRIFT`
  chip on buoy and ocean-point cards.
- Added a bundled global land/sea mask (GSHHG-derived, 1/8°, three-state)
  that gates ocean clicks instantly — land clicks produce nothing, water
  clicks get their card and DRIFT chip before any network round-trip, and
  coastal cells keep the honest live-probe fallback.
- Added drift-particle beaching: ETOPO bathymetry (2 arc-min, `z ≥ 0` ⇒
  land, with the bundled mask as offline fallback) freezes particles at
  their last water position, recolors them, and the scrub panel reports
  `⚓ N beached`.
- Upgraded the drift integrator from forward Euler to classical RK4
  (convergence-tested against closed-form trajectories), added a per-step
  turbulent-diffusion term, a deterministic control particle (particle 0:
  unperturbed best-estimate track), and mean-drift/spread diagnostics.
- Added a drift parameter window: horizon (6/12/24/48 h), particle count,
  turbulence σ, FORECAST/HINDCAST direction, and a RERUN button that
  re-runs the same seed with new parameters. Backward (hindcast) runs are
  labeled `REVERSE DRIFT — origin hypothesis` and clock as `T−hh:mm`; the
  forcing grid now carries 48 h of past hours to feed them.

### Changed

- The HF-radar Barnes length scale is retuned from `L = 2d + 6 km` to
  `L = 2.05·d`, with a 2.05 km floor, putting the two-pass half-amplitude
  wavelength at 4× the observation spacing instead of 10.5×. The old rule
  smoothed the 2 km product to a 19.5 km half-amplitude scale — barely finer
  than the global tier it exists to improve on — and its response at the data's
  own Nyquist wavelength (2Δ = 3.7 km at a measured 1.86 km spacing) was
  0.0000. Measured effect on a live offshore Monterey box: holdout RMSE 0.069 →
  0.043 m/s at full coverage. The trade is spatial reach: a narrower kernel
  constrains fewer cells, so on a 1° coastal box the radar share of the
  composite falls from 30% to 11% and HYCOM fills the rest.
- The drift simulation's initial position scatter is now a labelled control,
  **last known position uncertainty**, with three bands — witnessed 300 m,
  estimated 1 km, uncertain 5 km — defaulting to 1 km rather than the previous
  hardcoded 300 m. It is a physical uncertainty (how well the entry point is
  known), not a display parameter, and the spread the panel reports is
  uninterpretable without it; a 300 m assumption on a position that was actually
  estimated understates the search area.
- The Ocean Currents layer's global tier is now **HYCOM ESPC-D-V02** rather than
  NOAA CoastWatch's blended altimetry. The altimetry product is
  `surface_geostrophic_eastward_sea_water_velocity` — absolute geostrophic
  velocity and nothing else: no Ekman, no wind drift, no tides. Measured against
  OSCAR (geostrophic + Ekman + buoyancy) over 77,715 matched cell-days, its
  missing ageostrophic component is 0.176 m/s RMS globally and 0.351 m/s within
  10° of the equator, where the omitted signal is comparable to the retained
  one; its own near-real-time and delayed-time versions differ by 0.228 m/s RMS
  over 79,365 matched pairs, which is 2–3× the HF-radar tier's reported error;
  and its measured effective resolved wavelength is ~300 km, not the 0.25° its
  grid implies. HYCOM is a primitive-equation forecast carrying wind-driven flow
  and eight astronomically forced tidal constituents on a 0.04°×0.08° grid at
  3-hourly steps from −10 d to +5 d, so it is physically comparable to the
  HF-radar tier — which contains tides — instead of merely adjacent to it. The
  altimetry product is retained as an automatic fallback, and the legend names
  whichever source served along with its physics.

### Fixed

- **The HYCOM tier never actually served.** `parseHycomAscii` required both
  velocity components to carry a coordinate map named exactly `time`, but the
  THREDDS FMRC aggregation numbers the two axes apart — the `.dds` declares
  `water_u[time]` beside `water_v[time1]` — so the parser rejected every
  well-formed response as shape drift and `globalTier` fell through to the
  altimetry fallback on 100% of requests. Measured across five disjoint boxes
  (Monterey, mid-Pacific, North Sea, antimeridian, equator): 5/5 failed against
  a healthy upstream, and renaming `time1` to `time` in a captured body made the
  same parser succeed. The time map is now matched by family, which is safe
  because the two axes are the same axis under two names (max |time − time1| = 0
  across all 129 steps) and the cross-component equality check on the VALUE
  still refuses a genuine mismatch. The test fixture reproduced the server's
  variable *ordering* quirk but not its *naming* quirk, so all 52 of the
  module's tests passed against a body the server never sends; the builder now
  emits the real shape, which turns 10 of them into a regression guard.
- A forecast field is no longer labelled `just now`. `fieldGrid.resolveAgeMs`
  clamped its input with `Math.max(0, …)`, discarding the negative `ageMs` that
  HYCOM reports on purpose for a step valid ahead of now, so a field valid five
  days out rendered as a just-published analysis with `stale: false` — the one
  substitution `hycomCurrents.js` had gone to trouble to avoid. The sign is kept
  on the fetcher-reported branch (measured against *now*) and still clamped on
  the derived branch (measured against the *requested* instant, which may be
  historical); `formatAge` renders a negative age as `4 days ahead`;
  `isForecast` / `forecastLeadMs` ride through `provenance` and `sources[]`; and
  the caveat that fires for a future valid time now distinguishes a forecast
  step from the altimetry fetcher's "newest published step" limit.
- The Ocean Currents layer reported no status at all. It exposed `getStatus()`
  while `DataLayerManager` reads `getStats()` and early-returns a
  `{count: 0, lastUpdate: null}` stub for anything else, so the DATA panel row
  showed a blank count and "never" permanently — including while `refresh()` was
  failing. It is the only one of ~25 layer modules that used the other name. The
  contract test asserted the wrong name too, certifying the break rather than
  catching it; it now drives `DataLayerManager._moduleStats` itself. `getStats()`
  also reports which rung served, so the row cannot advertise HF radar over a
  view that is 89% model fill.
- `/api/ocean/field` answered HTTP 500 `ocean proxy error` for every malformed
  request. `normalizeBox` signals refusal by throwing, so the handler's
  `if (!box)` 400 branch was unreachable and the throw fell through to the outer
  catch. Verified live against five invalid inputs, all 500 before and 400 after.
  A new `tryNormalizeBox` returns the refusal instead of throwing, bounds are
  read for presence rather than finiteness (`Number(null) === 0` turned an
  omitted bound into a valid zero), and the 400 names which bound was wrong.
  Four route-level tests now drive the middleware; previously all 26 tests in
  `oceanProxy.test.mjs` called pure helpers, leaving dispatch, method checks and
  status codes covered by nothing.
- The bundled land/sea mask no longer puts a Node builtin in a browser module.
  `data/landSeaMask.js` branched on an `isNode` check around a dynamic fs
  import, reintroducing exactly what upstream removed in `6d83bb6`; Vite
  externalizes `node:*` for the browser and only warns, so it survived the
  build. The binary asset has no import-attribute equivalent, so it is now two
  modules over one pure codec — `data/landSeaMask.js` fetches, the new
  `server/landSeaMaskNode.js` reads the file — and `browserModuleBoundary.test.mjs`
  gains a second assertion that no browser module imports from `src/server/`,
  which is what makes excluding that tree from the first assertion sound.
- Voice could not turn the current field on. `ocean-field` was in the layer
  registry and `main.js` but in none of the tool enums and had no aliases, so
  "show me the ocean currents" resolved to `ocean-conditions` — the buoys.
- The global tier was described as "blended geostrophic + Ekman" in four places.
  It has no Ekman component at all; the dataset's CF `standard_name` is
  `surface_geostrophic_*_sea_water_velocity` and its metadata contains no
  mention of wind. Corrected in `fieldGrid.js`, its `@file` block, the
  `provenance.method` string the legend renders from, and `DATA_SOURCES.md`.
- The drift forcing grid is now georeferenced to the coordinates Open-Meteo
  **served**, not the ones requested. Open-Meteo snaps each requested point to
  its own 1/12° cell centre, so the requested lattice attributed every velocity
  to a point it was not sampled at — bounded by the cell half-diagonal, 5.94 km
  at 36.8°N, and measured at 3.87 km max / 3.82 km median over the Monterey
  grid. Correcting it moves a 24 h ensemble endpoint 1.315 km on a 10.227 km
  drift. Separately, upstream answers a request that lands on land by
  substituting a different cell's water, observed up to 22.5 km away; those
  nodes are now identified against their row/column consensus and **dropped**
  (their series blanked to a NaN gap) rather than georeferenced at all. The
  payload reports `maxNodeSnapM`, dropped-node counts, and the marine-vs-wind
  endpoint skew.
- A 48 h drift run no longer silently integrates its tail on a frozen field.
  `forecast_days` was 2, whose axis ends at (today + 1) 23:00 UTC, giving a run
  launched at hour *h* only (47 − *h*) hours of forward lead — so **every** 48 h
  run extrapolated past the end of its forecast, by 1 to 24 h, while reporting
  `degraded = false`. Measured cost at Monterey: the mean endpoint shifted
  10.653 km against a correctly-forced mean drift of 5.575 km. The request now
  covers the longest offered horizon, and time clamping is reported separately
  from value gaps (`clampedInTime` / `clampedFrames`) because they are
  different failures.
- Two overlapping drift starts no longer leak a GPU collection and a DOM panel.
  `start()` awaited seconds of I/O before taking ownership, and `dispose()` only
  ever reached the current run, so the orphaned panel's callbacks kept driving
  the surviving simulation. A monotonic run token now retires the superseded
  start at every await.
- The drift simulation can run more than once: disposing a run no longer
  destroys its particle collection twice (Cesium's `PrimitiveCollection`
  destroys on `remove`), which had bricked every start after the first.

## [Unreleased] — 2026-08-24

### Added

- Added honest aircraft identity narration: callsign, operator, registration,
  type, and route come only from selected-contact context, and missing operator,
  route, or type enrichment is named explicitly.
- Added local, publication-compatible copies of the two README PNGs, with source
  records and third-party-license boundaries in `docs/media/README.md`.
- Added regression coverage for aircraft identity narration and optional-key
  loading feedback.

### Changed

- First-run presentation now opens with Detection `DENSE` at 75%, `ELASTIC`
  allocation, Fade 7%, Outside 1%, scope feather 11%, and aircraft 3D models in
  `PROXIMITY`. Stored state and share links still override these baselines.
- The 17 selected README GIFs remain unchanged and are documented separately
  from the two owner-published PNGs.
- Bundled datacenter and dam snapshots now omit contact-oriented fields and
  note values containing email or phone identifiers. Feature geometry, names,
  operator/capacity/river metadata, counts, and ODbL terms are unchanged.
- Public documentation and the L9 release matrix no longer reference non-public
  planning material or repository history.

### Fixed

- A missing optional FIRMS key no longer turns the complete Environmental
  mission into `LOAD FAILED`. The FIRMS row still reports `KEY REQUIRED`, while
  earthquakes continue to load. Real lifecycle and fetch failures retain
  failure priority.
- The mapped-installations layer retries after an unavailable request when it is
  enabled or the camera settles.
- Aircraft trails attach to the rendered aircraft transform and remain near the
  rear center across headings. Parked aircraft do not draw a moving head
  segment.
- Grounded aircraft keep validated floor evidence through temporary terrain
  outages and wait for measured photoreal-surface evidence before a 3D model
  takes over from its billboard.
- Cockpit altitude uses aviation MSL data rather than Cesium render height.

### Security

- Production transitive dependencies resolve to patched DOMPurify and
  protobufjs releases without changing the Cesium version or application APIs.
- Production dependency audit reports no known advisories; remaining audit
  findings are confined to development and QA tooling.

## [Unreleased] — 2026-08-23

### Added

- Added a first-run mission launcher for Contacts, Space Missions,
  Environmental, and manual exploration.
- Added terrain-validity gating and bounded last-known placement for grounded
  aircraft models.

### Changed

- Environmental consistently presents both earthquakes and NASA FIRMS fires,
  with honest optional-key degradation.
- The tracked aircraft trail acceptance bar is visual: roughly rear-center,
  stable across headings, with minor hull overlap allowed and no conspicuous
  top, bottom, or lateral projection.

## [Unreleased] — 2026-08-18 to 2026-08-22

### Added

- Added the four-source Map Source tray, share-link v2 state, cockpit/context
  voice parity, MSL altitude readouts, and close-range tracked aircraft models.
- Added the L9 release-candidate matrix, AIS feed watchdog, voice cost controls,
  satellite classes, and the shared world-overlay host.
- Added deterministic first-run, map-source, floor, overlay, tracking, and
  aircraft-model regression harnesses.

### Changed

- Consolidated world labels, cards, tracked readouts, CCTV thumbnails, cable
  labels, mission labels, and detection presentation under shared allocation and
  lifecycle rules.
- Reduced idle rendering through the render governor and explicit scope mask.
- Improved cockpit layout, context restoration, keyless feed honesty, and
  aircraft 2D/3D handoffs.

### Fixed

- Fixed degenerate depth picks, map-source restore states, route-camera motion,
  bright-ground label readability, grounded display flooring, and cross-layer
  tracking cleanup.
- Fixed stale overlay callbacks, parked-idle render leaks, cable-label sweep
  starvation, and several share-link state conflicts.

## [Unreleased] — 2026-08-02 to 2026-08-16

### Added

- Added Global Context modes, Cockpit briefing surfaces, Radio context,
  satellite mission replay, and real per-class aircraft models with adjacent
  provenance records.
- Added a shared screen-space overlay system with bounded allocation for labels,
  cards, callouts, detection brackets, and selected-object presentation.

### Changed

- Unified right-side product controls and responsive cockpit/map layouts.
- Migrated public-safe neighborhood geometry to DataSF and tightened safe local
  development defaults.
- Improved proxy resilience, annotation outline bounds, CCTV enable pacing,
  contact de-emphasis, and deterministic visual stacking.

## [Unreleased] — July 2026

### Added

- Added live NASA FIRMS fires, optional live TomTom traffic, Caltrans and TfL
  CCTV packs, CCTV viewsheds and direct-manipulation calibration, citywide CCTV
  cards, Natural Earth regions, analyst queries, and voice routing QA.
- Added the end-to-end vertical-datum system for aircraft, vessels, CCTV,
  annotations, trails, and terrain-aware rendering.
- Added aircraft class silhouettes, path-derived display heading, ADSBDB
  enrichment, cached CelesTrak TLE lookup, and next-ISS-pass prediction.

### Fixed

- Fixed elevated-airport aircraft placement, vessel sea-surface placement,
  close-zoom FIRMS anchors, antimeridian region framing, annotation resolution,
  cross-layer tracking ownership, and CCTV projection lifecycle issues.

## [Unreleased] — June 2026

### Added

- Added OpenAI Realtime voice control, scene-aware entity context, viewport image
  grounding, the AI HUD summary, live AIS vessels, infrastructure layers, map
  source switching, free-text navigation, and server-side data proxies.
- Added hybrid map annotations, 3D aircraft, panoptic detection, tracking
  harnesses, and public data attribution.
- Added MIT source licensing, security guidance, contribution guidance, data
  source notices, and third-party asset boundaries.

### Changed

- Removed the experimental AI video-edit style and retained seven deterministic
  visual styles.
- Moved Realtime text-history trimming to the server-side retention policy while
  keeping only the latest viewport image in conversation context.

## [0.7.0] — 2026-02-18

- Added the Bikeshare Pulse layer and panoptic label improvements.
- Improved tracked-item boxes, post-render alignment, and CCTV projection
  quality.
- Removed the experimental shift-drag CCTV calibration interaction.

## [0.6.0] — 2026-02-10

- Added the initial multi-layer 3D globe experience, visual styles, live
  aircraft, satellites, earthquakes, CCTV, traffic, FIRMS, infrastructure, and
  performance controls.
- Added entity inspection, tracking, scenes, keyboard controls, and shareable
  views.

## [0.1.0] — 2026-02-09

- Initial project version.
