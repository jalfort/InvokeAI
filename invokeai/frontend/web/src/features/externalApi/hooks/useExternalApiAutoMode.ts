import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import {
  selectActiveInpaintMaskEntities,
  selectActiveRasterLayerEntities,
} from 'features/controlLayers/store/selectors';
import {
  externalApiGenerationModeAutoSet,
  selectExternalApiIsEnabled,
} from 'features/externalApi/store/externalApiSlice';
import { useEffect } from 'react';

export const useExternalApiAutoMode = () => {
  const dispatch = useAppDispatch();
  const isEnabled = useAppSelector(selectExternalApiIsEnabled);
  const activeRasterLayers = useAppSelector(selectActiveRasterLayerEntities);
  const activeInpaintMasks = useAppSelector(selectActiveInpaintMaskEntities);

  const hasCanvasContent = activeRasterLayers.length > 0 || activeInpaintMasks.length > 0;

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    if (hasCanvasContent) {
      dispatch(externalApiGenerationModeAutoSet('edit'));
    } else {
      dispatch(externalApiGenerationModeAutoSet('generate'));
    }
  }, [dispatch, isEnabled, hasCanvasContent]);
};
