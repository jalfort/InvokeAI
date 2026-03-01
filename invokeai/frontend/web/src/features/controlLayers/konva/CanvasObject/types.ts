import type { CanvasObjectBrushLine } from 'features/controlLayers/konva/CanvasObject/CanvasObjectBrushLine';
import type { CanvasObjectBrushLineWithPressure } from 'features/controlLayers/konva/CanvasObject/CanvasObjectBrushLineWithPressure';
import type { CanvasObjectCloneBrushLine } from 'features/controlLayers/konva/CanvasObject/CanvasObjectCloneBrushLine';
import type { CanvasObjectEraserLine } from 'features/controlLayers/konva/CanvasObject/CanvasObjectEraserLine';
import type { CanvasObjectEraserLineWithPressure } from 'features/controlLayers/konva/CanvasObject/CanvasObjectEraserLineWithPressure';
import type { CanvasObjectGradient } from 'features/controlLayers/konva/CanvasObject/CanvasObjectGradient';
import type { CanvasObjectImage } from 'features/controlLayers/konva/CanvasObject/CanvasObjectImage';
import type { CanvasObjectRect } from 'features/controlLayers/konva/CanvasObject/CanvasObjectRect';
import type { CanvasObjectSoftBrushLine } from 'features/controlLayers/konva/CanvasObject/CanvasObjectSoftBrushLine';
import type {
  CanvasBrushLineState,
  CanvasBrushLineWithPressureState,
  CanvasCloneBrushLineState,
  CanvasCloneBrushLineWithPressureState,
  CanvasEraserLineState,
  CanvasEraserLineWithPressureState,
  CanvasGradientState,
  CanvasImageState,
  CanvasRectState,
  CanvasSoftBrushLineState,
  CanvasSoftBrushLineWithPressureState,
  CanvasSoftEraserLineState,
  CanvasSoftEraserLineWithPressureState,
} from 'features/controlLayers/store/types';

/**
 * Union of all object renderers.
 */

export type AnyObjectRenderer =
  | CanvasObjectBrushLine
  | CanvasObjectBrushLineWithPressure
  | CanvasObjectSoftBrushLine
  | CanvasObjectCloneBrushLine
  | CanvasObjectEraserLine
  | CanvasObjectEraserLineWithPressure
  | CanvasObjectRect
  | CanvasObjectImage
  | CanvasObjectGradient;
/**
 * Union of all object states.
 */
export type AnyObjectState =
  | CanvasBrushLineState
  | CanvasBrushLineWithPressureState
  | CanvasSoftBrushLineState
  | CanvasSoftBrushLineWithPressureState
  | CanvasCloneBrushLineState
  | CanvasCloneBrushLineWithPressureState
  | CanvasEraserLineState
  | CanvasEraserLineWithPressureState
  | CanvasSoftEraserLineState
  | CanvasSoftEraserLineWithPressureState
  | CanvasImageState
  | CanvasRectState
  | CanvasGradientState;
