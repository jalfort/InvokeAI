import type { ComboboxOnChange, ComboboxOption } from '@invoke-ai/ui-library';
import { Badge, Button, Combobox, Flex, FormControl, IconButton, Input, Text } from '@invoke-ai/ui-library';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useMemo, useState } from 'react';
import { PiPlusBold, PiTrashSimpleBold } from 'react-icons/pi';
import {
  useGetExternalApiProvidersQuery,
  useSetExternalApiKeyMutation,
  useTestExternalApiKeyMutation,
} from 'services/api/endpoints/externalApi';

type KeyRow = {
  providerId: string;
  keyValue: string;
  testResult: { isValid: boolean; message: string } | null;
};

/**
 * A single row showing a configured provider with its status and test button.
 */
const ConfiguredProviderRow = memo(
  ({
    providerId,
    displayName,
    capabilityType,
    isAvailable,
  }: {
    providerId: string;
    displayName: string;
    capabilityType: string;
    isAvailable: boolean;
  }) => {
    const [testKey, { isLoading: isTesting }] = useTestExternalApiKeyMutation();
    const [testResult, setTestResult] = useState<{ isValid: boolean; message: string } | null>(null);

    const onTest = useCallback(async () => {
      const result = await testKey(providerId).unwrap();
      setTestResult({ isValid: result.is_valid, message: result.message });
    }, [providerId, testKey]);

    const capabilityLabel =
      capabilityType === 'image_text' ? 'Image + Text' : capabilityType === 'text' ? 'Text' : 'Image';

    return (
      <Flex flexDir="column" gap={1}>
        <Flex alignItems="center" gap={2} px={2} py={1}>
          <Text fontSize="sm" minW="120px">
            {displayName}
          </Text>
          <Badge colorScheme="green" variant="subtle">
            Configured
          </Badge>
          <Badge variant="subtle">{capabilityLabel}</Badge>
          {!isAvailable && (
            <Badge colorScheme="yellow" variant="subtle">
              Coming Soon
            </Badge>
          )}
          <Button size="xs" variant="ghost" onClick={onTest} isLoading={isTesting}>
            Test
          </Button>
        </Flex>
        {testResult && (
          <Badge colorScheme={testResult.isValid ? 'green' : 'red'} variant="subtle" mx={2}>
            {testResult.message}
          </Badge>
        )}
      </Flex>
    );
  }
);
ConfiguredProviderRow.displayName = 'ConfiguredProviderRow';

/**
 * A single editable row for adding a new API key.
 */
const NewKeyRow = memo(
  ({
    row,
    index,
    providerOptions,
    onProviderChange,
    onKeyChange,
    onSave,
    onRemove,
    isSaving,
  }: {
    row: KeyRow;
    index: number;
    providerOptions: ComboboxOption[];
    onProviderChange: (index: number) => ComboboxOnChange;
    onKeyChange: (index: number) => (e: ChangeEvent<HTMLInputElement>) => void;
    onSave: (index: number) => void;
    onRemove: (index: number) => void;
    isSaving: boolean;
  }) => {
    const selectedValue = useMemo(
      () => providerOptions.find((o) => o.value === row.providerId) ?? null,
      [providerOptions, row.providerId]
    );

    const handleSave = useCallback(() => {
      onSave(index);
    }, [onSave, index]);

    const handleRemove = useCallback(() => {
      onRemove(index);
    }, [onRemove, index]);

    return (
      <Flex flexDir="column" gap={2} p={2} borderWidth={1} borderRadius="md">
        <Flex gap={2} alignItems="center">
          <FormControl w="200px">
            <Combobox value={selectedValue} options={providerOptions} onChange={onProviderChange(index)} />
          </FormControl>
          <IconButton
            aria-label="Remove"
            icon={<PiTrashSimpleBold />}
            size="sm"
            variant="ghost"
            onClick={handleRemove}
          />
        </Flex>
        <Flex gap={2}>
          <Input
            type="password"
            placeholder="Enter API key..."
            value={row.keyValue}
            onChange={onKeyChange(index)}
            size="sm"
            flex={1}
          />
          <Button size="sm" onClick={handleSave} isLoading={isSaving} isDisabled={!row.keyValue}>
            Save
          </Button>
        </Flex>
        {row.testResult && (
          <Badge colorScheme={row.testResult.isValid ? 'green' : 'red'} variant="subtle">
            {row.testResult.message}
          </Badge>
        )}
      </Flex>
    );
  }
);
NewKeyRow.displayName = 'NewKeyRow';

export const ExternalApiKeySettings = memo(() => {
  const { data: providersData } = useGetExternalApiProvidersQuery();
  const [setKey, { isLoading: isSaving }] = useSetExternalApiKeyMutation();

  const [keyRows, setKeyRows] = useState<KeyRow[]>([]);

  const configuredProviderIds = useMemo(() => {
    if (!providersData) {
      return new Set<string>();
    }
    return new Set(providersData.providers.filter((p) => p.is_configured).map((p) => p.provider));
  }, [providersData]);

  const allProviders = useMemo(() => {
    if (!providersData) {
      return [];
    }
    return providersData.providers;
  }, [providersData]);

  const rowProviderIds = useMemo(() => new Set(keyRows.map((r) => r.providerId)), [keyRows]);

  const availableProviderOptions = useMemo((): ComboboxOption[] => {
    return allProviders
      .filter((p) => !configuredProviderIds.has(p.provider) && !rowProviderIds.has(p.provider))
      .map((p) => {
        const capLabel =
          p.capability_type === 'image_text' ? 'Image + Text' : p.capability_type === 'text' ? 'Text' : 'Image';
        return {
          value: p.provider,
          label: `${p.display_name} (${capLabel})`,
        };
      });
  }, [allProviders, configuredProviderIds, rowProviderIds]);

  const onAddRow = useCallback(() => {
    const firstAvailable = allProviders.find(
      (p) => !configuredProviderIds.has(p.provider) && !rowProviderIds.has(p.provider)
    );
    if (!firstAvailable) {
      return;
    }
    setKeyRows((prev) => [...prev, { providerId: firstAvailable.provider, keyValue: '', testResult: null }]);
  }, [allProviders, configuredProviderIds, rowProviderIds]);

  const onRemoveRow = useCallback((index: number) => {
    setKeyRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const onProviderChange = useCallback(
    (index: number): ComboboxOnChange =>
      (v) => {
        if (!v) {
          return;
        }
        setKeyRows((prev) =>
          prev.map((row, i) => (i === index ? { ...row, providerId: v.value, testResult: null } : row))
        );
      },
    []
  );

  const onKeyChange = useCallback(
    (index: number) => (e: ChangeEvent<HTMLInputElement>) => {
      setKeyRows((prev) => prev.map((row, i) => (i === index ? { ...row, keyValue: e.target.value } : row)));
    },
    []
  );

  const onSaveKey = useCallback(
    async (index: number) => {
      const row = keyRows[index];
      if (!row || !row.keyValue) {
        return;
      }
      await setKey({ provider: row.providerId, api_key: row.keyValue, persist: true });
      setKeyRows((prev) => prev.filter((_, i) => i !== index));
    },
    [keyRows, setKey]
  );

  return (
    <Flex flexDir="column" gap={4}>
      <Text fontSize="sm" fontWeight="semibold">
        API Keys
      </Text>

      {allProviders
        .filter((p) => p.is_configured)
        .map((provider) => (
          <ConfiguredProviderRow
            key={provider.provider}
            providerId={provider.provider}
            displayName={provider.display_name}
            capabilityType={provider.capability_type}
            isAvailable={provider.is_available}
          />
        ))}

      {keyRows.map((row, index) => {
        const rowOptions = [
          ...availableProviderOptions,
          ...allProviders
            .filter((p) => p.provider === row.providerId)
            .map((p) => {
              const capLabel =
                p.capability_type === 'image_text' ? 'Image + Text' : p.capability_type === 'text' ? 'Text' : 'Image';
              return {
                value: p.provider,
                label: `${p.display_name} (${capLabel})`,
              };
            }),
        ];

        return (
          <NewKeyRow
            key={index}
            row={row}
            index={index}
            providerOptions={rowOptions}
            onProviderChange={onProviderChange}
            onKeyChange={onKeyChange}
            onSave={onSaveKey}
            onRemove={onRemoveRow}
            isSaving={isSaving}
          />
        );
      })}

      {availableProviderOptions.length > 0 && (
        <Button size="sm" variant="ghost" leftIcon={<PiPlusBold />} onClick={onAddRow} alignSelf="flex-start">
          Add API Key
        </Button>
      )}

      {!allProviders.some((p) => p.is_configured) && keyRows.length === 0 && (
        <Text fontSize="xs" color="base.500">
          No API keys configured. Add a key to enable external image generation.
        </Text>
      )}
    </Flex>
  );
});

ExternalApiKeySettings.displayName = 'ExternalApiKeySettings';
