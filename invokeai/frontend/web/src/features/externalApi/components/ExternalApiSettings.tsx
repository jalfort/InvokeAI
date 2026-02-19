import type { ComboboxOnChange, ComboboxOption } from '@invoke-ai/ui-library';
import {
  Combobox,
  CompositeNumberInput,
  Flex,
  FormControl,
  FormLabel,
  Switch,
  Text,
} from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import type {
  ExternalApiAspectRatio,
  ExternalApiGenerationMode,
  ExternalApiOutputFormat,
  ExternalApiResolution,
} from 'features/externalApi/store/externalApiSlice';
import {
  externalApiAspectRatioChanged,
  externalApiGenerationModeChanged,
  externalApiModelChanged,
  externalApiNumImagesChanged,
  externalApiOutputFormatChanged,
  externalApiResolutionChanged,
  externalApiSafetyToleranceChanged,
  externalApiWebSearchToggled,
  selectExternalApiAspectRatio,
  selectExternalApiEnableWebSearch,
  selectExternalApiGenerationMode,
  selectExternalApiModelId,
  selectExternalApiNumImages,
  selectExternalApiOutputFormat,
  selectExternalApiResolution,
  selectExternalApiSafetyTolerance,
} from 'features/externalApi/store/externalApiSlice';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useMemo } from 'react';

const MODEL_OPTIONS: ComboboxOption[] = [
  { value: 'fal-ai/nano-banana-pro', label: 'NanoBanana Pro' },
  { value: 'fal-ai/flux-pro/kontext', label: 'Flux Kontext Pro' },
  { value: 'fal-ai/flux-pro/kontext/max', label: 'Flux Kontext Max' },
];

const MODE_OPTIONS: ComboboxOption[] = [
  { value: 'generate', label: 'Generate' },
  { value: 'edit', label: 'Edit' },
];

const ASPECT_RATIO_OPTIONS: ComboboxOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '3:2', label: '3:2' },
  { value: '16:9', label: '16:9' },
  { value: '21:9', label: '21:9' },
  { value: '3:4', label: '3:4' },
  { value: '2:3', label: '2:3' },
  { value: '9:16', label: '9:16' },
  { value: '4:5', label: '4:5' },
  { value: '5:4', label: '5:4' },
];

const RESOLUTION_OPTIONS: ComboboxOption[] = [
  { value: '1K', label: '1K (~$0.04)' },
  { value: '2K', label: '2K (~$0.08)' },
  { value: '4K', label: '4K (~$0.15)' },
];

const OUTPUT_FORMAT_OPTIONS: ComboboxOption[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
];

export const ExternalApiSettings = memo(() => {
  const dispatch = useAppDispatch();
  const modelId = useAppSelector(selectExternalApiModelId);
  const generationMode = useAppSelector(selectExternalApiGenerationMode);
  const aspectRatio = useAppSelector(selectExternalApiAspectRatio);
  const resolution = useAppSelector(selectExternalApiResolution);
  const enableWebSearch = useAppSelector(selectExternalApiEnableWebSearch);
  const safetyTolerance = useAppSelector(selectExternalApiSafetyTolerance);
  const numImages = useAppSelector(selectExternalApiNumImages);
  const outputFormat = useAppSelector(selectExternalApiOutputFormat);

  const modelValue = useMemo(() => MODEL_OPTIONS.find((o) => o.value === modelId) ?? null, [modelId]);
  const modeValue = useMemo(() => MODE_OPTIONS.find((o) => o.value === generationMode) ?? null, [generationMode]);
  const aspectRatioValue = useMemo(
    () => ASPECT_RATIO_OPTIONS.find((o) => o.value === aspectRatio) ?? null,
    [aspectRatio]
  );
  const resolutionValue = useMemo(
    () => RESOLUTION_OPTIONS.find((o) => o.value === resolution) ?? null,
    [resolution]
  );
  const outputFormatValue = useMemo(
    () => OUTPUT_FORMAT_OPTIONS.find((o) => o.value === outputFormat) ?? null,
    [outputFormat]
  );

  const onModelChange = useCallback<ComboboxOnChange>(
    (v) => {
      if (v) {
        dispatch(externalApiModelChanged(v.value));
      }
    },
    [dispatch]
  );
  const onModeChange = useCallback<ComboboxOnChange>(
    (v) => {
      if (v) {
        dispatch(externalApiGenerationModeChanged(v.value as ExternalApiGenerationMode));
      }
    },
    [dispatch]
  );
  const onAspectRatioChange = useCallback<ComboboxOnChange>(
    (v) => {
      if (v) {
        dispatch(externalApiAspectRatioChanged(v.value as ExternalApiAspectRatio));
      }
    },
    [dispatch]
  );
  const onResolutionChange = useCallback<ComboboxOnChange>(
    (v) => {
      if (v) {
        dispatch(externalApiResolutionChanged(v.value as ExternalApiResolution));
      }
    },
    [dispatch]
  );
  const onOutputFormatChange = useCallback<ComboboxOnChange>(
    (v) => {
      if (v) {
        dispatch(externalApiOutputFormatChanged(v.value as ExternalApiOutputFormat));
      }
    },
    [dispatch]
  );
  const onWebSearchToggle = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      dispatch(externalApiWebSearchToggled(e.target.checked));
    },
    [dispatch]
  );
  const onSafetyToleranceChange = useCallback(
    (v: number) => {
      dispatch(externalApiSafetyToleranceChanged(v));
    },
    [dispatch]
  );
  const onNumImagesChange = useCallback(
    (v: number) => {
      dispatch(externalApiNumImagesChanged(v));
    },
    [dispatch]
  );

  return (
    <Flex flexDir="column" gap={3}>
      <FormControl>
        <FormLabel>Model</FormLabel>
        <Combobox value={modelValue} options={MODEL_OPTIONS} onChange={onModelChange} />
      </FormControl>

      <FormControl>
        <FormLabel>Mode</FormLabel>
        <Combobox value={modeValue} options={MODE_OPTIONS} onChange={onModeChange} />
      </FormControl>

      <FormControl>
        <FormLabel>Aspect Ratio</FormLabel>
        <Combobox value={aspectRatioValue} options={ASPECT_RATIO_OPTIONS} onChange={onAspectRatioChange} />
      </FormControl>

      <FormControl>
        <FormLabel>Resolution</FormLabel>
        <Combobox value={resolutionValue} options={RESOLUTION_OPTIONS} onChange={onResolutionChange} />
      </FormControl>

      <FormControl>
        <FormLabel>Output Format</FormLabel>
        <Combobox value={outputFormatValue} options={OUTPUT_FORMAT_OPTIONS} onChange={onOutputFormatChange} />
      </FormControl>

      <FormControl>
        <FormLabel>Images</FormLabel>
        <CompositeNumberInput value={numImages} min={1} max={4} step={1} onChange={onNumImagesChange} defaultValue={1} />
      </FormControl>

      <FormControl>
        <FormLabel>Safety Tolerance</FormLabel>
        <CompositeNumberInput
          value={safetyTolerance}
          min={1}
          max={6}
          step={1}
          onChange={onSafetyToleranceChange}
          defaultValue={6}
        />
      </FormControl>

      <FormControl>
        <FormLabel>Web Search</FormLabel>
        <Switch isChecked={enableWebSearch} onChange={onWebSearchToggle} />
      </FormControl>

      <Text fontSize="xs" color="base.500">
        Provider: FAL.ai
      </Text>
    </Flex>
  );
});

ExternalApiSettings.displayName = 'ExternalApiSettings';
