import { Box, ButtonGroup, CompositeNumberInput, Flex, IconButton, Text, Tooltip } from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import type { AnnotationMode } from 'features/controlLayers/store/canvasSettingsSlice';
import {
  selectAnnotationFontSize,
  selectAnnotationMode,
  selectAnnotationStrokeWidth,
  settingsAnnotationFontSizeChanged,
  settingsAnnotationModeChanged,
  settingsAnnotationStrokeWidthChanged,
} from 'features/controlLayers/store/canvasSettingsSlice';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PiArrowUpRightBold,
  PiCircleBold,
  PiCursorBold,
  PiLineSegmentBold,
  PiRectangleBold,
  PiTextTBold,
} from 'react-icons/pi';

const formatPx = (v: number | string) => `${v} px`;
const formatPt = (v: number | string) => `${v} pt`;

export const ToolAnnotateSettings = memo(() => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const annotationMode = useAppSelector(selectAnnotationMode);
  const strokeWidth = useAppSelector(selectAnnotationStrokeWidth);
  const fontSize = useAppSelector(selectAnnotationFontSize);

  const onSelectMode = useCallback(
    (mode: AnnotationMode) => () => {
      dispatch(settingsAnnotationModeChanged(mode));
    },
    [dispatch]
  );

  const onStrokeWidthChange = useCallback(
    (value: number) => {
      dispatch(settingsAnnotationStrokeWidthChanged(value));
    },
    [dispatch]
  );

  const onFontSizeChange = useCallback(
    (value: number) => {
      dispatch(settingsAnnotationFontSizeChanged(value));
    },
    [dispatch]
  );

  return (
    <Flex ms={2} alignItems="center" gap={3}>
      {/* Sub-tool Mode Picker */}
      <ButtonGroup isAttached size="sm">
        <Tooltip label={t('controlLayers.annotate.select')}>
          <IconButton
            aria-label={t('controlLayers.annotate.select')}
            icon={<PiCursorBold />}
            colorScheme={annotationMode === 'select' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={onSelectMode('select')}
          />
        </Tooltip>
        <Tooltip label={t('controlLayers.annotate.line')}>
          <IconButton
            aria-label={t('controlLayers.annotate.line')}
            icon={<PiLineSegmentBold />}
            colorScheme={annotationMode === 'line' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={onSelectMode('line')}
          />
        </Tooltip>
        <Tooltip label={t('controlLayers.annotate.arrow')}>
          <IconButton
            aria-label={t('controlLayers.annotate.arrow')}
            icon={<PiArrowUpRightBold />}
            colorScheme={annotationMode === 'arrow' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={onSelectMode('arrow')}
          />
        </Tooltip>
        <Tooltip label={t('controlLayers.annotate.text')}>
          <IconButton
            aria-label={t('controlLayers.annotate.text')}
            icon={<PiTextTBold />}
            colorScheme={annotationMode === 'text' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={onSelectMode('text')}
          />
        </Tooltip>
        <Tooltip label={t('controlLayers.annotate.rect')}>
          <IconButton
            aria-label={t('controlLayers.annotate.rect')}
            icon={<PiRectangleBold />}
            colorScheme={annotationMode === 'rect' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={onSelectMode('rect')}
          />
        </Tooltip>
        <Tooltip label={t('controlLayers.annotate.ellipse')}>
          <IconButton
            aria-label={t('controlLayers.annotate.ellipse')}
            icon={<PiCircleBold />}
            colorScheme={annotationMode === 'ellipse' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={onSelectMode('ellipse')}
          />
        </Tooltip>
      </ButtonGroup>

      {/* Stroke Width (line/arrow/rect/ellipse) */}
      {annotationMode !== 'text' && annotationMode !== 'select' && (
        <Flex alignItems="center" gap={1}>
          <Text fontSize="xs" color="base.400" whiteSpace="nowrap">
            {t('controlLayers.annotate.strokeWidth')}
          </Text>
          <Box w={24}>
            <CompositeNumberInput
              min={1}
              max={50}
              step={1}
              value={strokeWidth}
              onChange={onStrokeWidthChange}
              defaultValue={3}
              format={formatPx}
              variant="outline"
              size="sm"
            />
          </Box>
        </Flex>
      )}

      {/* Font Size (text only) */}
      {annotationMode === 'text' && (
        <Flex alignItems="center" gap={1}>
          <Text fontSize="xs" color="base.400" whiteSpace="nowrap">
            {t('controlLayers.annotate.fontSize')}
          </Text>
          <Box w={24}>
            <CompositeNumberInput
              min={8}
              max={200}
              step={2}
              value={fontSize}
              onChange={onFontSizeChange}
              defaultValue={16}
              format={formatPt}
              variant="outline"
              size="sm"
            />
          </Box>
        </Flex>
      )}
    </Flex>
  );
});

ToolAnnotateSettings.displayName = 'ToolAnnotateSettings';
