import {
  Box,
  Button,
  ButtonGroup,
  CompositeNumberInput,
  Flex,
  FormControl,
  FormLabel,
  Switch,
  Text,
} from '@invoke-ai/ui-library';
import { createSelector } from '@reduxjs/toolkit';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import {
  selectBrushHardness,
  selectBrushOpacity,
  selectCanvasSettingsSlice,
  selectCloneBrushAlignedMode,
  selectCloneBrushSampleMode,
  settingsBrushHardnessChanged,
  settingsBrushOpacityChanged,
  settingsBrushWidthChanged,
  settingsCloneBrushAlignedModeChanged,
  settingsCloneBrushSampleModeChanged,
} from 'features/controlLayers/store/canvasSettingsSlice';
import type { ChangeEvent } from 'react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

const selectBrushWidth = createSelector(selectCanvasSettingsSlice, (settings) => settings.brushWidth);

const formatPx = (v: number | string) => `${v} px`;
const formatPct = (v: number | string) => `${v} %`;

export const ToolCloneBrushSettings = memo(() => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const width = useAppSelector(selectBrushWidth);
  const hardness = useAppSelector(selectBrushHardness);
  const opacity = useAppSelector(selectBrushOpacity);
  const aligned = useAppSelector(selectCloneBrushAlignedMode);
  const sampleMode = useAppSelector(selectCloneBrushSampleMode);

  const onWidthChange = useCallback((value: number) => dispatch(settingsBrushWidthChanged(value)), [dispatch]);
  const onHardnessChange = useCallback(
    (value: number) => dispatch(settingsBrushHardnessChanged(value / 100)),
    [dispatch]
  );
  const onOpacityChange = useCallback(
    (value: number) => dispatch(settingsBrushOpacityChanged(value / 100)),
    [dispatch]
  );
  const onAlignedChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => dispatch(settingsCloneBrushAlignedModeChanged(e.target.checked)),
    [dispatch]
  );
  const onSampleCurrent = useCallback(() => dispatch(settingsCloneBrushSampleModeChanged('current_layer')), [dispatch]);
  const onSampleBelow = useCallback(
    () => dispatch(settingsCloneBrushSampleModeChanged('current_and_below')),
    [dispatch]
  );

  return (
    <Flex ms={2} alignItems="center" gap={3}>
      <Flex alignItems="center" gap={1}>
        <Text fontSize="xs" color="base.400" whiteSpace="nowrap">
          {t('controlLayers.width', { defaultValue: 'Width' })}
        </Text>
        <Box w={24}>
          <CompositeNumberInput
            min={1}
            max={600}
            step={5}
            fineStep={1}
            value={width}
            onChange={onWidthChange}
            defaultValue={50}
            format={formatPx}
            variant="outline"
            size="sm"
          />
        </Box>
      </Flex>
      <Flex alignItems="center" gap={1}>
        <Text fontSize="xs" color="base.400" whiteSpace="nowrap">
          {t('controlLayers.hardness', { defaultValue: 'Hardness' })}
        </Text>
        <Box w={20}>
          <CompositeNumberInput
            min={0}
            max={100}
            step={5}
            value={Math.round(hardness * 100)}
            onChange={onHardnessChange}
            defaultValue={100}
            format={formatPct}
            variant="outline"
            size="sm"
          />
        </Box>
      </Flex>
      <Flex alignItems="center" gap={1}>
        <Text fontSize="xs" color="base.400" whiteSpace="nowrap">
          {t('controlLayers.opacity', { defaultValue: 'Opacity' })}
        </Text>
        <Box w={20}>
          <CompositeNumberInput
            min={0}
            max={100}
            step={5}
            value={Math.round(opacity * 100)}
            onChange={onOpacityChange}
            defaultValue={100}
            format={formatPct}
            variant="outline"
            size="sm"
          />
        </Box>
      </Flex>
      <ButtonGroup isAttached size="sm">
        <Button colorScheme={sampleMode === 'current_layer' ? 'invokeBlue' : 'base'} onClick={onSampleCurrent}>
          {t('controlLayers.cloneSampleCurrent', { defaultValue: 'Current' })}
        </Button>
        <Button colorScheme={sampleMode === 'current_and_below' ? 'invokeBlue' : 'base'} onClick={onSampleBelow}>
          {t('controlLayers.cloneSampleBelow', { defaultValue: 'Current + Below' })}
        </Button>
      </ButtonGroup>
      <FormControl w="auto" gap={2}>
        <FormLabel m={0} fontSize="xs" color="base.400">
          {t('controlLayers.cloneAligned', { defaultValue: 'Aligned' })}
        </FormLabel>
        <Switch size="sm" isChecked={aligned} onChange={onAlignedChange} />
      </FormControl>
    </Flex>
  );
});

ToolCloneBrushSettings.displayName = 'ToolCloneBrushSettings';
