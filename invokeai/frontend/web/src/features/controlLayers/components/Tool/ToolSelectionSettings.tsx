import {
  Box,
  ButtonGroup,
  CompositeNumberInput,
  Flex,
  IconButton,
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Portal,
  Text,
  Tooltip,
} from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import RgbColorPicker from 'common/components/ColorPicker/RgbColorPicker';
import { rgbColorToString } from 'common/util/colorCodeTransformers';
import {
  selectSelectionFeatherDirection,
  selectSelectionFeatherRadius,
  selectSelectionMode,
  selectSelectionOverlayColor,
  selectSelectionOverlayOpacity,
  settingsSelectionFeatherDirectionChanged,
  settingsSelectionFeatherRadiusChanged,
  settingsSelectionModeChanged,
  settingsSelectionOverlayColorChanged,
  settingsSelectionOverlayOpacityChanged,
} from 'features/controlLayers/store/canvasSettingsSlice';
import type { RgbColor } from 'features/controlLayers/store/types';
import { memo, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PiArrowsInBold,
  PiArrowsInLineVerticalBold,
  PiArrowsOutBold,
  PiCircleDashedBold,
  PiPathBold,
  PiPolygonBold,
  PiSelectionBold,
} from 'react-icons/pi';

const formatPx = (v: number | string) => `${v} px`;
const formatPct = (v: number | string) => `${v} %`;

export const ToolSelectionSettings = memo(() => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const selectionMode = useAppSelector(selectSelectionMode);
  const featherRadius = useAppSelector(selectSelectionFeatherRadius);
  const featherDirection = useAppSelector(selectSelectionFeatherDirection);
  const overlayOpacity = useAppSelector(selectSelectionOverlayOpacity);
  const overlayColor = useAppSelector(selectSelectionOverlayColor);

  const onSelectRectangle = useCallback(() => dispatch(settingsSelectionModeChanged('rectangle')), [dispatch]);
  const onSelectEllipse = useCallback(() => dispatch(settingsSelectionModeChanged('ellipse')), [dispatch]);
  const onSelectLasso = useCallback(() => dispatch(settingsSelectionModeChanged('lasso')), [dispatch]);
  const onSelectPolygon = useCallback(() => dispatch(settingsSelectionModeChanged('polygon')), [dispatch]);

  // Track Ctrl key for 10x stepper increment
  const ctrlHeldRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        ctrlHeldRef.current = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Control') {
        ctrlHeldRef.current = false;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const onFeatherRadiusChange = useCallback(
    (value: number) => {
      if (ctrlHeldRef.current) {
        // Ctrl held: snap to nearest 10
        const snapped = Math.round(value / 10) * 10;
        dispatch(settingsSelectionFeatherRadiusChanged(snapped));
      } else {
        dispatch(settingsSelectionFeatherRadiusChanged(value));
      }
    },
    [dispatch]
  );

  const onFeatherBoth = useCallback(() => dispatch(settingsSelectionFeatherDirectionChanged('both')), [dispatch]);
  const onFeatherInward = useCallback(() => dispatch(settingsSelectionFeatherDirectionChanged('inward')), [dispatch]);
  const onFeatherOutward = useCallback(() => dispatch(settingsSelectionFeatherDirectionChanged('outward')), [dispatch]);

  const onOverlayOpacityChange = useCallback(
    (value: number) => {
      dispatch(settingsSelectionOverlayOpacityChanged(value / 100));
    },
    [dispatch]
  );

  const onOverlayColorChange = useCallback(
    (color: RgbColor) => {
      dispatch(settingsSelectionOverlayColorChanged(color));
    },
    [dispatch]
  );

  return (
    <Flex ms={2} alignItems="center" gap={3}>
      {/* Shape Mode Picker */}
      <ButtonGroup isAttached size="sm">
        <Tooltip label={t('controlLayers.selection.rectangle', { defaultValue: 'Rectangle' })}>
          <IconButton
            aria-label={t('controlLayers.selection.rectangle', { defaultValue: 'Rectangle' })}
            icon={<PiSelectionBold />}
            colorScheme={selectionMode === 'rectangle' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={onSelectRectangle}
          />
        </Tooltip>
        <Tooltip label={t('controlLayers.selection.ellipse', { defaultValue: 'Ellipse' })}>
          <IconButton
            aria-label={t('controlLayers.selection.ellipse', { defaultValue: 'Ellipse' })}
            icon={<PiCircleDashedBold />}
            colorScheme={selectionMode === 'ellipse' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={onSelectEllipse}
          />
        </Tooltip>
        <Tooltip label={t('controlLayers.selection.lasso', { defaultValue: 'Lasso' })}>
          <IconButton
            aria-label={t('controlLayers.selection.lasso', { defaultValue: 'Lasso' })}
            icon={<PiPathBold />}
            colorScheme={selectionMode === 'lasso' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={onSelectLasso}
          />
        </Tooltip>
        <Tooltip label={t('controlLayers.selection.polygon', { defaultValue: 'Polygon' })}>
          <IconButton
            aria-label={t('controlLayers.selection.polygon', { defaultValue: 'Polygon' })}
            icon={<PiPolygonBold />}
            colorScheme={selectionMode === 'polygon' ? 'invokeBlue' : 'base'}
            variant="solid"
            onClick={onSelectPolygon}
          />
        </Tooltip>
      </ButtonGroup>

      {/* Feather Radius */}
      <Flex alignItems="center" gap={1}>
        <Text fontSize="xs" color="base.400" whiteSpace="nowrap">
          {t('controlLayers.selection.featherRadius', { defaultValue: 'Feather' })}
        </Text>
        <Box w={28}>
          <CompositeNumberInput
            min={0}
            max={1024}
            step={5}
            fineStep={1}
            value={featherRadius}
            onChange={onFeatherRadiusChange}
            defaultValue={0}
            format={formatPx}
            variant="outline"
            size="sm"
          />
        </Box>
      </Flex>

      {/* Feather Direction */}
      {featherRadius > 0 && (
        <ButtonGroup isAttached size="sm">
          <Tooltip label={t('controlLayers.selection.featherBoth', { defaultValue: 'Both' })}>
            <IconButton
              aria-label={t('controlLayers.selection.featherBoth', { defaultValue: 'Both' })}
              icon={<PiArrowsInLineVerticalBold />}
              colorScheme={featherDirection === 'both' ? 'invokeBlue' : 'base'}
              variant="solid"
              onClick={onFeatherBoth}
            />
          </Tooltip>
          <Tooltip label={t('controlLayers.selection.featherInward', { defaultValue: 'Inward' })}>
            <IconButton
              aria-label={t('controlLayers.selection.featherInward', { defaultValue: 'Inward' })}
              icon={<PiArrowsInBold />}
              colorScheme={featherDirection === 'inward' ? 'invokeBlue' : 'base'}
              variant="solid"
              onClick={onFeatherInward}
            />
          </Tooltip>
          <Tooltip label={t('controlLayers.selection.featherOutward', { defaultValue: 'Outward' })}>
            <IconButton
              aria-label={t('controlLayers.selection.featherOutward', { defaultValue: 'Outward' })}
              icon={<PiArrowsOutBold />}
              colorScheme={featherDirection === 'outward' ? 'invokeBlue' : 'base'}
              variant="solid"
              onClick={onFeatherOutward}
            />
          </Tooltip>
        </ButtonGroup>
      )}

      {/* Overlay Opacity */}
      <Flex alignItems="center" gap={1}>
        <Text fontSize="xs" color="base.400" whiteSpace="nowrap">
          Opacity
        </Text>
        <Box w={24}>
          <CompositeNumberInput
            min={0}
            max={100}
            step={5}
            value={Math.round(overlayOpacity * 100)}
            onChange={onOverlayOpacityChange}
            defaultValue={50}
            format={formatPct}
            variant="outline"
            size="sm"
          />
        </Box>
      </Flex>

      {/* Overlay Color */}
      <Popover isLazy>
        <PopoverTrigger>
          <Flex role="button" aria-label="Selection overlay color" tabIndex={-1} w={8} h={8}>
            <Tooltip label="Overlay Color">
              <Flex w="full" h="full" alignItems="center" justifyContent="center">
                <Box borderRadius="full" borderColor="base.600" w={6} h={6} borderWidth={2} bg={rgbColorToString(overlayColor)} />
              </Flex>
            </Tooltip>
          </Flex>
        </PopoverTrigger>
        <Portal>
          <PopoverContent>
            <PopoverBody minH={64}>
              <RgbColorPicker color={overlayColor} onChange={onOverlayColorChange} withNumberInput withSwatches />
            </PopoverBody>
          </PopoverContent>
        </Portal>
      </Popover>
    </Flex>
  );
});

ToolSelectionSettings.displayName = 'ToolSelectionSettings';
