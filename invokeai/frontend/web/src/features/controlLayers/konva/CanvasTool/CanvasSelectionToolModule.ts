import { rgbaColorToString } from 'common/util/colorCodeTransformers';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type { CanvasToolModule } from 'features/controlLayers/konva/CanvasTool/CanvasToolModule';
import { canvasToBlob, getPrefixedId, loadImage } from 'features/controlLayers/konva/util';
import type { SelectionFeatherDirection, SelectionMode } from 'features/controlLayers/store/canvasSettingsSlice';
import type { Coordinate, Rect, RgbaColor } from 'features/controlLayers/store/types';
import { imageDTOToImageObject } from 'features/controlLayers/store/util';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { atom } from 'nanostores';
import type { Logger } from 'roarr';
import { uploadImage } from 'services/api/endpoints/images';

/**
 * Configuration constants for the selection tool.
 */
type CanvasSelectionToolModuleConfig = {
  /** Marching ants dash length in pixels */
  DASH_LENGTH: number;
  /** Marching ants gap length in pixels */
  GAP_LENGTH: number;
  /** Marching ants animation speed (pixels per frame) */
  MARCH_SPEED: number;
  /** Minimum selection size to be considered valid */
  MIN_SELECTION_SIZE: number;
  /** Marching ants line width in screen pixels */
  LINE_WIDTH: number;
};

const DEFAULT_CONFIG: CanvasSelectionToolModuleConfig = {
  DASH_LENGTH: 6,
  GAP_LENGTH: 6,
  MARCH_SPEED: 0.5,
  MIN_SELECTION_SIZE: 2,
  LINE_WIDTH: 1,
};

/**
 * CanvasSelectionToolModule handles ephemeral selection overlays on the canvas.
 *
 * Unlike drawing tools (brush, rect, gradient), selections are NOT persistent canvas objects.
 * They are ephemeral overlays rendered by this module's own Konva group. Selection operations
 * (fill, delete) produce standard canvas objects clipped to the selection.
 *
 * Supports three shape modes: rectangle, ellipse, and lasso (freehand).
 */
export class CanvasSelectionToolModule extends CanvasModuleBase {
  readonly type = 'selection_tool';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasToolModule;
  readonly manager: CanvasManager;
  readonly log: Logger;

  config: CanvasSelectionToolModuleConfig = DEFAULT_CONFIG;

  // --- Nanostore atoms for ephemeral selection state ---

  /** Binary selection mask (off-screen canvas, alpha channel = selection) */
  $selectionMask = atom<HTMLCanvasElement | null>(null);
  /** Feathered version of the selection mask */
  $featheredMask = atom<HTMLCanvasElement | null>(null);
  /** Bounding rect of the selection in stage-relative coordinates */
  $selectionBounds = atom<Rect | null>(null);
  /** Whether the user is currently drawing a selection shape */
  $isDrawing = atom<boolean>(false);
  /** Start point for rect/ellipse mode */
  $drawOrigin = atom<Coordinate | null>(null);
  /** Point array for lasso mode [x1, y1, x2, y2, ...] */
  $lassoPoints = atom<number[]>([]);
  /** Whether ctrl is held (constrain to square/circle) */
  $ctrlHeld = atom<boolean>(false);
  /** Current combine mode based on held modifiers at draw start */
  $combineMode = atom<'replace' | 'add' | 'subtract'>('replace');
  /** Stashed previous mask for add/subtract compositing */
  $previousMask = atom<HTMLCanvasElement | null>(null);
  /** Whether the current selection is a composite (from add/subtract) */
  $isComposite = atom<boolean>(false);

  /** Animation frame ID for marching ants */
  private marchingAntsAnimId: number | null = null;
  /** Current dash offset for marching ants animation */
  private dashOffset = 0;
  /** Track last settings for reactivity */
  private _lastFeatherRadius = 0;
  private _lastFeatherDirection: SelectionFeatherDirection = 'both';
  private _lastOverlayOpacity = 0.5;
  private _lastOverlayColor = { r: 160, g: 32, b: 240 };
  /** Cached signed distance transform (reused when only radius/direction changes) */
  private _cachedSdt: Float32Array | null = null;
  private _cachedSdtWidth = 0;
  private _cachedSdtHeight = 0;
  /** The mask identity that the cached SDT was computed from */
  private _cachedSdtMask: HTMLCanvasElement | null = null;
  /** Unsubscribe from Redux store */
  private unsubscribeStore: (() => void) | null = null;

  konva: {
    group: Konva.Group;
    /** Shape outline while drawing (dashed preview) */
    preview: Konva.Shape;
    /** Marching ants around finalized selection */
    marchingAnts: Konva.Shape;
    /** Semi-transparent overlay showing feathered mask */
    overlay: Konva.Image;
  };

  constructor(parent: CanvasToolModule) {
    super();
    this.id = getPrefixedId(this.type);
    this.parent = parent;
    this.manager = this.parent.manager;
    this.path = this.manager.buildPath(this);
    this.log = this.manager.buildLogger(this);

    this.log.debug('Creating module');

    this.konva = {
      group: new Konva.Group({ name: `${this.type}:group`, listening: false }),
      preview: new Konva.Shape({
        name: `${this.type}:preview`,
        listening: false,
        visible: false,
        sceneFunc: (ctx, shape) => this.drawPreview(ctx, shape),
      }),
      marchingAnts: new Konva.Shape({
        name: `${this.type}:marching_ants`,
        listening: false,
        visible: false,
        sceneFunc: (ctx, shape) => this.drawMarchingAnts(ctx, shape),
      }),
      overlay: new Konva.Image({
        name: `${this.type}:overlay`,
        listening: false,
        visible: false,
        opacity: 0.3,
        image: undefined as unknown as HTMLImageElement,
      }),
    };

    this.konva.group.add(this.konva.overlay, this.konva.preview, this.konva.marchingAnts);

    // Listen for ctrl key state (constrain)
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);

    // Watch feather and overlay settings changes, re-apply when selection exists
    this.unsubscribeStore = this.manager.stateApi.store.subscribe(() => {
      const settings = this.manager.stateApi.getSettings();
      const mask = this.$selectionMask.get();
      if (!mask) {
        return;
      }

      const featherChanged =
        settings.selectionFeatherRadius !== this._lastFeatherRadius ||
        settings.selectionFeatherDirection !== this._lastFeatherDirection;

      const overlayChanged =
        settings.selectionOverlayOpacity !== this._lastOverlayOpacity ||
        settings.selectionOverlayColor.r !== this._lastOverlayColor.r ||
        settings.selectionOverlayColor.g !== this._lastOverlayColor.g ||
        settings.selectionOverlayColor.b !== this._lastOverlayColor.b;

      if (featherChanged) {
        this._lastFeatherRadius = settings.selectionFeatherRadius;
        this._lastFeatherDirection = settings.selectionFeatherDirection;

        if (settings.selectionFeatherRadius > 0) {
          this.applyFeathering(settings.selectionFeatherRadius, settings.selectionFeatherDirection);
        } else {
          this.$featheredMask.set(mask);
          this.updateOverlayPreview();
        }
      } else if (overlayChanged) {
        this._lastOverlayOpacity = settings.selectionOverlayOpacity;
        this._lastOverlayColor = { ...settings.selectionOverlayColor };
        this.updateOverlayPreview();
      }
    });
  }

  syncCursorStyle = () => {
    this.manager.stage.setCursor('crosshair');
  };

  // --- Event Handlers ---

  onStagePointerDown = (e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();
    const isPrimaryPointerDown = this.parent.$isPrimaryPointerDown.get();

    if (!cursorPos || !isPrimaryPointerDown) {
      return;
    }

    // Determine combine mode from modifier keys
    let combineMode: 'replace' | 'add' | 'subtract' = 'replace';
    if (e.evt.shiftKey && this.hasSelection()) {
      combineMode = 'add';
    } else if (e.evt.altKey && this.hasSelection()) {
      combineMode = 'subtract';
    }
    this.$combineMode.set(combineMode);

    if (combineMode !== 'replace') {
      // Stash current raw mask for compositing later
      this.$previousMask.set(this.$selectionMask.get());
      // Stop marching ants during drawing but keep overlay visible so user can see existing selection
      this.stopMarchingAnts();
      if (!this.konva.overlay.visible()) {
        this.updateOverlayPreview();
      }
    } else {
      this.$previousMask.set(null);
      this.clearSelection();
    }

    this.$isDrawing.set(true);
    this.$drawOrigin.set(cursorPos.relative);

    const settings = this.manager.stateApi.getSettings();
    if (settings.selectionMode === 'lasso') {
      this.$lassoPoints.set([cursorPos.relative.x, cursorPos.relative.y]);
    }

    this.konva.preview.visible(true);
  };

  onStagePointerMove = (_e: KonvaEventObject<PointerEvent>) => {
    if (!this.$isDrawing.get()) {
      return;
    }

    const cursorPos = this.parent.$cursorPos.get();
    if (!cursorPos) {
      return;
    }

    const settings = this.manager.stateApi.getSettings();

    if (settings.selectionMode === 'lasso') {
      const points = this.$lassoPoints.get();
      points.push(cursorPos.relative.x, cursorPos.relative.y);
      this.$lassoPoints.set([...points]);
    }

    // Force Konva to re-draw the preview shape
    this.konva.preview.getLayer()?.batchDraw();
  };

  onStagePointerUp = (_e: KonvaEventObject<PointerEvent>) => {
    if (!this.$isDrawing.get()) {
      return;
    }

    this.$isDrawing.set(false);
    this.konva.preview.visible(false);

    const cursorPos = this.parent.$cursorPos.get();
    const origin = this.$drawOrigin.get();
    const settings = this.manager.stateApi.getSettings();
    const combineMode = this.$combineMode.get();
    const previousMask = this.$previousMask.get();

    if (settings.selectionMode === 'lasso') {
      const points = this.$lassoPoints.get();
      if (points.length < 6) {
        // Need at least 3 points for a polygon - restore previous if add/subtract
        if (previousMask) {
          this.restorePreviousMask(previousMask);
        } else {
          this.clearSelection();
        }
        return;
      }
      this.generateLassoMask(points);
    } else if (origin && cursorPos) {
      const rect = this.getSelectionRect(origin, cursorPos.relative, settings.selectionMode === 'rectangle');
      if (
        Math.abs(rect.width) < this.config.MIN_SELECTION_SIZE ||
        Math.abs(rect.height) < this.config.MIN_SELECTION_SIZE
      ) {
        // Too small - restore previous if add/subtract
        if (previousMask) {
          this.restorePreviousMask(previousMask);
        } else {
          this.clearSelection();
        }
        return;
      }
      this.generateShapeMask(rect, settings.selectionMode);
    } else {
      this.clearSelection();
      return;
    }

    // Composite with previous mask if add/subtract
    if (previousMask && combineMode !== 'replace') {
      const newMask = this.$selectionMask.get();
      if (newMask) {
        const composite = this.compositeMasks(previousMask, newMask, combineMode);
        this.invalidateSdtCache();
        this.$selectionMask.set(composite);
        this.$featheredMask.set(composite);
        this.$isComposite.set(true);
        this.updateBoundsFromMask(composite);
      }
      this.$previousMask.set(null);
    }

    // Apply feathering if radius > 0
    if (settings.selectionFeatherRadius > 0) {
      this.applyFeathering(settings.selectionFeatherRadius, settings.selectionFeatherDirection);
    }

    // Always show overlay when selection exists
    this.updateOverlayPreview();

    // Start marching ants
    this.startMarchingAnts();
  };

  // --- Shift key tracking ---

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Control') {
      this.$ctrlHeld.set(true);
      if (this.$isDrawing.get()) {
        this.konva.preview.getLayer()?.batchDraw();
      }
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Control') {
      this.$ctrlHeld.set(false);
      if (this.$isDrawing.get()) {
        this.konva.preview.getLayer()?.batchDraw();
      }
    }
  };

  // --- Drawing Helpers ---

  /**
   * Calculates the selection rect from origin to current cursor position.
   * When shift is held, constrains to a square (for rect mode) or circle (for ellipse mode).
   */
  private getSelectionRect(origin: Coordinate, cursor: Coordinate, _isRectMode: boolean): Rect {
    let width = cursor.x - origin.x;
    let height = cursor.y - origin.y;

    if (this.$ctrlHeld.get()) {
      // Constrain to square/circle
      const maxDim = Math.max(Math.abs(width), Math.abs(height));
      width = maxDim * Math.sign(width || 1);
      height = maxDim * Math.sign(height || 1);
    }

    return {
      x: width >= 0 ? origin.x : origin.x + width,
      y: height >= 0 ? origin.y : origin.y + height,
      width: Math.abs(width),
      height: Math.abs(height),
    };
  }

  // --- Preview Drawing (sceneFunc) ---

  private drawPreview = (ctx: Konva.Context, shape: Konva.Shape) => {
    if (!this.$isDrawing.get()) {
      return;
    }

    const origin = this.$drawOrigin.get();
    const cursorPos = this.parent.$cursorPos.get();
    const settings = this.manager.stateApi.getSettings();

    if (!origin || !cursorPos) {
      return;
    }

    const scale = this.manager.stage.getScale();
    const lineWidth = this.config.LINE_WIDTH / scale;
    const dashLength = this.config.DASH_LENGTH / scale;
    const gapLength = this.config.GAP_LENGTH / scale;

    // Color by combine mode: green=add, red=subtract, blue=replace
    const combineMode = this.$combineMode.get();
    let strokeColor: string;
    let fillColor: string;
    if (combineMode === 'add') {
      strokeColor = 'rgba(0, 200, 0, 0.8)';
      fillColor = 'rgba(0, 200, 0, 0.15)';
    } else if (combineMode === 'subtract') {
      strokeColor = 'rgba(255, 50, 50, 0.8)';
      fillColor = 'rgba(255, 50, 50, 0.15)';
    } else {
      strokeColor = 'rgba(0, 120, 255, 0.8)';
      fillColor = 'rgba(0, 120, 255, 0.1)';
    }

    ctx.setAttr('strokeStyle', strokeColor);
    ctx.setAttr('lineWidth', lineWidth);
    ctx.setAttr('lineDash', [dashLength, gapLength]);
    ctx.setAttr('fillStyle', fillColor);

    if (settings.selectionMode === 'lasso') {
      const points = this.$lassoPoints.get();
      if (points.length < 4) {
        return;
      }
      ctx.beginPath();
      ctx.moveTo(points[0]!, points[1]!);
      for (let i = 2; i < points.length; i += 2) {
        ctx.lineTo(points[i]!, points[i + 1]!);
      }
      ctx.closePath();
      ctx._context.fill();
      ctx._context.stroke();
    } else {
      const rect = this.getSelectionRect(origin, cursorPos.relative, settings.selectionMode === 'rectangle');

      if (settings.selectionMode === 'ellipse') {
        ctx.beginPath();
        const cx = rect.x + rect.width / 2;
        const cy = rect.y + rect.height / 2;
        const rx = rect.width / 2;
        const ry = rect.height / 2;
        ctx._context.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        ctx.closePath();
        ctx._context.fill();
        ctx._context.stroke();
      } else {
        ctx._context.fillRect(rect.x, rect.y, rect.width, rect.height);
        ctx._context.strokeRect(rect.x, rect.y, rect.width, rect.height);
      }
    }

    shape.getLayer()?.batchDraw();
  };

  // --- Mask Generation ---

  /**
   * Generates a binary selection mask for rectangle or ellipse shapes.
   */
  private generateShapeMask(rect: Rect, mode: SelectionMode): void {
    const canvas = document.createElement('canvas');
    const stageSize = this.manager.stage.getSize();
    canvas.width = stageSize.width;
    canvas.height = stageSize.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    // Scale the canvas to match the stage scale
    const scale = this.manager.stage.getScale();
    const stagePos = this.manager.stage.getPosition();

    // Convert stage-relative coords to canvas pixel coords
    const px = rect.x * scale + stagePos.x;
    const py = rect.y * scale + stagePos.y;
    const pw = rect.width * scale;
    const ph = rect.height * scale;

    ctx.fillStyle = 'white';

    if (mode === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(px + pw / 2, py + ph / 2, pw / 2, ph / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillRect(px, py, pw, ph);
    }

    this.invalidateSdtCache();
    this.$selectionMask.set(canvas);
    this.$featheredMask.set(canvas);
    this.$selectionBounds.set(rect);
  }

  /**
   * Generates a binary selection mask for lasso (freehand polygon).
   */
  private generateLassoMask(points: number[]): void {
    const canvas = document.createElement('canvas');
    const stageSize = this.manager.stage.getSize();
    canvas.width = stageSize.width;
    canvas.height = stageSize.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const scale = this.manager.stage.getScale();
    const stagePos = this.manager.stage.getPosition();

    ctx.fillStyle = 'white';
    ctx.beginPath();
    const firstX = points[0]! * scale + stagePos.x;
    const firstY = points[1]! * scale + stagePos.y;
    ctx.moveTo(firstX, firstY);

    for (let i = 2; i < points.length; i += 2) {
      const px = points[i]! * scale + stagePos.x;
      const py = points[i + 1]! * scale + stagePos.y;
      ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill('evenodd');

    // Calculate bounding rect from points (in stage-relative coords)
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < points.length; i += 2) {
      minX = Math.min(minX, points[i]!);
      minY = Math.min(minY, points[i + 1]!);
      maxX = Math.max(maxX, points[i]!);
      maxY = Math.max(maxY, points[i + 1]!);
    }

    this.invalidateSdtCache();
    this.$selectionMask.set(canvas);
    this.$featheredMask.set(canvas);
    this.$selectionBounds.set({
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    });
  }

  // --- Marching Ants ---

  private drawMarchingAnts = (ctx: Konva.Context, _shape: Konva.Shape) => {
    const bounds = this.$selectionBounds.get();
    const mask = this.$selectionMask.get();
    if (!bounds || !mask) {
      return;
    }

    const settings = this.manager.stateApi.getSettings();
    const scale = this.manager.stage.getScale();
    const lineWidth = this.config.LINE_WIDTH / scale;
    const dashLength = this.config.DASH_LENGTH / scale;
    const gapLength = this.config.GAP_LENGTH / scale;

    // For composite selections (add/subtract), draw bounding rect with overlay showing exact shape
    if (this.$isComposite.get()) {
      ctx.beginPath();
      ctx._context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
      ctx.closePath();

      ctx.setAttr('strokeStyle', 'black');
      ctx.setAttr('lineWidth', lineWidth);
      ctx.setAttr('lineDash', [dashLength, gapLength]);
      ctx.setAttr('lineDashOffset', this.dashOffset / scale);
      ctx._context.stroke();

      ctx.setAttr('strokeStyle', 'white');
      ctx.setAttr('lineDashOffset', (this.dashOffset + dashLength) / scale);
      ctx._context.stroke();
      return;
    }

    // Draw marching ants based on selection mode
    if (settings.selectionMode === 'lasso') {
      const points = this.$lassoPoints.get();
      if (points.length < 4) {
        return;
      }

      ctx.beginPath();
      ctx.moveTo(points[0]!, points[1]!);
      for (let i = 2; i < points.length; i += 2) {
        ctx.lineTo(points[i]!, points[i + 1]!);
      }
      ctx.closePath();

      // Black dashes
      ctx.setAttr('strokeStyle', 'black');
      ctx.setAttr('lineWidth', lineWidth);
      ctx.setAttr('lineDash', [dashLength, gapLength]);
      ctx.setAttr('lineDashOffset', this.dashOffset / scale);
      ctx._context.stroke();

      // White dashes (offset for contrast)
      ctx.setAttr('strokeStyle', 'white');
      ctx.setAttr('lineDashOffset', (this.dashOffset + dashLength) / scale);
      ctx._context.stroke();
    } else {
      // Rectangle or ellipse
      if (settings.selectionMode === 'ellipse') {
        ctx.beginPath();
        const cx = bounds.x + bounds.width / 2;
        const cy = bounds.y + bounds.height / 2;
        const rx = bounds.width / 2;
        const ry = bounds.height / 2;
        ctx._context.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        ctx.closePath();
      } else {
        ctx.beginPath();
        ctx._context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
        ctx.closePath();
      }

      // Black dashes
      ctx.setAttr('strokeStyle', 'black');
      ctx.setAttr('lineWidth', lineWidth);
      ctx.setAttr('lineDash', [dashLength, gapLength]);
      ctx.setAttr('lineDashOffset', this.dashOffset / scale);
      ctx._context.stroke();

      // White dashes (offset)
      ctx.setAttr('strokeStyle', 'white');
      ctx.setAttr('lineDashOffset', (this.dashOffset + dashLength) / scale);
      ctx._context.stroke();
    }
  };

  private startMarchingAnts = () => {
    this.stopMarchingAnts();
    this.konva.marchingAnts.visible(true);

    const animate = () => {
      this.dashOffset += this.config.MARCH_SPEED;
      if (this.dashOffset > (this.config.DASH_LENGTH + this.config.GAP_LENGTH) * 2) {
        this.dashOffset = 0;
      }
      this.konva.marchingAnts.getLayer()?.batchDraw();
      this.marchingAntsAnimId = requestAnimationFrame(animate);
    };

    this.marchingAntsAnimId = requestAnimationFrame(animate);
  };

  private stopMarchingAnts = () => {
    if (this.marchingAntsAnimId !== null) {
      cancelAnimationFrame(this.marchingAntsAnimId);
      this.marchingAntsAnimId = null;
    }
    this.dashOffset = 0;
    this.konva.marchingAnts.visible(false);
  };

  // --- Feathering (SDT-based) ---

  /**
   * Applies feathering to the selection mask using a Signed Distance Transform.
   * The SDT is computed in a Web Worker and cached — changing radius/direction
   * only re-evaluates the falloff function (instant).
   *
   * Falloff formulas (positive sdt = inside, negative = outside):
   * - Inward:  alpha = smoothstep(0, R, sdt)      — edge=0, R inward=1
   * - Outward: alpha = smoothstep(-R, 0, sdt)      — R outward=0, edge=1
   * - Both:    alpha = smoothstep(-R/2, R/2, sdt)  — R/2 out=0, edge=0.5, R/2 in=1
   */
  applyFeathering = (radius: number, direction: SelectionFeatherDirection): void => {
    const mask = this.$selectionMask.get();
    if (!mask || radius <= 0) {
      return;
    }

    // If the SDT is cached for this exact mask, re-evaluate the falloff directly
    if (this._cachedSdt && this._cachedSdtMask === mask) {
      this.applyFalloff(this._cachedSdt, this._cachedSdtWidth, this._cachedSdtHeight, radius, direction);
      return;
    }

    // Otherwise, compute the SDT in the worker
    const ctx = mask.getContext('2d');
    if (!ctx) {
      return;
    }

    const imageData = ctx.getImageData(0, 0, mask.width, mask.height);
    const bufferCopy = imageData.data.buffer.slice(0);

    this.manager.worker.requestSdt(
      { buffer: bufferCopy, width: mask.width, height: mask.height },
      (sdt, width, height) => {
        // Cache the SDT for instant re-evaluation when slider changes
        this._cachedSdt = sdt;
        this._cachedSdtWidth = width;
        this._cachedSdtHeight = height;
        this._cachedSdtMask = mask;

        // Read current settings (may have changed while worker was computing)
        const settings = this.manager.stateApi.getSettings();
        this.applyFalloff(sdt, width, height, settings.selectionFeatherRadius, settings.selectionFeatherDirection);
      }
    );
  };

  /**
   * Evaluates the SDT falloff and produces the feathered mask canvas.
   * This is the fast path — no worker needed, just per-pixel alpha computation.
   */
  private applyFalloff(
    sdt: Float32Array,
    width: number,
    height: number,
    radius: number,
    direction: SelectionFeatherDirection
  ): void {
    const result = document.createElement('canvas');
    result.width = width;
    result.height = height;
    const ctx = result.getContext('2d');
    if (!ctx) {
      return;
    }

    const imageData = ctx.createImageData(width, height);
    const data = imageData.data;

    // Determine the smoothstep range based on direction
    let edge0: number;
    let edge1: number;
    if (direction === 'inward') {
      edge0 = 0;
      edge1 = radius;
    } else if (direction === 'outward') {
      edge0 = -radius;
      edge1 = 0;
    } else {
      // both
      edge0 = -radius / 2;
      edge1 = radius / 2;
    }

    const range = edge1 - edge0;
    const size = width * height;

    for (let i = 0; i < size; i++) {
      const d = sdt[i]!;
      let t: number;
      if (range === 0) {
        t = d >= 0 ? 1 : 0;
      } else {
        t = (d - edge0) / range;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      // Smoothstep: t * t * (3 - 2 * t)
      const alpha = t * t * (3 - 2 * t);
      // Write white pixel with computed alpha
      const idx = i * 4;
      data[idx] = 255;
      data[idx + 1] = 255;
      data[idx + 2] = 255;
      data[idx + 3] = Math.round(alpha * 255);
    }

    ctx.putImageData(imageData, 0, 0);
    this.$featheredMask.set(result);
    this.updateOverlayPreview();
  }

  /**
   * Invalidates the cached SDT. Called when the selection mask changes.
   */
  private invalidateSdtCache(): void {
    this._cachedSdt = null;
    this._cachedSdtMask = null;
    this._cachedSdtWidth = 0;
    this._cachedSdtHeight = 0;
  }

  /**
   * Shows a semi-transparent colored overlay of the selection mask so the user can see
   * the selection area and feathered edges. Color and opacity are read from settings.
   */
  updateOverlayPreview = (): void => {
    const feathered = this.$featheredMask.get() ?? this.$selectionMask.get();
    if (!feathered) {
      this.konva.overlay.visible(false);
      return;
    }

    const settings = this.manager.stateApi.getSettings();
    const { r, g, b } = settings.selectionOverlayColor;

    // Create a tinted version of the mask
    const overlay = document.createElement('canvas');
    overlay.width = feathered.width;
    overlay.height = feathered.height;
    const ctx = overlay.getContext('2d');
    if (!ctx) {
      return;
    }

    // Draw the mask
    ctx.drawImage(feathered, 0, 0);
    // Tint using source-in compositing
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, overlay.width, overlay.height);

    const img = new Image();
    img.onload = () => {
      const stagePos = this.manager.stage.getPosition();
      const scale = this.manager.stage.getScale();
      this.konva.overlay.setAttrs({
        image: img,
        x: -stagePos.x / scale,
        y: -stagePos.y / scale,
        width: overlay.width / scale,
        height: overlay.height / scale,
        opacity: settings.selectionOverlayOpacity,
        visible: true,
      });
      this.konva.overlay.getLayer()?.batchDraw();
    };
    img.src = overlay.toDataURL();
  };

  // --- Selection Operations ---

  /**
   * Returns true if there is an active selection.
   */
  hasSelection = (): boolean => {
    return this.$selectionMask.get() !== null;
  };

  /**
   * Fills the selected area with the current brush color.
   * Rasterizes the entity first, then adds the fill as a second image via the buffer renderer.
   */
  fillSelection = async (): Promise<void> => {
    const mask = this.$featheredMask.get() ?? this.$selectionMask.get();
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!mask || !selectedEntity) {
      return;
    }

    const color = this.manager.stateApi.getCurrentColor();
    const scale = this.manager.stage.getScale();
    const stagePos = this.manager.stage.getPosition();

    // Step 1: Rasterize entity to consolidate all objects into a single image at known position
    const rect = selectedEntity.transformer.getRelativeRect();
    await selectedEntity.renderer.rasterize({ rect, replaceObjects: true });

    // Step 2: Create fill canvas matching the entity's rect dimensions
    const fillCanvas = document.createElement('canvas');
    fillCanvas.width = Math.max(1, Math.round(rect.width));
    fillCanvas.height = Math.max(1, Math.round(rect.height));
    const ctx = fillCanvas.getContext('2d');
    if (!ctx) {
      return;
    }

    // Step 3: Create the color-masked fill at screen resolution
    const colorMask = this.createFilledMask(mask, color);
    if (!colorMask) {
      return;
    }

    // Step 4: Draw the color mask at the correct entity-relative offset
    // Screen pixel (0,0) maps to stage-relative (-stagePos.x/scale, -stagePos.y/scale)
    // Entity space starts at rect.x, rect.y in stage-relative space
    const offsetX = -stagePos.x / scale - rect.x;
    const offsetY = -stagePos.y / scale - rect.y;
    ctx.drawImage(colorMask, offsetX, offsetY, colorMask.width / scale, colorMask.height / scale);

    // Step 5: Upload the fill canvas
    const blob = await canvasToBlob(fillCanvas);
    const imageDTO = await uploadImage({
      file: new File([blob], 'selection_fill.png', { type: 'image/png' }),
      image_category: 'other',
      is_intermediate: true,
      silent: true,
    });
    const imageObject = imageDTOToImageObject(imageDTO);

    // Step 6: Add via buffer renderer pipeline (handles Konva + Redux)
    await selectedEntity.bufferRenderer.setBuffer(imageObject);
    selectedEntity.bufferRenderer.commitBuffer();

    this.clearSelection();
  };

  /**
   * Deletes (erases) pixels within the selection area.
   * Rasterizes the entity, composites the deletion, then replaces the entity.
   */
  deleteSelection = async (): Promise<void> => {
    const mask = this.$featheredMask.get() ?? this.$selectionMask.get();
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!mask || !selectedEntity) {
      return;
    }

    const scale = this.manager.stage.getScale();
    const stagePos = this.manager.stage.getPosition();

    // Step 1: Rasterize entity without replacing to get current state as ImageDTO
    const rect = selectedEntity.transformer.getRelativeRect();
    const existingImageDTO = await selectedEntity.renderer.rasterize({ rect, replaceObjects: false });

    // Step 2: Load the rasterized image
    const existingImg = await loadImage(existingImageDTO.image_url);

    // Step 3: Create composite canvas and draw existing entity
    const composite = document.createElement('canvas');
    composite.width = Math.max(1, Math.round(rect.width));
    composite.height = Math.max(1, Math.round(rect.height));
    const ctx = composite.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.drawImage(existingImg, 0, 0, composite.width, composite.height);

    // Step 4: Erase the selection area using destination-out
    // Transform the selection mask from screen coords to entity-relative coords
    const offsetX = -stagePos.x / scale - rect.x;
    const offsetY = -stagePos.y / scale - rect.y;
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(mask, offsetX, offsetY, mask.width / scale, mask.height / scale);

    // Step 5: Upload the composite
    const blob = await canvasToBlob(composite);
    const imageDTO = await uploadImage({
      file: new File([blob], 'selection_delete.png', { type: 'image/png' }),
      image_category: 'other',
      is_intermediate: true,
      silent: true,
    });
    const imageObject = imageDTOToImageObject(imageDTO);

    // Step 6: Replace entity with composite (Konva + Redux)
    await selectedEntity.bufferRenderer.setBuffer(imageObject);
    selectedEntity.bufferRenderer.commitBuffer({ pushToState: false });
    this.manager.stateApi.rasterizeEntity({
      entityIdentifier: selectedEntity.entityIdentifier,
      imageObject,
      position: { x: Math.round(rect.x), y: Math.round(rect.y) },
      replaceObjects: true,
    });

    this.clearSelection();
  };

  /**
   * Inverts the current selection (flips alpha channel).
   */
  invertSelection = (): void => {
    const mask = this.$selectionMask.get();
    if (!mask) {
      return;
    }

    const ctx = mask.getContext('2d');
    if (!ctx) {
      return;
    }

    const imageData = ctx.getImageData(0, 0, mask.width, mask.height);
    const data = imageData.data;
    for (let i = 3; i < data.length; i += 4) {
      data[i] = 255 - data[i]!;
    }
    ctx.putImageData(imageData, 0, 0);
    this.invalidateSdtCache();

    // Update feathered mask
    const settings = this.manager.stateApi.getSettings();
    if (settings.selectionFeatherRadius > 0) {
      this.applyFeathering(settings.selectionFeatherRadius, settings.selectionFeatherDirection);
    } else {
      this.$featheredMask.set(mask);
    }

    // Update bounds to full stage
    const stageSize = this.manager.stage.getSize();
    const scale = this.manager.stage.getScale();
    const stagePos = this.manager.stage.getPosition();
    this.$selectionBounds.set({
      x: -stagePos.x / scale,
      y: -stagePos.y / scale,
      width: stageSize.width / scale,
      height: stageSize.height / scale,
    });

    // Refresh marching ants
    this.konva.marchingAnts.getLayer()?.batchDraw();
  };

  /**
   * Clears the selection - called on tool change or deselect.
   */
  clearSelection = (): void => {
    this.invalidateSdtCache();
    this.$selectionMask.set(null);
    this.$featheredMask.set(null);
    this.$selectionBounds.set(null);
    this.$isDrawing.set(false);
    this.$drawOrigin.set(null);
    this.$lassoPoints.set([]);
    this.$combineMode.set('replace');
    this.$previousMask.set(null);
    this.$isComposite.set(false);

    this.stopMarchingAnts();
    this.konva.preview.visible(false);
    this.konva.overlay.visible(false);
  };

  // --- Utility Methods ---

  /**
   * Composites two masks together using the specified mode.
   * Add = union (source-over), subtract = erase (destination-out).
   */
  private compositeMasks(
    previous: HTMLCanvasElement,
    current: HTMLCanvasElement,
    mode: 'add' | 'subtract'
  ): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = previous.width;
    canvas.height = previous.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return previous;
    }

    if (mode === 'add') {
      ctx.drawImage(previous, 0, 0);
      ctx.drawImage(current, 0, 0);
    } else {
      ctx.drawImage(previous, 0, 0);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(current, 0, 0);
    }

    return canvas;
  }

  /**
   * Updates $selectionBounds by scanning the mask for actual non-zero alpha pixel bounds.
   */
  private updateBoundsFromMask(mask: HTMLCanvasElement): void {
    const ctx = mask.getContext('2d');
    if (!ctx) {
      return;
    }

    const imageData = ctx.getImageData(0, 0, mask.width, mask.height);
    const data = imageData.data;
    const w = mask.width;
    const h = mask.height;

    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const alpha = data[(y * w + x) * 4 + 3]!;
        if (alpha > 0) {
          if (x < minX) {
            minX = x;
          }
          if (y < minY) {
            minY = y;
          }
          if (x > maxX) {
            maxX = x;
          }
          if (y > maxY) {
            maxY = y;
          }
        }
      }
    }

    if (minX > maxX || minY > maxY) {
      this.clearSelection();
      return;
    }

    const scale = this.manager.stage.getScale();
    const stagePos = this.manager.stage.getPosition();

    this.$selectionBounds.set({
      x: (minX - stagePos.x) / scale,
      y: (minY - stagePos.y) / scale,
      width: (maxX - minX + 1) / scale,
      height: (maxY - minY + 1) / scale,
    });
  }

  /**
   * Restores a previously stashed mask when an add/subtract draw gesture is canceled
   * (e.g., drawn shape too small or too few lasso points).
   */
  private restorePreviousMask(mask: HTMLCanvasElement): void {
    this.invalidateSdtCache();
    this.$selectionMask.set(mask);
    this.$featheredMask.set(mask);
    this.$previousMask.set(null);

    const settings = this.manager.stateApi.getSettings();
    if (settings.selectionFeatherRadius > 0) {
      this.applyFeathering(settings.selectionFeatherRadius, settings.selectionFeatherDirection);
    }

    this.updateOverlayPreview();
    this.startMarchingAnts();
  }

  /**
   * Creates a filled canvas masked by the selection.
   */
  private createFilledMask(mask: HTMLCanvasElement, color: RgbaColor): HTMLCanvasElement | null {
    const canvas = document.createElement('canvas');
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
    }

    // Fill with the color
    ctx.fillStyle = rgbaColorToString(color);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Apply mask as alpha
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(mask, 0, 0);

    return canvas;
  }

  render = () => {
    // The selection tool renders itself via sceneFunc callbacks
    // This method is called when the parent tool module renders
    if (this.parent.$tool.get() !== 'selection') {
      this.konva.group.visible(false);
      return;
    }
    this.konva.group.visible(true);
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      config: this.config,
      hasSelection: this.hasSelection(),
      isDrawing: this.$isDrawing.get(),
      selectionBounds: this.$selectionBounds.get(),
    };
  };

  destroy = () => {
    this.log.debug('Destroying module');
    this.clearSelection();
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    this.unsubscribeStore?.();
    this.konva.group.destroy();
  };
}
