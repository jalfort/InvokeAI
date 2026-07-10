import type { Rect, RgbColor } from 'features/controlLayers/store/types';

/**
 * Shared, dependency-free float foundation for the fork brushes (soft + clone).
 *
 * Everything here is pure math over typed arrays — no Konva, no DOM, no canvas. The brush
 * modules own all canvas I/O (snapshotting, `putImageData`, rasterizing to `Konva.Image`) and
 * feed decoded numbers in / read baked bytes out. That keeps this file unit-testable in jsdom
 * without a real canvas and lets the soft brush and clone brush finally share ONE edge curve and
 * ONE accumulation model.
 *
 * Design notes:
 * - Accumulation happens entirely in **Float32** to kill the banding the old 8-bit `Uint8Array`
 *   buffers produced. We quantize to 8-bit sRGB **only** on `bakeInto` — the whole point of the
 *   float precision. Re-baking a dirty rect every frame is cheap and lossless because the float
 *   accumulator (not the 8-bit output) stays authoritative, so overlapping dabs never accrue
 *   8-bit rounding error.
 * - The soft brush accumulates a single COVERAGE channel via `max` (Krita ALPHA_DARKEN) and bakes
 *   `constantColor * coverage`. It stays sRGB throughout — the soft edge is composited OVER the
 *   layer by Konva in sRGB (we don't own that flatten), so linearizing only our edge would make it
 *   inconsistent with every native tool. See the Phase B plan for that descope.
 * - The clone brush DOES blend multiple different sampled colors internally (overlapping dabs of
 *   different source pixels), and that accumulation is ours — so it composites with the CORRECT
 *   operator: premultiplied source-over in LINEAR light. This fixes the old per-channel
 *   `Math.max`-on-RGBA hack that shifted hue/brightness on overlap.
 */

// ---------------------------------------------------------------------------------------------
// sRGB <-> linear
// ---------------------------------------------------------------------------------------------

/**
 * Decode LUT: sRGB byte (0..255) -> linear light (0..1). Precomputed once at module load using
 * the standard sRGB electro-optical transfer function. Index with a `Uint8` sample.
 */
export const SRGB_TO_LINEAR: Float32Array = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

/**
 * Encode a single linear-light value (0..1) to an sRGB byte (0..255), clamped and rounded. Uses
 * the standard sRGB opto-electronic transfer function (a `pow`) — only ever called on bake, so the
 * per-pixel `pow` cost is negligible.
 */
const linearToSrgb8 = (linear: number): number => {
  let c = linear;
  if (c <= 0) {
    return 0;
  }
  if (c >= 1) {
    return 255;
  }
  c = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(c * 255);
};

// ---------------------------------------------------------------------------------------------
// Analytic hardness falloff profile
// ---------------------------------------------------------------------------------------------

/**
 * Controls how steeply the falloff exponent grows with hardness: `gamma = 2 ^ (hardness * K)`.
 * Larger K = crisper hard edge at `hardness = 1`. Tunable knob for brush feel.
 */
const HARDNESS_GAMMA_K = 10;

/**
 * Maps a 0..1 hardness to the falloff exponent gamma for `alpha(r) = 1 - (r/R)^gamma`:
 * - hardness 0 -> gamma 1  (linear cone — softest)
 * - hardness 1 -> gamma 2^K (very steep — a near-crisp disc with a ~1px AA edge)
 *
 * Higher gamma flattens the top and pushes the falloff to the rim (harder); lower gamma rounds the
 * whole profile (softer). Monotonic increasing in hardness.
 */
export const hardnessToGamma = (hardness: number): number => {
  const h = hardness < 0 ? 0 : hardness > 1 ? 1 : hardness;
  return Math.pow(2, h * HARDNESS_GAMMA_K);
};

/**
 * A precomputed, color-independent dab coverage profile. `data[j * size + i]` is the analytic
 * coverage (0..1) at texel-center `(i + 0.5, j + 0.5)` of a `size x size` bounding square, sampled
 * from `alpha(r) = clamp(1 - (r/R)^gamma, 0, 1)` with `R = diameter / 2`.
 *
 * This single curve replaces BOTH the old soft brush's hand-rolled linear `Uint8Array` ramp and
 * the old clone brush's native `createRadialGradient`, so the two brushes now share one edge.
 */
export interface DabProfile {
  readonly data: Float32Array;
  /** Side length in texels (`ceil(diameter) + 2 * DAB_PROFILE_PAD`, min 1). */
  readonly size: number;
  /** The float diameter the profile was built for (its falloff-to-zero radius is `diameter / 2`). */
  readonly diameter: number;
}

/**
 * Zero-padding (in texels) added on every side of the dab grid. Guarantees the analytic falloff
 * reaches a genuine `alpha = 0` texel just past the rim so bilinear sampling ramps smoothly to zero
 * instead of stepping off the outermost nonzero texel (which, at mid hardness, is still ~0.8).
 */
const DAB_PROFILE_PAD = 1;

/**
 * Builds a {@link DabProfile} for the given float diameter and 0..1 hardness. The grid is 1 texel =
 * 1 build-pixel, centered, with the falloff radius `R = diameter / 2` and a padding ring of zeros;
 * sampled at sub-pixel texel centers so the analytic edge is smooth. Pure.
 */
export const buildDabProfile = (diameter: number, hardness: number): DabProfile => {
  const size = Math.max(1, Math.ceil(diameter) + 2 * DAB_PROFILE_PAD);
  const data = new Float32Array(size * size);
  const gamma = hardnessToGamma(hardness);
  const center = size / 2;
  const radius = diameter / 2;
  const invRadius = radius > 0 ? 1 / radius : 0;

  for (let j = 0; j < size; j++) {
    const dy = j + 0.5 - center;
    for (let i = 0; i < size; i++) {
      const dx = i + 0.5 - center;
      const rNorm = Math.hypot(dx, dy) * invRadius;
      let a = rNorm >= 1 ? 0 : 1 - Math.pow(rNorm, gamma);
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      data[j * size + i] = a;
    }
  }

  return { data, size, diameter };
};

/**
 * Bilinear-samples a profile at continuous texel-center coordinates `(fx, fy)` (0-based, where
 * integer `k` is the center of texel `k`). Coordinates are clamped to the grid; the profile edge is
 * ~0 by construction, so out-of-footprint reads contribute nothing.
 */
const sampleProfileBilinear = (data: Float32Array, size: number, fx: number, fy: number): number => {
  let cx = fx < 0 ? 0 : fx > size - 1 ? size - 1 : fx;
  let cy = fy < 0 ? 0 : fy > size - 1 ? size - 1 : fy;
  const ix = cx | 0;
  const iy = cy | 0;
  const ix1 = ix + 1 < size ? ix + 1 : ix;
  const iy1 = iy + 1 < size ? iy + 1 : iy;
  const tx = cx - ix;
  const ty = cy - iy;
  const row0 = iy * size;
  const row1 = iy1 * size;
  const a = data[row0 + ix]!;
  const b = data[row0 + ix1]!;
  const c = data[row1 + ix]!;
  const d = data[row1 + ix1]!;
  const top = a + (b - a) * tx;
  const bot = c + (d - c) * tx;
  return top + (bot - top) * ty;
};

// ---------------------------------------------------------------------------------------------
// Dirty-rect tracking (shared internal helper)
// ---------------------------------------------------------------------------------------------

/** Half-open accumulated dirty region `[x1, x2) x [y1, y2)`, for efficient partial bakes/blits. */
class DirtyRect {
  private x1 = 0;
  private y1 = 0;
  private x2 = 0;
  private y2 = 0;
  private has = false;

  expand(x0: number, y0: number, x1: number, y1: number): void {
    if (this.has) {
      if (x0 < this.x1) {
        this.x1 = x0;
      }
      if (y0 < this.y1) {
        this.y1 = y0;
      }
      if (x1 > this.x2) {
        this.x2 = x1;
      }
      if (y1 > this.y2) {
        this.y2 = y1;
      }
    } else {
      this.x1 = x0;
      this.y1 = y0;
      this.x2 = x1;
      this.y2 = y1;
      this.has = true;
    }
  }

  get(): Rect | null {
    if (!this.has) {
      return null;
    }
    return { x: this.x1, y: this.y1, width: this.x2 - this.x1, height: this.y2 - this.y1 };
  }

  clear(): void {
    this.has = false;
  }
}

/**
 * Resolves an optional bake sub-rect against the accumulator bounds, returning clamped half-open
 * bounds `[x0, x1) x [y0, y1)`. Omitting `rect` bakes the whole buffer.
 */
const clampRect = (
  rect: Rect | undefined,
  width: number,
  height: number
): { x0: number; y0: number; x1: number; y1: number } => {
  if (!rect) {
    return { x0: 0, y0: 0, x1: width, y1: height };
  }
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(height, Math.ceil(rect.y + rect.height));
  return { x0, y0, x1, y1 };
};

/**
 * Iterates the integer texel footprint of a dab centered at float `(cx, cy)`, invoking
 * `fn(px, py, coverage)` per covered texel. The profile grid is 1 texel = 1 build-pixel; a render
 * `diameter` different from the profile's build diameter (pressure) rescales sampling by
 * `buildDiameter / diameter` about the dab center, so the same profile serves every pressure.
 */
const forEachDabTexel = (
  profile: DabProfile,
  cx: number,
  cy: number,
  diameter: number,
  width: number,
  height: number,
  fn: (px: number, py: number, coverage: number) => void
): void => {
  const radius = diameter / 2;
  // Map render-space offset from the dab center -> profile build-pixel offset, then to a
  // continuous texel-center index (`center - 0.5` is the index whose center sits at offset 0).
  const invScale = diameter > 0 ? profile.diameter / diameter : 0;
  const center = profile.size / 2;
  const base = center - 0.5;
  // Extend the footprint by the render-space width of the zero-padding ring so the falloff's final
  // ramp-to-zero texels are actually sampled (smoothest edge) and the bilinear clamp reads a true 0.
  const margin = invScale > 0 ? DAB_PROFILE_PAD / invScale : 0;

  const px0 = Math.max(0, Math.floor(cx - radius - margin));
  const py0 = Math.max(0, Math.floor(cy - radius - margin));
  const px1 = Math.min(width, Math.ceil(cx + radius + margin));
  const py1 = Math.min(height, Math.ceil(cy + radius + margin));

  for (let py = py0; py < py1; py++) {
    const fy = (py + 0.5 - cy) * invScale + base;
    for (let px = px0; px < px1; px++) {
      const fx = (px + 0.5 - cx) * invScale + base;
      const cov = sampleProfileBilinear(profile.data, profile.size, fx, fy);
      if (cov > 0) {
        fn(px, py, cov);
      }
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Soft-brush accumulator: single max-accumulated coverage channel
// ---------------------------------------------------------------------------------------------

/**
 * Per-stroke coverage accumulator for the SOFT brush. Holds one Float32 coverage channel that is
 * `max`-accumulated (ALPHA_DARKEN): overlapping dabs within a stroke never darken past the strongest
 * dab. Bakes to straight 8-bit sRGB RGBA as `constantColor * coverage`.
 */
export class CoverageAccumulator {
  readonly width: number;
  readonly height: number;
  /** Coverage per texel, 0..1. Length `width * height`. */
  readonly coverage: Float32Array;
  private readonly dirty = new DirtyRect();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.coverage = new Float32Array(width * height);
  }

  /**
   * Max-accumulates one dab centered at float `(cx, cy)` (accumulator coords). `diameter` defaults
   * to the profile's build diameter; pass a different value (e.g. `strokeWidth * pressure`) to
   * scale the same profile without rebuilding it.
   */
  stampDab(profile: DabProfile, cx: number, cy: number, diameter: number = profile.diameter): void {
    const cov = this.coverage;
    const w = this.width;
    forEachDabTexel(profile, cx, cy, diameter, w, this.height, (px, py, c) => {
      const idx = py * w + px;
      if (c > cov[idx]!) {
        cov[idx] = c;
        this.dirty.expand(px, py, px + 1, py + 1);
      }
    });
  }

  getDirtyRect(): Rect | null {
    return this.dirty.get();
  }

  clearDirtyRect(): void {
    this.dirty.clear();
  }

  /** Zeroes coverage and the dirty rect (restart a stroke). */
  reset(): void {
    this.coverage.fill(0);
    this.dirty.clear();
  }

  /**
   * Bakes `color * coverage` into `out` (a `width * height * 4` straight-alpha RGBA byte buffer,
   * e.g. `ImageData.data`). RGB is the constant sRGB color; alpha is `coverage * 255`. Stays in
   * sRGB by design (see file header). Pass `rect` to bake only a sub-region (e.g. the dirty rect).
   */
  bakeInto(out: Uint8ClampedArray, color: RgbColor, rect?: Rect): void {
    const { x0, y0, x1, y1 } = clampRect(rect, this.width, this.height);
    const { r, g, b } = color;
    const w = this.width;
    const cov = this.coverage;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const idx = py * w + px;
        const o = idx * 4;
        let a = cov[idx]!;
        a = a < 0 ? 0 : a > 1 ? 1 : a;
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = Math.round(a * 255);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Clone-brush accumulator: premultiplied linear color + coverage gate
// ---------------------------------------------------------------------------------------------

/**
 * A rectangular block of once-decoded source pixels for clone stamping: **straight** (un-
 * premultiplied) **linear-light** RGBA, row-major. `data[(sy * width + sx) * 4 + {0,1,2,3}]` are
 * `R, G, B` in linear 0..1 and `A` in 0..1. `origin{X,Y}` is the accumulator-space coordinate of
 * pixel `(0, 0)`. The clone brush builds this once per dab (or per stroke) by decoding its snapshot
 * region through {@link SRGB_TO_LINEAR}.
 */
export interface LinearSourceRegion {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly originX: number;
  readonly originY: number;
}

/**
 * Per-stroke accumulator for the CLONE brush. Holds premultiplied linear color `(pmR, pmG, pmB,
 * pmA)` plus a separate `coverage` channel that gates how much NEW area each dab paints.
 *
 * Per covered texel the source pixel is CONSTANT across the whole stroke (the clone offset is fixed,
 * so a given dest texel always samples the same source pixel) — there is no inter-color blending to
 * do. So this is a true ALPHA_DARKEN max-coverage model: whenever a dab raises the running-max
 * coverage (`dab > coverage`), OVERWRITE the premultiplied color from that new max —
 *   `alpha = maxCoverage * sourceAlpha`, premultiplied RGB = sourceColor * alpha —
 * and raise `coverage = max(coverage, dab)`. Final baked alpha is exactly `maxCoverage * sourceAlpha`.
 *
 * (Over-compositing per-delta would telescope alpha to `1 - prod(1 - delta_k*srcA) < max*srcA`,
 * washing every stroke out by an amount that varies with dab spacing — the bug this replaces. It
 * still fixes the original per-channel `Math.max`-on-sRGB-RGBA hue/brightness shift.) On bake we
 * un-premultiply, encode linear->sRGB, and write straight 8-bit RGBA.
 */
export class CloneAccumulator {
  readonly width: number;
  readonly height: number;
  private readonly pmR: Float32Array;
  private readonly pmG: Float32Array;
  private readonly pmB: Float32Array;
  private readonly pmA: Float32Array;
  private readonly coverage: Float32Array;
  private readonly dirty = new DirtyRect();

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.pmR = new Float32Array(n);
    this.pmG = new Float32Array(n);
    this.pmB = new Float32Array(n);
    this.pmA = new Float32Array(n);
    this.coverage = new Float32Array(n);
  }

  /**
   * Stamps one dab centered at float `(cx, cy)`, compositing source pixels from `src`. `diameter`
   * defaults to the profile's build diameter (pass `strokeWidth * pressure` to scale). Texels whose
   * source falls outside `src` contribute no color but still advance the coverage gate.
   */
  stampDab(
    profile: DabProfile,
    cx: number,
    cy: number,
    src: LinearSourceRegion,
    diameter: number = profile.diameter
  ): void {
    const w = this.width;
    const { pmR, pmG, pmB, pmA, coverage } = this;
    const sData = src.data;
    const sw = src.width;
    const sh = src.height;
    const sox = src.originX;
    const soy = src.originY;

    forEachDabTexel(profile, cx, cy, diameter, w, this.height, (px, py, dab) => {
      const idx = py * w + px;
      const delta = dab - coverage[idx]!;
      if (delta <= 0) {
        return;
      }

      const sx = px - sox;
      const sy = py - soy;
      if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) {
        const s = (sy * sw + sx) * 4;
        const srcA = sData[s + 3]!;
        // ALPHA_DARKEN overwrite: `delta > 0` means `dab` is the new running-max coverage, and the
        // source pixel for this texel is constant across the stroke, so set premultiplied color
        // directly from the new max — final alpha = maxCoverage * srcA, RGB = source color. (Do NOT
        // over-composite the delta; that telescopes alpha below the max and washes the stroke out.)
        const inA = dab * srcA;
        pmR[idx] = sData[s]! * inA;
        pmG[idx] = sData[s + 1]! * inA;
        pmB[idx] = sData[s + 2]! * inA;
        pmA[idx] = inA;
      }

      coverage[idx] = dab;
      this.dirty.expand(px, py, px + 1, py + 1);
    });
  }

  getDirtyRect(): Rect | null {
    return this.dirty.get();
  }

  clearDirtyRect(): void {
    this.dirty.clear();
  }

  /** Zeroes all channels and the dirty rect (restart a stroke). */
  reset(): void {
    this.pmR.fill(0);
    this.pmG.fill(0);
    this.pmB.fill(0);
    this.pmA.fill(0);
    this.coverage.fill(0);
    this.dirty.clear();
  }

  /**
   * Un-premultiplies, encodes linear->sRGB, and writes straight 8-bit RGBA into `out` (a
   * `width * height * 4` byte buffer, e.g. `ImageData.data`). Fully-transparent texels write zeros.
   * Pass `rect` to bake only a sub-region (e.g. the dirty rect).
   */
  bakeInto(out: Uint8ClampedArray, rect?: Rect): void {
    const { x0, y0, x1, y1 } = clampRect(rect, this.width, this.height);
    const w = this.width;
    const { pmR, pmG, pmB, pmA } = this;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const idx = py * w + px;
        const o = idx * 4;
        const a = pmA[idx]!;
        if (a <= 0) {
          out[o] = 0;
          out[o + 1] = 0;
          out[o + 2] = 0;
          out[o + 3] = 0;
          continue;
        }
        const inv = 1 / a;
        out[o] = linearToSrgb8(pmR[idx]! * inv);
        out[o + 1] = linearToSrgb8(pmG[idx]! * inv);
        out[o + 2] = linearToSrgb8(pmB[idx]! * inv);
        out[o + 3] = Math.round((a > 1 ? 1 : a) * 255);
      }
    }
  }
}
