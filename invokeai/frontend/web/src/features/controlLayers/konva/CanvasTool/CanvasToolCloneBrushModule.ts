import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import { CanvasObjectCloneBrushLine } from 'features/controlLayers/konva/CanvasObject/CanvasObjectCloneBrushLine';
import type { CanvasToolModule } from 'features/controlLayers/konva/CanvasTool/CanvasToolModule';
import {
  alignCoordForTool,
  getLastPointOfLine,
  getPrefixedId,
  isDistanceMoreThanMin,
  offsetCoord,
} from 'features/controlLayers/konva/util';
import type { Coordinate } from 'features/controlLayers/store/types';
import { getEntityIdentifier } from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { atom } from 'nanostores';
import type { Logger } from 'roarr';

type CanvasToolCloneBrushModuleConfig = {
  BORDER_INNER_COLOR: string;
  BORDER_OUTER_COLOR: string;
  CROSSHAIR_COLOR: string;
  CROSSHAIR_SIZE: number;
  HIDE_FILL_TIMEOUT_MS: number;
};

const DEFAULT_CONFIG: CanvasToolCloneBrushModuleConfig = {
  BORDER_INNER_COLOR: 'rgba(0,0,0,1)',
  BORDER_OUTER_COLOR: 'rgba(255,255,255,0.8)',
  CROSSHAIR_COLOR: 'rgba(255,0,0,0.8)',
  CROSSHAIR_SIZE: 10,
  HIDE_FILL_TIMEOUT_MS: 1500,
};

/**
 * Tool module for the clone brush. Handles Alt+click source selection, snapshot capture,
 * offset tracking, and crosshair overlay rendering.
 */
export class CanvasToolCloneBrushModule extends CanvasModuleBase {
  readonly type = 'clone_brush_tool';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasToolModule;
  readonly manager: CanvasManager;
  readonly log: Logger;

  config: CanvasToolCloneBrushModuleConfig = DEFAULT_CONFIG;
  hideFillTimeoutId: number | null = null;

  /**
   * The source point set by Alt+click, in entity-local coordinates.
   * Null until the user first Alt+clicks.
   */
  $sourcePoint = atom<Coordinate | null>(null);

  /**
   * The computed source offset (source - destination), in entity-local coordinates.
   * Persists across strokes in aligned mode.
   */
  private _sourceOffset: Coordinate | null = null;

  /**
   * Whether the offset has been computed (after the first stroke with a source point).
   * In aligned mode, once computed, the offset persists.
   */
  private _hasComputedOffset = false;

  /**
   * The entity ID that the source point belongs to. Clears the source if the selected
   * entity changes.
   */
  private _sourceEntityId: string | null = null;

  konva: {
    group: Konva.Group;
    fillCircle: Konva.Circle;
    innerBorder: Konva.Ring;
    outerBorder: Konva.Ring;
    crosshairGroup: Konva.Group;
    crosshairH: Konva.Line;
    crosshairV: Konva.Line;
    crosshairCircle: Konva.Circle;
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
      fillCircle: new Konva.Circle({
        name: `${this.type}:fill_circle`,
        listening: false,
        strokeEnabled: false,
        perfectDrawEnabled: false,
      }),
      innerBorder: new Konva.Ring({
        name: `${this.type}:inner_border`,
        listening: false,
        innerRadius: 0,
        outerRadius: 0,
        fill: this.config.BORDER_INNER_COLOR,
        strokeEnabled: false,
        perfectDrawEnabled: false,
      }),
      outerBorder: new Konva.Ring({
        name: `${this.type}:outer_border`,
        listening: false,
        innerRadius: 0,
        outerRadius: 0,
        fill: this.config.BORDER_OUTER_COLOR,
        strokeEnabled: false,
        perfectDrawEnabled: false,
      }),
      crosshairGroup: new Konva.Group({ name: `${this.type}:crosshair_group`, listening: false }),
      crosshairH: new Konva.Line({
        name: `${this.type}:crosshair_h`,
        listening: false,
        stroke: this.config.CROSSHAIR_COLOR,
        strokeWidth: 1,
        perfectDrawEnabled: false,
      }),
      crosshairV: new Konva.Line({
        name: `${this.type}:crosshair_v`,
        listening: false,
        stroke: this.config.CROSSHAIR_COLOR,
        strokeWidth: 1,
        perfectDrawEnabled: false,
      }),
      crosshairCircle: new Konva.Circle({
        name: `${this.type}:crosshair_circle`,
        listening: false,
        stroke: this.config.CROSSHAIR_COLOR,
        strokeWidth: 1,
        fill: 'transparent',
        radius: 4,
        perfectDrawEnabled: false,
      }),
    };

    this.konva.crosshairGroup.add(this.konva.crosshairH, this.konva.crosshairV, this.konva.crosshairCircle);
    this.konva.group.add(
      this.konva.fillCircle,
      this.konva.innerBorder,
      this.konva.outerBorder,
      this.konva.crosshairGroup
    );
  }

  syncCursorStyle = () => {
    this.manager.stage.setCursor('none');
  };

  render = () => {
    if (this.parent.$tool.get() !== 'cloneBrush') {
      this.setVisibility(false);
      return;
    }

    if (!this.parent.getCanDraw()) {
      this.setVisibility(false);
      return;
    }

    const cursorPos = this.parent.$cursorPos.get();

    if (!cursorPos) {
      this.setVisibility(false);
      return;
    }

    const isPrimaryPointerDown = this.parent.$isPrimaryPointerDown.get();
    const lastPointerType = this.parent.$lastPointerType.get();

    if (lastPointerType !== 'mouse' && isPrimaryPointerDown) {
      this.setVisibility(false);
      return;
    }

    this.setVisibility(true);

    if (this.hideFillTimeoutId !== null) {
      window.clearTimeout(this.hideFillTimeoutId);
      this.hideFillTimeoutId = null;
    }

    const settings = this.manager.stateApi.getSettings();
    const radius = settings.brushWidth / 2;
    const fillVisible = !isPrimaryPointerDown && lastPointerType === 'mouse';
    const alignedCursorPos = alignCoordForTool(cursorPos.relative, settings.brushWidth);

    // Brush preview circle (semi-transparent gray to indicate clone mode)
    if (settings.brushHardness < 1) {
      const solidColor = 'rgba(128, 128, 128, 0.4)';
      const transparentColor = 'rgba(128, 128, 128, 0)';
      this.konva.fillCircle.setAttrs({
        x: alignedCursorPos.x,
        y: alignedCursorPos.y,
        radius,
        fill: undefined,
        fillRadialGradientStartPoint: { x: 0, y: 0 },
        fillRadialGradientEndPoint: { x: 0, y: 0 },
        fillRadialGradientStartRadius: radius * settings.brushHardness,
        fillRadialGradientEndRadius: radius,
        fillRadialGradientColorStops: [0, solidColor, 1, transparentColor],
        opacity: settings.brushOpacity,
        visible: fillVisible,
      });
    } else {
      this.konva.fillCircle.setAttrs({
        x: alignedCursorPos.x,
        y: alignedCursorPos.y,
        radius,
        fill: 'rgba(128, 128, 128, 0.3)',
        fillRadialGradientColorStops: undefined,
        opacity: settings.brushOpacity,
        visible: fillVisible,
      });
    }

    // Border rings in screen-pixels
    const onePixel = this.manager.stage.unscale(1);
    const twoPixels = this.manager.stage.unscale(2);

    this.konva.innerBorder.setAttrs({
      x: cursorPos.relative.x,
      y: cursorPos.relative.y,
      innerRadius: radius,
      outerRadius: radius + onePixel,
    });
    this.konva.outerBorder.setAttrs({
      x: cursorPos.relative.x,
      y: cursorPos.relative.y,
      innerRadius: radius + onePixel,
      outerRadius: radius + twoPixels,
    });

    // Crosshair at source position
    this._renderCrosshair(cursorPos.relative);

    this.hideFillTimeoutId = window.setTimeout(() => {
      this.konva.fillCircle.visible(false);
      this.hideFillTimeoutId = null;
    }, this.config.HIDE_FILL_TIMEOUT_MS);
  };

  /**
   * Renders the source crosshair overlay. The crosshair position depends on:
   * - If offset has been computed: crosshair = cursorPos + offset (moves 1:1 with cursor)
   * - If offset not yet computed: crosshair = sourcePoint (fixed at Alt+click position)
   */
  private _renderCrosshair = (cursorRelative: Coordinate) => {
    const sourcePoint = this.$sourcePoint.get();
    if (!sourcePoint) {
      this.konva.crosshairGroup.visible(false);
      return;
    }

    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();
    if (!selectedEntity) {
      this.konva.crosshairGroup.visible(false);
      return;
    }

    // Compute crosshair position in stage/absolute coords
    let crosshairPos: Coordinate;

    if (this._hasComputedOffset && this._sourceOffset) {
      // Offset computed: crosshair tracks cursor with fixed offset
      // cursorRelative is in stage coords, sourceOffset is in entity-local coords.
      // Convert sourceOffset to stage coords by adding entity position.
      crosshairPos = {
        x: cursorRelative.x + this._sourceOffset.x,
        y: cursorRelative.y + this._sourceOffset.y,
      };
    } else {
      // Offset not yet computed: show crosshair at the fixed source point
      // sourcePoint is in entity-local coords, convert to stage coords
      crosshairPos = {
        x: sourcePoint.x + selectedEntity.state.position.x,
        y: sourcePoint.y + selectedEntity.state.position.y,
      };
    }

    const s = this.config.CROSSHAIR_SIZE;
    const lineWidth = this.manager.stage.unscale(1);

    this.konva.crosshairGroup.visible(true);
    this.konva.crosshairH.setAttrs({
      points: [crosshairPos.x - s, crosshairPos.y, crosshairPos.x + s, crosshairPos.y],
      strokeWidth: lineWidth,
    });
    this.konva.crosshairV.setAttrs({
      points: [crosshairPos.x, crosshairPos.y - s, crosshairPos.x, crosshairPos.y + s],
      strokeWidth: lineWidth,
    });
    this.konva.crosshairCircle.setAttrs({
      x: crosshairPos.x,
      y: crosshairPos.y,
      strokeWidth: lineWidth,
    });
  };

  /**
   * Takes a snapshot of the source layer(s) for the current stroke.
   * Returns the snapshot canvas and its origin offset in entity-local coordinates.
   */
  private _captureSourceSnapshot(
    entityId: string,
    sampleMode: 'current_layer' | 'current_and_below'
  ): { canvas: HTMLCanvasElement; offsetX: number; offsetY: number } | null {
    const adapter = this.manager.stateApi.getSelectedEntityAdapter();
    if (!adapter) {
      return null;
    }

    const bbox = this.manager.stateApi.getBbox().rect;
    const entityPos = adapter.state.position;

    // Snapshot offset in entity-local coordinates
    const offsetX = bbox.x - entityPos.x;
    const offsetY = bbox.y - entityPos.y;

    let canvas: HTMLCanvasElement;

    if (sampleMode === 'current_layer') {
      canvas = adapter.getCanvas(bbox);
    } else {
      // "Current & Below" — composite current layer and all visible raster layers below it
      const rasterEntities = this.manager.stateApi.getRasterLayersState().entities;
      const currentIndex = rasterEntities.findIndex((e) => e.id === entityId);

      if (currentIndex < 0) {
        // Entity not found in raster layers, fall back to current layer only
        canvas = adapter.getCanvas(bbox);
      } else {
        // Slice from beginning to current (inclusive) — these are "current & below" in the array
        const belowEntities = rasterEntities.slice(0, currentIndex + 1);
        const adapters = belowEntities
          .map((e) => this.manager.getAdapter(getEntityIdentifier(e)))
          .filter((a): a is NonNullable<typeof a> => a !== null)
          .filter((a) => !a.$isDisabled.get() && a.renderer.hasObjects());

        if (adapters.length === 0) {
          canvas = adapter.getCanvas(bbox);
        } else {
          canvas = this.manager.compositor.getCompositeCanvas(adapters, bbox);
        }
      }
    }

    return { canvas, offsetX, offsetY };
  }

  onStagePointerDown = async (e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();
    const isPrimaryPointerDown = this.parent.$isPrimaryPointerDown.get();
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!cursorPos || !selectedEntity || !isPrimaryPointerDown) {
      return;
    }

    const settings = this.manager.stateApi.getSettings();
    const normalizedPoint = offsetCoord(cursorPos.relative, selectedEntity.state.position);
    const alignedPoint = alignCoordForTool(normalizedPoint, settings.brushWidth);

    // Alt+click: set source point
    if (e.evt.altKey) {
      this.$sourcePoint.set({ x: alignedPoint.x, y: alignedPoint.y });
      this._sourceEntityId = selectedEntity.state.id;
      // Reset offset so it gets recomputed on next stroke start
      this._sourceOffset = null;
      this._hasComputedOffset = false;
      this.log.debug({ sourcePoint: this.$sourcePoint.get() }, 'Clone source set');
      return;
    }

    // Normal click: start clone stroke
    const sourcePoint = this.$sourcePoint.get();
    if (!sourcePoint) {
      // No source set — can't paint
      this.log.trace('No clone source set, ignoring pointer down');
      return;
    }

    // Commit any existing buffer
    if (selectedEntity.bufferRenderer.hasBuffer()) {
      selectedEntity.bufferRenderer.commitBuffer();
    }

    // Compute source offset
    if (!this._hasComputedOffset || !settings.cloneBrushAlignedMode) {
      this._sourceOffset = {
        x: sourcePoint.x - alignedPoint.x,
        y: sourcePoint.y - alignedPoint.y,
      };
      this._hasComputedOffset = true;
    }

    // Take snapshot
    const snapshot = this._captureSourceSnapshot(selectedEntity.state.id, settings.cloneBrushSampleMode);
    if (!snapshot) {
      this.log.warn('Failed to capture source snapshot');
      return;
    }

    const clip = this.parent.getClip(selectedEntity.state);

    // Create buffer state
    if (e.evt.pointerType === 'pen' && settings.pressureSensitivity) {
      await selectedEntity.bufferRenderer.setBuffer({
        id: getPrefixedId('clone_brush_line_with_pressure'),
        type: 'clone_brush_line_with_pressure',
        points: [alignedPoint.x, alignedPoint.y, e.evt.pressure],
        strokeWidth: settings.brushWidth,
        hardness: settings.brushHardness,
        opacity: settings.brushOpacity,
        clip,
        sourceOffsetX: this._sourceOffset!.x,
        sourceOffsetY: this._sourceOffset!.y,
      });
    } else {
      await selectedEntity.bufferRenderer.setBuffer({
        id: getPrefixedId('clone_brush_line'),
        type: 'clone_brush_line',
        points: [alignedPoint.x, alignedPoint.y],
        strokeWidth: settings.brushWidth,
        hardness: settings.brushHardness,
        opacity: settings.brushOpacity,
        clip,
        sourceOffsetX: this._sourceOffset!.x,
        sourceOffsetY: this._sourceOffset!.y,
      });
    }

    // Set the source snapshot on the renderer
    const renderer = selectedEntity.bufferRenderer.renderer;
    if (renderer instanceof CanvasObjectCloneBrushLine) {
      renderer.setSourceSnapshot(snapshot.canvas, snapshot.offsetX, snapshot.offsetY);
    }
  };

  onStagePointerUp = (_e: KonvaEventObject<PointerEvent>) => {
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();
    if (!selectedEntity) {
      return;
    }
    if (
      (selectedEntity.bufferRenderer.state?.type === 'clone_brush_line' ||
        selectedEntity.bufferRenderer.state?.type === 'clone_brush_line_with_pressure') &&
      selectedEntity.bufferRenderer.hasBuffer()
    ) {
      selectedEntity.bufferRenderer.commitBuffer();
    } else {
      selectedEntity.bufferRenderer.clearBuffer();
    }
  };

  onStagePointerMove = async (e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();

    if (!cursorPos) {
      return;
    }

    if (!this.parent.$isPrimaryPointerDown.get()) {
      return;
    }

    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!selectedEntity) {
      return;
    }

    const bufferState = selectedEntity.bufferRenderer.state;

    if (!bufferState) {
      return;
    }

    if (bufferState.type !== 'clone_brush_line' && bufferState.type !== 'clone_brush_line_with_pressure') {
      return;
    }

    const settings = this.manager.stateApi.getSettings();

    const lastPoint = getLastPointOfLine(bufferState.points);
    const minDistance = settings.brushWidth * this.parent.config.BRUSH_SPACING_TARGET_SCALE;
    if (!lastPoint || !isDistanceMoreThanMin(cursorPos.relative, lastPoint, minDistance)) {
      return;
    }

    const normalizedPoint = offsetCoord(cursorPos.relative, selectedEntity.state.position);
    const alignedPoint = alignCoordForTool(normalizedPoint, settings.brushWidth);

    if (lastPoint.x === alignedPoint.x && lastPoint.y === alignedPoint.y) {
      return;
    }

    bufferState.points.push(alignedPoint.x, alignedPoint.y);

    if (bufferState.type === 'clone_brush_line_with_pressure' && settings.pressureSensitivity) {
      bufferState.points.push(e.evt.pressure);
    }

    await selectedEntity.bufferRenderer.setBuffer(bufferState);
  };

  onStagePointerEnter = async (e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();
    const isPrimaryPointerDown = this.parent.$isPrimaryPointerDown.get();
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!cursorPos || !isPrimaryPointerDown || !selectedEntity) {
      return;
    }

    // If re-entering the stage mid-stroke and no source set, bail
    if (!this.$sourcePoint.get() || !this._hasComputedOffset || !this._sourceOffset) {
      return;
    }

    const settings = this.manager.stateApi.getSettings();
    const normalizedPoint = offsetCoord(cursorPos.relative, selectedEntity.state.position);
    const alignedPoint = alignCoordForTool(normalizedPoint, settings.brushWidth);

    // Take a fresh snapshot for the new stroke segment
    const snapshot = this._captureSourceSnapshot(selectedEntity.state.id, settings.cloneBrushSampleMode);
    if (!snapshot) {
      return;
    }

    const clip = this.parent.getClip(selectedEntity.state);

    if (e.evt.pointerType === 'pen' && settings.pressureSensitivity) {
      await selectedEntity.bufferRenderer.setBuffer({
        id: getPrefixedId('clone_brush_line_with_pressure'),
        type: 'clone_brush_line_with_pressure',
        points: [alignedPoint.x, alignedPoint.y, e.evt.pressure],
        strokeWidth: settings.brushWidth,
        hardness: settings.brushHardness,
        opacity: settings.brushOpacity,
        clip,
        sourceOffsetX: this._sourceOffset.x,
        sourceOffsetY: this._sourceOffset.y,
      });
    } else {
      await selectedEntity.bufferRenderer.setBuffer({
        id: getPrefixedId('clone_brush_line'),
        type: 'clone_brush_line',
        points: [alignedPoint.x, alignedPoint.y],
        strokeWidth: settings.brushWidth,
        hardness: settings.brushHardness,
        opacity: settings.brushOpacity,
        clip,
        sourceOffsetX: this._sourceOffset.x,
        sourceOffsetY: this._sourceOffset.y,
      });
    }

    const renderer = selectedEntity.bufferRenderer.renderer;
    if (renderer instanceof CanvasObjectCloneBrushLine) {
      renderer.setSourceSnapshot(snapshot.canvas, snapshot.offsetX, snapshot.offsetY);
    }
  };

  setVisibility = (visible: boolean) => {
    this.konva.group.visible(visible);
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      config: this.config,
      $sourcePoint: this.$sourcePoint.get(),
    };
  };

  destroy = () => {
    this.log.debug('Destroying module');
    this.konva.group.destroy();
  };
}
