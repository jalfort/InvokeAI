import { deepClone } from 'common/util/deepClone';
import type { CanvasEntityBufferObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityBufferObjectRenderer';
import type { CanvasEntityObjectRenderer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityObjectRenderer';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type {
  CanvasCloneBrushLineState,
  CanvasCloneBrushLineWithPressureState,
} from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { Logger } from 'roarr';

type CloneBrushState = CanvasCloneBrushLineState | CanvasCloneBrushLineWithPressureState;

/**
 * Renders clone brush lines by sampling RGBA pixels from a source snapshot and stamping
 * them through a soft dab mask onto a stroke canvas.
 * Handles both regular and pressure-sensitive variants.
 *
 * Architecture (per-pixel Math.max RGBA blending):
 * - Pre-rendered dab mask canvas (radial gradient from white to transparent, based on hardness)
 * - Per-dab temporary canvas: source region copied, then masked via destination-in compositing
 * - Dab pixels read via getImageData, then Math.max blended into stroke ImageData by alpha
 *   (if new dab alpha > existing stroke alpha, overwrite RGBA — preserves soft edges)
 * - Dirty rect of stroke ImageData written to stroke canvas via putImageData
 * - Stroke canvas blitted to Konva context (single drawImage)
 * - Stroke-level opacity via Konva group (caps visible alpha)
 */
export class CanvasObjectCloneBrushLine extends CanvasModuleBase {
  readonly type = 'object_clone_brush_line';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasEntityObjectRenderer | CanvasEntityBufferObjectRenderer;
  readonly manager: CanvasManager;
  readonly log: Logger;

  /** Dab spacing as fraction of brush diameter (3% = smooth, matches BRUSH_SPACING_TARGET_SCALE) */
  private static readonly DAB_SPACING = 0.03;

  state: CloneBrushState;
  konva: {
    group: Konva.Group;
    shape: Konva.Shape;
  };

  /** Source snapshot canvas set externally by the tool module at stroke start */
  private _sourceSnapshot: HTMLCanvasElement | null = null;
  /** Snapshot origin in entity-local coordinates (to convert from entity-local to snapshot coords) */
  private _snapshotOffsetX = 0;
  private _snapshotOffsetY = 0;

  /** Pre-rendered radial gradient mask canvas (white center -> transparent edge based on hardness) */
  private _dabMaskCanvas: HTMLCanvasElement | null = null;
  /** Temporary per-dab canvas for source sampling + masking */
  private _dabCanvas: HTMLCanvasElement | null = null;
  /** Context for _dabCanvas */
  private _dabCtx: CanvasRenderingContext2D | null = null;

  /** The diameter the cached dab mask was built for */
  private _dabSize = 0;
  /** The hardness the cached dab mask was built for */
  private _dabHardness = -1;

  /** Offscreen canvas accumulating the final stroke image */
  private _strokeCanvas: HTMLCanvasElement | null = null;
  private _strokeCtx: CanvasRenderingContext2D | null = null;
  /** Persistent RGBA ImageData for per-pixel Math.max blending */
  private _strokeImageData: ImageData | null = null;
  /** Stroke canvas dimensions */
  private _strokeW = 0;
  private _strokeH = 0;

  /** Dirty rect tracking for efficient putImageData */
  private _dirtyX1 = 0;
  private _dirtyY1 = 0;
  private _dirtyX2 = 0;
  private _dirtyY2 = 0;
  private _hasDirtyRect = false;

  /** How many points have been rendered to the stroke buffer */
  private _lastRenderedPointCount = 0;
  /** Leftover distance from previous segment for even dab spacing */
  private _distanceRemainder = 0;
  /** Offset for the stroke canvas position (matches clip origin) */
  private _strokeOffsetX = 0;
  private _strokeOffsetY = 0;

  /** Whether the stroke has been rasterized to a Konva.Image (after commit) */
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
   * Sets the source snapshot canvas for this stroke. Called externally by the tool module
   * at stroke start.
   *
   * @param canvas The snapshot canvas (e.g. from adapter.getCanvas(bboxRect))
   * @param offsetX Snapshot origin X in entity-local coords (typically clip.x = bbox.x - entityPos.x)
   * @param offsetY Snapshot origin Y in entity-local coords (typically clip.y = bbox.y - entityPos.y)
   */
  setSourceSnapshot(canvas: HTMLCanvasElement, offsetX: number, offsetY: number): void {
    this._sourceSnapshot = canvas;
    this._snapshotOffsetX = offsetX;
    this._snapshotOffsetY = offsetY;
    // Reset stroke buffer since a new source means re-rendering
    this._resetStrokeBuffer();
  }

  /**
   * Builds a small canvas with a radial gradient from white (center) to transparent (edge),
   * respecting the hardness parameter. This canvas is used as a destination-in mask to shape
   * each dab's alpha profile.
   */
  private _buildDabMaskCanvas(diameter: number, hardness: number): HTMLCanvasElement {
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

    const gradient = ctx.createRadialGradient(radius, radius, innerRadius, radius, radius, radius);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    return canvas;
  }

  /**
   * Ensures the dab mask canvas is built and cached. Rebuilds on size/hardness change.
   */
  private _ensureDabMask(): void {
    const { strokeWidth, hardness } = this.state;

    if (!this._dabMaskCanvas || this._dabSize !== strokeWidth || this._dabHardness !== hardness) {
      this._dabMaskCanvas = this._buildDabMaskCanvas(strokeWidth, hardness);
      this._dabSize = strokeWidth;
      this._dabHardness = hardness;
      // Also invalidate the dab canvas since its size may have changed
      this._dabCanvas = null;
      this._dabCtx = null;
    }
  }

  /**
   * Ensures the stroke buffer canvas and ImageData exist and are sized appropriately.
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
    this._strokeW = width;
    this._strokeH = height;

    // Create persistent ImageData for Math.max blending — starts fully transparent
    if (this._strokeCtx) {
      this._strokeImageData = this._strokeCtx.createImageData(width, height);
    }
  }

  /**
   * Ensures the temporary per-dab canvas exists and matches the current dab size.
   */
  private _ensureDabCanvas(): void {
    const size = Math.max(1, Math.ceil(this.state.strokeWidth));

    if (this._dabCanvas && this._dabCanvas.width === size && this._dabCanvas.height === size) {
      return;
    }

    this._dabCanvas = document.createElement('canvas');
    this._dabCanvas.width = size;
    this._dabCanvas.height = size;
    this._dabCtx = this._dabCanvas.getContext('2d');
  }

  /**
   * Core stamping method. For each dab at position (cx, cy):
   * 1. Compute source position in snapshot coordinates using sourceOffset
   * 2. Clear dab canvas
   * 3. Draw source region from snapshot onto dab canvas
   * 4. Apply dab mask using destination-in compositing (multiplies alpha by profile)
   * 5. Read dab pixels via getImageData
   * 6. Math.max blend into stroke ImageData (if new alpha > existing, overwrite RGBA)
   *
   * When diameter differs from the base strokeWidth (pressure), the source region and
   * dab mask are scaled accordingly via drawImage, and the output is sampled with
   * nearest-neighbor scaling.
   */
  private _stampDab(cx: number, cy: number, diameter?: number): void {
    const snapshot = this._sourceSnapshot;
    const dabMask = this._dabMaskCanvas;
    const strokeImageData = this._strokeImageData;
    if (!snapshot || !dabMask || !strokeImageData || !this._dabCtx || !this._dabCanvas) {
      return;
    }

    const baseDabSize = Math.max(1, Math.ceil(this.state.strokeWidth));
    const useDiameter = diameter !== undefined ? Math.max(1, diameter) : baseDabSize;
    const radius = useDiameter / 2;

    const ox = this._strokeOffsetX;
    const oy = this._strokeOffsetY;

    // Source position in snapshot coordinates.
    const srcX = cx + this.state.sourceOffsetX - radius - this._snapshotOffsetX;
    const srcY = cy + this.state.sourceOffsetY - radius - this._snapshotOffsetY;

    const dabSize = baseDabSize;
    const dabCtx = this._dabCtx;

    // Step 1: Clear the dab canvas
    dabCtx.clearRect(0, 0, dabSize, dabSize);

    // Step 2: Draw source region onto dab canvas (scaled to baseDabSize)
    dabCtx.globalCompositeOperation = 'source-over';
    if (Math.abs(useDiameter - dabSize) > 0.5) {
      dabCtx.drawImage(snapshot, srcX, srcY, useDiameter, useDiameter, 0, 0, dabSize, dabSize);
    } else {
      dabCtx.drawImage(snapshot, srcX, srcY, dabSize, dabSize, 0, 0, dabSize, dabSize);
    }

    // Step 3: Apply dab mask using destination-in (multiplies source pixels' alpha by mask alpha)
    dabCtx.globalCompositeOperation = 'destination-in';
    dabCtx.drawImage(dabMask, 0, 0, dabSize, dabSize);

    // Step 4: Read masked dab pixels
    const dabData = dabCtx.getImageData(0, 0, dabSize, dabSize);
    const dabPixels = dabData.data;

    // Step 5: Math.max RGBA blend into stroke ImageData
    const strokePixels = strokeImageData.data;
    const strokeW = this._strokeW;
    const strokeH = this._strokeH;
    const destLeft = Math.floor(cx - radius - ox);
    const destTop = Math.floor(cy - radius - oy);
    const ceilDiam = Math.ceil(useDiameter);
    const hasPressureScale = Math.abs(useDiameter - dabSize) > 0.5;
    const scaleFactor = hasPressureScale ? dabSize / useDiameter : 1;

    for (let dy = 0; dy < ceilDiam; dy++) {
      const dstY = destTop + dy;
      if (dstY < 0 || dstY >= strokeH) {
        continue;
      }

      for (let dx = 0; dx < ceilDiam; dx++) {
        const dstX = destLeft + dx;
        if (dstX < 0 || dstX >= strokeW) {
          continue;
        }

        // Sample from dab canvas (nearest-neighbor when pressure-scaled)
        let sx: number;
        let sy: number;
        if (hasPressureScale) {
          sx = Math.min(Math.floor(dx * scaleFactor), dabSize - 1);
          sy = Math.min(Math.floor(dy * scaleFactor), dabSize - 1);
        } else {
          sx = dx < dabSize ? dx : dabSize - 1;
          sy = dy < dabSize ? dy : dabSize - 1;
        }

        const dabIdx = (sy * dabSize + sx) * 4;
        const dabAlpha = dabPixels[dabIdx + 3]!;

        if (dabAlpha === 0) {
          continue;
        }

        const strokeIdx = (dstY * strokeW + dstX) * 4;
        const existingAlpha = strokePixels[strokeIdx + 3]!;

        // Math.max: only overwrite if new dab alpha is stronger
        if (dabAlpha > existingAlpha) {
          strokePixels[strokeIdx] = dabPixels[dabIdx]!;
          strokePixels[strokeIdx + 1] = dabPixels[dabIdx + 1]!;
          strokePixels[strokeIdx + 2] = dabPixels[dabIdx + 2]!;
          strokePixels[strokeIdx + 3] = dabAlpha;
        }
      }
    }

    // Expand dirty rect
    const dirtyLeft = Math.max(0, destLeft);
    const dirtyTop = Math.max(0, destTop);
    const dirtyRight = Math.min(strokeW, destLeft + ceilDiam);
    const dirtyBottom = Math.min(strokeH, destTop + ceilDiam);

    if (this._hasDirtyRect) {
      this._dirtyX1 = Math.min(this._dirtyX1, dirtyLeft);
      this._dirtyY1 = Math.min(this._dirtyY1, dirtyTop);
      this._dirtyX2 = Math.max(this._dirtyX2, dirtyRight);
      this._dirtyY2 = Math.max(this._dirtyY2, dirtyBottom);
    } else {
      this._dirtyX1 = dirtyLeft;
      this._dirtyY1 = dirtyTop;
      this._dirtyX2 = dirtyRight;
      this._dirtyY2 = dirtyBottom;
      this._hasDirtyRect = true;
    }
  }

  /**
   * Stamps interpolated dabs along a segment from (x0,y0) to (x1,y1) onto the stroke canvas.
   * Uses the Krita/GIMP distance-accumulator algorithm for gap-free, evenly-spaced dabs.
   * Pressure is linearly interpolated between segment endpoints.
   */
  private _stampSegment(x0: number, y0: number, x1: number, y1: number, p0?: number, p1?: number): void {
    if (!this._sourceSnapshot || !this._dabMaskCanvas) {
      return;
    }

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
        this._stampDab(ix, iy, d);
      } else {
        this._stampDab(ix, iy);
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
    if (!this._sourceSnapshot || !this._dabMaskCanvas) {
      return;
    }

    if (pressure !== undefined) {
      const d = this.state.strokeWidth * pressure;
      this._stampDab(x, y, d);
    } else {
      this._stampDab(x, y);
    }
  }

  /**
   * Custom Konva sceneFunc. Incrementally stamps new dabs from the source snapshot
   * into the stroke ImageData (Math.max blend), commits dirty rect to stroke canvas,
   * then blits the stroke canvas to the Konva context.
   */
  private _sceneFunc(ctx: Konva.Context): void {
    // After rasterization, the Konva.Image handles rendering — sceneFunc is a no-op
    if (this._rasterized) {
      return;
    }

    const { points } = this.state;
    const isPressure = this.state.type === 'clone_brush_line_with_pressure';
    const step = isPressure ? 3 : 2;

    if (points.length < step) {
      return;
    }

    // Cannot render without a source snapshot
    if (!this._sourceSnapshot) {
      return;
    }

    // Ensure dab mask, dab canvas, and stroke canvas exist
    this._ensureDabMask();
    this._ensureStrokeCanvas();
    this._ensureDabCanvas();

    if (
      !this._strokeCtx ||
      !this._strokeCanvas ||
      !this._strokeImageData ||
      !this._dabMaskCanvas ||
      !this._dabCanvas ||
      !this._dabCtx
    ) {
      return;
    }

    // Phase A: Stamp new dabs incrementally into the stroke ImageData
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

    // Phase B: Commit dirty rect to stroke canvas, then blit to Konva
    if (this._hasDirtyRect) {
      const dx = Math.max(0, this._dirtyX1);
      const dy = Math.max(0, this._dirtyY1);
      const dw = Math.min(this._strokeW, this._dirtyX2) - dx;
      const dh = Math.min(this._strokeH, this._dirtyY2) - dy;
      if (dw > 0 && dh > 0) {
        this._strokeCtx.putImageData(this._strokeImageData, 0, 0, dx, dy, dw, dh);
      }
      this._hasDirtyRect = false;
    }

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
    this._ensureDabMask();
    this._ensureStrokeCanvas();

    if (!this._strokeCanvas || !this._strokeCtx) {
      return;
    }

    // Flush any remaining dirty rect to the stroke canvas
    if (this._hasDirtyRect && this._strokeImageData) {
      const dx = Math.max(0, this._dirtyX1);
      const dy = Math.max(0, this._dirtyY1);
      const dw = Math.min(this._strokeW, this._dirtyX2) - dx;
      const dh = Math.min(this._strokeH, this._dirtyY2) - dy;
      if (dw > 0 && dh > 0) {
        this._strokeCtx.putImageData(this._strokeImageData, 0, 0, dx, dy, dw, dh);
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
    });

    // Remove the custom Shape and add the Image to the group
    this.konva.shape.remove();
    this.konva.group.add(image);

    // Clean up internal buffers (stroke canvas stays alive — Konva.Image references it)
    this._dabMaskCanvas = null;
    this._dabCanvas = null;
    this._dabCtx = null;
    this._sourceSnapshot = null;
    this._snapshotOffsetX = 0;
    this._snapshotOffsetY = 0;
    this._strokeCtx = null;
    this._strokeImageData = null;
    this._rasterized = true;

    this.log.trace('Rasterized clone brush stroke to Konva.Image');
  }

  update(state: CloneBrushState, force = false): boolean {
    if (force || this.state !== state) {
      this.log.trace({ state }, 'Updating clone brush line');

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

      // Invalidate dab mask if size or hardness changed
      if (state.strokeWidth !== this._dabSize || state.hardness !== this._dabHardness) {
        this._dabMaskCanvas = null;
        this._dabCanvas = null;
        this._dabCtx = null;
        // Dab changed — need to re-render entire stroke with new profile
        this._resetStrokeBuffer();
      }

      // Mark shape dirty so Konva re-executes _sceneFunc on next frame.
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
    this._strokeImageData = null;
    this._strokeW = 0;
    this._strokeH = 0;
    this._dabCanvas = null;
    this._dabCtx = null;
    this._lastRenderedPointCount = 0;
    this._distanceRemainder = 0;
    this._hasDirtyRect = false;
  }

  setVisibility(isVisible: boolean): void {
    this.log.trace({ isVisible }, 'Setting clone brush line visibility');
    this.konva.group.visible(isVisible);
  }

  destroy = () => {
    this.log.debug('Destroying clone brush line module');
    this._dabMaskCanvas = null;
    this._dabCanvas = null;
    this._dabCtx = null;
    this._sourceSnapshot = null;
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
