import { ButtonGroup, Flex, IconButton, Tooltip } from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import {
  selectBrushHardness,
  selectBrushOpacity,
  selectCloneBrushAlignedMode,
  selectCloneBrushSampleMode,
  settingsBrushHardnessChanged,
  settingsBrushOpacityChanged,
  settingsCloneBrushAlignedModeToggled,
  settingsCloneBrushSampleModeChanged,
} from 'features/controlLayers/store/canvasSettingsSlice';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PiLinkSimpleBold, PiLinkSimpleBreakBold, PiSquareBold, PiStackBold } from 'react-icons/pi';

import { ToolPercentPicker } from './ToolPercentPicker';
import { ToolWidthPicker } from './ToolWidthPicker';

export const ToolCloneBrushSettings = memo(() => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const hardness = useAppSelector(selectBrushHardness);
  const opacity = useAppSelector(selectBrushOpacity);
  const alignedMode = useAppSelector(selectCloneBrushAlignedMode);
  const sampleMode = useAppSelector(selectCloneBrushSampleMode);

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

  const toggleAlignedMode = useCallback(() => {
    dispatch(settingsCloneBrushAlignedModeToggled());
  }, [dispatch]);

  const setSampleCurrentLayer = useCallback(() => {
    dispatch(settingsCloneBrushSampleModeChanged('current_layer'));
  }, [dispatch]);

  const setSampleCurrentAndBelow = useCallback(() => {
    dispatch(settingsCloneBrushSampleModeChanged('current_and_below'));
  }, [dispatch]);

  return (
    <Flex alignItems="center" gap={4} flexGrow={1}>
      <Flex flexGrow={0} flexShrink={1} flexBasis="320px" minW="280px">
        <ToolWidthPicker />
      </Flex>
      <ToolPercentPicker value={hardnessValue} onChange={onHardnessChange} min={0} defaultValue={100} />
      <ToolPercentPicker value={opacityValue} onChange={onOpacityChange} min={1} defaultValue={100} />
      <ButtonGroup isAttached size="sm">
        <Tooltip label={t('controlLayers.cloneBrush.aligned')}>
          <IconButton
            aria-label={t('controlLayers.cloneBrush.aligned')}
            icon={alignedMode ? <PiLinkSimpleBold /> : <PiLinkSimpleBreakBold />}
            colorScheme={alignedMode ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={toggleAlignedMode}
          />
        </Tooltip>
      </ButtonGroup>
      <ButtonGroup isAttached size="sm">
        <Tooltip label={t('controlLayers.cloneBrush.currentLayer')}>
          <IconButton
            aria-label={t('controlLayers.cloneBrush.currentLayer')}
            icon={<PiSquareBold />}
            colorScheme={sampleMode === 'current_layer' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={setSampleCurrentLayer}
          />
        </Tooltip>
        <Tooltip label={t('controlLayers.cloneBrush.currentAndBelow')}>
          <IconButton
            aria-label={t('controlLayers.cloneBrush.currentAndBelow')}
            icon={<PiStackBold />}
            colorScheme={sampleMode === 'current_and_below' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={setSampleCurrentAndBelow}
          />
        </Tooltip>
      </ButtonGroup>
    </Flex>
  );
});

ToolCloneBrushSettings.displayName = 'ToolCloneBrushSettings';
