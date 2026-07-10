import { deepClone } from 'common/util/deepClone';
import {
  buildDabProfile,
  CloneAccumulator,
  type DabProfile,
  type LinearSourceRegion,
  SRGB_TO_LINEAR,
} from 'features/controlLayers/fork/brush/brushBuffer';
import type { CanvasEntityBufferObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityBufferObjectRenderer';
import type { CanvasEntityObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityObjectRenderer';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type { Rect } from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { Logger } from 'roarr';

/**
 * FORK: buffer-only object states for the clone brush. These are NOT persisted as their own type —
 * on commit the stroke is baked to a plain `image` object (a clone_brush_line has no meaning without
 * its source snapshot, which is never serialized). They live in the runtime {@link AnyObjectState}
 * union purely so the buffer renderer can carry a live clone stroke. Plain TS interfaces (no Zod)
 * because they never round-trip through the persisted `zCanvasObjectState` schema.
 *
 * Seam: add both to `AnyObjectState` (and `CanvasObjectCloneBrushLine` to `AnyObjectRenderer`) in
 * `konva/CanvasObject/types.ts`.
 */
export type CanvasCloneBrushLineState = {
  id: string;
  type: 'clone_brush_line';
  strokeWidth: number;
  hardness: number;
  opacity: number;
  /** Points without pressure: [x1, y1, x2, y2, ...] in entity-local coords. */
  points: number[];
  clip: Rect | null;
  /** Fixed entity-local displacement from each destination point to its source sample point. */
  sourceOffsetX: number;
  sourceOffsetY: number;
};

export type CanvasCloneBrushLineWithPressureState = {
  id: string;
  type: 'clone_brush_line_with_pressure';
  strokeWidth: number;
  hardness: number;
  opacity: number;
  /** Points with pressure: [x1, y1, pressure1, x2, y2, pressure2, ...] in entity-local coords. */
  points: number[];
  clip: Rect | null;
  sourceOffsetX: number;
  sourceOffsetY: number;
};

type CloneBrushState = CanvasCloneBrushLineState | CanvasCloneBrushLineWithPressureState;

/**
 * FORK clone-brush renderer. Samples RGBA from a source snapshot and stamps it through a shared
 * analytic falloff profile into a {@link CloneAccumulator}.
 *
 * P3 correctness fix vs the old renderer: the old code composited dabs with per-channel `Math.max`
 * on straight sRGB RGBA — not a valid operator (it shifts hue and brightens overlaps because it
 * ignores premultiplied alpha). This renderer instead:
 *   - decodes the whole snapshot to STRAIGHT LINEAR RGBA ONCE per stroke (also batches away the old
 *     per-dab `getImageData` readback);
 *   - max-accumulates a coverage mask and composites each source pixel exactly once with
 *     premultiplied source-over IN LINEAR (via {@link CloneAccumulator});
 *   - shares ONE analytic float falloff ({@link buildDabProfile}) with the soft brush instead of a
 *     native `createRadialGradient`.
 * Quantization to 8-bit sRGB happens only in the accumulator's `bakeInto`, killing banding.
 *
 * Coordinate spaces:
 *   - `points` / dab centers are ENTITY-LOCAL.
 *   - The stroke canvas + accumulator are offset by the clip origin (`_strokeOffset`), so
 *     accumulator-local = entity-local − `_strokeOffset`.
 *   - The snapshot's pixel (0,0) is entity-local `(_snapshotOffsetX, _snapshotOffsetY)` = bbox − the
 *     entity's CURRENT position at capture (see the tool module's move-bug fix, #18).
 */
export class CanvasObjectCloneBrushLine extends CanvasModuleBase {
  readonly type = 'object_clone_brush_line';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasEntityObjectRenderer | CanvasEntityBufferObjectRenderer;
  readonly manager: CanvasManager;
  readonly log: Logger;

  /** Dab spacing as a fraction of brush diameter (3% = smooth, matches the native BRUSH spacing). */
  private static readonly DAB_SPACING = 0.03;

  state: CloneBrushState;
  konva: {
    group: Konva.Group;
    shape: Konva.Shape;
  };

  /** Decoded straight-linear RGBA of the source snapshot (built once per snapshot). */
  private _snapshotLinear: Float32Array | null = null;
  private _snapshotW = 0;
  private _snapshotH = 0;
  /** Snapshot origin in entity-local coords (entity-local of snapshot pixel (0,0)). */
  private _snapshotOffsetX = 0;
  private _snapshotOffsetY = 0;
  /** Cached accumulator-space source region (origin depends on stroke + source offsets). */
  private _sourceRegion: LinearSourceRegion | null = null;

  /** Shared analytic falloff profile, cached per (strokeWidth, hardness). */
  private _profile: DabProfile | null = null;
  private _profileWidth = -1;
  private _profileHardness = -1;

  /** Float clone accumulator (premultiplied linear color + coverage gate). */
  private _acc: CloneAccumulator | null = null;

  /** Offscreen canvas the accumulator bakes into, blitted to the Konva context. */
  private _strokeCanvas: HTMLCanvasElement | null = null;
  private _strokeCtx: CanvasRenderingContext2D | null = null;
  private _strokeImageData: ImageData | null = null;
  /** Stroke canvas origin in entity-local coords (matches clip origin, minus pad). */
  private _strokeOffsetX = 0;
  private _strokeOffsetY = 0;

  /** How many point-scalars have been stamped into the accumulator. */
  private _lastRenderedPointCount = 0;
  /** Leftover distance carried into the next segment for even dab spacing. */
  private _distanceRemainder = 0;

  /** Whether the stroke has been baked to a Konva.Image (after commit). */
  private _rasterized = false;

  constructor(state: CloneBrushState, parent: CanvasEntityObjectRenderer | CanvasEntityBufferObjectRenderer) {
    super();
    const { id, clip, opacity } = state;
    this.id = id;
    this.parent = parent;
    this.manager = parent.manager;
    this.path = this.manager.buildPath(this);
    this.log = this.manager.buildLogger(this);

    this.log.debug({ state }, 'Creating clone brush line module');

    this.konva = {
      group: new Konva.Group({
        name: `${this.type}:group`,
        clip,
        listening: false,
        opacity,
      }),
      shape: new Konva.Shape({
        name: `${this.type}:shape`,
        listening: false,
        perfectDrawEnabled: false,
        globalCompositeOperation: 'source-over',
        sceneFunc: (ctx) => this._sceneFunc(ctx),
      }),
    };
    this.konva.group.add(this.konva.shape);
    this.state = state;
  }

  /**
   * Sets the source snapshot for this stroke (called externally by the tool module at stroke start),
   * decoding it once to straight-linear RGBA for the accumulator. `offsetX/Y` is the entity-local
   * coordinate of snapshot pixel (0,0) — the tool computes it from the entity's CURRENT position, so
   * the sample tracks the layer after a move (#18).
   */
  setSourceSnapshot(canvas: HTMLCanvasElement, offsetX: number, offsetY: number): void {
    const w = canvas.width;
    const h = canvas.height;
    const ctx = canvas.getContext('2d');
    if (!ctx || w === 0 || h === 0) {
      this._snapshotLinear = null;
      this._snapshotW = 0;
      this._snapshotH = 0;
      return;
    }

    // Batched, one-shot readback of the entire snapshot (replaces the old per-dab getImageData).
    const rgba = ctx.getImageData(0, 0, w, h).data;
    const linear = new Float32Array(w * h * 4);
    for (let i = 0, n = w * h; i < n; i++) {
      const s = i * 4;
      linear[s] = SRGB_TO_LINEAR[rgba[s]!]!;
      linear[s + 1] = SRGB_TO_LINEAR[rgba[s + 1]!]!;
      linear[s + 2] = SRGB_TO_LINEAR[rgba[s + 2]!]!;
      linear[s + 3] = rgba[s + 3]! / 255;
    }

    this._snapshotLinear = linear;
    this._snapshotW = w;
    this._snapshotH = h;
    this._snapshotOffsetX = offsetX;
    this._snapshotOffsetY = offsetY;
    this._sourceRegion = null;

    // A new source means the stroke must re-render from scratch.
    this._resetStrokeBuffer();
  }

  /** Ensures the shared falloff profile matches the current (strokeWidth, hardness). */
  private _ensureProfile(): void {
    const { strokeWidth, hardness } = this.state;
    if (!this._profile || this._profileWidth !== strokeWidth || this._profileHardness !== hardness) {
      this._profile = buildDabProfile(strokeWidth, hardness);
      this._profileWidth = strokeWidth;
      this._profileHardness = hardness;
    }
  }

  /** Ensures the stroke canvas, ImageData, and accumulator exist and are sized from the clip. */
  private _ensureStrokeCanvas(): void {
    if (this._strokeCanvas && this._acc && this._strokeImageData) {
      return;
    }

    const clip = this.state.clip;
    let width: number;
    let height: number;

    if (clip) {
      const pad = this.state.strokeWidth;
      width = Math.max(1, Math.ceil(clip.width + pad * 2));
      height = Math.max(1, Math.ceil(clip.height + pad * 2));
      this._strokeOffsetX = clip.x - pad;
      this._strokeOffsetY = clip.y - pad;
    } else {
      width = 4096;
      height = 4096;
      this._strokeOffsetX = 0;
      this._strokeOffsetY = 0;
    }

    this._strokeCanvas = document.createElement('canvas');
    this._strokeCanvas.width = width;
    this._strokeCanvas.height = height;
    this._strokeCtx = this._strokeCanvas.getContext('2d');
    this._acc = new CloneAccumulator(width, height);
    if (this._strokeCtx) {
      this._strokeImageData = this._strokeCtx.createImageData(width, height);
    }
    // Origin depends on the stroke offset we just computed.
    this._sourceRegion = null;
  }

  /**
   * Builds (and caches) the accumulator-space {@link LinearSourceRegion}. Its origin maps an
   * accumulator texel `(px, py)` to a snapshot pixel:
   *   `snapshotPixel = px + _strokeOffset + sourceOffset − _snapshotOffset`,
   * i.e. `origin = _snapshotOffset − _strokeOffset − sourceOffset` (rounded to keep integer
   * nearest-neighbour source sampling, matching the old renderer).
   */
  private _ensureSourceRegion(): LinearSourceRegion | null {
    if (this._sourceRegion) {
      return this._sourceRegion;
    }
    if (!this._snapshotLinear) {
      return null;
    }
    const originX = Math.round(this._snapshotOffsetX - this._strokeOffsetX - this.state.sourceOffsetX);
    const originY = Math.round(this._snapshotOffsetY - this._strokeOffsetY - this.state.sourceOffsetY);
    this._sourceRegion = {
      data: this._snapshotLinear,
      width: this._snapshotW,
      height: this._snapshotH,
      originX,
      originY,
    };
    return this._sourceRegion;
  }

  /** Max-accumulates one dab at entity-local `(cx, cy)`. `diameter` scales the shared profile. */
  private _stampDab(cx: number, cy: number, diameter?: number): void {
    const acc = this._acc;
    const profile = this._profile;
    const src = this._ensureSourceRegion();
    if (!acc || !profile || !src) {
      return;
    }
    const ax = cx - this._strokeOffsetX;
    const ay = cy - this._strokeOffsetY;
    if (diameter !== undefined) {
      acc.stampDab(profile, ax, ay, src, Math.max(0.01, diameter));
    } else {
      acc.stampDab(profile, ax, ay, src);
    }
  }

  /**
   * Stamps evenly-spaced dabs along a segment using the Krita/GIMP distance-accumulator algorithm.
   * Pressure is linearly interpolated between the endpoints.
   */
  private _stampSegment(x0: number, y0: number, x1: number, y1: number, p0?: number, p1?: number): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 0.001) {
      return;
    }

    const spacing = Math.max(1, this.state.strokeWidth * CanvasObjectCloneBrushLine.DAB_SPACING);
    const ux = dx / segLen;
    const uy = dy / segLen;
    const hasPressure = p0 !== undefined && p1 !== undefined;

    let dist = spacing - this._distanceRemainder;
    if (dist > segLen) {
      this._distanceRemainder += segLen;
      return;
    }

    while (dist <= segLen) {
      const ix = x0 + ux * dist;
      const iy = y0 + uy * dist;
      if (hasPressure) {
        const t = dist / segLen;
        const pressure = p0 + (p1 - p0) * t;
        this._stampDab(ix, iy, this.state.strokeWidth * pressure);
      } else {
        this._stampDab(ix, iy);
      }
      dist += spacing;
    }

    this._distanceRemainder = segLen - (dist - spacing);
  }

  /** Stamps a single dab (click without drag). */
  private _stampSingleDab(x: number, y: number, pressure?: number): void {
    if (pressure !== undefined) {
      this._stampDab(x, y, this.state.strokeWidth * pressure);
    } else {
      this._stampDab(x, y);
    }
  }

  /** Blits the accumulator's dirty rect into the stroke canvas, then draws it to the Konva ctx. */
  private _blitDirtyRect(): void {
    const acc = this._acc;
    const ctx = this._strokeCtx;
    const imageData = this._strokeImageData;
    if (!acc || !ctx || !imageData) {
      return;
    }
    const dirty = acc.getDirtyRect();
    if (dirty) {
      acc.bakeInto(imageData.data, dirty);
      ctx.putImageData(imageData, 0, 0, dirty.x, dirty.y, dirty.width, dirty.height);
      acc.clearDirtyRect();
    }
  }

  /**
   * Custom Konva sceneFunc: incrementally stamps new dabs into the accumulator, bakes the dirty rect
   * to the stroke canvas, and blits the stroke canvas to the layer.
   */
  private _sceneFunc(ctx: Konva.Context): void {
    // After rasterization the Konva.Image renders — sceneFunc is a no-op.
    if (this._rasterized) {
      return;
    }

    const { points } = this.state;
    const isPressure = this.state.type === 'clone_brush_line_with_pressure';
    const step = isPressure ? 3 : 2;

    if (points.length < step || !this._snapshotLinear) {
      return;
    }

    this._ensureProfile();
    this._ensureStrokeCanvas();

    if (!this._strokeCtx || !this._strokeCanvas || !this._strokeImageData || !this._acc || !this._profile) {
      return;
    }

    // Phase A — stamp new dabs.
    if (points.length > this._lastRenderedPointCount) {
      if (this._lastRenderedPointCount === 0) {
        if (isPressure) {
          this._stampSingleDab(points[0]!, points[1]!, points[2]);
        } else {
          this._stampSingleDab(points[0]!, points[1]!);
        }
        this._lastRenderedPointCount = step;
        this._distanceRemainder = 0;
      }

      const startIdx = Math.max(step, this._lastRenderedPointCount) - step;
      for (let i = startIdx; i < points.length - step; i += step) {
        const x0 = points[i]!;
        const y0 = points[i + 1]!;
        const x1 = points[i + step]!;
        const y1 = points[i + step + 1]!;
        if (i + step >= this._lastRenderedPointCount) {
          if (isPressure) {
            this._stampSegment(x0, y0, x1, y1, points[i + 2], points[i + step + 2]);
          } else {
            this._stampSegment(x0, y0, x1, y1);
          }
        }
      }

      this._lastRenderedPointCount = points.length;
    }

    // Phase B — bake dirty rect + blit.
    this._blitDirtyRect();
    ctx._context.drawImage(this._strokeCanvas, this._strokeOffsetX, this._strokeOffsetY);
  }

  /**
   * Bakes the finalized stroke into a Konva.Image, replacing the sceneFunc Shape so the stroke
   * survives Konva's `clone()` (which does not preserve custom sceneFuncs). Called on commit.
   */
  rasterizeToImage(): void {
    if (this._rasterized) {
      return;
    }

    this._ensureProfile();
    this._ensureStrokeCanvas();

    if (!this._strokeCanvas || !this._strokeCtx || !this._acc || !this._strokeImageData) {
      return;
    }

    // Full bake (no rect) — the float accumulator is authoritative, so this is lossless.
    this._acc.bakeInto(this._strokeImageData.data);
    this._strokeCtx.putImageData(this._strokeImageData, 0, 0);
    this._acc.clearDirtyRect();

    const image = new Konva.Image({
      image: this._strokeCanvas,
      x: this._strokeOffsetX,
      y: this._strokeOffsetY,
      listening: false,
      perfectDrawEnabled: false,
    });

    this.konva.shape.remove();
    this.konva.group.add(image);

    // Drop the heavy float buffers; the Konva.Image keeps the stroke canvas alive.
    this._acc = null;
    this._snapshotLinear = null;
    this._sourceRegion = null;
    this._strokeCtx = null;
    this._strokeImageData = null;
    this._rasterized = true;

    this.log.trace('Rasterized clone brush stroke to Konva.Image');
  }

  /**
   * Returns the baked stroke canvas and its entity-local origin so the commit seam can persist the
   * stroke as a plain `image` object (bake-on-commit). Call after {@link rasterizeToImage}.
   */
  getBakedCanvas(): { canvas: HTMLCanvasElement; x: number; y: number } | null {
    if (!this._strokeCanvas) {
      return null;
    }
    return { canvas: this._strokeCanvas, x: this._strokeOffsetX, y: this._strokeOffsetY };
  }

  update(state: CloneBrushState, force = false): boolean {
    if (force || this.state !== state) {
      this.log.trace({ state }, 'Updating clone brush line');

      if (this.state.opacity !== state.opacity) {
        this.konva.group.opacity(state.opacity);
      }

      // After rasterization the stroke is baked — only opacity updates matter.
      if (this._rasterized) {
        this.state = state;
        return true;
      }

      // New stroke id — reset the incremental buffer.
      if (this.state.id !== state.id) {
        this._resetStrokeBuffer();
      }

      const sizeOrHardnessChanged =
        state.strokeWidth !== this._profileWidth || state.hardness !== this._profileHardness;
      const offsetChanged =
        state.sourceOffsetX !== this.state.sourceOffsetX || state.sourceOffsetY !== this.state.sourceOffsetY;

      this.state = state;

      if (sizeOrHardnessChanged) {
        this._profile = null;
        // Diameter change alters clip padding + accumulator size — re-render the whole stroke.
        this._resetStrokeBuffer();
      }
      if (offsetChanged) {
        this._sourceRegion = null;
        this._resetStrokeBuffer();
      }

      this.konva.shape.getLayer()?.batchDraw();
      return true;
    }

    return false;
  }

  /** Resets the incremental stroke buffer, forcing a full re-render on the next sceneFunc. */
  private _resetStrokeBuffer(): void {
    this._strokeCanvas = null;
    this._strokeCtx = null;
    this._strokeImageData = null;
    this._acc = null;
    this._sourceRegion = null;
    this._lastRenderedPointCount = 0;
    this._distanceRemainder = 0;
  }

  setVisibility(isVisible: boolean): void {
    this.log.trace({ isVisible }, 'Setting clone brush line visibility');
    this.konva.group.visible(isVisible);
  }

  destroy = () => {
    this.log.debug('Destroying clone brush line module');
    this._acc = null;
    this._snapshotLinear = null;
    this._sourceRegion = null;
    this._strokeCanvas = null;
    this._strokeCtx = null;
    this._strokeImageData = null;
    this.konva.group.destroy();
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      parent: this.parent.id,
      state: deepClone(this.state),
    };
  };
}
