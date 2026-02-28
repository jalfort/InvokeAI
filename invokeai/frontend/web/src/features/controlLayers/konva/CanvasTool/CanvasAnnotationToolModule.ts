import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type { CanvasToolModule } from 'features/controlLayers/konva/CanvasTool/CanvasToolModule';
import { getPrefixedId } from 'features/controlLayers/konva/util';
import type { AnnotationMode } from 'features/controlLayers/store/canvasSettingsSlice';
import {
  annotationLayerAdded,
  annotationObjectAdded,
} from 'features/controlLayers/store/canvasSlice';
import type { CanvasEntityIdentifier, Coordinate } from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { atom } from 'nanostores';
import type { Logger } from 'roarr';

/**
 * CanvasAnnotationToolModule handles mouse interactions for creating annotations.
 *
 * Each sub-tool mode (line, arrow, text, rect, ellipse) has its own draw logic:
 * - Line/Arrow: mousedown sets start, drag updates end, mouseup commits
 * - Text: click places a text object (inline editing comes in Step 5)
 * - Rect/Ellipse: mousedown+drag draws outline, mouseup commits
 *
 * Auto-creates an annotation layer if none exists on first draw.
 */
export class CanvasAnnotationToolModule extends CanvasModuleBase {
  readonly type = 'annotation_tool';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasToolModule;
  readonly manager: CanvasManager;
  readonly log: Logger;

  subscriptions = new Set<() => void>();

  /** The start point of the current draw gesture */
  $startPoint = atom<Coordinate | null>(null);

  /** Preview Konva shape shown during drag */
  private previewShape: Konva.Shape | null = null;

  konva: {
    group: Konva.Group;
  };

  constructor(parent: CanvasToolModule) {
    super();
    this.id = getPrefixedId(this.type);
    this.parent = parent;
    this.manager = parent.manager;
    this.path = this.manager.buildPath(this);
    this.log = this.manager.buildLogger(this);

    this.log.debug('Creating annotation tool module');

    this.konva = {
      group: new Konva.Group({ name: `${this.type}:group`, listening: false }),
    };
  }

  /**
   * Gets or creates the first annotation layer, returning its entity identifier.
   */
  private getOrCreateAnnotationLayer = (): CanvasEntityIdentifier<'annotation_layer'> => {
    const state = this.manager.stateApi.getAnnotationLayersState();
    if (state.entities.length > 0) {
      return { id: state.entities[0]!.id, type: 'annotation_layer' };
    }

    // Create a new annotation layer
    this.manager.stateApi.store.dispatch(annotationLayerAdded({ isSelected: true }));

    // Re-read state to get the new entity
    const newState = this.manager.stateApi.getAnnotationLayersState();
    return { id: newState.entities[0]!.id, type: 'annotation_layer' };
  };

  private getSettings = () => {
    return this.manager.stateApi.getSettings();
  };

  private getMode = (): AnnotationMode => {
    return this.getSettings().annotationMode;
  };

  onStagePointerDown = (_e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();
    if (!cursorPos) {
      return;
    }

    const mode = this.getMode();
    const pos = cursorPos.relative;

    if (mode === 'text') {
      // Text: single click places a text object
      this.commitTextObject(pos);
      return;
    }

    // Line/Arrow/Rect/Ellipse: start drag
    this.$startPoint.set(pos);

    // Create a preview shape
    this.clearPreview();
    const settings = this.getSettings();

    if (mode === 'line') {
      this.previewShape = new Konva.Line({
        points: [pos.x, pos.y, pos.x, pos.y],
        stroke: settings.annotationColor,
        strokeWidth: settings.annotationStrokeWidth,
        lineCap: 'round',
        lineJoin: 'round',
        listening: false,
      });
    } else if (mode === 'arrow') {
      this.previewShape = new Konva.Arrow({
        points: [pos.x, pos.y, pos.x, pos.y],
        stroke: settings.annotationColor,
        strokeWidth: settings.annotationStrokeWidth,
        fill: settings.annotationColor,
        lineCap: 'round',
        lineJoin: 'round',
        pointerLength: settings.annotationStrokeWidth * 4,
        pointerWidth: settings.annotationStrokeWidth * 3,
        listening: false,
      });
    } else if (mode === 'rect') {
      this.previewShape = new Konva.Rect({
        x: pos.x,
        y: pos.y,
        width: 0,
        height: 0,
        stroke: settings.annotationColor,
        strokeWidth: settings.annotationStrokeWidth,
        listening: false,
      });
    } else if (mode === 'ellipse') {
      this.previewShape = new Konva.Ellipse({
        x: pos.x,
        y: pos.y,
        radiusX: 0,
        radiusY: 0,
        stroke: settings.annotationColor,
        strokeWidth: settings.annotationStrokeWidth,
        listening: false,
      });
    }

    if (this.previewShape) {
      this.konva.group.add(this.previewShape);
    }
  };

  onStagePointerMove = (_e: KonvaEventObject<PointerEvent>) => {
    const startPoint = this.$startPoint.get();
    if (!startPoint || !this.previewShape) {
      return;
    }

    const cursorPos = this.parent.$cursorPos.get();
    if (!cursorPos) {
      return;
    }

    const pos = cursorPos.relative;
    const mode = this.getMode();

    if (mode === 'line' || mode === 'arrow') {
      (this.previewShape as Konva.Line).points([startPoint.x, startPoint.y, pos.x, pos.y]);
    } else if (mode === 'rect') {
      const x = Math.min(startPoint.x, pos.x);
      const y = Math.min(startPoint.y, pos.y);
      const w = Math.abs(pos.x - startPoint.x);
      const h = Math.abs(pos.y - startPoint.y);
      this.previewShape.x(x);
      this.previewShape.y(y);
      (this.previewShape as Konva.Rect).width(w);
      (this.previewShape as Konva.Rect).height(h);
    } else if (mode === 'ellipse') {
      const cx = (startPoint.x + pos.x) / 2;
      const cy = (startPoint.y + pos.y) / 2;
      const rx = Math.abs(pos.x - startPoint.x) / 2;
      const ry = Math.abs(pos.y - startPoint.y) / 2;
      this.previewShape.x(cx);
      this.previewShape.y(cy);
      (this.previewShape as Konva.Ellipse).radiusX(rx);
      (this.previewShape as Konva.Ellipse).radiusY(ry);
    }
  };

  onStagePointerUp = (_e: KonvaEventObject<PointerEvent>) => {
    const startPoint = this.$startPoint.get();
    if (!startPoint) {
      return;
    }

    const cursorPos = this.parent.$cursorPos.get();
    if (!cursorPos) {
      this.clearPreview();
      this.$startPoint.set(null);
      return;
    }

    const pos = cursorPos.relative;
    const mode = this.getMode();
    const settings = this.getSettings();

    // Only commit if there's actual size
    const dx = pos.x - startPoint.x;
    const dy = pos.y - startPoint.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < 2) {
      // Too small — discard
      this.clearPreview();
      this.$startPoint.set(null);
      return;
    }

    const entityIdentifier = this.getOrCreateAnnotationLayer();

    if (mode === 'line') {
      this.manager.stateApi.store.dispatch(
        annotationObjectAdded({
          entityIdentifier,
          annotationObject: {
            type: 'annotation_line',
            id: getPrefixedId('annotation_line'),
            points: [startPoint.x, startPoint.y, pos.x, pos.y],
            color: settings.annotationColor,
            strokeWidth: settings.annotationStrokeWidth,
          },
        })
      );
    } else if (mode === 'arrow') {
      this.manager.stateApi.store.dispatch(
        annotationObjectAdded({
          entityIdentifier,
          annotationObject: {
            type: 'annotation_arrow',
            id: getPrefixedId('annotation_arrow'),
            points: [startPoint.x, startPoint.y, pos.x, pos.y],
            color: settings.annotationColor,
            strokeWidth: settings.annotationStrokeWidth,
          },
        })
      );
    } else if (mode === 'rect') {
      const x = Math.min(startPoint.x, pos.x);
      const y = Math.min(startPoint.y, pos.y);
      const w = Math.abs(dx);
      const h = Math.abs(dy);
      this.manager.stateApi.store.dispatch(
        annotationObjectAdded({
          entityIdentifier,
          annotationObject: {
            type: 'annotation_rect',
            id: getPrefixedId('annotation_rect'),
            position: { x, y },
            width: w,
            height: h,
            color: settings.annotationColor,
            strokeWidth: settings.annotationStrokeWidth,
          },
        })
      );
    } else if (mode === 'ellipse') {
      const cx = (startPoint.x + pos.x) / 2;
      const cy = (startPoint.y + pos.y) / 2;
      const rx = Math.abs(dx) / 2;
      const ry = Math.abs(dy) / 2;
      this.manager.stateApi.store.dispatch(
        annotationObjectAdded({
          entityIdentifier,
          annotationObject: {
            type: 'annotation_ellipse',
            id: getPrefixedId('annotation_ellipse'),
            position: { x: cx, y: cy },
            radiusX: rx,
            radiusY: ry,
            color: settings.annotationColor,
            strokeWidth: settings.annotationStrokeWidth,
          },
        })
      );
    }

    this.clearPreview();
    this.$startPoint.set(null);
  };

  private commitTextObject = (pos: Coordinate) => {
    const settings = this.getSettings();
    const entityIdentifier = this.getOrCreateAnnotationLayer();

    this.manager.stateApi.store.dispatch(
      annotationObjectAdded({
        entityIdentifier,
        annotationObject: {
          type: 'annotation_text',
          id: getPrefixedId('annotation_text'),
          position: pos,
          text: 'Text',
          color: settings.annotationColor,
          fontSize: settings.annotationFontSize,
          fontFamily: settings.annotationFontFamily,
        },
      })
    );
  };

  private clearPreview = () => {
    if (this.previewShape) {
      this.previewShape.destroy();
      this.previewShape = null;
    }
  };

  syncCursorStyle = () => {
    this.manager.stage.setCursor('crosshair');
  };

  render = () => {
    // Preview shapes are managed via onStage* handlers
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      startPoint: this.$startPoint.get(),
    };
  };

  destroy = () => {
    this.log.debug('Destroying annotation tool module');
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    this.subscriptions.clear();
    this.clearPreview();
    this.konva.group.destroy();
  };
}
