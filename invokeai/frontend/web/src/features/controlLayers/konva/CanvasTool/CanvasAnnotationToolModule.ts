import { rgbaToHex } from 'common/util/colorCodeTransformers';
import type { CanvasEntityAdapterAnnotationLayer } from 'features/controlLayers/konva/CanvasEntity/CanvasEntityAdapterAnnotationLayer';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import type { CanvasToolModule } from 'features/controlLayers/konva/CanvasTool/CanvasToolModule';
import { getPrefixedId } from 'features/controlLayers/konva/util';
import type { AnnotationMode } from 'features/controlLayers/store/canvasSettingsSlice';
import {
  annotationLayerAdded,
  annotationObjectAdded,
  annotationObjectRemoved,
  annotationObjectUpdated,
} from 'features/controlLayers/store/canvasSlice';
import type { AnnotationObject, CanvasEntityIdentifier, Coordinate } from 'features/controlLayers/store/types';
import Konva from 'konva';
import type { KonvaEventObject } from 'konva/lib/Node';
import { atom } from 'nanostores';
import type { Logger } from 'roarr';

/**
 * CanvasAnnotationToolModule handles mouse interactions for creating and manipulating annotations.
 *
 * Drawing modes (line, arrow, text, rect, ellipse):
 * - Line/Arrow: mousedown sets start, drag updates end, mouseup commits
 * - Text: click opens on-canvas textarea overlay for text input
 * - Rect/Ellipse: mousedown+drag draws outline, mouseup commits
 *
 * Selection & manipulation:
 * - Click an existing annotation → select it (glow + transform handles)
 * - Drag → move selected object
 * - Resize via Konva.Transformer handles
 * - Delete key → remove selected object
 * - Double-click text → re-edit in textarea overlay
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

  /** Active text editing session (ephemeral, not Redux). Null when no text is being edited. */
  $textSession = atom<{ position: Coordinate; text: string; editingObjectId?: string } | null>(null);

  /** Currently selected annotation object ID (ephemeral). */
  $selectedAnnotationId = atom<string | null>(null);

  /** Preview Konva shape shown during drag */
  private previewShape: Konva.Shape | null = null;

  /** Shared Konva.Transformer for selected annotation objects */
  private transformer: Konva.Transformer;

  /** Whether we're currently dragging a selected object (suppresses pointerUp draw commit) */
  private isDraggingSelection = false;

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

    // Create shared transformer (no rotation, all anchor points)
    this.transformer = new Konva.Transformer({
      rotateEnabled: false,
      borderStroke: '#0ea5e9',
      borderStrokeWidth: 1,
      anchorFill: '#0ea5e9',
      anchorStroke: '#fff',
      anchorSize: 8,
      anchorCornerRadius: 2,
      boundBoxFunc: (_oldBox, newBox) => {
        // Prevent negative dimensions
        if (newBox.width < 5) {
          newBox.width = 5;
        }
        if (newBox.height < 5) {
          newBox.height = 5;
        }
        return newBox;
      },
      listening: true,
    });
  }

  /**
   * Gets or creates the first annotation layer, returning its entity identifier.
   */
  getOrCreateAnnotationLayer = (): CanvasEntityIdentifier<'annotation_layer'> => {
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

  /**
   * Finds the annotation layer adapter that contains the given object ID.
   */
  private findAdapterForObject = (objectId: string): CanvasEntityAdapterAnnotationLayer | null => {
    for (const adapter of this.manager.adapters.annotationLayers.values()) {
      if (adapter.state.objects.some((o) => o.id === objectId)) {
        return adapter;
      }
    }
    return null;
  };

  /**
   * Finds the annotation object data by ID across all annotation layers.
   */
  private findAnnotationObject = (objectId: string): { adapter: CanvasEntityAdapterAnnotationLayer; obj: AnnotationObject } | null => {
    for (const adapter of this.manager.adapters.annotationLayers.values()) {
      const obj = adapter.state.objects.find((o) => o.id === objectId);
      if (obj) {
        return { adapter, obj };
      }
    }
    return null;
  };

  // ─── Hit-testing ───────────────────────────────────────────────

  /**
   * Attempts to hit-test annotation shapes under the pointer position.
   * Returns the shape ID if a hit is found, or null.
   */
  private hitTestAnnotations = (pointerPos: Coordinate): string | null => {
    // Use the Konva stage's getIntersection to find any shape at the pointer position
    const stage = this.manager.stage.konva.stage;
    const shape = stage.getIntersection(pointerPos);
    if (!shape || !shape.id()) {
      return null;
    }

    // Check if this shape belongs to an annotation layer
    const shapeId = shape.id();
    for (const adapter of this.manager.adapters.annotationLayers.values()) {
      if (!adapter.state.isEnabled) {
        continue;
      }
      if (adapter.getShapeById(shapeId)) {
        return shapeId;
      }
    }
    return null;
  };

  // ─── Selection management ──────────────────────────────────────

  /**
   * Selects an annotation object: applies glow + attaches transformer.
   */
  selectAnnotation = (objectId: string) => {
    // Clear any previous selection
    this.deselectAnnotation();

    this.$selectedAnnotationId.set(objectId);

    // Find the Konva shape across all annotation layers
    for (const adapter of this.manager.adapters.annotationLayers.values()) {
      const shape = adapter.getShapeById(objectId);
      if (shape) {
        // Apply selection glow
        shape.shadowColor('#0ea5e9');
        shape.shadowBlur(6);
        shape.shadowEnabled(true);
        shape.shadowOpacity(0.8);

        // Enable dragging
        shape.draggable(true);

        // Attach transformer
        this.transformer.nodes([shape]);
        adapter.konva.objectGroup.add(this.transformer);
        this.transformer.moveToTop();

        // Listen for drag events
        shape.on('dragend.annotationSelect', () => this.onShapeDragEnd(shape, adapter));
        // Listen for transform events
        shape.on('transformend.annotationSelect', () => this.onShapeTransformEnd(shape, adapter));
        // Listen for double-click (text re-edit)
        shape.on('dblclick.annotationSelect', () => this.onShapeDoubleClick(objectId));

        break;
      }
    }
  };

  /**
   * Deselects the currently selected annotation object.
   */
  deselectAnnotation = () => {
    const selectedId = this.$selectedAnnotationId.get();
    if (!selectedId) {
      return;
    }

    // Find and un-glow the shape
    for (const adapter of this.manager.adapters.annotationLayers.values()) {
      const shape = adapter.getShapeById(selectedId);
      if (shape) {
        shape.shadowEnabled(false);
        shape.draggable(false);
        shape.off('dragend.annotationSelect');
        shape.off('transformend.annotationSelect');
        shape.off('dblclick.annotationSelect');
        break;
      }
    }

    // Detach transformer
    this.transformer.nodes([]);
    this.transformer.remove();

    this.$selectedAnnotationId.set(null);
  };

  /**
   * Deletes the currently selected annotation object.
   */
  deleteSelectedAnnotation = () => {
    const selectedId = this.$selectedAnnotationId.get();
    if (!selectedId) {
      return;
    }

    const found = this.findAdapterForObject(selectedId);
    if (found) {
      this.deselectAnnotation();
      this.manager.stateApi.store.dispatch(
        annotationObjectRemoved({
          entityIdentifier: found.entityIdentifier,
          objectId: selectedId,
        })
      );
    }
  };

  // ─── Drag & Transform handlers ────────────────────────────────

  private onShapeDragEnd = (shape: Konva.Shape, adapter: CanvasEntityAdapterAnnotationLayer) => {
    const objectId = shape.id();
    const found = this.findAnnotationObject(objectId);
    if (!found) {
      return;
    }

    const { obj } = found;

    // Commit new position to Redux based on object type
    if (obj.type === 'annotation_line' || obj.type === 'annotation_arrow') {
      // Lines/arrows: offset all points by the drag delta
      const dx = shape.x();
      const dy = shape.y();
      const oldPoints = obj.points;
      const newPoints: number[] = [];
      for (let i = 0; i < oldPoints.length; i += 2) {
        newPoints.push(oldPoints[i]! + dx, oldPoints[i + 1]! + dy);
      }
      // Reset shape position (points are now absolute)
      shape.x(0);
      shape.y(0);

      this.manager.stateApi.store.dispatch(
        annotationObjectUpdated({
          entityIdentifier: adapter.entityIdentifier,
          objectId,
          changes: { points: newPoints } as Partial<AnnotationObject>,
        })
      );
    } else if (obj.type === 'annotation_text' || obj.type === 'annotation_rect' || obj.type === 'annotation_ellipse') {
      this.manager.stateApi.store.dispatch(
        annotationObjectUpdated({
          entityIdentifier: adapter.entityIdentifier,
          objectId,
          changes: { position: { x: shape.x(), y: shape.y() } } as Partial<AnnotationObject>,
        })
      );
    }
  };

  private onShapeTransformEnd = (shape: Konva.Shape, adapter: CanvasEntityAdapterAnnotationLayer) => {
    const objectId = shape.id();
    const found = this.findAnnotationObject(objectId);
    if (!found) {
      return;
    }

    const { obj } = found;
    const scaleX = shape.scaleX();
    const scaleY = shape.scaleY();

    if (obj.type === 'annotation_line' || obj.type === 'annotation_arrow') {
      // Scale all points, then reset scale
      const dx = shape.x();
      const dy = shape.y();
      const oldPoints = obj.points;
      const newPoints: number[] = [];
      for (let i = 0; i < oldPoints.length; i += 2) {
        newPoints.push(oldPoints[i]! * scaleX + dx, oldPoints[i + 1]! * scaleY + dy);
      }
      shape.scaleX(1);
      shape.scaleY(1);
      shape.x(0);
      shape.y(0);

      this.manager.stateApi.store.dispatch(
        annotationObjectUpdated({
          entityIdentifier: adapter.entityIdentifier,
          objectId,
          changes: { points: newPoints } as Partial<AnnotationObject>,
        })
      );
    } else if (obj.type === 'annotation_rect') {
      const newWidth = obj.width * scaleX;
      const newHeight = obj.height * scaleY;
      shape.scaleX(1);
      shape.scaleY(1);

      this.manager.stateApi.store.dispatch(
        annotationObjectUpdated({
          entityIdentifier: adapter.entityIdentifier,
          objectId,
          changes: {
            position: { x: shape.x(), y: shape.y() },
            width: newWidth,
            height: newHeight,
          } as Partial<AnnotationObject>,
        })
      );
    } else if (obj.type === 'annotation_ellipse') {
      const newRadiusX = obj.radiusX * scaleX;
      const newRadiusY = obj.radiusY * scaleY;
      shape.scaleX(1);
      shape.scaleY(1);

      this.manager.stateApi.store.dispatch(
        annotationObjectUpdated({
          entityIdentifier: adapter.entityIdentifier,
          objectId,
          changes: {
            position: { x: shape.x(), y: shape.y() },
            radiusX: newRadiusX,
            radiusY: newRadiusY,
          } as Partial<AnnotationObject>,
        })
      );
    } else if (obj.type === 'annotation_text') {
      const newFontSize = Math.round(obj.fontSize * scaleY);
      shape.scaleX(1);
      shape.scaleY(1);

      this.manager.stateApi.store.dispatch(
        annotationObjectUpdated({
          entityIdentifier: adapter.entityIdentifier,
          objectId,
          changes: {
            position: { x: shape.x(), y: shape.y() },
            fontSize: Math.max(8, newFontSize),
          } as Partial<AnnotationObject>,
        })
      );
    }
  };

  private onShapeDoubleClick = (objectId: string) => {
    const found = this.findAnnotationObject(objectId);
    if (!found || found.obj.type !== 'annotation_text') {
      return;
    }

    // Deselect the shape and start a text editing session pre-filled with existing text
    this.deselectAnnotation();
    this.$textSession.set({
      position: found.obj.position,
      text: found.obj.text,
      editingObjectId: objectId,
    });
  };

  // ─── Keyboard handler ─────────────────────────────────────────

  onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const selectedId = this.$selectedAnnotationId.get();
      // Only handle Delete if we have a selected annotation and no text session is active
      if (selectedId && !this.$textSession.get()) {
        e.preventDefault();
        this.deleteSelectedAnnotation();
      }
    } else if (e.key === 'Escape') {
      if (this.$textSession.get()) {
        this.cancelTextSession();
      } else if (this.$selectedAnnotationId.get()) {
        this.deselectAnnotation();
      }
    }
  };

  // ─── Pointer event handlers ────────────────────────────────────

  onStagePointerDown = (_e: KonvaEventObject<PointerEvent>) => {
    const cursorPos = this.parent.$cursorPos.get();
    if (!cursorPos) {
      return;
    }

    const mode = this.getMode();
    const pos = cursorPos.relative;

    if (mode === 'text') {
      // If there's an active text session, commit it first (click-away = commit)
      if (this.$textSession.get()) {
        this.commitTextSession();
      }
      // Start a new text editing session at the click position
      this.$textSession.set({ position: pos, text: '' });
      return;
    }

    // Hit-test existing annotations before starting a new draw
    const stage = this.manager.stage.konva.stage;
    const pointerPosition = stage.getPointerPosition();
    if (pointerPosition) {
      // Check if clicking on the transformer's anchors first (let it handle resize)
      const clickedOnTransformer = _e.target?.getParent()?.className === 'Transformer' ||
        _e.target?.className === 'Transformer';
      if (clickedOnTransformer) {
        this.isDraggingSelection = true;
        return;
      }

      const hitId = this.hitTestAnnotations(pointerPosition);
      if (hitId) {
        // Clicked on an existing annotation — select it
        this.selectAnnotation(hitId);
        this.isDraggingSelection = true;
        return;
      }
    }

    // No hit — deselect any current selection and start drawing
    this.deselectAnnotation();
    this.isDraggingSelection = false;

    // Line/Arrow/Rect/Ellipse: start drag
    this.$startPoint.set(pos);

    // Create a preview shape
    this.clearPreview();
    const settings = this.getSettings();
    const colorHex = rgbaToHex(settings.annotationColor);

    if (mode === 'line') {
      this.previewShape = new Konva.Line({
        points: [pos.x, pos.y, pos.x, pos.y],
        stroke: colorHex,
        strokeWidth: settings.annotationStrokeWidth,
        lineCap: 'round',
        lineJoin: 'round',
        listening: false,
      });
    } else if (mode === 'arrow') {
      this.previewShape = new Konva.Arrow({
        points: [pos.x, pos.y, pos.x, pos.y],
        stroke: colorHex,
        strokeWidth: settings.annotationStrokeWidth,
        fill: colorHex,
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
        stroke: colorHex,
        strokeWidth: settings.annotationStrokeWidth,
        listening: false,
      });
    } else if (mode === 'ellipse') {
      this.previewShape = new Konva.Ellipse({
        x: pos.x,
        y: pos.y,
        radiusX: 0,
        radiusY: 0,
        stroke: colorHex,
        strokeWidth: settings.annotationStrokeWidth,
        listening: false,
      });
    }

    if (this.previewShape) {
      this.konva.group.add(this.previewShape);
    }
  };

  onStagePointerMove = (_e: KonvaEventObject<PointerEvent>) => {
    // If dragging a selected object, Konva handles it — nothing to do
    if (this.isDraggingSelection) {
      return;
    }

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
    // If we were dragging a selected object, just reset the flag
    if (this.isDraggingSelection) {
      this.isDraggingSelection = false;
      return;
    }

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
    const colorHex = rgbaToHex(settings.annotationColor);

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
            color: colorHex,
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
            color: colorHex,
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
            color: colorHex,
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
            color: colorHex,
            strokeWidth: settings.annotationStrokeWidth,
          },
        })
      );
    }

    this.clearPreview();
    this.$startPoint.set(null);
  };

  // ─── Text session management ───────────────────────────────────

  /**
   * Commits the active text session, creating or updating an annotation text object.
   */
  commitTextSession = () => {
    const session = this.$textSession.get();
    if (!session) {
      return;
    }

    const trimmed = session.text.trim();
    if (trimmed.length > 0) {
      const settings = this.getSettings();
      const colorHex = rgbaToHex(settings.annotationColor);

      if (session.editingObjectId) {
        // Re-editing an existing text object — update it
        const found = this.findAdapterForObject(session.editingObjectId);
        if (found) {
          this.manager.stateApi.store.dispatch(
            annotationObjectUpdated({
              entityIdentifier: found.entityIdentifier,
              objectId: session.editingObjectId,
              changes: { text: trimmed } as Partial<AnnotationObject>,
            })
          );
        }
      } else {
        // New text object
        const entityIdentifier = this.getOrCreateAnnotationLayer();
        this.manager.stateApi.store.dispatch(
          annotationObjectAdded({
            entityIdentifier,
            annotationObject: {
              type: 'annotation_text',
              id: getPrefixedId('annotation_text'),
              position: session.position,
              text: trimmed,
              color: colorHex,
              fontSize: settings.annotationFontSize,
              fontFamily: settings.annotationFontFamily,
            },
          })
        );
      }
    }

    this.$textSession.set(null);
  };

  /**
   * Cancels the active text session without creating an annotation object.
   */
  cancelTextSession = () => {
    this.$textSession.set(null);
  };

  // ─── Lifecycle ─────────────────────────────────────────────────

  private clearPreview = () => {
    if (this.previewShape) {
      this.previewShape.destroy();
      this.previewShape = null;
    }
  };

  /**
   * Enables listening on all annotation shapes (call when annotate tool activates).
   */
  enableShapeListening = () => {
    for (const adapter of this.manager.adapters.annotationLayers.values()) {
      adapter.setShapeListening(true);
    }
  };

  /**
   * Disables listening on all annotation shapes (call when switching away from annotate tool).
   */
  disableShapeListening = () => {
    this.deselectAnnotation();
    for (const adapter of this.manager.adapters.annotationLayers.values()) {
      adapter.setShapeListening(false);
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
      selectedAnnotationId: this.$selectedAnnotationId.get(),
    };
  };

  destroy = () => {
    this.log.debug('Destroying annotation tool module');
    this.deselectAnnotation();
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    this.subscriptions.clear();
    this.clearPreview();
    this.transformer.destroy();
    this.konva.group.destroy();
  };
}
