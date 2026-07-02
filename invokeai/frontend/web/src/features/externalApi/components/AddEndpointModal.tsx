import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Badge,
  Button,
  Flex,
  FormControl,
  FormLabel,
  Input,
  Text,
} from '@invoke-ai/ui-library';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAddDynamicEndpointMutation } from 'services/api/endpoints/externalApi';

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

type DetectionResult = {
  provider: 'fal' | 'replicate' | null;
  /** True when the provider was inferred heuristically and the user may want to override. */
  ambiguous: boolean;
};

/**
 * Detect provider from the slug/URL input.
 * Mirrors the backend `_parse_endpoint_input` priority order.
 */
const detectProvider = (input: string): DetectionResult => {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return { provider: null, ambiguous: false };
  }

  // URL-based: definitive
  if (trimmed.includes('fal.ai/') || trimmed.includes('fal.run/')) {
    return { provider: 'fal', ambiguous: false };
  }
  if (trimmed.includes('replicate.com')) {
    return { provider: 'replicate', ambiguous: false };
  }

  // fal-ai/ prefix: definitive FAL first-party
  if (trimmed.startsWith('fal-ai/')) {
    return { provider: 'fal', ambiguous: false };
  }

  // Replicate version hash: owner/model:hex64
  if (/^[^/]+\/[^/:]+:[0-9a-f]{64}$/.test(trimmed)) {
    return { provider: 'replicate', ambiguous: false };
  }

  // 3+ path segments → likely FAL third-party (recraft/v4/text-to-image)
  const segments = trimmed.split('/');
  if (segments.length >= 3) {
    return { provider: 'fal', ambiguous: true };
  }

  // 2-segment slug → default Replicate, but ambiguous
  if (segments.length === 2) {
    return { provider: 'replicate', ambiguous: true };
  }

  return { provider: null, ambiguous: false };
};

export const AddEndpointModal = memo(({ isOpen, onClose }: Props) => {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [endpointInput, setEndpointInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [providerOverride, setProviderOverride] = useState<'fal' | 'replicate' | null>(null);
  const [addEndpoint, { isLoading }] = useAddDynamicEndpointMutation();

  const detection = useMemo(() => detectProvider(endpointInput), [endpointInput]);
  const effectiveProvider = providerOverride ?? detection.provider;

  const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEndpointInput(e.target.value);
    setError(null);
    setProviderOverride(null);
  }, []);

  const toggleProvider = useCallback(() => {
    if (!detection.ambiguous) {
      return;
    }
    const current = providerOverride ?? detection.provider;
    setProviderOverride(current === 'fal' ? 'replicate' : 'fal');
  }, [detection, providerOverride]);

  const onSubmit = useCallback(async () => {
    if (!endpointInput.trim()) {
      return;
    }
    try {
      await addEndpoint({
        endpoint_input: endpointInput.trim(),
        provider_hint: providerOverride,
      }).unwrap();
      setEndpointInput('');
      setError(null);
      setProviderOverride(null);
      onClose();
    } catch (err) {
      const msg = (err as { data?: { detail?: string } })?.data?.detail ?? t('externalApi.addEndpointError');
      setError(msg);
    }
  }, [endpointInput, addEndpoint, providerOverride, onClose, t]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !isLoading && endpointInput.trim()) {
        onSubmit();
      }
    },
    [onSubmit, isLoading, endpointInput]
  );

  const handleClose = useCallback(() => {
    setEndpointInput('');
    setError(null);
    setProviderOverride(null);
    onClose();
  }, [onClose]);

  return (
    <AlertDialog isOpen={isOpen} onClose={handleClose} leastDestructiveRef={cancelRef} isCentered>
      <AlertDialogOverlay>
        <AlertDialogContent>
          <AlertDialogHeader fontSize="lg" fontWeight="bold">
            {t('externalApi.addEndpoint')}
          </AlertDialogHeader>

          <AlertDialogBody>
            <Flex direction="column" gap={3}>
              <Text fontSize="sm" color="base.400">
                {t('externalApi.addEndpointDescription')}
              </Text>

              <FormControl>
                <FormLabel>{t('externalApi.endpointSlug')}</FormLabel>
                <Input
                  ref={inputRef}
                  value={endpointInput}
                  onChange={onInputChange}
                  onKeyDown={onKeyDown}
                  placeholder="fal-ai/flux-2-pro"
                  size="sm"
                  autoFocus
                />
              </FormControl>

              {effectiveProvider && (
                <Flex alignItems="center" gap={2}>
                  <Text fontSize="xs" color="base.400">
                    {t('externalApi.detectedProvider')}:
                  </Text>
                  <Badge
                    variant="subtle"
                    colorScheme={effectiveProvider === 'fal' ? 'purple' : 'teal'}
                    fontSize="xs"
                    cursor={detection.ambiguous ? 'pointer' : undefined}
                    onClick={detection.ambiguous ? toggleProvider : undefined}
                  >
                    {effectiveProvider === 'fal' ? 'FAL.ai' : 'Replicate'}
                  </Badge>
                  {detection.ambiguous && (
                    <Text fontSize="xs" color="base.500">
                      {t('externalApi.clickToSwitch')}
                    </Text>
                  )}
                </Flex>
              )}

              {error && (
                <Text fontSize="sm" color="error.400">
                  {error}
                </Text>
              )}
            </Flex>
          </AlertDialogBody>

          <AlertDialogFooter>
            <Flex w="full" gap={2} justifyContent="end">
              <Button ref={cancelRef} onClick={handleClose} size="sm">
                {t('common.cancel')}
              </Button>
              <Button
                colorScheme="invokeBlue"
                onClick={onSubmit}
                isLoading={isLoading}
                isDisabled={!endpointInput.trim() || !effectiveProvider}
                size="sm"
              >
                {t('externalApi.add')}
              </Button>
            </Flex>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogOverlay>
    </AlertDialog>
  );
});

AddEndpointModal.displayName = 'AddEndpointModal';
