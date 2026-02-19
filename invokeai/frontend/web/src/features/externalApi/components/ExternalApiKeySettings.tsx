import { Badge, Button, Flex, FormControl, FormLabel, Input } from '@invoke-ai/ui-library';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useState } from 'react';
import {
  useGetExternalApiProvidersQuery,
  useSetExternalApiKeyMutation,
  useTestExternalApiKeyMutation,
} from 'services/api/endpoints/externalApi';

export const ExternalApiKeySettings = memo(() => {
  const { data: providersData } = useGetExternalApiProvidersQuery();
  const [setKey, { isLoading: isSaving }] = useSetExternalApiKeyMutation();
  const [testKey, { isLoading: isTesting }] = useTestExternalApiKeyMutation();

  const [falKey, setFalKey] = useState('');
  const [testResult, setTestResult] = useState<{ isValid: boolean; message: string } | null>(null);

  const falProvider = providersData?.providers.find((p) => p.provider === 'fal');

  const onFalKeyChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setFalKey(e.target.value);
  }, []);

  const onSaveFalKey = useCallback(async () => {
    await setKey({ provider: 'fal', api_key: falKey, persist: true });
    setFalKey('');
    setTestResult(null);
  }, [falKey, setKey]);

  const onTestFalKey = useCallback(async () => {
    const result = await testKey('fal').unwrap();
    setTestResult({ isValid: result.is_valid, message: result.message });
  }, [testKey]);

  return (
    <Flex flexDir="column" gap={3}>
      <Flex alignItems="center" gap={2}>
        <FormLabel mb={0}>FAL.ai</FormLabel>
        {falProvider?.is_configured ? (
          <Badge colorScheme="green" variant="subtle">Configured</Badge>
        ) : (
          <Badge colorScheme="yellow" variant="subtle">Not Set</Badge>
        )}
      </Flex>

      <FormControl>
        <Input
          type="password"
          placeholder="Enter FAL API key..."
          value={falKey}
          onChange={onFalKeyChange}
          size="sm"
        />
      </FormControl>

      <Flex gap={2}>
        <Button size="sm" onClick={onSaveFalKey} isLoading={isSaving} isDisabled={!falKey}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onTestFalKey} isLoading={isTesting} isDisabled={!falProvider?.is_configured}>
          Test Connection
        </Button>
      </Flex>

      {testResult && (
        <Badge colorScheme={testResult.isValid ? 'green' : 'red'} variant="subtle">
          {testResult.message}
        </Badge>
      )}
    </Flex>
  );
});

ExternalApiKeySettings.displayName = 'ExternalApiKeySettings';
