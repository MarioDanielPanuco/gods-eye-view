/**
 * @file Runtime loader for the bundled 2-bit land/sea mask asset.
 *
 * ONE shared memoized instance serves both ocean click gating and the drift
 * beaching fallback — the decoded mask is never copied or transferred, so the
 * ~1 MB payload exists once per session. Node (unit tests, build script
 * verification) reads the committed file directly; the browser fetches the
 * Vite-emitted asset URL with `force-cache` since the file is content-hashed.
 *
 * @module data/landSeaMask
 */

import { createRetryableLoader } from './retryableLoad.js';
import { decodeMaskBuffer } from './landSeaMaskCodec.js';

export {
  MASK_WATER,
  MASK_LAND,
  MASK_COASTAL,
  MASK_WIDTH,
  MASK_HEIGHT,
  maskStateAt,
} from './landSeaMaskCodec.js';

// Vite rewrites this to the emitted asset URL (assetsInclude: ['**/*.bin']);
// under node it resolves to the committed file next to this module.
const MASK_URL = new URL('./local_data/gshhg_mask/land-sea-mask.bin', import.meta.url);

const isNode = typeof process !== 'undefined' && !!process.versions?.node
  && typeof window === 'undefined';

/** @returns {Promise<ArrayBuffer>} Raw asset bytes, environment-appropriate. */
async function fetchMaskBytes() {
  if (isNode) {
    const { readFileSync } = await import(/* @vite-ignore */ 'node:fs');
    const bytes = readFileSync(MASK_URL);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const res = await fetch(MASK_URL, { cache: 'force-cache' });
  if (!res.ok) throw new Error(`land/sea mask fetch failed: HTTP ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Load and decode the bundled land/sea mask. Success is memoized for the
 * session; failures back off per data/retryableLoad, so callers may retry.
 *
 * @type {() => Promise<{width: number, height: number, data: Uint8Array}>}
 */
export const loadLandSeaMask = createRetryableLoader(
  async () => decodeMaskBuffer(await fetchMaskBytes()),
);
