import type { ComboboxOnChange, ComboboxOption } from '@invoke-ai/ui-library';
import {
  Badge,
  Combobox,
  CompositeNumberInput,
  Flex,
  FormControl,
  FormLabel,
  IconButton,
  Switch,
  Text,
  Tooltip,
} from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import type { GroupBase } from 'chakra-react-select';
import { AddEndpointModal } from 'features/externalApi/components/AddEndpointModal';
import { DynamicSchemaSettings } from 'features/externalApi/components/DynamicSchemaSettings';
import { EndpointSettingsPopover } from 'features/externalApi/components/EndpointSettingsPopover';
import { ExternalApiReferenceImages } from 'features/externalApi/components/ExternalApiReferenceImages';
import { useExternalApiAutoMode } from 'features/externalApi/hooks/useExternalApiAutoMode';
import type {
  ExternalApiAspectRatio,
  ExternalApiGenerationMode,
  ExternalApiOutputFormat,
  ExternalApiResolution,
  ExternalApiSortBy,
} from 'features/externalApi/store/externalApiSlice';
import {
  externalApiAspectRatioChanged,
  externalApiGenerationModeChanged,
  externalApiModelChanged,
  externalApiOutputFormatChanged,
  externalApiProviderChanged,
  externalApiResolutionChanged,
  externalApiSafetyToleranceChanged,
  externalApiSortByChanged,
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
  selectExternalApiSortBy,
} from 'features/externalApi/store/externalApiSlice';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiArrowsClockwiseBold, PiPlusBold } from 'react-icons/pi';
import {
  useGetDynamicEndpointsQuery,
  useGetExternalApiModelsQuery,
  useGetExternalApiProvidersQuery,
  useRefreshDynamicEndpointMutation,
} from 'services/api/endpoints/externalApi';

/** Sentinel value for the "Add Endpoint..." option in the model dropdown. */
const ADD_ENDPOINT_VALUE = '__add_endpoint__';

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

const SORT_OPTIONS: ComboboxOption[] = [
  { value: 'provider', label: 'Provider' },
  { value: 'api_category', label: 'API Category' },
  { value: 'user_category', label: 'Custom Categories' },
];

/** Provider display order — hardcoded providers first. */
const PROVIDER_ORDER: Record<string, number> = {
  gemini: 0,
  fal: 1,
  replicate: 2,
};

export const ExternalApiSettings = memo(() => {
  const { t } = useTranslation();
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
  const sortBy = useAppSelector(selectExternalApiSortBy);

  const { data: modelsData } = useGetExternalApiModelsQuery();
  const { data: providersData } = useGetExternalApiProvidersQuery();
  const { data: endpointsData } = useGetDynamicEndpointsQuery();

  // Add endpoint modal state
  const [isAddEndpointOpen, setIsAddEndpointOpen] = useState(false);
  const openAddEndpoint = useCallback(() => setIsAddEndpointOpen(true), []);
  const closeAddEndpoint = useCallback(() => setIsAddEndpointOpen(false), []);

  const [refreshEndpoint, { isLoading: isRefreshing }] = useRefreshDynamicEndpointMutation();

  // Check if selected model is dynamic
  const selectedModelEntry = useMemo(() => {
    if (!modelsData?.models.length) {
      return null;
    }
    return modelsData.models.find((m) => m.id === modelId) ?? null;
  }, [modelsData, modelId]);

  const isDynamic = selectedModelEntry?.is_dynamic ?? false;

  // Find the dynamic endpoint for the selected model
  const selectedEndpoint = useMemo(() => {
    if (!isDynamic || !endpointsData?.endpoints.length) {
      return null;
    }
    return endpointsData.endpoints.find((ep) => ep.endpoint_id === modelId) ?? null;
  }, [isDynamic, endpointsData, modelId]);

  // Build a lookup from endpoint_id → DynamicEndpoint for sorting by category
  const endpointLookup = useMemo(() => {
    const map = new Map<string, { api_category: string; user_category: string }>();
    if (endpointsData?.endpoints) {
      for (const ep of endpointsData.endpoints) {
        map.set(ep.endpoint_id, { api_category: ep.api_category, user_category: ep.user_category });
      }
    }
    return map;
  }, [endpointsData]);

  // Build grouped model options sorted by the user's preferred sort order
  const modelOptions = useMemo((): GroupBase<ComboboxOption>[] => {
    if (!modelsData?.models.length) {
      return [{ label: '', options: FALLBACK_MODEL_OPTIONS }];
    }

    // Build model entries with group keys and display labels
    type ModelEntry = {
      id: string;
      name: string;
      providerId: string;
      providerLabel: string;
      groupKey: string;
      groupLabel: string;
    };
    const entries: ModelEntry[] = [];
    for (const model of modelsData.models) {
      const providerInfo = providersData?.providers.find((p) => p.provider === model.provider_id);
      const providerLabel = providerInfo?.display_name ?? model.provider_id;
      const epInfo = endpointLookup.get(model.id);

      let groupKey: string;
      let groupLabel: string;
      if (sortBy === 'api_category') {
        groupKey = epInfo?.api_category || model.provider_id;
        groupLabel = epInfo?.api_category || providerLabel;
      } else if (sortBy === 'user_category') {
        groupKey = epInfo?.user_category || epInfo?.api_category || model.provider_id;
        groupLabel = epInfo?.user_category || epInfo?.api_category || providerLabel;
      } else {
        // Sort by provider — use provider_id as key, display_name as label
        groupKey = model.provider_id;
        groupLabel = providerLabel;
      }

      entries.push({
        id: model.id,
        name: model.name,
        providerId: model.provider_id,
        providerLabel,
        groupKey,
        groupLabel,
      });
    }

    // Group entries
    const groups: Record<string, { label: string; entries: ModelEntry[] }> = {};
    for (const entry of entries) {
      const group = groups[entry.groupKey];
      if (group) {
        group.entries.push(entry);
      } else {
        groups[entry.groupKey] = { label: entry.groupLabel, entries: [entry] };
      }
    }

    // Sort groups
    const sortedGroups = Object.entries(groups).sort(([a], [b]) => {
      if (sortBy === 'provider') {
        const orderA = PROVIDER_ORDER[a] ?? 99;
        const orderB = PROVIDER_ORDER[b] ?? 99;
        return orderA - orderB;
      }
      // Alphabetical for category sorts
      return a.localeCompare(b);
    });

    // Build GroupBase array
    const grouped: GroupBase<ComboboxOption>[] = sortedGroups.map(([, group]) => ({
      label: group.label,
      options: group.entries.map((entry) => ({
        value: entry.id,
        label: entry.name,
      })),
    }));

    // Add sentinel group at the bottom
    grouped.push({
      label: '',
      options: [{ value: ADD_ENDPOINT_VALUE, label: `+ ${t('externalApi.addEndpoint')}` }],
    });

    return grouped;
  }, [modelsData, providersData, endpointLookup, sortBy, t]);

  // Get capabilities for current provider+model to show/hide params
  const capabilities = useMemo(() => {
    if (!modelsData?.models.length) {
      return null;
    }
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

  const modelValue = useMemo(
    () => modelOptions.flatMap((g) => g.options).find((o) => o.value === modelId) ?? null,
    [modelOptions, modelId]
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
  const sortValue = useMemo(() => SORT_OPTIONS.find((o) => o.value === sortBy) ?? SORT_OPTIONS[0]!, [sortBy]);

  const onModelChange = useCallback<ComboboxOnChange>(
    (v) => {
      if (!v) {
        return;
      }
      // Intercept "Add Endpoint..." action
      if (v.value === ADD_ENDPOINT_VALUE) {
        openAddEndpoint();
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
    [dispatch, modelsData, providerId, openAddEndpoint]
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

  const onSortChange = useCallback<ComboboxOnChange>(
    (v) => {
      if (v) {
        dispatch(externalApiSortByChanged(v.value as ExternalApiSortBy));
      }
    },
    [dispatch]
  );

  const doRefresh = useCallback(async () => {
    if (selectedEndpoint) {
      await refreshEndpoint({ id: selectedEndpoint.id });
    }
  }, [selectedEndpoint, refreshEndpoint]);

  // Collect unique category suggestions from all endpoints for the settings popover
  const apiCategorySuggestions = useMemo(() => {
    if (!endpointsData?.endpoints) {
      return [];
    }
    const cats = new Set<string>();
    for (const ep of endpointsData.endpoints) {
      if (ep.api_category) {
        cats.add(ep.api_category);
      }
    }
    return Array.from(cats).sort();
  }, [endpointsData]);

  const customCategorySuggestions = useMemo(() => {
    if (!endpointsData?.endpoints) {
      return [];
    }
    const cats = new Set<string>();
    for (const ep of endpointsData.endpoints) {
      if (ep.user_category) {
        cats.add(ep.user_category);
      }
    }
    return Array.from(cats).sort();
  }, [endpointsData]);

  return (
    <Flex flexDir="column" gap={3} pb={3}>
      {/* Sort toggle */}
      <Flex alignItems="center" gap={2}>
        <Text fontSize="xs" color="base.500" flexShrink={0}>
          {t('externalApi.sortBy')}:
        </Text>
        <Combobox value={sortValue} options={SORT_OPTIONS} onChange={onSortChange} />
      </Flex>

      {/* Model picker with grouped options */}
      <FormControl>
        <Flex alignItems="center" justifyContent="space-between">
          <FormLabel mb={0}>{t('externalApi.model')}</FormLabel>
          <Tooltip label={t('externalApi.addEndpoint')}>
            <IconButton
              aria-label={t('externalApi.addEndpoint')}
              icon={<PiPlusBold />}
              size="xs"
              variant="ghost"
              onClick={openAddEndpoint}
            />
          </Tooltip>
        </Flex>
        <Combobox value={modelValue} options={modelOptions} onChange={onModelChange} />
      </FormControl>

      {/* Dynamic endpoint management bar — shows when a dynamic model is selected */}
      {isDynamic && selectedEndpoint && (
        <Flex alignItems="center" gap={1}>
          <Badge variant="subtle" colorScheme={selectedEndpoint.provider === 'fal' ? 'purple' : 'teal'} fontSize="2xs">
            {selectedEndpoint.provider === 'fal' ? 'FAL.ai' : 'Replicate'}
          </Badge>
          {selectedEndpoint.api_category && (
            <Text fontSize="2xs" color="base.500">
              {selectedEndpoint.api_category}
            </Text>
          )}
          <Flex ml="auto" gap={0}>
            <EndpointSettingsPopover
              endpoint={selectedEndpoint}
              apiCategorySuggestions={apiCategorySuggestions}
              customCategorySuggestions={customCategorySuggestions}
            />
            <Tooltip label={t('externalApi.refreshSchema')}>
              <IconButton
                aria-label={t('externalApi.refreshSchema')}
                icon={<PiArrowsClockwiseBold />}
                size="xs"
                variant="ghost"
                onClick={doRefresh}
                isLoading={isRefreshing}
              />
            </Tooltip>
          </Flex>
        </Flex>
      )}

      {/* Capability badge for non-dynamic models */}
      {!isDynamic && capabilities && (
        <Flex alignItems="center" gap={2}>
          <Badge variant="subtle" fontSize="2xs">
            {capabilities.capability_type === 'image_text'
              ? 'Image + Text'
              : capabilities.capability_type === 'text'
                ? 'Text'
                : 'Image'}
          </Badge>
        </Flex>
      )}

      {/* Capability note for provider limitations */}
      {capabilities && !capabilities.supports_refs_in_generate && generationMode === 'generate' && (
        <Text fontSize="xs" color="warning.400">
          {t('externalApi.refsEditOnly')}
        </Text>
      )}

      {/* --- Hardcoded settings (non-dynamic models) --- */}
      {!isDynamic && (
        <>
          <FormControl>
            <FormLabel>{t('externalApi.mode')}</FormLabel>
            <Combobox value={modeValue} options={modeOptions} onChange={onModeChange} />
          </FormControl>

          <ExternalApiReferenceImages />

          <FormControl>
            <FormLabel>{t('externalApi.aspectRatio')}</FormLabel>
            <Combobox value={aspectRatioValue} options={ASPECT_RATIO_OPTIONS} onChange={onAspectRatioChange} />
          </FormControl>

          <FormControl>
            <FormLabel>{t('externalApi.resolution')}</FormLabel>
            <Combobox value={resolutionValue} options={resolutionOptions} onChange={onResolutionChange} />
          </FormControl>

          {(!capabilities || capabilities.output_formats.length > 1) && (
            <FormControl>
              <FormLabel>{t('externalApi.outputFormat')}</FormLabel>
              <Combobox value={outputFormatValue} options={OUTPUT_FORMAT_OPTIONS} onChange={onOutputFormatChange} />
            </FormControl>
          )}

          <FormControl>
            <FormLabel>{t('externalApi.safetyTolerance')}</FormLabel>
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
            <FormLabel>{t('externalApi.webSearch')}</FormLabel>
            <Switch isChecked={enableWebSearch} onChange={onWebSearchToggle} />
          </FormControl>
        </>
      )}

      {/* --- Dynamic settings from cached schema --- */}
      {isDynamic && selectedModelEntry?.cached_schema && (
        <DynamicSchemaSettings schema={selectedModelEntry.cached_schema} />
      )}

      <AddEndpointModal isOpen={isAddEndpointOpen} onClose={closeAddEndpoint} />
    </Flex>
  );
});

ExternalApiSettings.displayName = 'ExternalApiSettings';
