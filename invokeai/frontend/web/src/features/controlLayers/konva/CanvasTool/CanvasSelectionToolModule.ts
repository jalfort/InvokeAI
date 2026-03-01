import { rgbaColorToString } from 'common/util/colorCodeTransformers';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type { CanvasToolModule } from 'features/controlLayers/konva/CanvasTool/CanvasToolModule';
import { getPatternSVG } from 'features/controlLayers/konva/patterns/getPatternSVG';
import { canvasToBlob, getPrefixedId, loadImage } from 'features/controlLayers/konva/util';
import type { SelectionFeatherDirection, SelectionMode } from 'features/controlLayers/store/canvasSettingsSlice';
import type { Coordinate, Rect, RgbaColor, RgbColor } from 'features/controlLayers/store/types';
import { imageDTOToImageObject } from 'features/controlLayers/store/util';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { atom } from 'nanostores';
import type { Logger } from 'roarr';
import { uploadImage } from 'services/api/endpoints/images';

/**
 * A single sub-selection entry in the stack. Each draw operation creates one.
 * Feathering settings are captured at draw time and stored per-entry.
 */
interface SubSelection {
  binaryMask: HTMLCanvasElement;
  featherRadius: number;
  featherDirection: SelectionFeatherDirection;
  combineMode: 'replace' | 'add' | 'subtract';
  featheredMask: HTMLCanvasElement | null; // null = use binaryMask (feather=0)
  cachedSdt: Float32Array | null;
  cachedSdtWidth: number;
  cachedSdtHeight: number;
  selectionMode: SelectionMode; // for marching ants shape
  lassoPoints: number[] | null; // for lasso/polygon marching ants
  bounds: Rect;
}

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
  MARCH_SPEED: 0.25,
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
 * Uses a sub-selection stack architecture where each draw operation is an independent entry
 * with its own feather settings. The feather slider only affects the most recent entry.
 *
 * Supports four shape modes: rectangle, ellipse, lasso (freehand), and polygon (click-to-place).
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

  /** Binary selection mask (off-screen canvas, alpha channel = selection) — derived from stack */
  $selectionMask = atom<HTMLCanvasElement | null>(null);
  /** Feathered version of the selection mask — derived from stack */
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
  /** Whether C is held (draw from center) */
  $centerHeld = atom<boolean>(false);
  /** Current combine mode based on held modifiers at draw start */
  $combineMode = atom<'replace' | 'add' | 'subtract'>('replace');
  /** Committed polygon vertices [x1, y1, x2, y2, ...] */
  $polygonVertices = atom<number[]>([]);
  /** Whether a polygon is in-progress (vertices placed but not closed) */
  $polygonInProgress = atom<boolean>(false);
  /** Sub-mode: 'draw' (default) or 'move' (translate selection mask) */
  $selectionSubMode = atom<'draw' | 'move'>('draw');
  /** Sub-selection stack — source of truth for all selection state */
  $subSelections = atom<SubSelection[]>([]);
  /** Whether S key is held (for S+scroll feather radius) */
  $sKeyHeld = atom<boolean>(false);

  /** Animation frame ID for marching ants */
  private marchingAntsAnimId: number | null = null;
  /** Current dash offset for marching ants animation */
  private dashOffset = 0;
  /** Track last settings for reactivity */
  private _lastFeatherRadius = 0;
  private _lastFeatherDirection: SelectionFeatherDirection = 'both';
  private _lastOverlayOpacity = 0.5;
  private _lastOverlayColor = { r: 220, g: 40, b: 40 };
  /** Committed composite cache: binary composite of entries [0..n-2] */
  private _committedBinaryComposite: HTMLCanvasElement | null = null;
  /** Committed composite cache: feathered composite of entries [0..n-2] */
  private _committedFeatheredComposite: HTMLCanvasElement | null = null;
  /** Number of entries in the committed composite cache */
  private _committedCompositeCount = 0;
  /** Timestamp of last pointerDown for polygon double-click detection */
  private _lastClickTime = 0;
  /** Position of last pointerDown for polygon double-click detection */
  private _lastClickPos: Coordinate | null = null;
  /** Double-click threshold in ms */
  private static readonly DOUBLE_CLICK_TIME = 300;
  /** Double-click distance threshold in stage pixels */
  private static readonly DOUBLE_CLICK_DIST = 5;
  /** Move sub-mode: start position of the drag */
  private _moveStartPos: Coordinate | null = null;
  /** Move sub-mode: original bounds snapshot at drag start */
  private _moveOriginalBounds: Rect | null = null;
  /** Move sub-mode: original binary mask snapshot at drag start */
  private _moveOriginalMask: HTMLCanvasElement | null = null;
  /** Move sub-mode: original feathered mask snapshot at drag start */
  private _moveOriginalFeathered: HTMLCanvasElement | null = null;
  /** Cached diagonal hatching pattern image for overlay */
  private _patternImage: HTMLImageElement | null = null;
  /** Last color used for the cached pattern image */
  private _patternColor: RgbColor | null = null;
  /** Unsubscribe from Redux store */
  private unsubscribeStore: (() => void) | null = null;
  /** Guard against concurrent fill/delete operations */
  private _isOperationInProgress = false;

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

    // Watch feather and overlay settings changes, re-apply to latest stack entry
    this.unsubscribeStore = this.manager.stateApi.store.subscribe(() => {
      const settings = this.manager.stateApi.getSettings();
      const stack = this.$subSelections.get();
      if (stack.length === 0) {
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
        this.refeatherLatestEntry(settings.selectionFeatherRadius, settings.selectionFeatherDirection);
      } else if (overlayChanged) {
        this._lastOverlayOpacity = settings.selectionOverlayOpacity;
        this._lastOverlayColor = { ...settings.selectionOverlayColor };
        this.updateOverlayPreview();
      }
    });
  }

  syncCursorStyle = () => {
    if (this.$selectionSubMode.get() === 'move' && this.hasSelection()) {
      this.manager.stage.setCursor('move');
    } else {
      this.manager.stage.setCursor('crosshair');
    }
  };

  // --- Event Handlers ---

  onStagePointerDown = (e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();

    const isPrimaryPointerDown = this.parent.$isPrimaryPointerDown.get();

    if (!cursorPos || !isPrimaryPointerDown) {
      return;
    }

    // --- Move sub-mode: start drag to translate the selection mask ---
    if (this.$selectionSubMode.get() === 'move' && this.hasSelection()) {
      this._moveStartPos = { ...cursorPos.relative };
      this._moveOriginalBounds = this.$selectionBounds.get() ? { ...this.$selectionBounds.get()! } : null;
      // Snapshot masks so we can draw from originals on each move
      this._moveOriginalMask = this.$selectionMask.get();
      this._moveOriginalFeathered = this.$featheredMask.get();
      this.$isDrawing.set(true);
      return;
    }

    const settings = this.manager.stateApi.getSettings();

    // --- Polygon mode: click-to-place vertices ---
    if (settings.selectionMode === 'polygon') {
      const now = Date.now();
      const lastPos = this._lastClickPos;
      const timeDelta = now - this._lastClickTime;
      const scale = this.manager.stage.getScale();

      // Double-click detection: close polygon
      if (
        lastPos &&
        timeDelta < CanvasSelectionToolModule.DOUBLE_CLICK_TIME &&
        Math.hypot(cursorPos.relative.x - lastPos.x, cursorPos.relative.y - lastPos.y) <
          CanvasSelectionToolModule.DOUBLE_CLICK_DIST / scale
      ) {
        this.closePolygon();
        this._lastClickTime = 0;
        this._lastClickPos = null;
        return;
      }

      this._lastClickTime = now;
      this._lastClickPos = { ...cursorPos.relative };

      // On first vertex: determine combine mode
      if (!this.$polygonInProgress.get()) {
        let combineMode: 'replace' | 'add' | 'subtract' = 'replace';
        if (e.evt.shiftKey && this.hasSelection()) {
          combineMode = 'add';
        } else if (e.evt.altKey && this.hasSelection()) {
          combineMode = 'subtract';
        }
        this.$combineMode.set(combineMode);

        if (combineMode !== 'replace') {
          // Keep overlay visible, stop ants during drawing
          this.stopMarchingAnts();
          if (!this.konva.overlay.visible()) {
            this.updateOverlayPreview();
          }
        } else {
          this.clearSelection();
        }
      }

      // Click-on-first-vertex detection: close polygon if clicking near the first point
      const vertices = this.$polygonVertices.get();
      if (vertices.length >= 6) {
        // At least 3 vertices needed to close
        const firstX = vertices[0]!;
        const firstY = vertices[1]!;
        const dist = Math.hypot(cursorPos.relative.x - firstX, cursorPos.relative.y - firstY);
        // 6px hitbox radius, scaled to canvas zoom
        if (dist < 6 / scale) {
          this.closePolygon();
          this._lastClickTime = 0;
          this._lastClickPos = null;
          return;
        }
      }

      // Place vertex
      vertices.push(cursorPos.relative.x, cursorPos.relative.y);
      this.$polygonVertices.set([...vertices]);
      this.$polygonInProgress.set(true);
      this.$isDrawing.set(true);
      this.konva.preview.visible(true);
      this.konva.preview.getLayer()?.batchDraw();
      return;
    }

    // --- Standard modes: rectangle, ellipse, lasso ---

    // Determine combine mode from modifier keys
    let combineMode: 'replace' | 'add' | 'subtract' = 'replace';
    if (e.evt.shiftKey && this.hasSelection()) {
      combineMode = 'add';
    } else if (e.evt.altKey && this.hasSelection()) {
      combineMode = 'subtract';
    }
    this.$combineMode.set(combineMode);

    if (combineMode !== 'replace') {
      // Keep overlay visible, stop ants during drawing
      this.stopMarchingAnts();
      if (!this.konva.overlay.visible()) {
        this.updateOverlayPreview();
      }
    } else {
      this.clearSelection();
    }

    this.$isDrawing.set(true);
    this.$drawOrigin.set(cursorPos.relative);

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

    // --- Move sub-mode: translate the selection mask ---
    if (this.$selectionSubMode.get() === 'move' && this._moveStartPos && this._moveOriginalBounds) {
      const dx = cursorPos.relative.x - this._moveStartPos.x;
      const dy = cursorPos.relative.y - this._moveStartPos.y;
      this.translateMasks(dx, dy);
      return;
    }

    const settings = this.manager.stateApi.getSettings();

    // Polygon: no point accumulation during move, just rubber-band redraw
    if (settings.selectionMode === 'polygon') {
      this.konva.preview.getLayer()?.batchDraw();
      return;
    }

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

    // --- Move sub-mode: finalize translation ---
    if (this.$selectionSubMode.get() === 'move') {
      this.$isDrawing.set(false);

      // Flatten stack to a single entry with translated masks
      const mask = this.$selectionMask.get();
      const feathered = this.$featheredMask.get();
      const bounds = this.$selectionBounds.get();
      if (mask && bounds) {
        const entry: SubSelection = {
          binaryMask: mask,
          featherRadius: 0,
          featherDirection: 'both',
          combineMode: 'replace',
          featheredMask: feathered !== mask ? feathered : null,
          cachedSdt: null,
          cachedSdtWidth: 0,
          cachedSdtHeight: 0,
          selectionMode: 'rectangle',
          lassoPoints: null,
          bounds,
        };
        this.$subSelections.set([entry]);
        this._committedBinaryComposite = null;
        this._committedFeatheredComposite = null;
        this._committedCompositeCount = 0;
      }

      this._moveStartPos = null;
      this._moveOriginalBounds = null;
      this._moveOriginalMask = null;
      this._moveOriginalFeathered = null;
      return;
    }

    const settings = this.manager.stateApi.getSettings();

    // Polygon mode: no-op on pointer up (vertices placed by click, closed by double-click/Enter)
    if (settings.selectionMode === 'polygon') {
      return;
    }

    this.$isDrawing.set(false);
    this.konva.preview.visible(false);

    const cursorPos = this.parent.$cursorPos.get();
    const origin = this.$drawOrigin.get();

    if (settings.selectionMode === 'lasso') {
      const points = this.$lassoPoints.get();
      if (points.length < 6) {
        // Need at least 3 points for a polygon - restore from stack if add/subtract
        if (this.$combineMode.get() !== 'replace' && this.$subSelections.get().length > 0) {
          this.recomputeComposite();
        } else {
          this.clearSelection();
        }
        return;
      }
      const result = this.generateLassoMask(points);
      if (result) {
        this.pushSubSelection(result.canvas, result.bounds, this.$combineMode.get(), 'lasso', [...points]);
      }
    } else if (origin && cursorPos) {
      const rect = this.getSelectionRect(origin, cursorPos.relative, settings.selectionMode === 'rectangle');
      if (
        Math.abs(rect.width) < this.config.MIN_SELECTION_SIZE ||
        Math.abs(rect.height) < this.config.MIN_SELECTION_SIZE
      ) {
        // Too small - restore from stack if add/subtract
        if (this.$combineMode.get() !== 'replace' && this.$subSelections.get().length > 0) {
          this.recomputeComposite();
        } else {
          this.clearSelection();
        }
        return;
      }
      const result = this.generateShapeMask(rect, settings.selectionMode);
      if (result) {
        this.pushSubSelection(result.canvas, result.bounds, this.$combineMode.get(), settings.selectionMode, null);
      }
    } else {
      this.clearSelection();
      return;
    }
  };

  // --- Key Tracking ---

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
      return;
    }

    if (e.key === 'Control') {
      this.$ctrlHeld.set(true);
      if (this.$isDrawing.get()) {
        this.konva.preview.getLayer()?.batchDraw();
      }
    }

    if (e.key === 'c' || e.key === 'C') {
      this.$centerHeld.set(true);
      if (this.$isDrawing.get()) {
        this.konva.preview.getLayer()?.batchDraw();
      }
    }

    // S key tracking for S+scroll feather radius
    if ((e.key === 's' || e.key === 'S') && !e.ctrlKey && !e.metaKey) {
      this.$sKeyHeld.set(true);
    }

    // Polygon: Enter to close, Escape to cancel
    if (this.$polygonInProgress.get()) {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.closePolygon();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.cancelPolygon();
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

    if (e.key === 'c' || e.key === 'C') {
      this.$centerHeld.set(false);
      if (this.$isDrawing.get()) {
        this.konva.preview.getLayer()?.batchDraw();
      }
    }

    if (e.key === 's' || e.key === 'S') {
      this.$sKeyHeld.set(false);
    }
  };

  // --- Sub-Selection Stack Core Methods ---

  /**
   * Pushes a new sub-selection onto the stack with the current feather settings.
   * Replace mode clears the stack; add/subtract append to it.
   */
  private pushSubSelection(
    canvas: HTMLCanvasElement,
    bounds: Rect,
    combineMode: 'replace' | 'add' | 'subtract',
    selectionMode: SelectionMode,
    lassoPoints: number[] | null
  ): void {
    const settings = this.manager.stateApi.getSettings();

    const entry: SubSelection = {
      binaryMask: canvas,
      featherRadius: settings.selectionFeatherRadius,
      featherDirection: settings.selectionFeatherDirection,
      combineMode,
      featheredMask: null,
      cachedSdt: null,
      cachedSdtWidth: 0,
      cachedSdtHeight: 0,
      selectionMode,
      lassoPoints,
      bounds,
    };

    if (combineMode === 'replace') {
      this.$subSelections.set([entry]);
      this._committedBinaryComposite = null;
      this._committedFeatheredComposite = null;
      this._committedCompositeCount = 0;
    } else {
      const stack = this.$subSelections.get();
      this.$subSelections.set([...stack, entry]);
    }

    if (settings.selectionFeatherRadius > 0) {
      this.computeEntryFeathering(entry, () => {
        this.recomputeComposite();
      });
    } else {
      this.recomputeComposite();
    }
  }

  /**
   * Computes feathering for a sub-selection entry via the SDT worker.
   * Caches the SDT on the entry for instant re-feathering.
   */
  private computeEntryFeathering(entry: SubSelection, onComplete: () => void): void {
    const ctx = entry.binaryMask.getContext('2d');
    if (!ctx) {
      onComplete();
      return;
    }

    const imageData = ctx.getImageData(0, 0, entry.binaryMask.width, entry.binaryMask.height);
    const bufferCopy = imageData.data.buffer.slice(0);

    this.manager.worker.requestSdt(
      { buffer: bufferCopy, width: entry.binaryMask.width, height: entry.binaryMask.height },
      (sdt, w, h) => {
        entry.cachedSdt = sdt;
        entry.cachedSdtWidth = w;
        entry.cachedSdtHeight = h;
        // Read current settings (may have changed while worker was computing)
        const settings = this.manager.stateApi.getSettings();
        entry.featherRadius = settings.selectionFeatherRadius;
        entry.featherDirection = settings.selectionFeatherDirection;
        entry.featheredMask = this.buildFeatheredCanvas(sdt, w, h, entry.featherRadius, entry.featherDirection);
        onComplete();
      }
    );
  }

  /**
   * Re-feathers the latest stack entry when the feather slider changes.
   * Uses cached SDT for instant updates; computes SDT if not yet cached.
   */
  private refeatherLatestEntry(radius: number, direction: SelectionFeatherDirection): void {
    const stack = this.$subSelections.get();
    if (stack.length === 0) {
      return;
    }

    const entry = stack[stack.length - 1]!;
    entry.featherRadius = radius;
    entry.featherDirection = direction;

    if (radius === 0) {
      entry.featheredMask = null;
      this.recomputeComposite();
      return;
    }

    if (entry.cachedSdt) {
      // Fast path: SDT already cached
      entry.featheredMask = this.buildFeatheredCanvas(
        entry.cachedSdt,
        entry.cachedSdtWidth,
        entry.cachedSdtHeight,
        radius,
        direction
      );
      this.recomputeComposite();
    } else {
      // Need to compute SDT first
      this.computeEntryFeathering(entry, () => {
        this.recomputeComposite();
      });
    }
  }

  /**
   * Recomputes the composite selection mask from the sub-selection stack.
   * Uses a committed composite cache so only the latest entry needs recompositing
   * when the feather slider changes.
   */
  private recomputeComposite(): void {
    const stack = this.$subSelections.get();

    if (stack.length === 0) {
      this.$selectionMask.set(null);
      this.$featheredMask.set(null);
      this.$selectionBounds.set(null);
      this.stopMarchingAnts();
      this.konva.overlay.visible(false);
      return;
    }

    if (stack.length === 1) {
      const entry = stack[0]!;
      this.$selectionMask.set(entry.binaryMask);
      this.$featheredMask.set(entry.featheredMask ?? entry.binaryMask);
      this.$selectionBounds.set(entry.bounds);
      this._committedBinaryComposite = null;
      this._committedFeatheredComposite = null;
      this._committedCompositeCount = 0;
      this.updateOverlayPreview();
      this.startMarchingAnts();
      return;
    }

    // Multiple entries — compose them using committed cache
    const committedCount = stack.length - 1;
    if (this._committedCompositeCount !== committedCount || !this._committedBinaryComposite) {
      // Rebuild committed composite from scratch
      let binaryComposite = stack[0]!.binaryMask;
      let featheredComposite: HTMLCanvasElement = stack[0]!.featheredMask ?? stack[0]!.binaryMask;

      for (let i = 1; i < committedCount; i++) {
        const entry = stack[i]!;
        const mode = entry.combineMode === 'replace' ? 'add' : entry.combineMode;
        binaryComposite = this.compositeMasks(binaryComposite, entry.binaryMask, mode);
        featheredComposite = this.compositeMasks(featheredComposite, entry.featheredMask ?? entry.binaryMask, mode);
      }

      this._committedBinaryComposite = binaryComposite;
      this._committedFeatheredComposite = featheredComposite;
      this._committedCompositeCount = committedCount;
    }

    // Compose committed cache with latest entry
    const latest = stack[stack.length - 1]!;
    const mode = latest.combineMode === 'replace' ? 'add' : latest.combineMode;
    const finalBinary = this.compositeMasks(this._committedBinaryComposite, latest.binaryMask, mode);
    const finalFeathered = this.compositeMasks(
      this._committedFeatheredComposite!,
      latest.featheredMask ?? latest.binaryMask,
      mode
    );

    this.$selectionMask.set(finalBinary);
    this.$featheredMask.set(finalFeathered);
    this.updateBoundsFromMask(finalBinary);
    this.updateOverlayPreview();
    this.startMarchingAnts();
  }

  /**
   * Removes the last sub-selection from the stack. If only one remains,
   * clears the selection entirely.
   */
  undoLastSubSelection(): void {
    const stack = this.$subSelections.get();
    if (stack.length <= 1) {
      this.clearSelection();
      return;
    }

    const newStack = stack.slice(0, -1);
    this.$subSelections.set(newStack);

    // Invalidate committed cache since the stack changed
    this._committedBinaryComposite = null;
    this._committedFeatheredComposite = null;
    this._committedCompositeCount = 0;

    this.recomputeComposite();
  }

  // --- Drawing Helpers ---

  /**
   * Calculates the selection rect from origin to current cursor position.
   * Supports center-draw (C key) and constrain (Ctrl key) modifiers.
   */
  private getSelectionRect(origin: Coordinate, cursor: Coordinate, _isRectMode: boolean): Rect {
    const isCenter = this.$centerHeld.get();

    if (isCenter) {
      // Origin is center point — expand outward symmetrically
      let halfW = Math.abs(cursor.x - origin.x);
      let halfH = Math.abs(cursor.y - origin.y);

      if (this.$ctrlHeld.get()) {
        // Constrain to square/circle from center
        const maxHalf = Math.max(halfW, halfH);
        halfW = maxHalf;
        halfH = maxHalf;
      }

      return {
        x: origin.x - halfW,
        y: origin.y - halfH,
        width: halfW * 2,
        height: halfH * 2,
      };
    }

    // Corner-to-corner mode (default)
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

    const cursorPos = this.parent.$cursorPos.get();
    const settings = this.manager.stateApi.getSettings();

    if (!cursorPos) {
      return;
    }

    const scale = this.manager.stage.getScale();
    const lineWidth = this.config.LINE_WIDTH / scale;
    const dashLength = this.config.DASH_LENGTH / scale;
    const gapLength = this.config.GAP_LENGTH / scale;

    // Consistent blue outline for all modes
    const combineMode = this.$combineMode.get();
    const strokeColor = 'rgba(0, 120, 255, 0.8)';
    const fillColor = 'rgba(0, 120, 255, 0.1)';

    if (settings.selectionMode === 'polygon') {
      // --- Polygon preview ---
      const vertices = this.$polygonVertices.get();
      if (vertices.length < 2) {
        return;
      }

      // Draw committed edges as solid polyline
      ctx.setAttr('strokeStyle', strokeColor);
      ctx.setAttr('lineWidth', lineWidth);
      ctx._context.setLineDash([]);
      ctx.setAttr('fillStyle', fillColor);

      ctx.beginPath();
      ctx.moveTo(vertices[0]!, vertices[1]!);
      for (let i = 2; i < vertices.length; i += 2) {
        ctx.lineTo(vertices[i]!, vertices[i + 1]!);
      }
      // Close back to first vertex and fill
      ctx.closePath();
      ctx._context.fill();

      // Stroke the committed edges (solid)
      ctx.beginPath();
      ctx.moveTo(vertices[0]!, vertices[1]!);
      for (let i = 2; i < vertices.length; i += 2) {
        ctx.lineTo(vertices[i]!, vertices[i + 1]!);
      }
      ctx._context.stroke();

      // Rubber-band line from last vertex to cursor (dashed)
      const lastX = vertices[vertices.length - 2]!;
      const lastY = vertices[vertices.length - 1]!;
      ctx._context.setLineDash([dashLength, gapLength]);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(cursorPos.relative.x, cursorPos.relative.y);
      ctx._context.stroke();

      // Closing rubber-band from cursor to first vertex (dashed, lighter)
      ctx.setAttr('strokeStyle', 'rgba(0, 120, 255, 0.4)');
      ctx.beginPath();
      ctx.moveTo(cursorPos.relative.x, cursorPos.relative.y);
      ctx.lineTo(vertices[0]!, vertices[1]!);
      ctx._context.stroke();

      // Vertex dots
      ctx._context.setLineDash([]);
      ctx.setAttr('fillStyle', strokeColor);
      for (let i = 0; i < vertices.length; i += 2) {
        ctx.beginPath();
        if (i === 0) {
          // First vertex: larger (4px) with outline stroke — visual "close target"
          const firstDotRadius = 4 / scale;
          ctx._context.arc(vertices[i]!, vertices[i + 1]!, firstDotRadius, 0, Math.PI * 2);
          ctx._context.fill();
          ctx.setAttr('strokeStyle', 'rgba(255, 255, 255, 0.9)');
          ctx.setAttr('lineWidth', 1.5 / scale);
          ctx._context.stroke();
          // Restore stroke for subsequent drawing
          ctx.setAttr('strokeStyle', strokeColor);
          ctx.setAttr('lineWidth', lineWidth);
        } else {
          // Regular vertices: 3px filled dots
          const dotRadius = 3 / scale;
          ctx._context.arc(vertices[i]!, vertices[i + 1]!, dotRadius, 0, Math.PI * 2);
          ctx._context.fill();
        }
      }
    } else {
      const origin = this.$drawOrigin.get();
      if (!origin) {
        return;
      }

      ctx.setAttr('strokeStyle', strokeColor);
      ctx.setAttr('lineWidth', lineWidth);
      ctx._context.setLineDash([dashLength, gapLength]);
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
    }

    // Draw +/- indicator near cursor for add/subtract modes
    if (combineMode !== 'replace') {
      const fontSize = 16 / scale;
      const symbol = combineMode === 'add' ? '+' : '\u2212';
      const indicatorX = cursorPos.relative.x + 12 / scale;
      const indicatorY = cursorPos.relative.y - 4 / scale;

      ctx._context.setLineDash([]);
      // Dark outline for contrast
      ctx.setAttr('font', `bold ${fontSize}px sans-serif`);
      ctx.setAttr('fillStyle', 'rgba(0, 0, 0, 0.7)');
      ctx._context.fillText(symbol, indicatorX + 1 / scale, indicatorY + 1 / scale);

      // White text
      ctx.setAttr('fillStyle', 'white');
      ctx._context.fillText(symbol, indicatorX, indicatorY);
    }

    shape.getLayer()?.batchDraw();
  };

  // --- Mask Generation ---

  /**
   * Generates a binary selection mask for rectangle or ellipse shapes.
   * Returns the mask canvas and bounds without setting any atoms.
   */
  private generateShapeMask(rect: Rect, mode: SelectionMode): { canvas: HTMLCanvasElement; bounds: Rect } | null {
    const canvas = document.createElement('canvas');
    const stageSize = this.manager.stage.getSize();
    canvas.width = stageSize.width;
    canvas.height = stageSize.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
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

    return { canvas, bounds: rect };
  }

  /**
   * Generates a binary selection mask for lasso (freehand polygon).
   * Returns the mask canvas and bounds without setting any atoms.
   */
  private generateLassoMask(points: number[]): { canvas: HTMLCanvasElement; bounds: Rect } | null {
    const canvas = document.createElement('canvas');
    const stageSize = this.manager.stage.getSize();
    canvas.width = stageSize.width;
    canvas.height = stageSize.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return null;
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

    return {
      canvas,
      bounds: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
    };
  }

  // --- Marching Ants ---

  private drawMarchingAnts = (ctx: Konva.Context, _shape: Konva.Shape) => {
    const bounds = this.$selectionBounds.get();
    const mask = this.$selectionMask.get();
    if (!bounds || !mask) {
      return;
    }

    const scale = this.manager.stage.getScale();
    const lineWidth = this.config.LINE_WIDTH / scale;
    const dashLength = this.config.DASH_LENGTH / scale;
    const gapLength = this.config.GAP_LENGTH / scale;

    const stack = this.$subSelections.get();

    // For composite selections (multiple entries), draw bounding rect with overlay showing exact shape
    if (stack.length > 1) {
      ctx.beginPath();
      ctx._context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
      ctx.closePath();

      ctx.setAttr('strokeStyle', 'black');
      ctx.setAttr('lineWidth', lineWidth);
      ctx._context.setLineDash([dashLength, gapLength]);
      ctx._context.lineDashOffset = this.dashOffset / scale;
      ctx._context.stroke();

      ctx.setAttr('strokeStyle', 'white');
      ctx._context.lineDashOffset = (this.dashOffset + dashLength) / scale;
      ctx._context.stroke();
      return;
    }

    // Single entry — draw shape-specific ants from the entry's stored data
    if (stack.length === 1) {
      const entry = stack[0]!;

      if (
        (entry.selectionMode === 'lasso' || entry.selectionMode === 'polygon') &&
        entry.lassoPoints &&
        entry.lassoPoints.length >= 4
      ) {
        ctx.beginPath();
        ctx.moveTo(entry.lassoPoints[0]!, entry.lassoPoints[1]!);
        for (let i = 2; i < entry.lassoPoints.length; i += 2) {
          ctx.lineTo(entry.lassoPoints[i]!, entry.lassoPoints[i + 1]!);
        }
        ctx.closePath();
      } else if (entry.selectionMode === 'ellipse') {
        ctx.beginPath();
        const cx = bounds.x + bounds.width / 2;
        const cy = bounds.y + bounds.height / 2;
        const rx = bounds.width / 2;
        const ry = bounds.height / 2;
        ctx._context.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, 0, Math.PI * 2);
        ctx.closePath();
      } else {
        // Rectangle (also used for moved/inverted selections)
        ctx.beginPath();
        ctx._context.rect(bounds.x, bounds.y, bounds.width, bounds.height);
        ctx.closePath();
      }

      // Black dashes
      ctx.setAttr('strokeStyle', 'black');
      ctx.setAttr('lineWidth', lineWidth);
      ctx._context.setLineDash([dashLength, gapLength]);
      ctx._context.lineDashOffset = this.dashOffset / scale;
      ctx._context.stroke();

      // White dashes (offset for contrast)
      ctx.setAttr('strokeStyle', 'white');
      ctx._context.lineDashOffset = (this.dashOffset + dashLength) / scale;
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
   * Builds a feathered canvas from SDT data. Pure function — does not set any atoms.
   * Used by per-entry feathering methods.
   *
   * Falloff formulas (positive sdt = inside, negative = outside):
   * - Inward:  alpha = smoothstep(0, R, sdt)      — edge=0, R inward=1
   * - Outward: alpha = smoothstep(-R, 0, sdt)      — R outward=0, edge=1
   * - Both:    alpha = smoothstep(-R/2, R/2, sdt)  — R/2 out=0, edge=0.5, R/2 in=1
   */
  private buildFeatheredCanvas(
    sdt: Float32Array,
    width: number,
    height: number,
    radius: number,
    direction: SelectionFeatherDirection
  ): HTMLCanvasElement {
    const result = document.createElement('canvas');
    result.width = width;
    result.height = height;
    const ctx = result.getContext('2d');
    if (!ctx) {
      return result;
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
    return result;
  }

  /**
   * Loads (or reuses) the diagonal hatching pattern image for the given color.
   */
  private getHatchingPattern(color: RgbColor): HTMLImageElement | null {
    if (
      this._patternImage &&
      this._patternColor &&
      this._patternColor.r === color.r &&
      this._patternColor.g === color.g &&
      this._patternColor.b === color.b
    ) {
      return this._patternImage;
    }
    const img = new Image();
    img.src = getPatternSVG('diagonal', color);
    this._patternImage = img;
    this._patternColor = { ...color };
    return img;
  }

  /**
   * Shows a hatched overlay of the selection mask matching the inpaint mask visual language.
   * Color and opacity are read from settings. Diagonal hatching respects feathered alpha.
   */
  updateOverlayPreview = (): void => {
    const feathered = this.$featheredMask.get() ?? this.$selectionMask.get();
    if (!feathered) {
      this.konva.overlay.visible(false);
      return;
    }

    const settings = this.manager.stateApi.getSettings();
    const color = settings.selectionOverlayColor;

    // Create an overlay canvas with hatching pattern
    const overlay = document.createElement('canvas');
    overlay.width = feathered.width;
    overlay.height = feathered.height;
    const ctx = overlay.getContext('2d');
    if (!ctx) {
      return;
    }

    // Step 1: Draw the feathered mask as alpha source
    ctx.drawImage(feathered, 0, 0);

    // Step 2: Apply diagonal hatching via source-in compositing
    ctx.globalCompositeOperation = 'source-in';

    const patternImg = this.getHatchingPattern(color);
    if (patternImg && patternImg.complete && patternImg.naturalWidth > 0) {
      // Pattern already loaded — create and fill
      const pattern = ctx.createPattern(patternImg, 'repeat');
      if (pattern) {
        ctx.fillStyle = pattern;
      } else {
        ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
      }
      ctx.fillRect(0, 0, overlay.width, overlay.height);
    } else if (patternImg) {
      // Pattern loading — use onload, fall back to solid color in the meantime
      ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
      ctx.fillRect(0, 0, overlay.width, overlay.height);
      // Re-render when pattern loads
      patternImg.onload = () => {
        this.updateOverlayPreview();
      };
    } else {
      // Fallback: solid color tint
      ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
      ctx.fillRect(0, 0, overlay.width, overlay.height);
    }

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
    if (this._isOperationInProgress) {
      return;
    }

    const mask = this.$featheredMask.get() ?? this.$selectionMask.get();
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!mask || !selectedEntity) {
      return;
    }

    this._isOperationInProgress = true;
    try {
      const color = this.manager.stateApi.getCurrentColor();
      const scale = this.manager.stage.getScale();
      const stagePos = this.manager.stage.getPosition();

      // Flush any pending rect calculation so we get fresh bounds
      selectedEntity.transformer.calculateRect.flush();
      const rect = selectedEntity.transformer.getRelativeRect();

      // Step 1: Rasterize entity to consolidate all objects into a single image at known position
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
    } finally {
      this._isOperationInProgress = false;
    }
  };

  /**
   * Deletes (erases) pixels within the selection area.
   * Rasterizes the entity, composites the deletion, then replaces the entity.
   */
  deleteSelection = async (): Promise<void> => {
    if (this._isOperationInProgress) {
      return;
    }

    const mask = this.$featheredMask.get() ?? this.$selectionMask.get();
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!mask || !selectedEntity) {
      return;
    }

    this._isOperationInProgress = true;
    try {
      const scale = this.manager.stage.getScale();
      const stagePos = this.manager.stage.getPosition();

      // Flush any pending rect calculation so we get fresh bounds
      selectedEntity.transformer.calculateRect.flush();
      const rect = selectedEntity.transformer.getRelativeRect();

      // Step 1: Capture entity's current visual state as a blob directly, WITHOUT dispatching
      // to Redux. Using rasterize({replaceObjects: false}) here would dispatch a no-op
      // entityRasterized action that gets throttled with the real replacement action (1s window),
      // causing the actual delete to be excluded from undo history.
      const existingBlob = await selectedEntity.renderer.getBlob({ rect });
      const existingImageDTO = await uploadImage({
        file: new File([existingBlob], 'selection_snapshot.png', { type: 'image/png' }),
        image_category: 'other',
        is_intermediate: true,
        silent: true,
      });

      // Step 2: Load the snapshot image
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
    } finally {
      this._isOperationInProgress = false;
    }
  };

  /**
   * Inverts the current selection (flips alpha channel).
   * Clears the stack and pushes a single rectangle entry with the inverted mask.
   * Fixes oval ants bug and stale mask bug by using a clean stack.
   */
  invertSelection = (): void => {
    const mask = this.$selectionMask.get();
    if (!mask) {
      return;
    }

    // Use the generation BBox as the inversion boundary.
    // All masks are in screen-pixel space (canvas sized to stageSize), so we need
    // to convert the bbox world coordinates to screen pixels for clipping.
    const bboxState = this.manager.stateApi.getBbox();
    const bboxRect = bboxState.rect;
    const scale = this.manager.stage.getScale();
    const stagePos = this.manager.stage.getPosition();

    // Convert bbox world coords to screen-pixel coords
    const bboxPx = {
      x: bboxRect.x * scale + stagePos.x,
      y: bboxRect.y * scale + stagePos.y,
      w: bboxRect.width * scale,
      h: bboxRect.height * scale,
    };

    // Create a new canvas the same size as the existing mask (full stage pixels)
    const canvas = document.createElement('canvas');
    canvas.width = mask.width;
    canvas.height = mask.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    // Step 1: Fill the bbox region fully opaque (= select everything in bbox)
    ctx.fillStyle = 'white';
    ctx.fillRect(bboxPx.x, bboxPx.y, bboxPx.w, bboxPx.h);

    // Step 2: Punch out the original selection using destination-out
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = 'source-over';

    // Bounds in world coordinates = the bbox rect
    const bounds: Rect = {
      x: bboxRect.x,
      y: bboxRect.y,
      width: bboxRect.width,
      height: bboxRect.height,
    };

    // Replace stack with single rectangle entry (fixes oval ants + stale mask bugs)
    const entry: SubSelection = {
      binaryMask: canvas,
      featherRadius: 0,
      featherDirection: 'both',
      combineMode: 'replace',
      featheredMask: null,
      cachedSdt: null,
      cachedSdtWidth: 0,
      cachedSdtHeight: 0,
      selectionMode: 'rectangle',
      lassoPoints: null,
      bounds,
    };

    this.$subSelections.set([entry]);
    this._committedBinaryComposite = null;
    this._committedFeatheredComposite = null;
    this._committedCompositeCount = 0;

    this.$selectionMask.set(canvas);
    this.$featheredMask.set(canvas);
    this.$selectionBounds.set(bounds);

    this.updateOverlayPreview();
    this.startMarchingAnts();
  };

  /**
   * Closes the polygon: validates >= 3 vertices, generates a lasso mask from the
   * committed vertices, and pushes a sub-selection.
   */
  closePolygon = (): void => {
    const vertices = this.$polygonVertices.get();
    if (vertices.length < 6) {
      // Need at least 3 vertices (6 values)
      this.cancelPolygon();
      return;
    }

    // Reset drawing state
    this.$isDrawing.set(false);
    this.konva.preview.visible(false);

    // Generate mask from polygon vertices (reuses lasso mask generator)
    const result = this.generateLassoMask(vertices);

    // Save vertices copy for marching ants
    const verticesCopy = [...vertices];

    // Clean up polygon state
    this.$polygonVertices.set([]);
    this.$polygonInProgress.set(false);
    this._lastClickTime = 0;
    this._lastClickPos = null;

    // Push sub-selection
    if (result) {
      this.pushSubSelection(result.canvas, result.bounds, this.$combineMode.get(), 'polygon', verticesCopy);
    }
  };

  /**
   * Cancels the in-progress polygon. For add/subtract, refreshes from existing stack.
   */
  cancelPolygon = (): void => {
    this.$isDrawing.set(false);
    this.konva.preview.visible(false);
    this.$polygonVertices.set([]);
    this.$polygonInProgress.set(false);
    this._lastClickTime = 0;
    this._lastClickPos = null;

    if (this.$combineMode.get() !== 'replace' && this.$subSelections.get().length > 0) {
      this.recomputeComposite();
    }
  };

  /**
   * Translates (moves) both the binary and feathered selection masks by the given
   * stage-space delta from the drag start. Uses snapshotted originals to avoid
   * compounding translations. Redraws overlay and marching ants.
   */
  private translateMasks(dxStage: number, dyStage: number): void {
    const origMask = this._moveOriginalMask;
    const origFeathered = this._moveOriginalFeathered;
    const originalBounds = this._moveOriginalBounds;
    if (!origMask || !originalBounds) {
      return;
    }

    const scale = this.manager.stage.getScale();
    const dxPx = Math.round(dxStage * scale);
    const dyPx = Math.round(dyStage * scale);

    // Translate binary mask from original snapshot
    const newMask = document.createElement('canvas');
    newMask.width = origMask.width;
    newMask.height = origMask.height;
    const maskCtx = newMask.getContext('2d');
    if (maskCtx) {
      maskCtx.drawImage(origMask, dxPx, dyPx);
    }
    this.$selectionMask.set(newMask);

    // Translate feathered mask from original snapshot
    if (origFeathered && origFeathered !== origMask) {
      const newFeathered = document.createElement('canvas');
      newFeathered.width = origFeathered.width;
      newFeathered.height = origFeathered.height;
      const fCtx = newFeathered.getContext('2d');
      if (fCtx) {
        fCtx.drawImage(origFeathered, dxPx, dyPx);
      }
      this.$featheredMask.set(newFeathered);
    } else {
      this.$featheredMask.set(newMask);
    }

    // Update bounds relative to original
    this.$selectionBounds.set({
      x: originalBounds.x + dxStage,
      y: originalBounds.y + dyStage,
      width: originalBounds.width,
      height: originalBounds.height,
    });

    // Refresh visuals
    this.updateOverlayPreview();
    this.konva.marchingAnts.getLayer()?.batchDraw();
  }

  /**
   * Clears the selection - called on tool change or deselect.
   */
  clearSelection = (): void => {
    this.$subSelections.set([]);
    this._committedBinaryComposite = null;
    this._committedFeatheredComposite = null;
    this._committedCompositeCount = 0;

    this.$selectionMask.set(null);
    this.$featheredMask.set(null);
    this.$selectionBounds.set(null);
    this.$isDrawing.set(false);
    this.$drawOrigin.set(null);
    this.$lassoPoints.set([]);
    this.$combineMode.set('replace');
    this.$centerHeld.set(false);
    this.$sKeyHeld.set(false);
    this.$polygonVertices.set([]);
    this.$polygonInProgress.set(false);
    this._lastClickTime = 0;
    this._lastClickPos = null;
    this.$selectionSubMode.set('draw');
    this._moveStartPos = null;
    this._moveOriginalBounds = null;
    this._moveOriginalMask = null;
    this._moveOriginalFeathered = null;

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
      subSelectionCount: this.$subSelections.get().length,
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
