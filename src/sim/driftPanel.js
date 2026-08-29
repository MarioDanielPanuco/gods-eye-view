/**
 * Drift-simulation scrub panel: a small self-contained fixed DOM element
 * (banner, diagnostics, parameter row, time scrub, play/pause, close).
 * Self-styled on purpose — no ui.js edits, no stylesheet coupling; disposing
 * removes every trace. Returns a no-op stub when no DOM is available
 * (workers, tests).
 */

/** Parameter choices offered by the compact params row. */
const HORIZON_CHOICES = [6, 12, 24, 48];
const PARTICLE_CHOICES = [2000, 10000, 25000];
const SIGMA_CHOICES = [0, 0.05, 0.1];

/**
 * @param {Object} options
 * @param {number} options.particleCount Ensemble size.
 * @param {string} options.classLabel Leeway class shown in the header.
 * @param {number} options.frameCount Number of scrubbable frames.
 * @param {number} options.horizonH Simulation horizon, hours.
 * @param {boolean} [options.degraded] Forcing gaps were zero-filled.
 * @param {Object} [options.params] Current run params seeding the controls:
 *   {horizonH, n, sigmaTurbMs, backward}. `backward` also flips the clock
 *   label to `T−hh:mm`.
 * @param {(params: {horizonH: number, n: number, sigmaTurbMs: number,
 *   backward: boolean}) => void} [options.onRerun] Called with the controls'
 *   current values when RERUN is pressed (selects never auto-rerun).
 * @param {(index: number) => void} options.onScrub
 * @param {() => void} options.onPlayPause
 * @param {() => void} options.onClose
 * @returns {{setFrame: (index: number, offsetMs?: number, beachedCount?: number) => void,
 *   setPlaying: Function, setSummary: (text: ?string) => void, destroy: Function}}
 */
export function createDriftPanel({
  particleCount,
  classLabel,
  frameCount,
  horizonH,
  degraded = false,
  params = null,
  onRerun,
  onScrub,
  onPlayPause,
  onClose,
} = {}) {
  if (typeof document === 'undefined') {
    return { setFrame() {}, setPlaying() {}, setSummary() {}, destroy() {} };
  }

  const backward = Boolean(params?.backward);
  const clockSign = backward ? '−' : '+';

  const root = document.createElement('div');
  root.id = 'gev-drift-panel';
  root.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:18px', 'transform:translateX(-50%)',
    'z-index:44', 'min-width:340px', 'max-width:480px',
    'background:rgba(8,14,18,0.92)', 'border:1px solid rgba(255,177,77,0.55)',
    'border-radius:6px', 'padding:10px 12px',
    'font:11px/1.5 "SF Mono", ui-monospace, monospace', 'color:#e8f4ff',
    'backdrop-filter:blur(6px)',
  ].join(';');

  const banner = document.createElement('div');
  banner.textContent = 'SIMULATED DRIFT ENSEMBLE — NOT A SAR PRODUCT';
  banner.style.cssText = 'color:#ffb14d;font-weight:700;letter-spacing:0.08em;margin-bottom:2px;';
  root.appendChild(banner);

  const meta = document.createElement('div');
  meta.textContent = `${classLabel} · ${Number(particleCount).toLocaleString()} particles · ${horizonH} h ${backward ? 'reverse' : 'forecast'} drift`
    + (degraded ? ' · ⚠ forcing gaps' : '');
  meta.style.cssText = 'color:#9fb8c8;margin-bottom:2px;';
  const beached = document.createElement('span');
  beached.hidden = true; // shown only while the current frame has beached particles
  beached.style.cssText = 'color:#ffb14d;margin-left:8px;';
  meta.appendChild(beached);
  root.appendChild(meta);

  // Diagnostics line (mean drift + spread) — hidden until setSummary(text).
  const summary = document.createElement('div');
  summary.hidden = true;
  summary.style.cssText = 'color:#4dd2ff;margin-bottom:2px;';
  root.appendChild(summary);

  // --- Compact parameter row: three selects, direction toggle, RERUN. ---
  const paramsRow = document.createElement('div');
  paramsRow.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0 8px;';

  const selectCss = 'background:rgba(8,14,18,0.92);border:1px solid rgba(159,184,200,0.5);color:#e8f4ff;border-radius:4px;font:inherit;padding:1px 2px;cursor:pointer;';

  /** Labeled <select> appended to the params row; returns the select. */
  function makeSelect(labelText, ariaLabel, choices, current, format) {
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;align-items:center;gap:4px;color:#9fb8c8;';
    wrap.append(labelText);
    const select = document.createElement('select');
    select.setAttribute('aria-label', ariaLabel);
    select.style.cssText = selectCss;
    for (const value of choices) {
      const option = document.createElement('option');
      option.value = String(value);
      option.textContent = format(value);
      if (value === current) option.selected = true;
      select.appendChild(option);
    }
    wrap.appendChild(select);
    paramsRow.appendChild(wrap);
    return select;
  }

  const horizonSelect = makeSelect('⏱', 'Drift horizon, hours',
    HORIZON_CHOICES, params?.horizonH, (v) => `${v} h`);
  const particlesSelect = makeSelect('n', 'Ensemble particle count',
    PARTICLE_CHOICES, params?.n, (v) => v.toLocaleString());
  const sigmaSelect = makeSelect('σ', 'Turbulence sigma, m/s',
    SIGMA_CHOICES, params?.sigmaTurbMs, (v) => `${v} m/s`);

  // Direction toggle — a stateful button, applied only on RERUN.
  let backwardChoice = backward;
  const dirButton = document.createElement('button');
  dirButton.type = 'button';
  dirButton.setAttribute('aria-label', 'Toggle forecast or hindcast drift direction');
  dirButton.style.cssText = 'background:none;border:1px solid rgba(159,184,200,0.5);color:#e8f4ff;border-radius:4px;font:inherit;padding:1px 6px;cursor:pointer;';
  const paintDirection = () => {
    dirButton.textContent = backwardChoice ? '◀ HINDCAST' : 'FORECAST ▶';
  };
  paintDirection();
  dirButton.addEventListener('click', () => {
    backwardChoice = !backwardChoice;
    paintDirection();
  });
  paramsRow.appendChild(dirButton);

  // Explicit rerun — changing a select never auto-reruns.
  const rerunButton = document.createElement('button');
  rerunButton.type = 'button';
  rerunButton.textContent = 'RERUN';
  rerunButton.setAttribute('aria-label', 'Re-run the drift simulation with these parameters');
  rerunButton.style.cssText = 'background:none;border:1px solid #ffb14d;color:#ffb14d;border-radius:4px;font:inherit;font-weight:700;padding:1px 8px;cursor:pointer;margin-left:auto;';
  rerunButton.addEventListener('click', () => onRerun?.({
    horizonH: Number(horizonSelect.value),
    n: Number(particlesSelect.value),
    sigmaTurbMs: Number(sigmaSelect.value),
    backward: backwardChoice,
  }));
  paramsRow.appendChild(rerunButton);
  root.appendChild(paramsRow);

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;gap:8px;';

  const playButton = document.createElement('button');
  playButton.type = 'button';
  playButton.textContent = '▶';
  playButton.setAttribute('aria-label', 'Play or pause drift playback');
  playButton.style.cssText = 'background:none;border:1px solid #4dd2ff;color:#4dd2ff;border-radius:4px;width:26px;height:22px;cursor:pointer;font:inherit;';
  playButton.addEventListener('click', () => onPlayPause?.());
  row.appendChild(playButton);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = String(Math.max(0, frameCount - 1));
  slider.step = '1';
  slider.value = '0';
  slider.setAttribute('aria-label', 'Drift time scrub');
  slider.style.cssText = 'flex:1;accent-color:#ffb14d;';
  slider.addEventListener('input', () => onScrub?.(Number(slider.value)));
  row.appendChild(slider);

  const clock = document.createElement('span');
  clock.textContent = `T${clockSign}00:00`;
  clock.style.cssText = 'color:#ffb14d;min-width:62px;text-align:right;';
  row.appendChild(clock);

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '✕';
  closeButton.setAttribute('aria-label', 'Close drift simulation');
  closeButton.style.cssText = 'background:none;border:none;color:#9fb8c8;cursor:pointer;font:inherit;padding:0 2px;';
  closeButton.addEventListener('click', () => onClose?.());
  row.appendChild(closeButton);

  root.appendChild(row);
  document.body.appendChild(root);

  return {
    setFrame(index, offsetMs, beachedCount = 0) {
      slider.value = String(index);
      // Backward runs hand in negative offsets; the sign is carried by the
      // clock prefix (T−), so only the magnitude is formatted.
      const totalMinutes = Math.round(Math.abs(offsetMs ?? 0) / 60000);
      const hh = String(Math.floor(totalMinutes / 60)).padStart(2, '0');
      const mm = String(totalMinutes % 60).padStart(2, '0');
      clock.textContent = `T${clockSign}${hh}:${mm}`;
      beached.hidden = !(beachedCount > 0);
      beached.textContent = beachedCount > 0
        ? `⚓ ${Number(beachedCount).toLocaleString()} beached`
        : '';
    },
    setPlaying(playing) {
      playButton.textContent = playing ? '⏸' : '▶';
    },
    setSummary(text) {
      const show = typeof text === 'string' && text.length > 0;
      summary.hidden = !show;
      summary.textContent = show ? text : '';
    },
    destroy() {
      root.remove();
    },
  };
}
