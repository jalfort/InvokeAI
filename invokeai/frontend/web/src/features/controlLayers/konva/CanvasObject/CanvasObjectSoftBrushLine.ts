import { deepClone } from 'common/util/deepClone';
import type { CanvasEntityBufferObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityBufferObjectRenderer';
import type { CanvasEntityObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityObjectRenderer';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type {
  CanvasSoftBrushLineState,
  CanvasSoftBrushLineWithPressureState,
} from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { Logger } from 'roarr';

type SoftBrushState = CanvasSoftBrushLineState | CanvasSoftBrushLineWithPressureState;

/**
 * Renders soft brush lines with Gaussian falloff via radial gradient dab stamping.
 * Handles both regular and pressure-sensitive variants.
 *
 * Architecture (based on Krita/GIMP brush engines):
 * - Pre-rendered dab texture (offscreen canvas with radial gradient)
 * - Incremental stroke buffer: dabs are stamped once and never re-drawn
 * - Distance-accumulator interpolation for gap-free dab placement
 * - Stroke-level opacity via Konva group (prevents dab-overlap buildup)
 */
export class CanvasObjectSoftBrushLine extends CanvasModuleBase {
  readonly type = 'object_soft_brush_line';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasEntityObjectRenderer | CanvasEntityBufferObjectRenderer;
  readonly manager: CanvasManager;
  readonly log: Logger;

  /** Dab spacing as fraction of brush diameter (10% = smooth, matches BRUSH_SPACING_TARGET_SCALE) */
  private static readonly DAB_SPACING = 0.1;

  state: SoftBrushState;
  konva: {
    group: Konva.Group;
    shape: Konva.Shape;
  };

  /** Cached radial gradient dab texture */
  private _dabCanvas: HTMLCanvasElement | null = null;
  /** The diameter the cached dab was built for */
  private _dabSize = 0;
  /** The hardness the cached dab was built for */
  private _dabHardness = -1;
  /** The color key the cached dab was built for (r,g,b) */
  private _dabColorKey = '';

  /** Offscreen canvas accumulating stamped dabs for the current stroke */
  private _strokeCanvas: HTMLCanvasElement | null = null;
  private _strokeCtx: CanvasRenderingContext2D | null = null;
  /** How many points have been rendered to the stroke buffer */
  private _lastRenderedPointCount = 0;
  /** Leftover distance from previous segment for even dab spacing */
  private _distanceRemainder = 0;
  /** Offset for the stroke canvas position (matches clip origin) */
  private _strokeOffsetX = 0;
  private _strokeOffsetY = 0;

  constructor(state: SoftBrushState, parent: CanvasEntityObjectRenderer | CanvasEntityBufferObjectRenderer) {
    super();
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
        globalCompositeOperation: 'source-over',
        sceneFunc: (ctx) => this._sceneFunc(ctx),
      }),
    };
    this.konva.group.add(this.konva.shape);
    this.state = state;
  }

  /**
   * Builds a pre-colored radial gradient dab texture. The dab is built directly in the brush
   * color to avoid needing destructive compositing operations (source-in).
   */
  private _buildDabCanvas(
    diameter: number,
    hardness: number,
    color: { r: number; g: number; b: number }
  ): HTMLCanvasElement {
    const size = Math.max(1, Math.ceil(diameter));
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return canvas;
    }

    const radius = size / 2;
    const innerRadius = radius * hardness;

    const solidColor = `rgba(${color.r}, ${color.g}, ${color.b}, 1)`;
    const transparentColor = `rgba(${color.r}, ${color.g}, ${color.b}, 0)`;

    const gradient = ctx.createRadialGradient(radius, radius, innerRadius, radius, radius, radius);
    gradient.addColorStop(0, solidColor);
    gradient.addColorStop(1, transparentColor);

    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    return canvas;
  }

  /**
   * Ensures the stroke buffer canvas exists and is sized appropriately.
   * Uses the clip dimensions if available, otherwise a generous fallback.
   */
  private _ensureStrokeCanvas(): void {
    if (this._strokeCanvas) {
      return;
    }

    const clip = this.state.clip;
    let width: number;
    let height: number;

    if (clip) {
      // Add padding for brush overshoot at edges
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

    this._strokeCanvas = document.createElement('canvas');
    this._strokeCanvas.width = width;
    this._strokeCanvas.height = height;
    this._strokeCtx = this._strokeCanvas.getContext('2d');
  }

  /**
   * Ensures the dab texture is built and cached. Rebuilds on size/hardness/color change.
   */
  private _ensureDab(): void {
    const { strokeWidth, hardness, color } = this.state;
    const colorKey = `${color.r},${color.g},${color.b}`;

    if (
      !this._dabCanvas ||
      this._dabSize !== strokeWidth ||
      this._dabHardness !== hardness ||
      this._dabColorKey !== colorKey
    ) {
      this._dabCanvas = this._buildDabCanvas(strokeWidth, hardness, color);
      this._dabSize = strokeWidth;
      this._dabHardness = hardness;
      this._dabColorKey = colorKey;
    }
  }

  /**
   * Stamps interpolated dabs along a segment from (x0,y0) to (x1,y1) onto the stroke buffer.
   * Uses the Krita/GIMP distance-accumulator algorithm for gap-free, evenly-spaced dabs.
   * Pressure is linearly interpolated between segment endpoints.
   */
  private _stampSegment(x0: number, y0: number, x1: number, y1: number, p0?: number, p1?: number): void {
    if (!this._strokeCtx || !this._dabCanvas) {
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

    // Start at leftover distance from previous segment
    let dist = spacing - this._distanceRemainder;

    if (dist > segLen) {
      // Not enough distance for a dab — accumulate and return
      this._distanceRemainder += segLen;
      return;
    }

    const ox = this._strokeOffsetX;
    const oy = this._strokeOffsetY;

    while (dist <= segLen) {
      const ix = x0 + ux * dist;
      const iy = y0 + uy * dist;

      if (hasPressure) {
        const t = dist / segLen;
        const pressure = p0 + (p1 - p0) * t;
        const d = this.state.strokeWidth * pressure;
        const r = d / 2;
        this._strokeCtx.drawImage(this._dabCanvas, Math.round(ix - r - ox), Math.round(iy - r - oy), d, d);
      } else {
        const r = this.state.strokeWidth / 2;
        this._strokeCtx.drawImage(
          this._dabCanvas,
          Math.round(ix - r - ox),
          Math.round(iy - r - oy),
          this.state.strokeWidth,
          this.state.strokeWidth
        );
      }

      dist += spacing;
    }

    // Carry leftover into next segment
    this._distanceRemainder = segLen - (dist - spacing);
  }

  /**
   * Stamps a single dab at the given position (for single-point strokes / click without drag).
   */
  private _stampSingleDab(x: number, y: number, pressure?: number): void {
    if (!this._strokeCtx || !this._dabCanvas) {
      return;
    }

    const ox = this._strokeOffsetX;
    const oy = this._strokeOffsetY;

    if (pressure !== undefined) {
      const d = this.state.strokeWidth * pressure;
      const r = d / 2;
      this._strokeCtx.drawImage(this._dabCanvas, Math.round(x - r - ox), Math.round(y - r - oy), d, d);
    } else {
      const r = this.state.strokeWidth / 2;
      this._strokeCtx.drawImage(
        this._dabCanvas,
        Math.round(x - r - ox),
        Math.round(y - r - oy),
        this.state.strokeWidth,
        this.state.strokeWidth
      );
    }
  }

  /**
   * Custom Konva sceneFunc. Incrementally stamps new dabs onto the stroke buffer,
   * then blits the buffer to the layer in a single drawImage call.
   */
  private _sceneFunc(ctx: Konva.Context): void {
    const { points } = this.state;
    const isPressure = this.state.type === 'soft_brush_line_with_pressure';
    const step = isPressure ? 3 : 2;

    if (points.length < step) {
      return;
    }

    // Ensure dab and stroke buffer exist
    this._ensureDab();
    this._ensureStrokeCanvas();

    if (!this._strokeCtx || !this._strokeCanvas || !this._dabCanvas) {
      return;
    }

    // Phase A: Stamp new dabs incrementally onto the stroke buffer
    if (points.length > this._lastRenderedPointCount) {
      if (this._lastRenderedPointCount === 0) {
        // First render — stamp a dab at the first point
        if (isPressure) {
          this._stampSingleDab(points[0]!, points[1]!, points[2]);
        } else {
          this._stampSingleDab(points[0]!, points[1]!);
        }
        this._lastRenderedPointCount = step;
        this._distanceRemainder = 0;
      }

      // Stamp segments from last rendered point to all new points
      const startIdx = Math.max(step, this._lastRenderedPointCount) - step;
      for (let i = startIdx; i < points.length - step; i += step) {
        const x0 = points[i]!;
        const y0 = points[i + 1]!;
        const x1 = points[i + step]!;
        const y1 = points[i + step + 1]!;

        // Only process segments that include new points
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

    // Phase B: Blit the stroke buffer to the Konva context (single drawImage = O(1))
    const nativeCtx = ctx._context;
    nativeCtx.drawImage(this._strokeCanvas, this._strokeOffsetX, this._strokeOffsetY);
  }

  update(state: SoftBrushState, force = false): boolean {
    if (force || this.state !== state) {
      this.log.trace({ state }, 'Updating soft brush line');

      // Update group opacity if it changed
      if (this.state.opacity !== state.opacity) {
        this.konva.group.opacity(state.opacity);
      }

      // If the state ID changed (new stroke), reset the incremental buffer
      if (this.state.id !== state.id) {
        this._resetStrokeBuffer();
      }

      this.state = state;

      // Invalidate dab cache if size, hardness, or color changed
      const colorKey = `${state.color.r},${state.color.g},${state.color.b}`;
      if (state.strokeWidth !== this._dabSize || state.hardness !== this._dabHardness || colorKey !== this._dabColorKey) {
        this._dabCanvas = null;
        // Dab changed — need to re-render entire stroke with new dab
        this._resetStrokeBuffer();
      }

      // Mark shape dirty so Konva re-executes _sceneFunc on next frame.
      // Unlike Konva.Line (which auto-marks via setAttrs), our custom Shape
      // needs an explicit trigger. batchDraw coalesces rapid calls into one repaint.
      this.konva.shape.getLayer()?.batchDraw();

      return true;
    }

    return false;
  }

  /**
   * Resets the incremental stroke buffer, forcing a full re-render on next sceneFunc call.
   */
  private _resetStrokeBuffer(): void {
    if (this._strokeCtx && this._strokeCanvas) {
      this._strokeCtx.clearRect(0, 0, this._strokeCanvas.width, this._strokeCanvas.height);
    }
    this._strokeCanvas = null;
    this._strokeCtx = null;
    this._lastRenderedPointCount = 0;
    this._distanceRemainder = 0;
  }

  setVisibility(isVisible: boolean): void {
    this.log.trace({ isVisible }, 'Setting soft brush line visibility');
    this.konva.group.visible(isVisible);
  }

  destroy = () => {
    this.log.debug('Destroying soft brush line module');
    this._dabCanvas = null;
    this._strokeCanvas = null;
    this._strokeCtx = null;
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
