import { rgbaColorToString } from 'common/util/colorCodeTransformers';
import { hardnessToGamma } from 'features/controlLayers/fork/brush/brushBuffer';
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
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import type { Logger } from 'roarr';

type CanvasSoftBrushToolModuleConfig = {
  /** The inner border color for the brush tool preview. */
  BORDER_INNER_COLOR: string;
  /** The outer border color for the brush tool preview. */
  BORDER_OUTER_COLOR: string;
  /** Milliseconds to wait before hiding the brush preview's fill circle after the pointer is released. */
  HIDE_FILL_TIMEOUT_MS: number;
};

const DEFAULT_CONFIG: CanvasSoftBrushToolModuleConfig = {
  BORDER_INNER_COLOR: 'rgba(0,0,0,1)',
  BORDER_OUTER_COLOR: 'rgba(255,255,255,0.8)',
  HIDE_FILL_TIMEOUT_MS: 1500,
};

/**
 * The fork ("JA toolbox") SOFT BRUSH tool (hotkey `k`, tool value `softBrush`).
 *
 * Unlike the native brush (which always paints crisp `brush_line` objects), this tool always paints
 * soft-edged strokes: `soft_brush_line` / `soft_brush_line_with_pressure` (source-over), or the
 * `soft_eraser_line` variants (destination-out) when `settings.softBrushErase` is set. The strokes
 * are rendered by the fork {@link import('./CanvasObjectSoftBrushLine').CanvasObjectSoftBrushLine}
 * through the standard buffer pipeline (`setBuffer` / `commitBuffer`).
 *
 * This module owns only the on-canvas cursor preview (a radial-gradient fill circle sized to the
 * brush, plus two border rings) and the pointer plumbing that appends points to the live buffer. All
 * pixel accumulation lives in the object renderer + `fork/brush/brushBuffer.ts`.
 *
 * Mirrors the native `CanvasBrushToolModule` shape so `CanvasToolModule` can dispatch to it with the
 * same `render` / `onStagePointer*` seams used by every other drawing tool. Shift-to-draw-a-straight
 * -line is intentionally omitted: the recommended commit path bakes the stroke to a plain `image`
 * object, so there is no persistent `soft_brush_line` to continue from (see the Phase B seam notes).
 */
export class CanvasSoftBrushToolModule extends CanvasModuleBase {
  readonly type = 'soft_brush_tool';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasToolModule;
  readonly manager: CanvasManager;
  readonly log: Logger;

  config: CanvasSoftBrushToolModuleConfig = DEFAULT_CONFIG;
  hideFillTimeoutId: number | null = null;

  konva: {
    group: Konva.Group;
    fillCircle: Konva.Circle;
    innerBorder: Konva.Ring;
    outerBorder: Konva.Ring;
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
      group: new Konva.Group({ name: `${this.type}:brush_group`, listening: false }),
      fillCircle: new Konva.Circle({
        name: `${this.type}:brush_fill_circle`,
        listening: false,
        strokeEnabled: false,
        perfectDrawEnabled: false,
      }),
      innerBorder: new Konva.Ring({
        name: `${this.type}:brush_inner_border_ring`,
        listening: false,
        innerRadius: 0,
        outerRadius: 0,
        fill: this.config.BORDER_INNER_COLOR,
        strokeEnabled: false,
        perfectDrawEnabled: false,
      }),
      outerBorder: new Konva.Ring({
        name: `${this.type}:brush_outer_border_ring`,
        listening: false,
        innerRadius: 0,
        outerRadius: 0,
        fill: this.config.BORDER_OUTER_COLOR,
        strokeEnabled: false,
        perfectDrawEnabled: false,
      }),
    };
    this.konva.group.add(this.konva.fillCircle, this.konva.innerBorder, this.konva.outerBorder);
  }

  syncCursorStyle = () => {
    this.manager.stage.setCursor('none');
  };

  render = () => {
    if (this.parent.$tool.get() !== 'softBrush') {
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
    const brushPreviewFill = this.manager.stateApi.getBrushPreviewColor();
    const alignedCursorPos = alignCoordForTool(cursorPos.relative, settings.brushWidth);
    const radius = settings.brushWidth / 2;
    const fillVisible = !isPrimaryPointerDown && lastPointerType === 'mouse';
    const hardness = settings.softBrushHardness;
    const opacity = settings.softBrushOpacity;

    // Show the hardness gradient + opacity on the cursor preview.
    if (hardness < 1) {
      // Soft: sample the SAME falloff the brush actually paints — alpha(t) = 1 - t^gamma with the
      // shared hardnessToGamma — into gradient stops, so the cursor preview is true WYSIWYG (a plain
      // linear solid->transparent ramp diverges strongly from the curve across most of the range).
      const gamma = hardnessToGamma(hardness);
      const STOP_COUNT = 12;
      const stops: (number | string)[] = [];
      for (let i = 0; i <= STOP_COUNT; i++) {
        const t = i / STOP_COUNT;
        const a = Math.max(0, Math.min(1, 1 - Math.pow(t, gamma)));
        stops.push(t, rgbaColorToString({ ...brushPreviewFill, a }));
      }
      this.konva.fillCircle.setAttrs({
        x: alignedCursorPos.x,
        y: alignedCursorPos.y,
        radius,
        fill: undefined,
        fillRadialGradientStartPoint: { x: 0, y: 0 },
        fillRadialGradientEndPoint: { x: 0, y: 0 },
        fillRadialGradientStartRadius: 0,
        fillRadialGradientEndRadius: radius,
        fillRadialGradientColorStops: stops,
        opacity,
        visible: fillVisible,
      });
    } else {
      // Fully hard: solid fill.
      this.konva.fillCircle.setAttrs({
        x: alignedCursorPos.x,
        y: alignedCursorPos.y,
        radius,
        fill: rgbaColorToString(brushPreviewFill),
        fillRadialGradientColorStops: undefined,
        opacity,
        visible: fillVisible,
      });
    }

    // Borders are in screen pixels.
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

    this.hideFillTimeoutId = window.setTimeout(() => {
      this.konva.fillCircle.visible(false);
      this.hideFillTimeoutId = null;
    }, this.config.HIDE_FILL_TIMEOUT_MS);
  };

  setVisibility = (visible: boolean) => {
    this.konva.group.visible(visible);
  };

  /**
   * Sets a fresh soft-brush / soft-eraser buffer at `point` (entity-local), honoring the eraser
   * toggle and pressure. Uses literal `type` discriminants so the payload is assignable to the
   * discriminated `AnyObjectState` union.
   */
  private _setFreshBuffer(
    selectedEntity: NonNullable<ReturnType<CanvasManager['stateApi']['getSelectedEntityAdapter']>>,
    point: Coordinate,
    clip: ReturnType<CanvasToolModule['getClip']> | null,
    pressure?: number
  ): Promise<boolean> {
    const settings = this.manager.stateApi.getSettings();
    const common = {
      strokeWidth: settings.brushWidth,
      hardness: settings.softBrushHardness,
      opacity: settings.softBrushOpacity,
      clip,
    };
    const usePressure = pressure !== undefined;
    const points = usePressure ? [point.x, point.y, pressure] : [point.x, point.y];

    if (settings.softBrushErase) {
      if (usePressure) {
        return selectedEntity.bufferRenderer.setBuffer({
          id: getPrefixedId('soft_eraser_line_with_pressure'),
          type: 'soft_eraser_line_with_pressure',
          points,
          ...common,
        });
      }
      return selectedEntity.bufferRenderer.setBuffer({
        id: getPrefixedId('soft_eraser_line'),
        type: 'soft_eraser_line',
        points,
        ...common,
      });
    }

    const color = this.manager.stateApi.getCurrentColor();
    if (usePressure) {
      return selectedEntity.bufferRenderer.setBuffer({
        id: getPrefixedId('soft_brush_line_with_pressure'),
        type: 'soft_brush_line_with_pressure',
        points,
        color,
        ...common,
      });
    }
    return selectedEntity.bufferRenderer.setBuffer({
      id: getPrefixedId('soft_brush_line'),
      type: 'soft_brush_line',
      points,
      color,
      ...common,
    });
  }

  onStagePointerEnter = async (e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();
    const isPrimaryPointerDown = this.parent.$isPrimaryPointerDown.get();
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!cursorPos || !isPrimaryPointerDown || !selectedEntity) {
      return;
    }

    const settings = this.manager.stateApi.getSettings();
    const normalizedPoint = offsetCoord(cursorPos.relative, selectedEntity.state.position);
    const alignedPoint = alignCoordForTool(normalizedPoint, settings.brushWidth);
    const withPressure = e.evt.pointerType === 'pen' && settings.pressureSensitivity;

    await this._setFreshBuffer(
      selectedEntity,
      alignedPoint,
      this.parent.getClip(selectedEntity.state),
      withPressure ? e.evt.pressure : undefined
    );
  };

  onStagePointerDown = async (e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();
    const isPrimaryPointerDown = this.parent.$isPrimaryPointerDown.get();
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();

    if (!cursorPos || !selectedEntity || !isPrimaryPointerDown) {
      return;
    }

    if (selectedEntity.bufferRenderer.hasBuffer()) {
      selectedEntity.bufferRenderer.commitBuffer();
    }

    const settings = this.manager.stateApi.getSettings();
    const normalizedPoint = offsetCoord(cursorPos.relative, selectedEntity.state.position);
    const alignedPoint = alignCoordForTool(normalizedPoint, settings.brushWidth);
    const withPressure = e.evt.pointerType === 'pen' && settings.pressureSensitivity;

    await this._setFreshBuffer(
      selectedEntity,
      alignedPoint,
      this.parent.getClip(selectedEntity.state),
      withPressure ? e.evt.pressure : undefined
    );
  };

  onStagePointerUp = (_e: KonvaEventObject<PointerEvent>) => {
    const selectedEntity = this.manager.stateApi.getSelectedEntityAdapter();
    if (!selectedEntity) {
      return;
    }
    const bufferType = selectedEntity.bufferRenderer.state?.type;
    if (
      (bufferType === 'soft_brush_line' ||
        bufferType === 'soft_brush_line_with_pressure' ||
        bufferType === 'soft_eraser_line' ||
        bufferType === 'soft_eraser_line_with_pressure') &&
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

    if (
      bufferState.type !== 'soft_brush_line' &&
      bufferState.type !== 'soft_brush_line_with_pressure' &&
      bufferState.type !== 'soft_eraser_line' &&
      bufferState.type !== 'soft_eraser_line_with_pressure'
    ) {
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
      // Do not add duplicate points.
      return;
    }

    bufferState.points.push(alignedPoint.x, alignedPoint.y);

    // Append pressure for pressure-sensitive variants.
    if (
      (bufferState.type === 'soft_brush_line_with_pressure' || bufferState.type === 'soft_eraser_line_with_pressure') &&
      settings.pressureSensitivity
    ) {
      bufferState.points.push(e.evt.pressure);
    }

    await selectedEntity.bufferRenderer.setBuffer(bufferState);
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      config: this.config,
    };
  };

  destroy = () => {
    this.log.debug('Destroying module');
    if (this.hideFillTimeoutId !== null) {
      window.clearTimeout(this.hideFillTimeoutId);
      this.hideFillTimeoutId = null;
    }
    this.konva.group.destroy();
  };
}
