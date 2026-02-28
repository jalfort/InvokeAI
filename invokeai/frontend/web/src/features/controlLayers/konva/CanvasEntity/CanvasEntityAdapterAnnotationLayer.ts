import { createSelector } from '@reduxjs/toolkit';
import { rgbaColorToString } from 'common/util/colorCodeTransformers';
import { deepClone } from 'common/util/deepClone';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import {
  selectIsolatedLayerPreview,
  selectIsolatedStagingPreview,
} from 'features/controlLayers/store/canvasSettingsSlice';
import { getSelectIsTypeHidden, selectCanvasSlice, selectEntity } from 'features/controlLayers/store/selectors';
import type {
  AnnotationObject,
  CanvasAnnotationLayerState,
  CanvasEntityIdentifier,
} from 'features/controlLayers/store/types';
import Konva from 'konva';
import { atom } from 'nanostores';
import type { Logger } from 'roarr';

/**
 * Standalone adapter for annotation layers. Unlike the 4 "drawable" entity types, annotation layers:
 * - Have no position (objects use absolute coordinates)
 * - Have no opacity (each object has its own color)
 * - Don't use pixel buffers (render Konva primitives directly)
 * - Don't need CanvasEntityObjectRenderer, CanvasEntityBufferObjectRenderer, or CanvasEntityTransformer
 */
export class CanvasEntityAdapterAnnotationLayer extends CanvasModuleBase {
  readonly type = 'annotation_layer_adapter';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasManager;
  readonly manager: CanvasManager;
  readonly log: Logger;

  readonly entityIdentifier: CanvasEntityIdentifier<'annotation_layer'>;

  state: CanvasAnnotationLayerState;

  subscriptions = new Set<() => void>();

  /**
   * Map from annotation object ID to its Konva shape node, for O(1) lookup during sync.
   */
  private shapeMap = new Map<string, Konva.Shape | Konva.Label>();

  /** Whether shapes should have listening enabled (set by annotation tool on activate/deactivate) */
  private shapesListening = false;

  $isDisabled = atom(false);
  $isEntityTypeHidden = atom(false);

  konva: {
    layer: Konva.Layer;
    objectGroup: Konva.Group;
  };

  constructor(entityIdentifier: CanvasEntityIdentifier<'annotation_layer'>, manager: CanvasManager) {
    super();
    this.id = entityIdentifier.id;
    this.entityIdentifier = entityIdentifier;
    this.manager = manager;
    this.parent = manager;
    this.path = this.manager.buildPath(this);
    this.log = this.manager.buildLogger(this);

    this.log.debug('Creating annotation layer adapter');

    this.konva = {
      layer: new Konva.Layer({
        name: `${this.type}:layer`,
        listening: false,
        imageSmoothingEnabled: false,
      }),
      objectGroup: new Konva.Group({ name: `${this.type}:objectGroup` }),
    };

    this.konva.layer.add(this.konva.objectGroup);
    this.manager.stage.addLayer(this.konva.layer);

    // Get initial state
    const state = this.manager.stateApi.runSelector(this.selectState);
    if (!state) {
      throw new Error('Missing annotation layer state on creation');
    }
    this.state = state;

    // Subscribe to state changes
    this.subscriptions.add(this.manager.stateApi.createStoreSubscription(this.selectState, this.sync));

    // Subscribe to visibility changes
    const selectIsTypeHidden = getSelectIsTypeHidden('annotation_layer');
    this.subscriptions.add(this.manager.stateApi.createStoreSubscription(selectIsTypeHidden, this.syncVisibility));
    this.subscriptions.add(
      this.manager.stateApi.createStoreSubscription(selectIsolatedLayerPreview, this.syncVisibility)
    );
    this.subscriptions.add(
      this.manager.stateApi.createStoreSubscription(selectIsolatedStagingPreview, this.syncVisibility)
    );
    this.subscriptions.add(this.manager.stagingArea.$isStaging.listen(this.syncVisibility));
    this.subscriptions.add(this.manager.stateApi.$filteringAdapter.listen(this.syncVisibility));
    this.subscriptions.add(this.manager.stateApi.$transformingAdapter.listen(this.syncVisibility));
    this.subscriptions.add(this.manager.stateApi.$segmentingAdapter.listen(this.syncVisibility));
  }

  selectState = createSelector(
    selectCanvasSlice,
    (canvas) => selectEntity(canvas, this.entityIdentifier) as CanvasAnnotationLayerState | undefined
  );

  initialize = () => {
    this.log.debug('Initializing annotation layer adapter');
    this.sync(this.manager.stateApi.runSelector(this.selectState), undefined);
    this.syncVisibility();
  };

  sync = (state: CanvasAnnotationLayerState | undefined, prevState: CanvasAnnotationLayerState | undefined) => {
    if (!state) {
      this.destroy();
      return;
    }

    this.state = state;

    if (prevState && prevState === this.state) {
      return;
    }

    if (!prevState || this.state.isEnabled !== prevState.isEnabled) {
      this.$isDisabled.set(!this.state.isEnabled);
      this.syncVisibility();
    }

    if (!prevState || this.state.objects !== prevState.objects) {
      this.syncObjects();
    }
  };

  /**
   * Diff annotation objects and create/update/remove Konva shapes.
   */
  syncObjects = () => {
    const currentIds = new Set(this.state.objects.map((o) => o.id));

    // Remove shapes that no longer exist in state
    for (const [id, shape] of this.shapeMap) {
      if (!currentIds.has(id)) {
        shape.destroy();
        this.shapeMap.delete(id);
      }
    }

    // Create or update shapes
    for (const obj of this.state.objects) {
      const existing = this.shapeMap.get(obj.id);
      if (existing) {
        this.updateShape(existing, obj);
      } else {
        const shape = this.createShape(obj);
        if (shape) {
          shape.listening(this.shapesListening);
          this.konva.objectGroup.add(shape);
          this.shapeMap.set(obj.id, shape);
        }
      }
    }
  };

  /**
   * Creates a Konva shape from an annotation object.
   */
  createShape = (obj: AnnotationObject): Konva.Shape | Konva.Label | null => {
    const rotation = obj.rotation ?? 0;
    switch (obj.type) {
      case 'annotation_line':
        return new Konva.Line({
          id: obj.id,
          points: obj.points,
          stroke: obj.color,
          strokeWidth: obj.strokeWidth,
          rotation,
          lineCap: 'round',
          lineJoin: 'round',
          hitStrokeWidth: 10,
        });

      case 'annotation_arrow':
        return new Konva.Arrow({
          id: obj.id,
          points: obj.points,
          stroke: obj.color,
          strokeWidth: obj.strokeWidth,
          fill: obj.color,
          rotation,
          lineCap: 'round',
          lineJoin: 'round',
          pointerLength: obj.strokeWidth * 4,
          pointerWidth: obj.strokeWidth * 3,
          hitStrokeWidth: 10,
        });

      case 'annotation_text': {
        const bgEnabled = obj.backgroundEnabled ?? false;
        const bgColor = obj.backgroundColor
          ? rgbaColorToString(obj.backgroundColor)
          : 'rgba(0, 0, 0, 0.8)';
        const padding = obj.padding ?? 8;

        const label = new Konva.Label({
          id: obj.id,
          x: obj.position.x,
          y: obj.position.y,
          rotation,
        });

        label.add(
          new Konva.Tag({
            fill: bgEnabled ? bgColor : 'transparent',
            cornerRadius: 4,
          })
        );

        label.add(
          new Konva.Text({
            text: obj.text,
            fill: obj.color,
            fontSize: obj.fontSize,
            fontFamily: obj.fontFamily,
            fontStyle: obj.fontStyle ?? 'normal',
            padding,
            lineHeight: 1.2,
          })
        );

        return label;
      }

      case 'annotation_rect':
        return new Konva.Rect({
          id: obj.id,
          x: obj.position.x,
          y: obj.position.y,
          width: obj.width,
          height: obj.height,
          stroke: obj.color,
          strokeWidth: obj.strokeWidth,
          rotation,
          hitStrokeWidth: 10,
        });

      case 'annotation_ellipse':
        return new Konva.Ellipse({
          id: obj.id,
          x: obj.position.x,
          y: obj.position.y,
          radiusX: obj.radiusX,
          radiusY: obj.radiusY,
          stroke: obj.color,
          strokeWidth: obj.strokeWidth,
          rotation,
          hitStrokeWidth: 10,
        });

      default:
        return null;
    }
  };

  /**
   * Updates an existing Konva shape to match the annotation object state.
   */
  updateShape = (node: Konva.Shape | Konva.Label, obj: AnnotationObject) => {
    node.rotation(obj.rotation ?? 0);
    switch (obj.type) {
      case 'annotation_line':
        node.x(0);
        node.y(0);
        (node as Konva.Line).points(obj.points);
        (node as Konva.Shape).stroke(obj.color);
        (node as Konva.Shape).strokeWidth(obj.strokeWidth);
        break;

      case 'annotation_arrow':
        node.x(0);
        node.y(0);
        (node as Konva.Arrow).points(obj.points);
        (node as Konva.Shape).stroke(obj.color);
        (node as Konva.Shape).fill(obj.color);
        (node as Konva.Shape).strokeWidth(obj.strokeWidth);
        break;

      case 'annotation_text': {
        const label = node as Konva.Label;
        label.x(obj.position.x);
        label.y(obj.position.y);

        const textNode = label.getText() as Konva.Text;
        textNode.text(obj.text);
        textNode.fill(obj.color);
        textNode.fontSize(obj.fontSize);
        textNode.fontFamily(obj.fontFamily);
        textNode.fontStyle(obj.fontStyle ?? 'normal');
        textNode.padding(obj.padding ?? 8);

        const tag = label.getTag() as Konva.Tag;
        const bgEnabled = obj.backgroundEnabled ?? false;
        const bgColor = obj.backgroundColor
          ? rgbaColorToString(obj.backgroundColor)
          : 'rgba(0, 0, 0, 0.8)';
        tag.fill(bgEnabled ? bgColor : 'transparent');
        break;
      }

      case 'annotation_rect':
        node.x(obj.position.x);
        node.y(obj.position.y);
        (node as Konva.Rect).width(obj.width);
        (node as Konva.Rect).height(obj.height);
        (node as Konva.Shape).stroke(obj.color);
        (node as Konva.Shape).strokeWidth(obj.strokeWidth);
        break;

      case 'annotation_ellipse':
        node.x(obj.position.x);
        node.y(obj.position.y);
        (node as Konva.Ellipse).radiusX(obj.radiusX);
        (node as Konva.Ellipse).radiusY(obj.radiusY);
        (node as Konva.Shape).stroke(obj.color);
        (node as Konva.Shape).strokeWidth(obj.strokeWidth);
        break;
    }
  };

  syncVisibility = () => {
    const selectIsTypeHidden = getSelectIsTypeHidden('annotation_layer');
    if (this.manager.stateApi.runSelector(selectIsTypeHidden)) {
      this.konva.layer.visible(false);
      return;
    }

    if (this.manager.stateApi.runSelector(selectIsolatedStagingPreview)) {
      const isStaging = this.manager.stagingArea.$isStaging.get();
      if (isStaging) {
        this.konva.layer.visible(false);
        return;
      }
    }

    if (this.manager.stateApi.runSelector(selectIsolatedLayerPreview)) {
      const filteringAdapter = this.manager.stateApi.$filteringAdapter.get();
      if (filteringAdapter) {
        this.konva.layer.visible(false);
        return;
      }

      const transformingAdapter = this.manager.stateApi.$transformingAdapter.get();
      if (transformingAdapter && !transformingAdapter.transformer.$silentTransform.get()) {
        this.konva.layer.visible(false);
        return;
      }

      const segmentingAdapter = this.manager.stateApi.$segmentingAdapter.get();
      if (segmentingAdapter) {
        this.konva.layer.visible(false);
        return;
      }
    }

    if (this.$isDisabled.get()) {
      this.konva.layer.visible(false);
      return;
    }

    this.konva.layer.visible(true);
  };

  /**
   * Rasterizes the annotation layer to an HTMLCanvasElement, clipped to the given rect.
   * Used at generation time to bake annotations into the composite image.
   */
  getCanvas = (rect?: { x: number; y: number; width: number; height: number }): HTMLCanvasElement | null => {
    if (this.state.objects.length === 0) {
      return null;
    }

    if (rect) {
      return this.konva.objectGroup.toCanvas({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        pixelRatio: 1,
      });
    }

    return this.konva.objectGroup.toCanvas({ pixelRatio: 1 });
  };

  /**
   * Returns a Konva shape by its annotation object ID, or null if not found.
   */
  getShapeById = (objectId: string): Konva.Shape | Konva.Label | null => {
    return this.shapeMap.get(objectId) ?? null;
  };

  /**
   * Enables or disables listening (hit detection) on all annotation shapes.
   * Also toggles the layer's listening property so hit-tests work.
   */
  setShapeListening = (enabled: boolean) => {
    this.shapesListening = enabled;
    this.konva.layer.listening(enabled);
    for (const shape of this.shapeMap.values()) {
      shape.listening(enabled);
    }
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      entityIdentifier: this.entityIdentifier,
      state: deepClone(this.state),
      shapeCount: this.shapeMap.size,
      isDisabled: this.$isDisabled.get(),
      isEntityTypeHidden: this.$isEntityTypeHidden.get(),
    };
  };

  destroy = () => {
    this.log.debug('Destroying annotation layer adapter');
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    this.subscriptions.clear();
    // Detach all children from the objectGroup WITHOUT destroying them first.
    // The annotation tool's shared Transformer may be a child — removing (not destroying)
    // it here preserves it for use with other annotation layer adapters.
    this.konva.objectGroup.removeChildren();
    for (const shape of this.shapeMap.values()) {
      shape.destroy();
    }
    this.shapeMap.clear();
    this.konva.layer.destroy();
    this.manager.adapters.annotationLayers.delete(this.id);
  };
}
