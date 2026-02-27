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

/**
 * Detect provider from the slug/URL input.
 * - `fal-ai/` prefix or fal.ai URL → FAL.ai
 * - Everything else → Replicate
 */
const detectProvider = (input: string): 'fal' | 'replicate' | null => {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith('fal-ai/') || trimmed.includes('fal.ai/')) {
    return 'fal';
  }
  // Replicate slugs are "owner/model" or replicate.com URLs
  if (trimmed.includes('/') || trimmed.includes('replicate.com')) {
    return 'replicate';
  }
  return null;
};

export const AddEndpointModal = memo(({ isOpen, onClose }: Props) => {
  const { t } = useTranslation();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [endpointInput, setEndpointInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [addEndpoint, { isLoading }] = useAddDynamicEndpointMutation();

  const detectedProvider = useMemo(() => detectProvider(endpointInput), [endpointInput]);

  const onInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEndpointInput(e.target.value);
    setError(null);
  }, []);

  const onSubmit = useCallback(async () => {
    if (!endpointInput.trim()) {
      return;
    }
    try {
      await addEndpoint({ endpoint_input: endpointInput.trim() }).unwrap();
      setEndpointInput('');
      setError(null);
      onClose();
    } catch (err) {
      const msg = (err as { data?: { detail?: string } })?.data?.detail ?? t('externalApi.addEndpointError');
      setError(msg);
    }
  }, [endpointInput, addEndpoint, onClose, t]);

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

              {detectedProvider && (
                <Flex alignItems="center" gap={2}>
                  <Text fontSize="xs" color="base.400">
                    {t('externalApi.detectedProvider')}:
                  </Text>
                  <Badge
                    variant="subtle"
                    colorScheme={detectedProvider === 'fal' ? 'purple' : 'teal'}
                    fontSize="xs"
                  >
                    {detectedProvider === 'fal' ? 'FAL.ai' : 'Replicate'}
                  </Badge>
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
                isDisabled={!endpointInput.trim() || !detectedProvider}
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
