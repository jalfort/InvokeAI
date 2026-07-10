import { deepClone } from 'common/util/deepClone';
// FORK (Phase B): soft + clone brush renderers, and helpers to persist a baked clone stroke.
import { CanvasObjectCloneBrushLine } from 'features/controlLayers/fork/brush/CanvasObjectCloneBrushLine';
import { CanvasObjectSoftBrushLine } from 'features/controlLayers/fork/brush/CanvasObjectSoftBrushLine';
import type { CanvasEntityAdapter } from 'features/controlLayers/konva/CanvasEntity/types';
import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { CanvasModuleBase } from 'features/controlLayers/konva/CanvasModuleBase';
import { CanvasObjectBrushLine } from 'features/controlLayers/konva/CanvasObject/CanvasObjectBrushLine';
import { CanvasObjectBrushLineWithPressure } from 'features/controlLayers/konva/CanvasObject/CanvasObjectBrushLineWithPressure';
import { CanvasObjectEraserLine } from 'features/controlLayers/konva/CanvasObject/CanvasObjectEraserLine';
import { CanvasObjectEraserLineWithPressure } from 'features/controlLayers/konva/CanvasObject/CanvasObjectEraserLineWithPressure';
import { CanvasObjectGradient } from 'features/controlLayers/konva/CanvasObject/CanvasObjectGradient';
import { CanvasObjectImage } from 'features/controlLayers/konva/CanvasObject/CanvasObjectImage';
import { CanvasObjectLasso } from 'features/controlLayers/konva/CanvasObject/CanvasObjectLasso';
import { CanvasObjectOval } from 'features/controlLayers/konva/CanvasObject/CanvasObjectOval';
import { CanvasObjectPolygon } from 'features/controlLayers/konva/CanvasObject/CanvasObjectPolygon';
import { CanvasObjectRect } from 'features/controlLayers/konva/CanvasObject/CanvasObjectRect';
import type { AnyObjectRenderer, AnyObjectState } from 'features/controlLayers/konva/CanvasObject/types';
import { shouldPreserveSuspendableShapesSession } from 'features/controlLayers/konva/CanvasTool/toolHotkeys';
import { canvasToBlob, getPrefixedId } from 'features/controlLayers/konva/util';
import type { CanvasEntityIdentifier } from 'features/controlLayers/store/types';
import { imageDTOToImageObject } from 'features/controlLayers/store/util';
import Konva from 'konva';
import type { Logger } from 'roarr';
import { uploadImage } from 'services/api/endpoints/images';
import { assert } from 'tsafe';

/**
 * Handles rendering of objects for a canvas entity.
 */
export class CanvasEntityBufferObjectRenderer extends CanvasModuleBase {
  readonly type = 'buffer_renderer';
  readonly id: string;
  readonly path: string[];
  readonly parent: CanvasEntityAdapter;
  readonly manager: CanvasManager;
  readonly log: Logger;

  /**
   * A set of subscriptions that should be cleaned up when the transformer is destroyed.
   */
  subscriptions: Set<() => void> = new Set();

  /**
   * A buffer object state that is rendered separately from the other objects. This is used for objects that are being
   * drawn in real-time, such as brush lines. The buffer object state only exists in this renderer and is not part of
   * the application state until it is committed.
   */
  state: AnyObjectState | null = null;

  /**
   * The object renderer for the buffer object state. It is created when the buffer object state is set and destroyed
   * when the buffer object state is cleared. This is separate from the other object renderers to allow the buffer to
   * be rendered separately.
   */
  renderer: AnyObjectRenderer | null = null;

  /**
   * A object containing singleton Konva nodes.
   */
  konva: {
    /**
     * A Konva Group that holds the buffer object renderer.
     */
    group: Konva.Group;
  };

  constructor(parent: CanvasEntityAdapter) {
    super();
    this.id = getPrefixedId(this.type);
    this.parent = parent;
    this.manager = parent.manager;
    this.path = this.manager.buildPath(this);
    this.log = this.manager.buildLogger(this);
    this.log.debug('Creating module');

    this.konva = {
      group: new Konva.Group({ name: `${this.type}:buffer_group`, listening: false }),
    };

    this.parent.konva.layer.add(this.konva.group);

    /**
     * When switching tool, commit the buffer. This is necessary to prevent the buffer from being lost when the
     * user switches tool mid-drawing, for example by pressing space to pan the stage. It's easy to press space
     * to pan _before_ releasing the mouse button, which would cause the buffer to be lost if we didn't commit it.
     *
     * But! We should only do this if we are not "busy". "Busy" means the canvas may be filtering or transforming
     * a layer, and may be using the buffer object! So, we should not commit the buffer in that case, and let the
     * filter or transformer handle it.
     */
    this.subscriptions.add(
      this.manager.tool.$tool.listen(() => {
        if (this.hasBuffer() && !this.manager.$isBusy.get()) {
          const isTemporaryShapesToolSwitch = shouldPreserveSuspendableShapesSession(
            this.manager.tool.$tool.get(),
            this.manager.tool.$toolBuffer.get(),
            this.manager.tool.tools.rect.hasSuspendableSession()
          );

          if (isTemporaryShapesToolSwitch) {
            return;
          }

          if (this.state?.type === 'polygon' && this.state.previewPoint) {
            this.clearBuffer();
            return;
          }

          this.commitBuffer();
        }
      })
    );
  }

  /**
   * Renders the buffer object. If the buffer renderer does not exist, it will be created and its Konva group added to the
   * parent entity's buffer object group.
   * @returns A promise that resolves to a boolean, indicating if the object was rendered.
   */
  renderBufferObject = async (): Promise<boolean> => {
    let didRender = false;

    if (!this.state) {
      return false;
    }

    // If we are creating a new renderer, we need to destroy the old one. But, to prevent a flicker, we only destroy
    // it after the new renderer has been created and rendered.
    let rendererToDestroy: AnyObjectRenderer | null = null;
    if (this.renderer && this.renderer.id !== this.state.id) {
      rendererToDestroy = this.renderer;
      this.renderer = null;
    }

    if (this.state.type === 'brush_line') {
      assert(this.renderer instanceof CanvasObjectBrushLine || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectBrushLine(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (this.state.type === 'brush_line_with_pressure') {
      assert(this.renderer instanceof CanvasObjectBrushLineWithPressure || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectBrushLineWithPressure(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (
      // FORK (Phase B): one renderer handles all 4 soft brush/eraser variants.
      this.state.type === 'soft_brush_line' ||
      this.state.type === 'soft_brush_line_with_pressure' ||
      this.state.type === 'soft_eraser_line' ||
      this.state.type === 'soft_eraser_line_with_pressure'
    ) {
      assert(this.renderer instanceof CanvasObjectSoftBrushLine || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectSoftBrushLine(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (
      // FORK (Phase B): clone brush live buffer (2 variants, one renderer).
      this.state.type === 'clone_brush_line' ||
      this.state.type === 'clone_brush_line_with_pressure'
    ) {
      assert(this.renderer instanceof CanvasObjectCloneBrushLine || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectCloneBrushLine(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (this.state.type === 'eraser_line') {
      assert(this.renderer instanceof CanvasObjectEraserLine || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectEraserLine(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (this.state.type === 'eraser_line_with_pressure') {
      assert(this.renderer instanceof CanvasObjectEraserLineWithPressure || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectEraserLineWithPressure(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (this.state.type === 'rect') {
      assert(this.renderer instanceof CanvasObjectRect || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectRect(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (this.state.type === 'oval') {
      assert(this.renderer instanceof CanvasObjectOval || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectOval(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (this.state.type === 'polygon') {
      assert(this.renderer instanceof CanvasObjectPolygon || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectPolygon(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (this.state.type === 'lasso') {
      assert(this.renderer instanceof CanvasObjectLasso || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectLasso(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (this.state.type === 'gradient') {
      assert(this.renderer instanceof CanvasObjectGradient || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectGradient(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }

      didRender = this.renderer.update(this.state, true);
    } else if (this.state.type === 'image') {
      assert(this.renderer instanceof CanvasObjectImage || !this.renderer);

      if (!this.renderer) {
        this.renderer = new CanvasObjectImage(this.state, this);
        this.konva.group.add(this.renderer.konva.group);
      }
      didRender = await this.renderer.update(this.state, true);
    }

    if (rendererToDestroy) {
      rendererToDestroy.destroy();
    }

    return didRender;
  };

  /**
   * Determines if the renderer has a buffer object to render.
   * @returns Whether the renderer has a buffer object to render.
   */
  hasBuffer = (): boolean => {
    return this.state !== null || this.renderer !== null;
  };

  /**
   * Sets the buffer object state to render.
   * @param objectState The object state to set as the buffer.
   * @param resetBufferOffset Whether to reset the buffer's offset to 0,0. This is necessary when previewing filters.
   * When previewing a filter, the buffer object is an image of the same size as the entity, so it should be rendered
   * at the top-left corner of the entity.
   * @returns A promise that resolves to a boolean, indicating if the object was rendered.
   */
  setBuffer = async (objectState: AnyObjectState, resetBufferOffset: boolean = false): Promise<boolean> => {
    this.log.trace('Setting buffer');

    this.state = objectState;
    if (resetBufferOffset) {
      this.konva.group.offset({ x: 0, y: 0 });
    }
    return await this.renderBufferObject();
  };

  /**
   * Clears the buffer object state.
   */
  clearBuffer = () => {
    if (this.state || this.renderer) {
      this.log.trace('Clearing buffer');
      this.renderer?.destroy();
      this.renderer = null;
      this.state = null;
    }
  };

  /**
   * Commits the current buffer object, pushing the buffer object state back to the application state.
   */
  commitBuffer = (options?: { pushToState?: boolean }) => {
    // FORK (Phase B): upstream ships `{ ...options, pushToState: true }`, which ALWAYS forces
    // pushToState true (a latent bug) — harmless until a brush case lands in the commit switch, then
    // it double-pushes committed strokes. Spread options LAST so an explicit `pushToState: false`
    // (used by the async image-commit path below) is honoured.
    const { pushToState = true } = options ?? {};

    if (!this.state || !this.renderer) {
      this.log.trace('No buffer to commit');
      return;
    }

    this.log.trace({ buffer: this.renderer.repr() }, 'Committing buffer');

    let committedState = this.state;

    // Polygon previews render an outline while they are still live in the buffer.
    // Clear that preview state before adopting the renderer into the persistent object group.
    if (committedState.type === 'polygon' && this.renderer instanceof CanvasObjectPolygon) {
      committedState = { ...committedState, previewPoint: undefined };
      this.state = null;
      this.renderer.update(committedState, true);
    }

    // FORK (Phase B): soft + clone brush renderers use a custom sceneFunc Shape that does NOT survive
    // Konva's clone() (used by the transformer / rasterization). Bake the stroke into a Konva.Image so
    // the adopted node clones correctly. Done before/after adopt is equivalent (swaps the shape inside
    // the already-moved group).
    if (this.renderer instanceof CanvasObjectSoftBrushLine || this.renderer instanceof CanvasObjectCloneBrushLine) {
      this.renderer.rasterizeToImage();
    }

    // FORK (Phase B): the clone stroke cannot persist as a `clone_brush_line` (it has no meaning on
    // reload without its source snapshot, and 6.13 keeps clone states buffer-only). Capture the baked
    // canvas now (before the renderer is cleared) and commit it asynchronously as an `image` object.
    let cloneBaked: { canvas: HTMLCanvasElement; x: number; y: number } | null = null;
    if (
      pushToState &&
      this.renderer instanceof CanvasObjectCloneBrushLine &&
      (committedState.type === 'clone_brush_line' || committedState.type === 'clone_brush_line_with_pressure')
    ) {
      cloneBaked = this.renderer.getBakedCanvas();
    }

    // Move the buffer to the persistent objects group/renderers
    this.parent.renderer.adoptObjectRenderer(this.renderer);

    if (pushToState) {
      const entityIdentifier = this.parent.entityIdentifier;
      switch (committedState.type) {
        case 'brush_line':
        case 'brush_line_with_pressure':
          this.manager.stateApi.addBrushLine({ entityIdentifier, brushLine: committedState });
          break;
        case 'eraser_line':
        case 'eraser_line_with_pressure':
          this.manager.stateApi.addEraserLine({ entityIdentifier, eraserLine: committedState });
          break;
        // FORK (Phase B): persist the soft brush/eraser line (points are entity-local, position-correct).
        case 'soft_brush_line':
        case 'soft_brush_line_with_pressure':
        case 'soft_eraser_line':
        case 'soft_eraser_line_with_pressure':
          this.manager.stateApi.addSoftBrushLine({ entityIdentifier, softBrushLine: committedState });
          break;
        // FORK (Phase B): clone stroke persists as a baked image (async, see cloneBaked above).
        case 'clone_brush_line':
        case 'clone_brush_line_with_pressure':
          if (cloneBaked) {
            void this.commitCloneStrokeAsImage(entityIdentifier, cloneBaked);
          }
          break;
        case 'rect':
        case 'oval':
        case 'polygon':
          this.manager.stateApi.addShape({ entityIdentifier, shape: committedState });
          break;
        case 'lasso':
          this.manager.stateApi.addLasso({ entityIdentifier, lasso: committedState });
          break;
        case 'gradient':
          this.manager.stateApi.addGradient({ entityIdentifier, gradient: committedState });
          break;
      }
    }

    this.renderer = null;
    this.state = null;
  };

  /**
   * FORK (Phase B): Persists a baked clone-brush stroke as an `image` object on the target entity.
   *
   * The baked stroke canvas is clip-sized and sits at entity-local origin `(baked.x, baked.y)`. Image
   * objects render at the entity origin `(0,0)` with no position field, so we re-draw the stroke onto
   * a 0-origin canvas at its entity-local offset before uploading. Non-negative offsets (the common
   * `clipToBbox` case) are exact; a negative offset only clips the transparent falloff pad (≤ brush
   * radius) off the top/left, never painted content. The adopted baked Konva.Image keeps the stroke
   * visible until this async add re-renders the entity.
   */
  private commitCloneStrokeAsImage = async (
    entityIdentifier: CanvasEntityIdentifier,
    baked: { canvas: HTMLCanvasElement; x: number; y: number }
  ): Promise<void> => {
    try {
      const width = Math.max(1, Math.ceil(baked.x + baked.canvas.width));
      const height = Math.max(1, Math.ceil(baked.y + baked.canvas.height));
      const positioned = document.createElement('canvas');
      positioned.width = width;
      positioned.height = height;
      const ctx = positioned.getContext('2d');
      if (!ctx) {
        return;
      }
      ctx.drawImage(baked.canvas, baked.x, baked.y);

      const blob = await canvasToBlob(positioned);
      const imageDTO = await uploadImage({
        file: new File([blob], 'clone_brush_stroke.png', { type: 'image/png' }),
        image_category: 'other',
        is_intermediate: true,
        silent: true,
      });
      const imageObject = imageDTOToImageObject(imageDTO);
      this.manager.stateApi.addImage({ entityIdentifier, imageObject });
    } catch (error) {
      this.log.error({ error: String(error) }, 'Failed to commit clone brush stroke as image');
    }
  };

  destroy = () => {
    this.log.debug('Destroying module');
    this.subscriptions.forEach((unsubscribe) => unsubscribe());
    this.subscriptions.clear();
    if (this.renderer) {
      this.renderer.destroy();
    }
  };

  repr = () => {
    return {
      id: this.id,
      type: this.type,
      path: this.path,
      parent: this.parent.id,
      bufferState: deepClone(this.state),
      bufferRenderer: this.renderer?.repr() ?? null,
    };
  };
}
