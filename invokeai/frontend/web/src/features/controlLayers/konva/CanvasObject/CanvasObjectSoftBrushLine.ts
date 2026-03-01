import { deepClone } from 'common/util/deepClone';
import type { CanvasEntityBufferObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityBufferObjectRenderer';
import type { CanvasEntityObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityObjectRenderer';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type {
  CanvasSoftBrushLineState,
  CanvasSoftBrushLineWithPressureState,
  CanvasSoftEraserLineState,
  CanvasSoftEraserLineWithPressureState,
} from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { Logger } from 'roarr';

type SoftBrushState =
  | CanvasSoftBrushLineState
  | CanvasSoftBrushLineWithPressureState
  | CanvasSoftEraserLineState
  | CanvasSoftEraserLineWithPressureState;

/**
 * Renders soft brush AND soft eraser lines with Gaussian falloff via Uint8Array mask buffer stamping.
 * Handles brush (source-over) and eraser (destination-out) modes, as well as regular and pressure-sensitive variants.
 *
 * Architecture (Krita-style max-alpha / ALPHA_DARKEN):
 * - Pre-computed dab profile (Uint8Array with alpha-only radial values)
 * - Uint8Array mask buffer with Math.max stamping (no alpha accumulation)
 * - ImageData kept in sync with mask (only alpha byte updated per stamp)
 * - Dirty rect tracking for efficient putImageData
 * - Stroke-level opacity via Konva group (caps visible alpha)
 *
 * For eraser mode: globalCompositeOperation is set to 'destination-out' on the rasterized
 * Konva.Image. destination-out with semi-transparent pixels produces proportional erasure
 * (alpha_out = alpha_dest * (1 - alpha_source)), giving soft-edged erasing.
 */
export class CanvasObjectSoftBrushLine extends CanvasModuleBase {
  readonly type = 'object_soft_brush_line';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasEntityObjectRenderer | CanvasEntityBufferObjectRenderer;
  readonly manager: CanvasManager;
  readonly log: Logger;

  /** Dab spacing as fraction of brush diameter (10% = smooth, matches BRUSH_SPACING_TARGET_SCALE) */
  private static readonly DAB_SPACING = 0.03;

  state: SoftBrushState;
  konva: {
    group: Konva.Group;
    shape: Konva.Shape;
  };

  /** Pre-computed alpha-only radial profile for the dab */
  private _dabProfile: Uint8Array | null = null;
  /** Side length of the dab profile (diameter rounded up) */
  private _dabProfileSize = 0;
  /** The diameter the cached profile was built for */
  private _dabSize = 0;
  /** The hardness the cached profile was built for */
  private _dabHardness = -1;
  /** The color key the stroke canvas was built for (for detecting color changes) */
  private _colorKey = '';

  /** Offscreen canvas accumulating the final stroke image */
  private _strokeCanvas: HTMLCanvasElement | null = null;
  private _strokeCtx: CanvasRenderingContext2D | null = null;
  /** How many points have been rendered to the stroke buffer */
  private _lastRenderedPointCount = 0;
  /** Leftover distance from previous segment for even dab spacing */
  private _distanceRemainder = 0;
  /** Offset for the stroke canvas position (matches clip origin) */
  private _strokeOffsetX = 0;
  private _strokeOffsetY = 0;

  /** Alpha mask buffer — same dimensions as stroke canvas, stores max-alpha per pixel */
  private _maskBuffer: Uint8Array | null = null;
  private _maskWidth = 0;
  private _maskHeight = 0;
  /** Persistent RGBA ImageData kept in sync with mask (RGB pre-filled, alpha updated) */
  private _imageData: ImageData | null = null;

  /** Dirty rect tracking for efficient putImageData */
  private _dirtyX1 = 0;
  private _dirtyY1 = 0;
  private _dirtyX2 = 0;
  private _dirtyY2 = 0;
  private _hasDirtyRect = false;

  /** Whether the stroke has been rasterized to a Konva.Image (after commit) */
  private _rasterized = false;

  /** Whether this instance is rendering in eraser mode (destination-out compositing) */
  private get _isEraseMode(): boolean {
    return this.state.type === 'soft_eraser_line' || this.state.type === 'soft_eraser_line_with_pressure';
  }

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
        globalCompositeOperation:
          state.type === 'soft_eraser_line' || state.type === 'soft_eraser_line_with_pressure'
            ? 'destination-out'
            : 'source-over',
        sceneFunc: (ctx) => this._sceneFunc(ctx),
      }),
    };
    this.konva.group.add(this.konva.shape);
    this.state = state;
  }

  /**
   * Pre-computes a 2D alpha-only radial profile for the dab. Each pixel stores 0-255
   * representing the alpha intensity at that position, with Gaussian-like falloff
   * from the center based on the hardness parameter.
   */
  private _buildDabProfile(diameter: number, hardness: number): Uint8Array {
    const size = Math.max(1, Math.ceil(diameter));
    const profile = new Uint8Array(size * size);
    const center = size / 2;
    const radius = size / 2;
    const innerRadius = radius * hardness;
    const falloff = radius - innerRadius;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dist = Math.hypot(x + 0.5 - center, y + 0.5 - center);
        if (dist <= innerRadius) {
          profile[y * size + x] = 255;
        } else if (dist >= radius) {
          profile[y * size + x] = 0;
        } else {
          profile[y * size + x] = Math.round(255 * (1 - (dist - innerRadius) / falloff));
        }
      }
    }

    return profile;
  }

  /**
   * Ensures the dab profile is built and cached. Rebuilds on size/hardness change.
   * Unlike the old _ensureDab, this is color-independent since the profile is alpha-only.
   */
  private _ensureDabProfile(): void {
    const { strokeWidth, hardness } = this.state;

    if (!this._dabProfile || this._dabSize !== strokeWidth || this._dabHardness !== hardness) {
      this._dabProfile = this._buildDabProfile(strokeWidth, hardness);
      this._dabProfileSize = Math.max(1, Math.ceil(strokeWidth));
      this._dabSize = strokeWidth;
      this._dabHardness = hardness;
    }
  }

  /**
   * Ensures the stroke buffer canvas, mask buffer, and ImageData exist and are sized appropriately.
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

    // Create mask buffer (alpha-only, initialized to 0)
    this._maskWidth = width;
    this._maskHeight = height;
    this._maskBuffer = new Uint8Array(width * height);

    // Create ImageData with RGB pre-filled (brush color or white for eraser), alpha = 0
    const { r, g, b } = this._isEraseMode
      ? { r: 255, g: 255, b: 255 }
      : (this.state as CanvasSoftBrushLineState | CanvasSoftBrushLineWithPressureState).color;
    if (this._strokeCtx) {
      this._imageData = this._strokeCtx.createImageData(width, height);
      const data = this._imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 0;
      }
    }
    this._colorKey = `${r},${g},${b}`;

    // Reset dirty rect
    this._hasDirtyRect = false;
  }

  /**
   * Core mask stamping method. Stamps a dab at (cx, cy) using Math.max blending
   * into the mask buffer and updates ImageData alpha bytes inline.
   *
   * When diameter differs from profileSize (pressure), uses nearest-neighbor sampling.
   */
  private _stampDabToMask(cx: number, cy: number, diameter?: number): void {
    const profile = this._dabProfile;
    const mask = this._maskBuffer;
    const imageData = this._imageData;
    if (!profile || !mask || !imageData) {
      return;
    }

    const profileSize = this._dabProfileSize;
    const useDiameter = diameter !== undefined ? diameter : profileSize;
    const useScaling = diameter !== undefined && Math.abs(diameter - profileSize) > 0.5;
    const scale = useScaling ? profileSize / useDiameter : 1;

    const radius = useDiameter / 2;
    const ox = this._strokeOffsetX;
    const oy = this._strokeOffsetY;

    // Dab footprint in mask coordinates
    const startX = Math.round(cx - radius - ox);
    const startY = Math.round(cy - radius - oy);
    const dabW = Math.max(1, Math.ceil(useDiameter));
    const dabH = dabW;

    // Clamp to mask bounds
    const x0 = Math.max(0, startX);
    const y0 = Math.max(0, startY);
    const x1 = Math.min(this._maskWidth, startX + dabW);
    const y1 = Math.min(this._maskHeight, startY + dabH);

    if (x0 >= x1 || y0 >= y1) {
      return;
    }

    const data = imageData.data;
    const mw = this._maskWidth;
    let dirtyMinX = x1;
    let dirtyMinY = y1;
    let dirtyMaxX = x0;
    let dirtyMaxY = y0;
    let anyDirty = false;

    for (let py = y0; py < y1; py++) {
      const dy = py - startY;
      for (let px = x0; px < x1; px++) {
        const dx = px - startX;

        // Sample from profile (with optional nearest-neighbor scaling)
        let sx: number;
        let sy: number;
        if (useScaling) {
          sx = Math.min(Math.floor(dx * scale), profileSize - 1);
          sy = Math.min(Math.floor(dy * scale), profileSize - 1);
        } else {
          sx = dx;
          sy = dy;
          if (sx >= profileSize || sy >= profileSize) {
            continue;
          }
        }

        const dabAlpha = profile[sy * profileSize + sx]!;
        if (dabAlpha === 0) {
          continue;
        }

        const idx = py * mw + px;
        const current = mask[idx]!;
        if (dabAlpha > current) {
          mask[idx] = dabAlpha;
          data[idx * 4 + 3] = dabAlpha;

          // Track dirty region
          if (px < dirtyMinX) {
            dirtyMinX = px;
          }
          if (px > dirtyMaxX) {
            dirtyMaxX = px;
          }
          if (py < dirtyMinY) {
            dirtyMinY = py;
          }
          if (py > dirtyMaxY) {
            dirtyMaxY = py;
          }
          anyDirty = true;
        }
      }
    }

    // Expand accumulated dirty rect
    if (anyDirty) {
      if (this._hasDirtyRect) {
        if (dirtyMinX < this._dirtyX1) {
          this._dirtyX1 = dirtyMinX;
        }
        if (dirtyMinY < this._dirtyY1) {
          this._dirtyY1 = dirtyMinY;
        }
        if (dirtyMaxX + 1 > this._dirtyX2) {
          this._dirtyX2 = dirtyMaxX + 1;
        }
        if (dirtyMaxY + 1 > this._dirtyY2) {
          this._dirtyY2 = dirtyMaxY + 1;
        }
      } else {
        this._dirtyX1 = dirtyMinX;
        this._dirtyY1 = dirtyMinY;
        this._dirtyX2 = dirtyMaxX + 1;
        this._dirtyY2 = dirtyMaxY + 1;
        this._hasDirtyRect = true;
      }
    }
  }

  /**
   * Stamps interpolated dabs along a segment from (x0,y0) to (x1,y1) using mask buffer.
   * Uses the Krita/GIMP distance-accumulator algorithm for gap-free, evenly-spaced dabs.
   * Pressure is linearly interpolated between segment endpoints.
   */
  private _stampSegment(x0: number, y0: number, x1: number, y1: number, p0?: number, p1?: number): void {
    if (!this._dabProfile || !this._maskBuffer) {
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

    while (dist <= segLen) {
      const ix = x0 + ux * dist;
      const iy = y0 + uy * dist;

      if (hasPressure) {
        const t = dist / segLen;
        const pressure = p0 + (p1 - p0) * t;
        const d = this.state.strokeWidth * pressure;
        this._stampDabToMask(ix, iy, d);
      } else {
        this._stampDabToMask(ix, iy);
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
    if (!this._dabProfile || !this._maskBuffer) {
      return;
    }

    if (pressure !== undefined) {
      const d = this.state.strokeWidth * pressure;
      this._stampDabToMask(x, y, d);
    } else {
      this._stampDabToMask(x, y);
    }
  }

  /**
   * Custom Konva sceneFunc. Incrementally stamps new dabs into the mask buffer,
   * then commits dirty regions to the stroke canvas and blits to the Konva context.
   */
  private _sceneFunc(ctx: Konva.Context): void {
    // After rasterization, the Konva.Image handles rendering — sceneFunc is a no-op
    if (this._rasterized) {
      return;
    }

    const { points } = this.state;
    const isPressure =
      this.state.type === 'soft_brush_line_with_pressure' || this.state.type === 'soft_eraser_line_with_pressure';
    const step = isPressure ? 3 : 2;

    if (points.length < step) {
      return;
    }

    // Ensure dab profile and stroke canvas/mask exist
    this._ensureDabProfile();
    this._ensureStrokeCanvas();

    if (!this._strokeCtx || !this._strokeCanvas || !this._dabProfile || !this._maskBuffer || !this._imageData) {
      return;
    }

    // Phase A: Stamp new dabs incrementally into the mask buffer
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

    // Phase B: Commit dirty rect from ImageData to stroke canvas, then blit to Konva
    if (this._hasDirtyRect) {
      const dx = Math.max(0, this._dirtyX1);
      const dy = Math.max(0, this._dirtyY1);
      const dw = Math.min(this._maskWidth, this._dirtyX2) - dx;
      const dh = Math.min(this._maskHeight, this._dirtyY2) - dy;
      if (dw > 0 && dh > 0) {
        this._strokeCtx.putImageData(this._imageData, 0, 0, dx, dy, dw, dh);
      }
      this._hasDirtyRect = false;
    }

    // Blit stroke canvas to Konva (single drawImage = O(1))
    const nativeCtx = ctx._context;
    nativeCtx.drawImage(this._strokeCanvas, this._strokeOffsetX, this._strokeOffsetY);
  }

  /**
   * Bakes the finalized stroke canvas into a Konva.Image, replacing the custom Shape.
   * Called on commit so the stroke survives Konva's clone() (which doesn't preserve sceneFunc).
   */
  rasterizeToImage(): void {
    if (this._rasterized) {
      return;
    }

    // Ensure stroke canvas exists and has content
    this._ensureDabProfile();
    this._ensureStrokeCanvas();

    if (!this._strokeCanvas || !this._strokeCtx) {
      return;
    }

    // Flush any pending dirty rect to the stroke canvas
    if (this._hasDirtyRect && this._imageData) {
      const dx = Math.max(0, this._dirtyX1);
      const dy = Math.max(0, this._dirtyY1);
      const dw = Math.min(this._maskWidth, this._dirtyX2) - dx;
      const dh = Math.min(this._maskHeight, this._dirtyY2) - dy;
      if (dw > 0 && dh > 0) {
        this._strokeCtx.putImageData(this._imageData, 0, 0, dx, dy, dw, dh);
      }
      this._hasDirtyRect = false;
    }

    // Create Konva.Image from the finalized stroke canvas
    const image = new Konva.Image({
      image: this._strokeCanvas,
      x: this._strokeOffsetX,
      y: this._strokeOffsetY,
      listening: false,
      perfectDrawEnabled: false,
      globalCompositeOperation: this._isEraseMode ? 'destination-out' : undefined,
    });

    // Remove the custom Shape and add the Image to the group
    this.konva.shape.remove();
    this.konva.group.add(image);

    // Clean up internal buffers (stroke canvas stays alive — Konva.Image references it)
    this._dabProfile = null;
    this._maskBuffer = null;
    this._imageData = null;
    this._strokeCtx = null;
    this._rasterized = true;

    this.log.trace('Rasterized soft brush stroke to Konva.Image');
  }

  update(state: SoftBrushState, force = false): boolean {
    if (force || this.state !== state) {
      this.log.trace({ state }, 'Updating soft brush line');

      // Update group opacity if it changed
      if (this.state.opacity !== state.opacity) {
        this.konva.group.opacity(state.opacity);
      }

      // After rasterization, the stroke is baked — only opacity updates are needed
      if (this._rasterized) {
        this.state = state;
        return true;
      }

      // If the state ID changed (new stroke), reset the incremental buffer
      if (this.state.id !== state.id) {
        this._resetStrokeBuffer();
      }

      this.state = state;

      // Invalidate dab profile if size or hardness changed; invalidate on color change too
      // since ImageData RGB needs to be re-filled
      const isErase = this._isEraseMode;
      const colorKey = isErase
        ? '255,255,255'
        : `${(state as CanvasSoftBrushLineState | CanvasSoftBrushLineWithPressureState).color.r},${(state as CanvasSoftBrushLineState | CanvasSoftBrushLineWithPressureState).color.g},${(state as CanvasSoftBrushLineState | CanvasSoftBrushLineWithPressureState).color.b}`;
      if (state.strokeWidth !== this._dabSize || state.hardness !== this._dabHardness) {
        this._dabProfile = null;
        // Dab changed — need to re-render entire stroke with new profile
        this._resetStrokeBuffer();
      } else if (colorKey !== this._colorKey) {
        // Color changed — need to re-render entire stroke with new RGB
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
   * Resets the incremental stroke buffer, mask, and ImageData, forcing a full re-render
   * on next sceneFunc call.
   */
  private _resetStrokeBuffer(): void {
    if (this._strokeCtx && this._strokeCanvas) {
      this._strokeCtx.clearRect(0, 0, this._strokeCanvas.width, this._strokeCanvas.height);
    }
    this._strokeCanvas = null;
    this._strokeCtx = null;
    this._maskBuffer = null;
    this._imageData = null;
    this._maskWidth = 0;
    this._maskHeight = 0;
    this._colorKey = '';
    this._lastRenderedPointCount = 0;
    this._distanceRemainder = 0;
    this._hasDirtyRect = false;
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
    this._maskBuffer = null;
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
