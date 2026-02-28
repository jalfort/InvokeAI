import type { CanvasManager } from 'features/controlLayers/konva/CanvasManager';
import { canvasToBlob, canvasToImageData, getImageDataTransparency } from 'features/controlLayers/konva/util';
import type { Rect } from 'features/controlLayers/store/types';
import { requestTransparencyFill } from 'features/externalApi/store/transparencyFillAtom';
import { uploadImage } from 'services/api/endpoints/images';
import type { ImageDTO } from 'services/api/types';

const EXTERNAL_API_DOWNSCALE_FACTOR = 0.75;

/**
 * Prepares the canvas composite for external API submission:
 * 1. Composites visible raster layers within the bbox
 * 2. Checks for transparency — if found, shows Fill White/Black/Cancel dialog
 * 3. Overlays annotation layers (text, arrows, shapes) onto the composite
 * 4. Downscales to 75% to force the API to regenerate detail at output resolution
 * 5. Uploads and returns ImageDTO
 *
 * Returns null if no visible raster content exists.
 * Throws GenerationCancelledError if user cancels the transparency dialog.
 */
export const prepareCanvasComposite = async (manager: CanvasManager, rect: Rect): Promise<ImageDTO | null> => {
  const rasterAdapters = manager.compositor.getVisibleAdaptersOfType('raster_layer');
  if (rasterAdapters.length === 0) {
    return null;
  }

  const compositeCanvas = manager.compositor.getCompositeCanvas(rasterAdapters, rect);
  const imageData = canvasToImageData(compositeCanvas);
  const transparency = getImageDataTransparency(imageData);

  if (transparency === 'FULLY_TRANSPARENT') {
    return null;
  }

  let processedCanvas = compositeCanvas;

  // Handle transparency: show dialog for user to choose fill color
  if (transparency === 'PARTIALLY_TRANSPARENT') {
    const fillColor = await requestTransparencyFill(); // throws GenerationCancelledError on cancel

    const flattened = document.createElement('canvas');
    flattened.width = compositeCanvas.width;
    flattened.height = compositeCanvas.height;
    const ctx = flattened.getContext('2d')!;
    ctx.fillStyle = fillColor;
    ctx.fillRect(0, 0, flattened.width, flattened.height);
    ctx.drawImage(compositeCanvas, 0, 0);
    processedCanvas = flattened;
  }

  // Overlay annotations (text, arrows, shapes) on top of the raster composite
  manager.compositor.overlayAnnotationsOnCanvas(processedCanvas, rect);

  // Downscale to 75% — forces the API to regenerate detail at its configured output resolution
  // rather than passing through the same pixels, preventing quality degradation on iterative edits
  const scaledWidth = Math.round(processedCanvas.width * EXTERNAL_API_DOWNSCALE_FACTOR);
  const scaledHeight = Math.round(processedCanvas.height * EXTERNAL_API_DOWNSCALE_FACTOR);

  const downscaled = document.createElement('canvas');
  downscaled.width = scaledWidth;
  downscaled.height = scaledHeight;
  const dsCtx = downscaled.getContext('2d')!;
  dsCtx.imageSmoothingEnabled = true;
  dsCtx.imageSmoothingQuality = 'high';
  dsCtx.drawImage(processedCanvas, 0, 0, scaledWidth, scaledHeight);

  // Upload using same pattern as CanvasCompositorModule.getCompositeImageDTO
  const blob = await canvasToBlob(downscaled);
  const imageDTO = await uploadImage({
    file: new File([blob], 'canvas-composite.png', { type: 'image/png' }),
    image_category: 'general',
    is_intermediate: true,
  });

  return imageDTO;
};
