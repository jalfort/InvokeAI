import {
  Button,
  Divider,
  Flex,
  FormControl,
  FormLabel,
  IconButton,
  Input,
  Popover,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Portal,
  Text,
  Tooltip,
} from '@invoke-ai/ui-library';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { memo, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiPencilSimpleBold } from 'react-icons/pi';
import type { DynamicEndpoint } from 'services/api/endpoints/externalApi';
import {
  useDeleteDynamicEndpointMutation,
  useUpdateDynamicEndpointMutation,
} from 'services/api/endpoints/externalApi';

type Props = {
  endpoint: DynamicEndpoint;
  apiCategorySuggestions: string[];
  customCategorySuggestions: string[];
};

export const EndpointSettingsPopover = memo(({ endpoint, apiCategorySuggestions, customCategorySuggestions }: Props) => {
  const { t } = useTranslation();
  const [updateEndpoint] = useUpdateDynamicEndpointMutation();
  const [deleteEndpoint] = useDeleteDynamicEndpointMutation();

  const [isOpen, setIsOpen] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [apiCategory, setApiCategory] = useState('');
  const [customCategory, setCustomCategory] = useState('');

  // Reset drafts when popover opens or endpoint changes
  useEffect(() => {
    if (isOpen) {
      setDisplayName(endpoint.display_name);
      setApiCategory(endpoint.api_category);
      setCustomCategory(endpoint.user_category);
    }
  }, [isOpen, endpoint]);

  const onOpen = useCallback(() => setIsOpen(true), []);
  const onClose = useCallback(() => setIsOpen(false), []);

  const onDisplayNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDisplayName(e.target.value);
  }, []);

  const onApiCategoryChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setApiCategory(e.target.value);
  }, []);

  const onCustomCategoryChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setCustomCategory(e.target.value);
  }, []);

  const handleSave = useCallback(async () => {
    const updates: { id: string; display_name?: string; api_category?: string; user_category?: string } = {
      id: endpoint.id,
    };
    const trimmedName = displayName.trim();
    const trimmedApi = apiCategory.trim();
    const trimmedCustom = customCategory.trim();

    if (trimmedName !== endpoint.display_name) {
      updates.display_name = trimmedName || endpoint.display_name;
    }
    if (trimmedApi !== endpoint.api_category) {
      updates.api_category = trimmedApi;
    }
    if (trimmedCustom !== endpoint.user_category) {
      updates.user_category = trimmedCustom;
    }

    // Only call if something actually changed
    if (updates.display_name !== undefined || updates.api_category !== undefined || updates.user_category !== undefined) {
      await updateEndpoint(updates);
    }
    setIsOpen(false);
  }, [endpoint, displayName, apiCategory, customCategory, updateEndpoint]);

  const handleDelete = useCallback(async () => {
    await deleteEndpoint({ id: endpoint.id });
    setIsOpen(false);
  }, [endpoint.id, deleteEndpoint]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSave();
      } else if (e.key === 'Escape') {
        onClose();
      }
    },
    [handleSave, onClose]
  );

  return (
    <Popover isOpen={isOpen} onClose={onClose} isLazy>
      <PopoverTrigger>
        <IconButton
          aria-label={t('externalApi.endpointSettings')}
          icon={<PiPencilSimpleBold />}
          size="xs"
          variant="ghost"
          onClick={onOpen}
          tooltip={t('externalApi.endpointSettings')}
        />
      </PopoverTrigger>
      <Portal>
        <PopoverContent>
          <PopoverBody>
            <Flex flexDir="column" gap={3} py={1}>
              <Text fontWeight="semibold" fontSize="sm">
                {t('externalApi.endpointSettings')}
              </Text>
              <Divider />

              <FormControl>
                <FormLabel fontSize="xs">{t('externalApi.displayName')}</FormLabel>
                <Input size="sm" value={displayName} onChange={onDisplayNameChange} onKeyDown={onKeyDown} />
              </FormControl>

              <FormControl>
                <FormLabel fontSize="xs">{t('externalApi.apiCategory')}</FormLabel>
                <Input
                  size="sm"
                  value={apiCategory}
                  onChange={onApiCategoryChange}
                  onKeyDown={onKeyDown}
                  list="api-category-suggestions"
                  placeholder={t('externalApi.uncategorized')}
                />
                <datalist id="api-category-suggestions">
                  {apiCategorySuggestions.map((cat) => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </FormControl>

              <FormControl>
                <FormLabel fontSize="xs">{t('externalApi.customCategory')}</FormLabel>
                <Input
                  size="sm"
                  value={customCategory}
                  onChange={onCustomCategoryChange}
                  onKeyDown={onKeyDown}
                  list="custom-category-suggestions"
                  placeholder={t('externalApi.uncategorized')}
                />
                <datalist id="custom-category-suggestions">
                  {customCategorySuggestions.map((cat) => (
                    <option key={cat} value={cat} />
                  ))}
                </datalist>
              </FormControl>

              <Divider />
              <Flex justifyContent="space-between" alignItems="center">
                <Button size="sm" colorScheme="invokeBlue" onClick={handleSave}>
                  {t('common.save')}
                </Button>
                <Tooltip label={t('externalApi.deleteEndpoint')}>
                  <Button size="sm" variant="ghost" colorScheme="error" onClick={handleDelete}>
                    {t('externalApi.deleteEndpoint')}
                  </Button>
                </Tooltip>
              </Flex>
            </Flex>
          </PopoverBody>
        </PopoverContent>
      </Portal>
    </Popover>
  );
});

EndpointSettingsPopover.displayName = 'EndpointSettingsPopover';
