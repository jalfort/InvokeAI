import { deepClone } from 'common/util/deepClone';
import { buildDabProfile, CoverageAccumulator, type DabProfile } from 'features/controlLayers/fork/brush/brushBuffer';
import type { CanvasEntityBufferObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityBufferObjectRenderer';
import type { CanvasEntityObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityObjectRenderer';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type {
  CanvasSoftBrushLineState,
  CanvasSoftBrushLineWithPressureState,
  CanvasSoftEraserLineState,
  CanvasSoftEraserLineWithPressureState,
  Rect,
  RgbColor,
} from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { Logger } from 'roarr';

type SoftBrushState =
  | CanvasSoftBrushLineState
  | CanvasSoftBrushLineWithPressureState
  | CanvasSoftEraserLineState
  | CanvasSoftEraserLineWithPressureState;

const ERASER_COLOR: RgbColor = { r: 255, g: 255, b: 255 };

/**
 * Renders soft brush AND soft eraser lines with an analytic hardness falloff, accumulated in a
 * per-stroke Float32 coverage buffer (Krita-style max-alpha / ALPHA_DARKEN). Handles brush
 * (source-over) and eraser (destination-out) modes, plus regular and pressure-sensitive variants.
 *
 * Architecture (max-coverage / ALPHA_DARKEN):
 * - ONE analytic dab profile shared with the clone brush ({@link buildDabProfile}) — a float
 *   coverage curve `clamp(1 - (r/R)^gamma)` sampled bilinearly at sub-pixel dab centers. This
 *   replaces the old hand-rolled 8-bit `Uint8Array` linear ramp with nearest-neighbour sampling,
 *   which is where the visible banding came from.
 * - A per-stroke {@link CoverageAccumulator} holds a single Float32 coverage channel, max-accumulated
 *   so overlapping dabs within one stroke never darken past the strongest dab. Quantization to 8-bit
 *   happens ONLY on bake, so re-baking a dirty rect every frame is lossless (no cumulative rounding).
 * - Dab centers stay in FLOAT accumulator-local coords — sub-pixel positioning and pressure scaling
 *   are both handled by the accumulator's bilinear profile sampling, no pre-rounding.
 * - Dirty-rect tracking drives an incremental `putImageData` into the stroke canvas, then a single
 *   `drawImage` blits the whole stroke canvas to the Konva scene per frame.
 * - Stroke-level opacity is applied via the Konva group (caps visible alpha) — deliberately NOT in
 *   the coverage bake, so opacity can change without re-accumulating.
 *
 * Compositing stays in sRGB by design: the soft edge is composited OVER the layer by Konva/canvas in
 * sRGB (we do not own that flatten), so linearizing only our edge would make it inconsistent with
 * every native tool. See `fork/brush/brushBuffer.ts` header and the Phase B plan for that descope.
 *
 * For eraser mode the rasterized `Konva.Image` (and the live shape) use
 * `globalCompositeOperation: 'destination-out'`, so semi-transparent coverage produces proportional
 * erasure (`alpha_out = alpha_dest * (1 - alpha_source)`) — soft-edged erasing.
 */
export class CanvasObjectSoftBrushLine extends CanvasModuleBase {
  readonly type = 'object_soft_brush_line';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasEntityObjectRenderer | CanvasEntityBufferObjectRenderer;
  readonly manager: CanvasManager;
  readonly log: Logger;

  /**
   * Dab spacing as a fraction of brush diameter. 6% keeps the stamped disc train dense enough that
   * overlapping analytic profiles read as one smooth edge, while stamping ~half as many dabs as the
   * old 3% value (which was denser than the analytic falloff needs).
   */
  private static readonly DAB_SPACING = 0.06;

  state: SoftBrushState;
  konva: {
    group: Konva.Group;
    shape: Konva.Shape;
  };

  /** Precomputed analytic coverage profile for the current (strokeWidth, hardness). */
  private _dabProfile: DabProfile | null = null;
  /** The diameter the cached profile was built for. */
  private _dabSize = -1;
  /** The hardness the cached profile was built for. */
  private _dabHardness = -1;

  /** Offscreen canvas accumulating the final stroke image (baked coverage). */
  private _strokeCanvas: HTMLCanvasElement | null = null;
  private _strokeCtx: CanvasRenderingContext2D | null = null;
  /** Per-stroke float coverage accumulator (authoritative; quantized only on bake). */
  private _accumulator: CoverageAccumulator | null = null;
  /** Persistent RGBA ImageData reused for dirty-rect blits into the stroke canvas. */
  private _imageData: ImageData | null = null;

  /** How many point components have been stamped into the accumulator. */
  private _lastRenderedPointCount = 0;
  /** Leftover distance from the previous segment for even dab spacing. */
  private _distanceRemainder = 0;
  /** Offset of the stroke canvas / accumulator origin, in entity-local coords (matches clip origin). */
  private _strokeOffsetX = 0;
  private _strokeOffsetY = 0;
  private _accWidth = 0;
  private _accHeight = 0;

  /** Whether the stroke has been rasterized to a Konva.Image (after commit). */
  private _rasterized = false;

  /** Whether this instance is rendering in eraser mode (destination-out compositing). */
  private get _isEraseMode(): boolean {
    return this.state.type === 'soft_eraser_line' || this.state.type === 'soft_eraser_line_with_pressure';
  }

  /** The constant sRGB color the coverage bakes to (white for eraser — only its alpha matters). */
  private get _bakeColor(): RgbColor {
    if (this._isEraseMode) {
      return ERASER_COLOR;
    }
    const { color } = this.state as CanvasSoftBrushLineState | CanvasSoftBrushLineWithPressureState;
    return { r: color.r, g: color.g, b: color.b };
  }

  constructor(state: SoftBrushState, parent: CanvasEntityObjectRenderer | CanvasEntityBufferObjectRenderer) {
    super();
    // Assign state FIRST: the Konva.Shape setup below reads `this._isEraseMode` (a getter over
    // `this.state.type`), so `this.state` must exist before we build the shape or it throws.
    this.state = state;
    const { id, clip, opacity } = state;
    this.id = id;
    this.parent = parent;
    this.manager = parent.manager;
    this.path = this.manager.buildPath(this);
    this.log = this.manager.buildLogger(this);

    this.log.debug({ state }, 'Creating soft brush line module');

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
        globalCompositeOperation: this._isEraseMode ? 'destination-out' : 'source-over',
        sceneFunc: (ctx) => this._sceneFunc(ctx),
      }),
    };
    this.konva.group.add(this.konva.shape);
  }

  /**
   * Ensures the analytic dab profile is built and cached. Rebuilds only when stroke width or hardness
   * changes. The profile is color-independent (pure coverage), so color changes never rebuild it.
   */
  private _ensureDabProfile(): void {
    const { strokeWidth, hardness } = this.state;
    if (!this._dabProfile || this._dabSize !== strokeWidth || this._dabHardness !== hardness) {
      this._dabProfile = buildDabProfile(strokeWidth, hardness);
      this._dabSize = strokeWidth;
      this._dabHardness = hardness;
    }
  }

  /**
   * Ensures the stroke buffer canvas, coverage accumulator, and ImageData exist and are sized to the
   * clip (plus brush-overshoot padding), otherwise a generous fallback. The accumulator origin is
   * `(_strokeOffsetX, _strokeOffsetY)` in entity-local coords; dab centers are mapped into this local
   * space before stamping.
   */
  private _ensureStrokeCanvas(): void {
    if (this._strokeCanvas) {
      return;
    }

    const clip = this.state.clip;
    let width: number;
    let height: number;

    if (clip) {
      // Pad for brush overshoot at edges.
      const pad = this.state.strokeWidth;
      width = Math.ceil(clip.width + pad * 2);
      height = Math.ceil(clip.height + pad * 2);
      this._strokeOffsetX = clip.x - pad;
      this._strokeOffsetY = clip.y - pad;
    } else {
      width = 4096;
      height = 4096;
      this._strokeOffsetX = 0;
      this._strokeOffsetY = 0;
    }

    this._accWidth = width;
    this._accHeight = height;
    this._strokeCanvas = document.createElement('canvas');
    this._strokeCanvas.width = width;
    this._strokeCanvas.height = height;
    this._strokeCtx = this._strokeCanvas.getContext('2d');
    this._accumulator = new CoverageAccumulator(width, height);
    if (this._strokeCtx) {
      this._imageData = this._strokeCtx.createImageData(width, height);
    }
  }

  /**
   * Stamps interpolated dabs along a segment from (x0,y0) to (x1,y1) into the coverage accumulator,
   * using the Krita/GIMP distance-accumulator algorithm for gap-free, evenly-spaced dabs. Centers
   * stay in FLOAT accumulator-local coords; pressure is linearly interpolated and passed as the dab
   * diameter (the shared profile is scaled by the accumulator's bilinear sampling — no rebuild).
   */
  private _stampSegment(x0: number, y0: number, x1: number, y1: number, p0?: number, p1?: number): void {
    const acc = this._accumulator;
    const profile = this._dabProfile;
    if (!acc || !profile) {
      return;
    }

    const dx = x1 - x0;
    const dy = y1 - y0;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 0.001) {
      return;
    }

    const spacing = Math.max(1, this.state.strokeWidth * CanvasObjectSoftBrushLine.DAB_SPACING);
    const ux = dx / segLen;
    const uy = dy / segLen;
    const hasPressure = p0 !== undefined && p1 !== undefined;
    const ox = this._strokeOffsetX;
    const oy = this._strokeOffsetY;

    // Start at the leftover distance carried from the previous segment.
    let dist = spacing - this._distanceRemainder;

    if (dist > segLen) {
      // Not enough distance for a dab — accumulate and return.
      this._distanceRemainder += segLen;
      return;
    }

    while (dist <= segLen) {
      const ix = x0 + ux * dist;
      const iy = y0 + uy * dist;
      if (hasPressure) {
        const t = dist / segLen;
        const pressure = p0 + (p1 - p0) * t;
        acc.stampDab(profile, ix - ox, iy - oy, this.state.strokeWidth * pressure);
      } else {
        acc.stampDab(profile, ix - ox, iy - oy);
      }
      dist += spacing;
    }

    // Carry leftover into the next segment.
    this._distanceRemainder = segLen - (dist - spacing);
  }

  /**
   * Stamps a single dab (for single-point strokes / a click without drag).
   */
  private _stampSingleDab(x: number, y: number, pressure?: number): void {
    const acc = this._accumulator;
    const profile = this._dabProfile;
    if (!acc || !profile) {
      return;
    }
    const ox = this._strokeOffsetX;
    const oy = this._strokeOffsetY;
    if (pressure !== undefined) {
      acc.stampDab(profile, x - ox, y - oy, this.state.strokeWidth * pressure);
    } else {
      acc.stampDab(profile, x - ox, y - oy);
    }
  }

  /** Blits the accumulator's dirty rect into the stroke canvas via bake + putImageData. */
  private _flushDirtyRect(): void {
    const acc = this._accumulator;
    const ctx = this._strokeCtx;
    const imageData = this._imageData;
    if (!acc || !ctx || !imageData) {
      return;
    }
    const dirty = acc.getDirtyRect();
    if (!dirty) {
      return;
    }
    acc.bakeInto(imageData.data, this._bakeColor, dirty);
    ctx.putImageData(imageData, 0, 0, dirty.x, dirty.y, dirty.width, dirty.height);
    acc.clearDirtyRect();
  }

  /**
   * Custom Konva sceneFunc. Incrementally stamps new dabs into the coverage accumulator, bakes the
   * dirty rect into the stroke canvas, then blits the stroke canvas to the Konva context.
   */
  /**
   * Stamps any buffered points not yet stamped into the float accumulator. Idempotent and
   * independent of Konva's ASYNC `_sceneFunc`: {@link rasterizeToImage} calls it so a stroke that
   * completes within a single animation frame (fast tap / quick flick, before any rAF fires) still
   * bakes its dabs instead of committing a blank Image.
   */
  private _stampPendingPoints(): void {
    const { points } = this.state;
    const isPressure =
      this.state.type === 'soft_brush_line_with_pressure' || this.state.type === 'soft_eraser_line_with_pressure';
    const step = isPressure ? 3 : 2;

    if (points.length < step) {
      return;
    }

    this._ensureDabProfile();
    this._ensureStrokeCanvas();

    if (!this._strokeCtx || !this._strokeCanvas || !this._dabProfile || !this._accumulator) {
      return;
    }

    if (points.length > this._lastRenderedPointCount) {
      if (this._lastRenderedPointCount === 0) {
        // First render — stamp a dab at the first point.
        if (isPressure) {
          this._stampSingleDab(points[0]!, points[1]!, points[2]);
        } else {
          this._stampSingleDab(points[0]!, points[1]!);
        }
        this._lastRenderedPointCount = step;
        this._distanceRemainder = 0;
      }

      // Stamp segments from the last rendered point through all new points.
      const startIdx = Math.max(step, this._lastRenderedPointCount) - step;
      for (let i = startIdx; i < points.length - step; i += step) {
        const x0 = points[i]!;
        const y0 = points[i + 1]!;
        const x1 = points[i + step]!;
        const y1 = points[i + step + 1]!;

        // Only process segments that include new points.
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
  }

  private _sceneFunc(ctx: Konva.Context): void {
    // After rasterization the Konva.Image handles rendering — sceneFunc is a no-op.
    if (this._rasterized) {
      return;
    }

    // Phase A: stamp new dabs incrementally into the accumulator.
    this._stampPendingPoints();

    if (!this._strokeCtx || !this._strokeCanvas) {
      return;
    }

    // Phase B: bake the dirty rect into the stroke canvas, then blit to Konva.
    this._flushDirtyRect();

    const nativeCtx = ctx._context;
    nativeCtx.drawImage(this._strokeCanvas, this._strokeOffsetX, this._strokeOffsetY);
  }

  /**
   * Bakes the finalized stroke into a Konva.Image, replacing the custom Shape. MANDATORY on commit:
   * Konva's `clone()` does not preserve a Shape's `sceneFunc`, so a committed soft-brush stroke must
   * become a real Konva.Image or it vanishes when the layer is cloned (transform, filter, etc.).
   */
  rasterizeToImage(): void {
    if (this._rasterized) {
      return;
    }

    // Stamp any points the async _sceneFunc hasn't rendered yet, so a stroke committed within a
    // single frame (before any rAF) bakes its dabs instead of a fully-transparent Image.
    this._stampPendingPoints();

    this._ensureDabProfile();
    this._ensureStrokeCanvas();

    if (!this._strokeCanvas || !this._strokeCtx || !this._accumulator || !this._imageData) {
      return;
    }

    // Full bake of the authoritative float coverage into the stroke canvas (lossless quantization).
    const fullRect: Rect = { x: 0, y: 0, width: this._accWidth, height: this._accHeight };
    this._accumulator.bakeInto(this._imageData.data, this._bakeColor, fullRect);
    this._strokeCtx.putImageData(this._imageData, 0, 0);
    this._accumulator.clearDirtyRect();

    const image = new Konva.Image({
      image: this._strokeCanvas,
      x: this._strokeOffsetX,
      y: this._strokeOffsetY,
      listening: false,
      perfectDrawEnabled: false,
      globalCompositeOperation: this._isEraseMode ? 'destination-out' : undefined,
    });

    this.konva.shape.remove();
    this.konva.group.add(image);

    // Release the accumulator/ImageData; the stroke canvas stays alive (referenced by Konva.Image).
    this._dabProfile = null;
    this._accumulator = null;
    this._imageData = null;
    this._strokeCtx = null;
    this._rasterized = true;

    this.log.trace('Rasterized soft brush stroke to Konva.Image');
  }

  /**
   * Exports the finalized (baked) stroke as an entity-local raster placement for committing as a
   * plain `image` object (data URL). This lets the commit path push an existing `image` object type
   * instead of a bespoke persistent soft-brush object — see the Phase B seam notes.
   *
   * Returns the data URL plus the entity-local top-left offset and pixel size of the stroke canvas.
   * Call after {@link rasterizeToImage} (or it will rasterize first). Returns null if there is nothing
   * to export.
   */
  exportBakedImage(): { dataURL: string; x: number; y: number; width: number; height: number } | null {
    if (!this._rasterized) {
      this.rasterizeToImage();
    }
    if (!this._strokeCanvas) {
      return null;
    }
    return {
      dataURL: this._strokeCanvas.toDataURL(),
      x: this._strokeOffsetX,
      y: this._strokeOffsetY,
      width: this._strokeCanvas.width,
      height: this._strokeCanvas.height,
    };
  }

  update(state: SoftBrushState, force = false): boolean {
    if (force || this.state !== state) {
      this.log.trace({ state }, 'Updating soft brush line');

      if (this.state.opacity !== state.opacity) {
        this.konva.group.opacity(state.opacity);
      }

      // After rasterization the stroke is baked — only opacity updates matter.
      if (this._rasterized) {
        this.state = state;
        return true;
      }

      // New stroke id → reset the incremental buffer.
      if (this.state.id !== state.id) {
        this._resetStrokeBuffer();
      }

      const prevState = this.state;
      this.state = state;

      // A change to size, hardness, or color requires re-accumulating the whole stroke: size/hardness
      // change the profile, and color changes the constant baked into every texel.
      const sizeOrHardnessChanged = state.strokeWidth !== this._dabSize || state.hardness !== this._dabHardness;
      const colorChanged =
        !this._isEraseMode &&
        prevState.type !== 'soft_eraser_line' &&
        prevState.type !== 'soft_eraser_line_with_pressure' &&
        ((prevState as CanvasSoftBrushLineState).color.r !== (state as CanvasSoftBrushLineState).color.r ||
          (prevState as CanvasSoftBrushLineState).color.g !== (state as CanvasSoftBrushLineState).color.g ||
          (prevState as CanvasSoftBrushLineState).color.b !== (state as CanvasSoftBrushLineState).color.b);
      if (sizeOrHardnessChanged || colorChanged) {
        this._dabProfile = null;
        this._resetStrokeBuffer();
      }

      // Mark the shape dirty so Konva re-executes _sceneFunc on the next frame. Unlike Konva.Line
      // (which auto-marks via setAttrs), our custom Shape needs an explicit trigger; batchDraw
      // coalesces rapid calls into one repaint.
      this.konva.shape.getLayer()?.batchDraw();

      return true;
    }

    return false;
  }

  /** Resets the incremental stroke buffer, accumulator, and ImageData, forcing a full re-render. */
  private _resetStrokeBuffer(): void {
    if (this._strokeCtx && this._strokeCanvas) {
      this._strokeCtx.clearRect(0, 0, this._strokeCanvas.width, this._strokeCanvas.height);
    }
    this._strokeCanvas = null;
    this._strokeCtx = null;
    this._accumulator = null;
    this._imageData = null;
    this._accWidth = 0;
    this._accHeight = 0;
    this._lastRenderedPointCount = 0;
    this._distanceRemainder = 0;
  }

  setVisibility(isVisible: boolean): void {
    this.log.trace({ isVisible }, 'Setting soft brush line visibility');
    this.konva.group.visible(isVisible);
  }

  destroy = () => {
    this.log.debug('Destroying soft brush line module');
    this._dabProfile = null;
    this._strokeCanvas = null;
    this._strokeCtx = null;
    this._accumulator = null;
    this._imageData = null;
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
