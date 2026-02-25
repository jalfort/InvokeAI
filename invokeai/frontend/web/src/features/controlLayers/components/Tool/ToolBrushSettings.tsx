import { Flex } from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import {
  selectBrushHardness,
  selectBrushOpacity,
  settingsBrushHardnessChanged,
  settingsBrushOpacityChanged,
} from 'features/controlLayers/store/canvasSettingsSlice';
import { memo, useCallback } from 'react';

import { ToolPercentPicker } from './ToolPercentPicker';
import { ToolWidthPicker } from './ToolWidthPicker';

export const ToolBrushSettings = memo(() => {
  const dispatch = useAppDispatch();
  const hardness = useAppSelector(selectBrushHardness);
  const opacity = useAppSelector(selectBrushOpacity);

  const hardnessValue = Math.round(hardness * 100);
  const opacityValue = Math.round(opacity * 100);

  const onHardnessChange = useCallback(
    (value: number) => {
      dispatch(settingsBrushHardnessChanged(value / 100));
    },
    [dispatch]
  );

  const onOpacityChange = useCallback(
    (value: number) => {
      dispatch(settingsBrushOpacityChanged(value / 100));
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

ToolBrushSettings.displayName = 'ToolBrushSettings';
