import { CanvasObjectCloneBrushLine } from 'features/controlLayers/fork/brush/CanvasObjectCloneBrushLine';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
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

type CanvasCloneBrushToolModuleConfig = {
  BORDER_INNER_COLOR: string;
  BORDER_OUTER_COLOR: string;
  CROSSHAIR_COLOR: string;
  CROSSHAIR_SIZE: number;
  HIDE_FILL_TIMEOUT_MS: number;
};

const DEFAULT_CONFIG: CanvasCloneBrushToolModuleConfig = {
  BORDER_INNER_COLOR: 'rgba(0,0,0,1)',
  BORDER_OUTER_COLOR: 'rgba(255,255,255,0.8)',
  CROSSHAIR_COLOR: 'rgba(255,0,0,0.8)',
  CROSSHAIR_SIZE: 10,
  HIDE_FILL_TIMEOUT_MS: 1500,
};

/**
 * FORK clone-brush tool module (JA toolbox, hotkey `j`). Handles Alt+click source selection, source
 * snapshot capture, offset tracking (aligned / non-aligned), current-layer vs current-and-below
 * sampling, and the source crosshair overlay. The pixel compositing lives in
 * {@link CanvasObjectCloneBrushLine} (premultiplied source-over in linear).
 *
 * Bug #18 (stale offset after a layer move): the clone source point is stored ENTITY-LOCAL
 * (content-anchored). In aligned mode the source→dest offset persists across strokes, so if the
 * layer is MOVED after the offset was established it would keep sampling the pre-move placement. Fix:
 * we snapshot the entity's position when the source is set and again when the offset is computed, and
 * we RE-BASE the offset from the entity's CURRENT `state.position` whenever it has moved since — i.e.
 * we guard on entity MOVE, not just entity switch. The snapshot itself is always cropped in document
 * space with the current position, so it already reflects the moved layer.
 */
export class CanvasCloneBrushToolModule extends CanvasModuleBase {
  readonly type = 'clone_brush_tool';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasToolModule;
  readonly manager: CanvasManager;
  readonly log: Logger;

  config: CanvasCloneBrushToolModuleConfig = DEFAULT_CONFIG;
  hideFillTimeoutId: number | null = null;

  /** The source point set by Alt+click, in entity-local (content-anchored) coordinates. */
  $sourcePoint = atom<Coordinate | null>(null);

  /** Computed source offset (source − destination), entity-local. Persists across strokes when aligned. */
  private _sourceOffset: Coordinate | null = null;
  /** Whether the offset has been computed since the source (or a move) was established. */
  private _hasComputedOffset = false;
  /** Entity the source point belongs to — clears the source if the selected entity changes. */
  private _sourceEntityId: string | null = null;
  /** Entity position at the time the source/offset was last (re-)based — used to detect moves (#18). */
  private _basePosition: Coordinate | null = null;

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

    // Brush preview circle (semi-transparent gray to indicate clone mode).
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

    // Border rings in screen pixels.
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

    this._renderCrosshair(cursorPos.relative);

    this.hideFillTimeoutId = window.setTimeout(() => {
      this.konva.fillCircle.visible(false);
      this.hideFillTimeoutId = null;
    }, this.config.HIDE_FILL_TIMEOUT_MS);
  };

  /**
   * Renders the source crosshair. When the offset is computed the crosshair tracks the cursor with a
   * fixed displacement (source displacements are frame-independent, so adding an entity-local offset
   * to a document-space cursor is valid); otherwise it sits at the fixed source point.
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

    let crosshairPos: Coordinate;
    if (this._hasComputedOffset && this._sourceOffset) {
      crosshairPos = {
        x: cursorRelative.x + this._sourceOffset.x,
        y: cursorRelative.y + this._sourceOffset.y,
      };
    } else {
      // sourcePoint is entity-local — convert to document/stage coords via current position.
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
   * Snapshots the source layer(s) for the current stroke. `getCanvas` / `getCompositeCanvas` crop in
   * DOCUMENT space, so we pass the document bbox and set the snapshot origin to `bbox − CURRENT
   * position`. Reading the position here (not at Alt+click) is what makes the sample follow the layer
   * after a move (#18).
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

    // Snapshot origin in entity-local coords (entity-local of document bbox top-left).
    const offsetX = bbox.x - entityPos.x;
    const offsetY = bbox.y - entityPos.y;

    let canvas: HTMLCanvasElement;

    if (sampleMode === 'current_layer') {
      canvas = adapter.getCanvas(bbox);
    } else {
      // "Current & Below" — composite current layer and all visible raster layers below it.
      const rasterEntities = this.manager.stateApi.getRasterLayersState().entities;
      const currentIndex = rasterEntities.findIndex((e) => e.id === entityId);

      if (currentIndex < 0) {
        canvas = adapter.getCanvas(bbox);
      } else {
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

  /**
   * Re-bases the source offset against the entity's CURRENT position when the layer has moved since
   * the offset was established (#18 guard). Forces a recompute on the next capture so aligned mode
   * re-anchors to the moved content instead of sampling the pre-move placement.
   */
  private _guardEntityMove(position: Coordinate): void {
    if (this._basePosition && (this._basePosition.x !== position.x || this._basePosition.y !== position.y)) {
      this._hasComputedOffset = false;
      this._basePosition = { x: position.x, y: position.y };
    }
  }

  onStagePointerDown = async (e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();
    const isPrimaryPointerDown = this.parent.$isPrimaryPointerDown.get();
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!cursorPos || !selectedEntity || !isPrimaryPointerDown) {
      return;
    }

    // Guard on entity switch — a source from a different entity is meaningless here.
    if (this._sourceEntityId !== null && this._sourceEntityId !== selectedEntity.state.id) {
      this.$sourcePoint.set(null);
      this._sourceOffset = null;
      this._hasComputedOffset = false;
      this._sourceEntityId = null;
      this._basePosition = null;
    }

    const settings = this.manager.stateApi.getSettings();
    const position = selectedEntity.state.position;
    const normalizedPoint = offsetCoord(cursorPos.relative, position);
    const alignedPoint = alignCoordForTool(normalizedPoint, settings.brushWidth);

    // Alt+click: set source point (entity-local, content-anchored).
    if (e.evt.altKey) {
      this.$sourcePoint.set({ x: alignedPoint.x, y: alignedPoint.y });
      this._sourceEntityId = selectedEntity.state.id;
      this._sourceOffset = null;
      this._hasComputedOffset = false;
      this._basePosition = { x: position.x, y: position.y };
      this.log.debug({ sourcePoint: this.$sourcePoint.get() }, 'Clone source set');
      return;
    }

    // Normal click: start a clone stroke.
    const sourcePoint = this.$sourcePoint.get();
    if (!sourcePoint) {
      this.log.trace('No clone source set, ignoring pointer down');
      return;
    }

    // Commit any existing buffer.
    if (selectedEntity.bufferRenderer.hasBuffer()) {
      selectedEntity.bufferRenderer.commitBuffer();
    }

    // #18: re-base the offset if the layer moved since it was established.
    this._guardEntityMove(position);

    // Compute source offset (recompute every stroke when not aligned; once when aligned).
    if (!this._hasComputedOffset || !settings.cloneBrushAlignedMode) {
      this._sourceOffset = {
        x: sourcePoint.x - alignedPoint.x,
        y: sourcePoint.y - alignedPoint.y,
      };
      this._hasComputedOffset = true;
      this._basePosition = { x: position.x, y: position.y };
    }

    const snapshot = this._captureSourceSnapshot(selectedEntity.state.id, settings.cloneBrushSampleMode);
    if (!snapshot) {
      this.log.warn('Failed to capture source snapshot');
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

    // Re-entering mid-stroke with no established source/offset — nothing to continue.
    if (!this.$sourcePoint.get() || !this._hasComputedOffset || !this._sourceOffset) {
      return;
    }

    const settings = this.manager.stateApi.getSettings();
    const normalizedPoint = offsetCoord(cursorPos.relative, selectedEntity.state.position);
    const alignedPoint = alignCoordForTool(normalizedPoint, settings.brushWidth);

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
