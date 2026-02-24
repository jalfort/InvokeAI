import type { ComboboxOnChange, ComboboxOption } from '@invoke-ai/ui-library';
import {
  Badge,
  Combobox,
  CompositeNumberInput,
  Flex,
  FormControl,
  FormLabel,
  Switch,
  Text,
} from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import { ExternalApiReferenceImages } from 'features/externalApi/components/ExternalApiReferenceImages';
import { useExternalApiAutoMode } from 'features/externalApi/hooks/useExternalApiAutoMode';
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
  externalApiOutputFormatChanged,
  externalApiProviderChanged,
  externalApiResolutionChanged,
  externalApiSafetyToleranceChanged,
  externalApiWebSearchToggled,
  selectExternalApiAspectRatio,
  selectExternalApiEnableWebSearch,
  selectExternalApiGenerationMode,
  selectExternalApiModelId,
  selectExternalApiModeSource,
  selectExternalApiOutputFormat,
  selectExternalApiProviderId,
  selectExternalApiResolution,
  selectExternalApiSafetyTolerance,
} from 'features/externalApi/store/externalApiSlice';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useMemo } from 'react';
import { useGetExternalApiModelsQuery, useGetExternalApiProvidersQuery } from 'services/api/endpoints/externalApi';

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

const OUTPUT_FORMAT_OPTIONS: ComboboxOption[] = [
  { value: 'png', label: 'PNG' },
  { value: 'jpeg', label: 'JPEG' },
  { value: 'webp', label: 'WebP' },
];

/**
 * Fallback model options when backend hasn't registered providers yet.
 * Once providers register, model options come from the /models endpoint.
 */
const FALLBACK_MODEL_OPTIONS: ComboboxOption[] = [
  { value: 'fal-ai/nano-banana-pro', label: 'NanoBanana Pro' },
  { value: 'fal-ai/flux-pro/kontext', label: 'Flux Kontext Pro' },
  { value: 'fal-ai/flux-pro/kontext/max', label: 'Flux Kontext Max' },
];

export const ExternalApiSettings = memo(() => {
  const dispatch = useAppDispatch();
  useExternalApiAutoMode();
  const providerId = useAppSelector(selectExternalApiProviderId);
  const modelId = useAppSelector(selectExternalApiModelId);
  const generationMode = useAppSelector(selectExternalApiGenerationMode);
  const modeSource = useAppSelector(selectExternalApiModeSource);
  const aspectRatio = useAppSelector(selectExternalApiAspectRatio);
  const resolution = useAppSelector(selectExternalApiResolution);
  const enableWebSearch = useAppSelector(selectExternalApiEnableWebSearch);
  const safetyTolerance = useAppSelector(selectExternalApiSafetyTolerance);
  const outputFormat = useAppSelector(selectExternalApiOutputFormat);

  const { data: modelsData } = useGetExternalApiModelsQuery();
  const { data: providersData } = useGetExternalApiProvidersQuery();

  // Build unique model options from backend (deduplicated by model name across providers)
  const modelOptions = useMemo((): ComboboxOption[] => {
    if (!modelsData?.models.length) {
      return FALLBACK_MODEL_OPTIONS;
    }
    // Group by model name to get unique models
    const seen = new Set<string>();
    const options: ComboboxOption[] = [];
    for (const model of modelsData.models) {
      if (!seen.has(model.name)) {
        seen.add(model.name);
        options.push({ value: model.id, label: model.name });
      }
    }
    return options.length > 0 ? options : FALLBACK_MODEL_OPTIONS;
  }, [modelsData]);

  // Build provider options for the currently selected model
  const providerOptions = useMemo((): ComboboxOption[] => {
    if (!modelsData?.models.length || !providersData?.providers.length) {
      return [{ value: 'fal', label: 'FAL.ai' }];
    }

    // Find all providers that serve a model with the same name as the selected model
    const selectedModel = modelsData.models.find((m) => m.id === modelId);
    const selectedModelName = selectedModel?.name;

    // Get all providers that serve this model (by name, since model IDs differ per provider)
    const matchingModels = selectedModelName
      ? modelsData.models.filter((m) => m.name === selectedModelName)
      : modelsData.models.filter((m) => m.id === modelId);

    const providerIds = new Set(matchingModels.map((m) => m.provider_id));
    const configuredProviders = new Set(providersData.providers.filter((p) => p.is_configured).map((p) => p.provider));

    return Array.from(providerIds).map((pid) => {
      const providerInfo = providersData.providers.find((p) => p.provider === pid);
      const isConfigured = configuredProviders.has(pid);
      return {
        value: pid,
        label: isConfigured ? (providerInfo?.display_name ?? pid) : `${providerInfo?.display_name ?? pid} (no key)`,
      };
    });
  }, [modelsData, providersData, modelId]);

  // Get capabilities for current provider+model to show/hide params
  const capabilities = useMemo(() => {
    if (!modelsData?.models.length) {
      return null;
    }
    // Find the model entry for the current provider
    const model = modelsData.models.find((m) => m.provider_id === providerId && m.id === modelId);
    return model?.capabilities ?? null;
  }, [modelsData, providerId, modelId]);

  // Dynamic resolution options based on provider capabilities
  const resolutionOptions = useMemo((): ComboboxOption[] => {
    if (!capabilities?.supported_resolutions.length) {
      return [
        { value: '1K', label: '1K' },
        { value: '2K', label: '2K' },
        { value: '4K', label: '4K' },
      ];
    }
    return capabilities.supported_resolutions.map((r) => ({ value: r, label: r }));
  }, [capabilities]);

  const modeOptions = useMemo(
    (): ComboboxOption[] => [
      { value: 'generate', label: 'Generate' },
      {
        value: 'edit',
        label: modeSource === 'auto' && generationMode === 'edit' ? 'Edit (Canvas Modified)' : 'Edit',
      },
    ],
    [modeSource, generationMode]
  );

  const modelValue = useMemo(() => modelOptions.find((o) => o.value === modelId) ?? null, [modelOptions, modelId]);
  const providerValue = useMemo(
    () => providerOptions.find((o) => o.value === providerId) ?? null,
    [providerOptions, providerId]
  );
  const modeValue = useMemo(
    () => modeOptions.find((o) => o.value === generationMode) ?? null,
    [modeOptions, generationMode]
  );
  const aspectRatioValue = useMemo(
    () => ASPECT_RATIO_OPTIONS.find((o) => o.value === aspectRatio) ?? null,
    [aspectRatio]
  );
  const resolutionValue = useMemo(
    () => resolutionOptions.find((o) => o.value === resolution) ?? null,
    [resolutionOptions, resolution]
  );
  const outputFormatValue = useMemo(
    () => OUTPUT_FORMAT_OPTIONS.find((o) => o.value === outputFormat) ?? null,
    [outputFormat]
  );

  const onModelChange = useCallback<ComboboxOnChange>(
    (v) => {
      if (!v) {
        return;
      }
      dispatch(externalApiModelChanged(v.value));

      // Auto-select the first available provider for this model
      if (!modelsData?.models.length) {
        return;
      }
      const modelEntry = modelsData.models.find((m) => m.id === v.value);
      if (modelEntry && modelEntry.provider_id !== providerId) {
        dispatch(externalApiProviderChanged(modelEntry.provider_id));
      }
    },
    [dispatch, modelsData, providerId]
  );

  const onProviderChange = useCallback<ComboboxOnChange>(
    (v) => {
      if (!v) {
        return;
      }
      dispatch(externalApiProviderChanged(v.value));

      // Update model ID to the provider-specific one if needed
      if (!modelsData?.models.length) {
        return;
      }
      const currentModel = modelsData.models.find((m) => m.id === modelId);
      if (currentModel) {
        // Find the same model name on the new provider
        const newProviderModel = modelsData.models.find(
          (m) => m.provider_id === v.value && m.name === currentModel.name
        );
        if (newProviderModel && newProviderModel.id !== modelId) {
          dispatch(externalApiModelChanged(newProviderModel.id));
        }
      }
    },
    [dispatch, modelsData, modelId]
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
  return (
    <Flex flexDir="column" gap={3}>
      {/* Model-first picker */}
      <FormControl>
        <FormLabel>Model</FormLabel>
        <Combobox value={modelValue} options={modelOptions} onChange={onModelChange} />
      </FormControl>

      {/* Provider selection (second level) */}
      <FormControl>
        <Flex alignItems="center" gap={2}>
          <FormLabel mb={0}>Provider</FormLabel>
          {capabilities && (
            <Badge variant="subtle" fontSize="2xs">
              {capabilities.capability_type === 'image_text'
                ? 'Image + Text'
                : capabilities.capability_type === 'text'
                  ? 'Text'
                  : 'Image'}
            </Badge>
          )}
        </Flex>
        <Combobox value={providerValue} options={providerOptions} onChange={onProviderChange} />
      </FormControl>

      {/* Capability note for provider limitations */}
      {capabilities && !capabilities.supports_refs_in_generate && generationMode === 'generate' && (
        <Text fontSize="xs" color="warning.400">
          Reference images only available in Edit mode on this provider.
        </Text>
      )}

      <FormControl>
        <FormLabel>Mode</FormLabel>
        <Combobox value={modeValue} options={modeOptions} onChange={onModeChange} />
      </FormControl>

      <ExternalApiReferenceImages />

      <FormControl>
        <FormLabel>Aspect Ratio</FormLabel>
        <Combobox value={aspectRatioValue} options={ASPECT_RATIO_OPTIONS} onChange={onAspectRatioChange} />
      </FormControl>

      <FormControl>
        <FormLabel>Resolution</FormLabel>
        <Combobox value={resolutionValue} options={resolutionOptions} onChange={onResolutionChange} />
      </FormControl>

      {/* Output format: show based on capabilities */}
      {(!capabilities || capabilities.output_formats.length > 1) && (
        <FormControl>
          <FormLabel>Output Format</FormLabel>
          <Combobox value={outputFormatValue} options={OUTPUT_FORMAT_OPTIONS} onChange={onOutputFormatChange} />
        </FormControl>
      )}

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
    </Flex>
  );
});

ExternalApiSettings.displayName = 'ExternalApiSettings';
