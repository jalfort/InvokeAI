import type { ComboboxOnChange, ComboboxOption } from '@invoke-ai/ui-library';
import {
  Button,
  Combobox,
  Divider,
  Flex,
  IconButton,
  Input,
  Modal,
  ModalBody,
  ModalCloseButton,
  ModalContent,
  ModalHeader,
  ModalOverlay,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Text,
  Textarea,
  Tooltip,
} from '@invoke-ai/ui-library';
import { useStore } from '@nanostores/react';
import { useAppDispatch } from 'app/store/storeHooks';
import { useClipboard } from 'common/hooks/useClipboard';
import { usePersistedTextAreaSize } from 'common/hooks/usePersistedTextareaSize';
import { positivePromptChanged } from 'features/controlLayers/store/paramsSlice';
import { toast } from 'features/toast/toast';
import { atom } from 'nanostores';
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PiArrowCounterClockwiseBold,
  PiCheckBold,
  PiClipboardTextBold,
  PiCursorTextBold,
  PiFloppyDiskBold,
  PiLockSimpleBold,
  PiLockSimpleOpenBold,
  PiPlusBold,
  PiSparkleBold,
  PiTrashSimpleBold,
} from 'react-icons/pi';
import type { SystemPromptEntry } from 'services/api/endpoints/externalApi';
import {
  useCreateSystemPromptMutation,
  useDeleteSystemPromptMutation,
  useDescribeImageMutation,
  useGetSystemPromptsQuery,
  useGetTextCapableProvidersQuery,
  useUpdateSystemPromptMutation,
} from 'services/api/endpoints/externalApi';
import { uploadImage } from 'services/api/endpoints/images';

const $activeDescribePresetId = atom<string | null>(null);

const resultTextareaPersistOptions: Parameters<typeof usePersistedTextAreaSize>[2] = {
  trackWidth: false,
  trackHeight: true,
  initialHeight: 120,
};

const ResultTextarea = memo(({ text }: { text: string }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  usePersistedTextAreaSize('imageDescriberResult', textareaRef, resultTextareaPersistOptions);

  return (
    <Textarea ref={textareaRef} value={text} readOnly fontSize="sm" h="120px" resize="vertical" variant="darkFilled" />
  );
});
ResultTextarea.displayName = 'ResultTextarea';

type DescriptionResult = {
  text: string;
  provider: string;
  model: string;
};

const PresetListItem = memo(
  ({
    preset,
    isSelected,
    isActive,
    onSelect,
  }: {
    preset: SystemPromptEntry;
    isSelected: boolean;
    isActive: boolean;
    onSelect: (preset: SystemPromptEntry) => void;
  }) => {
    const onClick = useCallback(() => {
      onSelect(preset);
    }, [preset, onSelect]);

    return (
      <Button
        size="sm"
        variant={isSelected ? 'solid' : 'ghost'}
        colorScheme={isActive ? 'invokeBlue' : undefined}
        justifyContent="flex-start"
        onClick={onClick}
        fontWeight={isActive ? 'bold' : 'normal'}
        overflow="hidden"
        textOverflow="ellipsis"
        whiteSpace="nowrap"
        gap={1}
      >
        {(preset.is_locked || preset.is_default) && <PiLockSimpleBold size={12} />}
        {preset.name}
      </Button>
    );
  }
);
PresetListItem.displayName = 'PresetListItem';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  imageName?: string;
  imageFile?: File;
};

export const ImageDescriberModal = memo(({ isOpen, onClose, imageName: imageNameProp, imageFile }: Props) => {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const nameInputRef = useRef<HTMLInputElement>(null);

  const clipboard = useClipboard();
  const { data: promptsData } = useGetSystemPromptsQuery({ category: 'describe' });
  const { data: textProvidersData } = useGetTextCapableProvidersQuery();
  const [describeImage, { isLoading }] = useDescribeImageMutation();
  const [createPrompt] = useCreateSystemPromptMutation();
  const [updatePrompt] = useUpdateSystemPromptMutation();
  const [deletePrompt] = useDeleteSystemPromptMutation();

  const activeDescribePresetId = useStore($activeDescribePresetId);
  const presets = useMemo(() => promptsData?.prompts ?? [], [promptsData]);
  const providers = useMemo(() => textProvidersData?.providers ?? [], [textProvidersData]);

  const [resolvedImageName, setResolvedImageName] = useState<string | null>(imageNameProp ?? null);
  const [isUploading, setIsUploading] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [shouldFocusName, setShouldFocusName] = useState(false);
  const skipAutoSelectRef = useRef(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [results, setResults] = useState<DescriptionResult[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);

  const selectedPreset = useMemo(
    () => presets.find((p) => p.id === selectedPresetId) ?? null,
    [presets, selectedPresetId]
  );
  const isLocked = selectedPreset?.is_locked ?? false;

  // Focus name input after creating new preset
  useEffect(() => {
    if (shouldFocusName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
      setShouldFocusName(false);
    }
  }, [shouldFocusName]);

  // Upload imageFile on mount if provided instead of imageName
  useEffect(() => {
    if (imageFile && !imageNameProp) {
      setIsUploading(true);
      uploadImage({ file: imageFile, image_category: 'other', is_intermediate: true })
        .then((imageDTO) => {
          setResolvedImageName(imageDTO.image_name);
        })
        .catch(() => {
          toast({ status: 'error', title: t('toast.problemSavingLayer') });
          onClose();
        })
        .finally(() => {
          setIsUploading(false);
        });
    }
  }, [imageFile, imageNameProp, onClose, t]);

  const providerOptions = useMemo(
    (): ComboboxOption[] => providers.map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) })),
    [providers]
  );

  const selectedProviderOption = useMemo(
    () => providerOptions.find((o) => o.value === selectedProvider) ?? null,
    [providerOptions, selectedProvider]
  );

  // Auto-select active preset (or first) when data loads
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    if (skipAutoSelectRef.current) {
      skipAutoSelectRef.current = false;
      return;
    }
    if (selectedPresetId && presets.find((p) => p.id === selectedPresetId)) {
      return;
    }
    const target = presets.find((p) => p.id === activeDescribePresetId) ?? presets[0];
    if (target) {
      setSelectedPresetId(target.id);
      setEditName(target.name);
      setEditContent(target.system_prompt);
      setIsDirty(false);
    }
  }, [isOpen, presets, selectedPresetId, activeDescribePresetId]);

  // Auto-select first provider
  useEffect(() => {
    if (!selectedProvider && providers.length > 0) {
      setSelectedProvider(providers[0]!);
    }
  }, [providers, selectedProvider]);

  const selectPreset = useCallback((preset: SystemPromptEntry) => {
    setSelectedPresetId(preset.id);
    setEditName(preset.name);
    setEditContent(preset.system_prompt);
    setIsDirty(false);
  }, []);

  const onProviderChange = useCallback<ComboboxOnChange>((v) => {
    if (v) {
      setSelectedProvider(v.value);
    }
  }, []);

  const onNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEditName(e.target.value);
    setIsDirty(true);
  }, []);

  const onContentChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setEditContent(e.target.value);
    setIsDirty(true);
  }, []);

  const onSave = useCallback(async () => {
    if (!selectedPresetId) {
      return;
    }
    await updatePrompt({ id: selectedPresetId, name: editName, system_prompt: editContent });
    setIsDirty(false);
  }, [selectedPresetId, editName, editContent, updatePrompt]);

  const onDelete = useCallback(async () => {
    if (!selectedPresetId || selectedPreset?.is_default) {
      return;
    }
    await deletePrompt({ id: selectedPresetId });
    setSelectedPresetId(null);
    setIsDirty(false);
  }, [selectedPresetId, selectedPreset, deletePrompt]);

  const onToggleLock = useCallback(async () => {
    if (!selectedPresetId || selectedPreset?.is_default) {
      return;
    }
    await updatePrompt({ id: selectedPresetId, is_locked: !isLocked });
  }, [selectedPresetId, selectedPreset, isLocked, updatePrompt]);

  const onSetActive = useCallback(() => {
    if (selectedPresetId) {
      $activeDescribePresetId.set(selectedPresetId);
    }
  }, [selectedPresetId]);

  const doDescribe = useCallback(async () => {
    const provider = selectedProvider ?? providers[0];
    if (!provider || !editContent.trim() || !resolvedImageName) {
      return;
    }

    try {
      const result = await describeImage({
        image_name: resolvedImageName,
        system_prompt: editContent,
        provider,
      }).unwrap();
      setResults((prev) => [...prev, { text: result.description, provider: result.provider, model: result.model }]);
      setActiveTabIndex(results.length);
    } catch {
      // Error handled by RTK Query
    }
  }, [selectedProvider, providers, editContent, resolvedImageName, describeImage, results.length]);

  const copyToClipboard = useCallback(() => {
    const result = results[activeTabIndex];
    if (result) {
      clipboard.writeText(result.text, () => {
        toast({ id: 'COPIED_DESCRIPTION', title: t('imageDescriber.copiedToClipboard'), status: 'success' });
      });
    }
  }, [results, activeTabIndex, clipboard, t]);

  const useAsPrompt = useCallback(() => {
    const result = results[activeTabIndex];
    if (result) {
      dispatch(positivePromptChanged(result.text));
      toast({ id: 'USED_AS_PROMPT', title: t('imageDescriber.usedAsPrompt'), status: 'success' });
      onClose();
    }
  }, [results, activeTabIndex, dispatch, onClose, t]);

  const onCreateNew = useCallback(async () => {
    skipAutoSelectRef.current = true;
    const newEntry = await createPrompt({
      name: 'New Description Preset',
      system_prompt: '',
      category: 'describe',
    }).unwrap();
    setSelectedPresetId(newEntry.id);
    setEditName(newEntry.name);
    setEditContent(newEntry.system_prompt);
    setIsDirty(false);
    setShouldFocusName(true);
  }, [createPrompt]);

  const handleClose = useCallback(() => {
    setResults([]);
    setActiveTabIndex(0);
    onClose();
  }, [onClose]);

  const hasNoProviders = providers.length === 0;

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="4xl" isCentered>
      <ModalOverlay />
      <ModalContent maxH="80vh" display="flex" flexDirection="column">
        <ModalHeader fontSize="md">{t('imageDescriber.describeImage')}</ModalHeader>
        <ModalCloseButton />
        <ModalBody pb={4} overflow="hidden" flex={1} minH={0}>
          {isUploading ? (
            <Flex justify="center" align="center" py={8}>
              <Spinner size="lg" />
            </Flex>
          ) : hasNoProviders ? (
            <Flex direction="column" gap={2} align="center" py={4}>
              <Text fontSize="sm" color="base.400" textAlign="center">
                {t('imageDescriber.noProviders')}
              </Text>
            </Flex>
          ) : (
            <Flex gap={4} h="full" minH={0}>
              {/* Left sidebar — preset list */}
              <Flex direction="column" w="200px" flexShrink={0} gap={2}>
                <Text fontSize="xs" color="base.400" fontWeight="semibold">
                  {t('imageDescriber.presets')}
                </Text>
                <Flex direction="column" gap={1} overflowY="auto" flex={1}>
                  {presets.map((p) => (
                    <PresetListItem
                      key={p.id}
                      preset={p}
                      isSelected={selectedPresetId === p.id}
                      isActive={activeDescribePresetId === p.id}
                      onSelect={selectPreset}
                    />
                  ))}
                </Flex>
                <Button size="sm" leftIcon={<PiPlusBold />} variant="ghost" onClick={onCreateNew}>
                  {t('imageDescriber.newPreset')}
                </Button>
              </Flex>

              <Divider orientation="vertical" />

              {/* Right panel */}
              {selectedPreset ? (
                <Flex direction="column" flex={1} gap={3} overflowY="auto" minH={0}>
                  {/* Preset name */}
                  <Flex direction="column" gap={1}>
                    <Text fontSize="xs" color="base.400" fontWeight="semibold">
                      {t('imageDescriber.presetName')}
                    </Text>
                    <Input
                      ref={nameInputRef}
                      value={editName}
                      onChange={onNameChange}
                      size="sm"
                      fontWeight="semibold"
                      placeholder={t('imageDescriber.presetName')}
                      isReadOnly={isLocked}
                      opacity={isLocked ? 0.6 : 1}
                    />
                  </Flex>

                  {/* System prompt */}
                  <Flex direction="column" gap={1}>
                    <Text fontSize="xs" color="base.400" fontWeight="semibold">
                      {t('imageDescriber.systemPromptLabel')}
                    </Text>
                    <Textarea
                      value={editContent}
                      onChange={onContentChange}
                      fontSize="sm"
                      minH="140px"
                      resize="vertical"
                      placeholder={t('imageDescriber.systemPromptPlaceholder')}
                      variant="darkFilled"
                      isReadOnly={isLocked}
                      opacity={isLocked ? 0.7 : 1}
                    />
                  </Flex>

                  {/* Action buttons — save / set active / lock / delete */}
                  <Flex gap={2} alignItems="center">
                    <Button
                      size="sm"
                      leftIcon={<PiFloppyDiskBold />}
                      onClick={onSave}
                      isDisabled={!isDirty || isLocked}
                    >
                      {t('common.save')}
                    </Button>
                    <Button
                      size="sm"
                      leftIcon={<PiCheckBold />}
                      onClick={onSetActive}
                      colorScheme={activeDescribePresetId === selectedPresetId ? 'invokeBlue' : undefined}
                      variant={activeDescribePresetId === selectedPresetId ? 'solid' : 'outline'}
                    >
                      {activeDescribePresetId === selectedPresetId
                        ? t('promptOptimizer.active')
                        : t('promptOptimizer.setActive')}
                    </Button>
                    {/* Lock/unlock toggle — not shown for default presets (always locked) */}
                    {!selectedPreset.is_default && (
                      <Tooltip label={isLocked ? t('promptOptimizer.unlock') : t('promptOptimizer.lock')}>
                        <IconButton
                          aria-label={isLocked ? t('promptOptimizer.unlock') : t('promptOptimizer.lock')}
                          icon={isLocked ? <PiLockSimpleBold /> : <PiLockSimpleOpenBold />}
                          size="sm"
                          variant="ghost"
                          colorScheme={isLocked ? 'invokeYellow' : undefined}
                          onClick={onToggleLock}
                        />
                      </Tooltip>
                    )}
                    {/* Default presets show a permanent lock icon */}
                    {selectedPreset.is_default && (
                      <Tooltip label={t('promptOptimizer.defaultLocked')}>
                        <IconButton
                          aria-label={t('promptOptimizer.defaultLocked')}
                          icon={<PiLockSimpleBold />}
                          size="sm"
                          variant="ghost"
                          colorScheme="invokeYellow"
                          isDisabled
                        />
                      </Tooltip>
                    )}
                    {!selectedPreset.is_default && !isLocked && (
                      <Tooltip label={t('common.delete')}>
                        <IconButton
                          aria-label={t('common.delete')}
                          icon={<PiTrashSimpleBold />}
                          size="sm"
                          variant="ghost"
                          colorScheme="error"
                          onClick={onDelete}
                        />
                      </Tooltip>
                    )}
                  </Flex>

                  {/* Provider selector + describe button */}
                  <Flex gap={2} alignItems="center">
                    <Flex flex={1}>
                      <Combobox
                        value={selectedProviderOption}
                        options={providerOptions}
                        onChange={onProviderChange}
                        placeholder={t('imageDescriber.selectProvider')}
                      />
                    </Flex>
                    <Button
                      size="sm"
                      leftIcon={<PiSparkleBold />}
                      onClick={doDescribe}
                      isLoading={isLoading}
                      isDisabled={!editContent.trim() || !resolvedImageName}
                      colorScheme="invokeBlue"
                    >
                      {t('imageDescriber.describe')}
                    </Button>
                  </Flex>

                  {/* Results area */}
                  {isLoading && results.length === 0 ? (
                    <Flex justify="center" py={6}>
                      <Spinner size="md" />
                    </Flex>
                  ) : results.length > 0 ? (
                    <>
                      <Tabs variant="line" size="sm" index={activeTabIndex} onChange={setActiveTabIndex}>
                        <TabList>
                          {results.map((_, i) => (
                            <Tab key={i} fontSize="xs">
                              {t('imageDescriber.result')} {i + 1}
                            </Tab>
                          ))}
                          {isLoading && (
                            <Tab isDisabled>
                              <Spinner size="xs" />
                            </Tab>
                          )}
                        </TabList>
                        <TabPanels>
                          {results.map((result, i) => (
                            <TabPanel key={i} px={0} py={2}>
                              <ResultTextarea text={result.text} />
                              <Text fontSize="xs" color="base.500" mt={1}>
                                {result.provider} / {result.model}
                              </Text>
                            </TabPanel>
                          ))}
                        </TabPanels>
                      </Tabs>

                      {/* Action buttons */}
                      <Flex gap={2} justifyContent="flex-end">
                        <Button
                          size="sm"
                          leftIcon={<PiArrowCounterClockwiseBold />}
                          onClick={doDescribe}
                          isLoading={isLoading}
                          variant="ghost"
                        >
                          {t('imageDescriber.reDescribe')}
                        </Button>
                        <Button size="sm" leftIcon={<PiClipboardTextBold />} onClick={copyToClipboard} variant="ghost">
                          {t('imageDescriber.copyToClipboard')}
                        </Button>
                        <Button
                          size="sm"
                          leftIcon={<PiCursorTextBold />}
                          onClick={useAsPrompt}
                          colorScheme="invokeBlue"
                        >
                          {t('imageDescriber.useAsPrompt')}
                        </Button>
                      </Flex>
                    </>
                  ) : null}
                </Flex>
              ) : (
                <Flex flex={1} justify="center" align="center">
                  <Text color="base.400">{t('imageDescriber.selectAPreset')}</Text>
                </Flex>
              )}
            </Flex>
          )}
        </ModalBody>
      </ModalContent>
    </Modal>
  );
});

ImageDescriberModal.displayName = 'ImageDescriberModal';
