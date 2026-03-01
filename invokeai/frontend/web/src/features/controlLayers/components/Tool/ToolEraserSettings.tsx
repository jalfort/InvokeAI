import { Flex } from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import {
  selectEraserHardness,
  selectEraserOpacity,
  settingsEraserHardnessChanged,
  settingsEraserOpacityChanged,
} from 'features/controlLayers/store/canvasSettingsSlice';
import { memo, useCallback } from 'react';

import { ToolPercentPicker } from './ToolPercentPicker';
import { ToolWidthPicker } from './ToolWidthPicker';

export const ToolEraserSettings = memo(() => {
  const dispatch = useAppDispatch();
  const hardness = useAppSelector(selectEraserHardness);
  const opacity = useAppSelector(selectEraserOpacity);

  const hardnessValue = Math.round(hardness * 100);
  const opacityValue = Math.round(opacity * 100);

  const onHardnessChange = useCallback(
    (value: number) => {
      dispatch(settingsEraserHardnessChanged(value / 100));
    },
    [dispatch]
  );

  const onOpacityChange = useCallback(
    (value: number) => {
      dispatch(settingsEraserOpacityChanged(value / 100));
    },
    [dispatch]
  );

  return (
    <Flex alignItems="center" gap={4} flexGrow={1}>
      <Flex flexGrow={0} flexShrink={1} flexBasis="320px" minW="280px">
        <ToolWidthPicker />
      </Flex>
      <ToolPercentPicker value={hardnessValue} onChange={onHardnessChange} min={0} defaultValue={100} />
      <ToolPercentPicker value={opacityValue} onChange={onOpacityChange} min={1} defaultValue={100} />
    </Flex>
  );
});

ToolEraserSettings.displayName = 'ToolEraserSettings';
