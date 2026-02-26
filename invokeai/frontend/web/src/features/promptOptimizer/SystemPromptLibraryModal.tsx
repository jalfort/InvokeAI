import type { ComboboxOnChange, ComboboxOption } from '@invoke-ai/ui-library';
import {
  Button,
  Checkbox,
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
import type { ChangeEvent } from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PiArrowCounterClockwiseBold,
  PiCheckBold,
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
  useGetSystemPromptsQuery,
  useGetTextCapableProvidersQuery,
  useRefineSystemPromptMutation,
  useUpdateSystemPromptMutation,
} from 'services/api/endpoints/externalApi';

type RefineResult = {
  text: string;
  provider: string;
  model: string;
};

const PromptListItem = memo(
  ({
    prompt,
    isSelected,
    isActive,
    onSelect,
  }: {
    prompt: SystemPromptEntry;
    isSelected: boolean;
    isActive: boolean;
    onSelect: (prompt: SystemPromptEntry) => void;
  }) => {
    const onClick = useCallback(() => {
      onSelect(prompt);
    }, [prompt, onSelect]);

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
        {(prompt.is_locked || prompt.is_default) && <PiLockSimpleBold size={12} />}
        {prompt.name}
      </Button>
    );
  }
);
PromptListItem.displayName = 'PromptListItem';

type Props = {
  isOpen: boolean;
  onClose: () => void;
  activeSystemPromptId: string | null;
  onSelect: (id: string) => void;
};

export const SystemPromptLibraryModal = memo(({ isOpen, onClose, activeSystemPromptId, onSelect }: Props) => {
  const { t } = useTranslation();
  const nameInputRef = useRef<HTMLInputElement>(null);

  const { data: promptsData } = useGetSystemPromptsQuery();
  const { data: textProvidersData } = useGetTextCapableProvidersQuery();
  const [createPrompt] = useCreateSystemPromptMutation();
  const [updatePrompt] = useUpdateSystemPromptMutation();
  const [deletePrompt] = useDeleteSystemPromptMutation();
  const [refinePrompt, { isLoading: isRefining }] = useRefineSystemPromptMutation();

  const prompts = useMemo(() => promptsData?.prompts ?? [], [promptsData]);
  const providers = useMemo(() => textProvidersData?.providers ?? [], [textProvidersData]);
  const defaultSystemPrompt = useMemo(
    () => prompts.find((p) => p.is_default)?.system_prompt ?? null,
    [prompts]
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editContent, setEditContent] = useState('');
  const [isDirty, setIsDirty] = useState(false);
  const [shouldFocusName, setShouldFocusName] = useState(false);
  const skipAutoSelectRef = useRef(false);

  // Refinement state
  const [refineInstruction, setRefineInstruction] = useState('');
  const [sendCurrentPrompt, setSendCurrentPrompt] = useState(false);
  const [refineProvider, setRefineProvider] = useState<string | null>(null);
  const [refineResults, setRefineResults] = useState<RefineResult[]>([]);
  const [refineTabIndex, setRefineTabIndex] = useState(0);

  const providerOptions = useMemo((): ComboboxOption[] => {
    return providers.map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }));
  }, [providers]);

  const selectedProviderOption = useMemo(
    () => providerOptions.find((o) => o.value === refineProvider) ?? null,
    [providerOptions, refineProvider]
  );

  const selectedPrompt = useMemo(
    () => prompts.find((p) => p.id === selectedId) ?? null,
    [prompts, selectedId]
  );

  const isLocked = selectedPrompt?.is_locked ?? false;

  // Focus name input after creating new prompt
  useEffect(() => {
    if (shouldFocusName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
      setShouldFocusName(false);
    }
  }, [shouldFocusName]);

  // Sync selection when data loads or modal opens
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    // Skip auto-select if we just intentionally set a selection (e.g. save-as-new, create)
    if (skipAutoSelectRef.current) {
      skipAutoSelectRef.current = false;
      return;
    }
    if (selectedId && prompts.find((p) => p.id === selectedId)) {
      return;
    }
    const target = prompts.find((p) => p.id === activeSystemPromptId) ?? prompts[0];
    if (target) {
      setSelectedId(target.id);
      setEditName(target.name);
      setEditContent(target.system_prompt);
      setIsDirty(false);
    }
  }, [isOpen, prompts, selectedId, activeSystemPromptId]);

  // Auto-select first provider
  useEffect(() => {
    if (!refineProvider && providers.length > 0) {
      setRefineProvider(providers[0]!);
    }
  }, [providers, refineProvider]);

  const selectPrompt = useCallback(
    (prompt: SystemPromptEntry) => {
      setSelectedId(prompt.id);
      setEditName(prompt.name);
      setEditContent(prompt.system_prompt);
      setIsDirty(false);
      setRefineResults([]);
      setRefineTabIndex(0);
    },
    []
  );

  const onNameChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setEditName(e.target.value);
    setIsDirty(true);
  }, []);

  const onContentChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setEditContent(e.target.value);
    setIsDirty(true);
  }, []);

  const onSave = useCallback(async () => {
    if (!selectedId) {
      return;
    }
    await updatePrompt({ id: selectedId, name: editName, system_prompt: editContent });
    setIsDirty(false);
  }, [selectedId, editName, editContent, updatePrompt]);

  const onDelete = useCallback(async () => {
    if (!selectedId || selectedPrompt?.is_default) {
      return;
    }
    await deletePrompt({ id: selectedId });
    setSelectedId(null);
    setIsDirty(false);
  }, [selectedId, selectedPrompt, deletePrompt]);

  const onSetActive = useCallback(() => {
    if (selectedId) {
      onSelect(selectedId);
    }
  }, [selectedId, onSelect]);

  const onToggleLock = useCallback(async () => {
    if (!selectedId || selectedPrompt?.is_default) {
      return;
    }
    await updatePrompt({ id: selectedId, is_locked: !isLocked });
  }, [selectedId, selectedPrompt, isLocked, updatePrompt]);

  const onCreateNew = useCallback(async () => {
    skipAutoSelectRef.current = true;
    const result = await createPrompt({
      name: 'New System Prompt',
      system_prompt: '',
    }).unwrap();
    setSelectedId(result.id);
    setEditName(result.name);
    setEditContent(result.system_prompt);
    setIsDirty(false);
    setShouldFocusName(true);
  }, [createPrompt]);

  const onRefineProviderChange = useCallback<ComboboxOnChange>((v) => {
    if (v) {
      setRefineProvider(v.value);
    }
  }, []);

  const onRefineInstructionChange = useCallback((e: ChangeEvent<HTMLTextAreaElement>) => {
    setRefineInstruction(e.target.value);
  }, []);

  const onSendCurrentPromptChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSendCurrentPrompt(e.target.checked);
  }, []);

  const doRefine = useCallback(async () => {
    if (!refineProvider || !refineInstruction.trim()) {
      return;
    }
    try {
      const result = await refinePrompt({
        system_prompt: editContent,
        instruction: refineInstruction,
        reference_prompt: sendCurrentPrompt ? defaultSystemPrompt : null,
        provider: refineProvider,
      }).unwrap();
      setRefineResults((prev) => [
        ...prev,
        { text: result.refined_prompt, provider: result.provider, model: result.model },
      ]);
      setRefineTabIndex(refineResults.length);
    } catch {
      // Handled by RTK Query
    }
  }, [refineProvider, refineInstruction, editContent, sendCurrentPrompt, defaultSystemPrompt, refinePrompt, refineResults.length]);

  const replaceCurrentPrompt = useCallback(() => {
    const result = refineResults[refineTabIndex];
    if (result) {
      setEditContent(result.text);
      setIsDirty(true);
      setRefineResults([]);
      setRefineTabIndex(0);
    }
  }, [refineResults, refineTabIndex]);

  const saveAsNewPrompt = useCallback(async () => {
    const result = refineResults[refineTabIndex];
    if (!result) {
      return;
    }
    skipAutoSelectRef.current = true;
    const newEntry = await createPrompt({
      name: `${editName} (refined)`,
      system_prompt: result.text,
    }).unwrap();
    setSelectedId(newEntry.id);
    setEditName(newEntry.name);
    setEditContent(newEntry.system_prompt);
    setIsDirty(false);
    setRefineResults([]);
    setRefineTabIndex(0);
    setShouldFocusName(true);
  }, [refineResults, refineTabIndex, editName, createPrompt]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} size="4xl" isCentered>
      <ModalOverlay />
      <ModalContent maxH="80vh">
        <ModalHeader fontSize="md">{t('promptOptimizer.systemPromptLibrary')}</ModalHeader>
        <ModalCloseButton />
        <ModalBody pb={4} overflow="hidden">
          <Flex gap={4} h="full" minH="400px">
            {/* Left sidebar — prompt list */}
            <Flex direction="column" w="200px" flexShrink={0} gap={2}>
              <Flex direction="column" gap={1} overflowY="auto" flex={1}>
                {prompts.map((p) => (
                  <PromptListItem
                    key={p.id}
                    prompt={p}
                    isSelected={selectedId === p.id}
                    isActive={activeSystemPromptId === p.id}
                    onSelect={selectPrompt}
                  />
                ))}
              </Flex>
              <Button size="sm" leftIcon={<PiPlusBold />} variant="ghost" onClick={onCreateNew}>
                {t('promptOptimizer.newPrompt')}
              </Button>
            </Flex>

            <Divider orientation="vertical" />

            {/* Right panel — editor */}
            {selectedPrompt ? (
              <Flex direction="column" flex={1} gap={3} overflowY="auto">
                {/* Name field with label */}
                <Flex direction="column" gap={1}>
                  <Text fontSize="xs" color="base.400" fontWeight="semibold">
                    {t('promptOptimizer.promptName')}
                  </Text>
                  <Input
                    ref={nameInputRef}
                    value={editName}
                    onChange={onNameChange}
                    size="sm"
                    fontWeight="semibold"
                    placeholder={t('promptOptimizer.promptName')}
                    isReadOnly={isLocked}
                    opacity={isLocked ? 0.6 : 1}
                  />
                </Flex>

                {/* System prompt content */}
                <Flex direction="column" gap={1}>
                  <Text fontSize="xs" color="base.400" fontWeight="semibold">
                    {t('promptOptimizer.systemPromptLabel')}
                  </Text>
                  <Textarea
                    value={editContent}
                    onChange={onContentChange}
                    fontSize="sm"
                    minH="240px"
                    resize="vertical"
                    placeholder={t('promptOptimizer.systemPromptPlaceholder')}
                    variant="darkFilled"
                    isReadOnly={isLocked}
                    opacity={isLocked ? 0.7 : 1}
                  />
                </Flex>

                {/* Action buttons */}
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
                    colorScheme={activeSystemPromptId === selectedId ? 'invokeBlue' : undefined}
                    variant={activeSystemPromptId === selectedId ? 'solid' : 'outline'}
                  >
                    {activeSystemPromptId === selectedId ? t('promptOptimizer.active') : t('promptOptimizer.setActive')}
                  </Button>
                  {/* Lock/unlock toggle — not shown for default prompts (always locked) */}
                  {!selectedPrompt.is_default && (
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
                  {/* Default prompts show a permanent lock icon */}
                  {selectedPrompt.is_default && (
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
                  {!selectedPrompt.is_default && !isLocked && (
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

                <Divider />

                {/* Refinement section */}
                <Text fontSize="sm" fontWeight="semibold">
                  {t('promptOptimizer.refineTitle')}
                </Text>

                <Flex gap={2} alignItems="center">
                  <Flex flex={1}>
                    <Combobox
                      value={selectedProviderOption}
                      options={providerOptions}
                      onChange={onRefineProviderChange}
                      placeholder={t('promptOptimizer.selectProvider')}
                    />
                  </Flex>
                </Flex>

                <Textarea
                  value={refineInstruction}
                  onChange={onRefineInstructionChange}
                  fontSize="sm"
                  minH="120px"
                  resize="vertical"
                  placeholder={t('promptOptimizer.refineInstruction')}
                  variant="darkFilled"
                />

                <Checkbox isChecked={sendCurrentPrompt} onChange={onSendCurrentPromptChange}>
                  <Text fontSize="xs">{t('promptOptimizer.sendCurrentPrompt')}</Text>
                </Checkbox>

                <Flex gap={2}>
                  <Button
                    size="sm"
                    leftIcon={<PiSparkleBold />}
                    onClick={doRefine}
                    isLoading={isRefining}
                    isDisabled={!refineInstruction.trim() || !refineProvider}
                  >
                    {t('promptOptimizer.refine')}
                  </Button>
                </Flex>

                {/* Refinement results */}
                {refineResults.length > 0 && (
                  <Flex direction="column" gap={2}>
                    <Tabs variant="line" size="sm" index={refineTabIndex} onChange={setRefineTabIndex}>
                      <TabList>
                        {refineResults.map((_, i) => (
                          <Tab key={i} fontSize="xs">
                            {t('promptOptimizer.result')} {i + 1}
                          </Tab>
                        ))}
                        {isRefining && (
                          <Tab isDisabled>
                            <Spinner size="xs" />
                          </Tab>
                        )}
                      </TabList>
                      <TabPanels>
                        {refineResults.map((result, i) => (
                          <TabPanel key={i} px={0} py={2}>
                            <Textarea
                              value={result.text}
                              readOnly
                              fontSize="sm"
                              minH="160px"
                              resize="vertical"
                              variant="darkFilled"
                            />
                            <Text fontSize="xs" color="base.500" mt={1}>
                              {result.provider} / {result.model}
                            </Text>
                          </TabPanel>
                        ))}
                      </TabPanels>
                    </Tabs>
                    <Flex gap={2}>
                      <Button
                        size="sm"
                        leftIcon={<PiCheckBold />}
                        onClick={replaceCurrentPrompt}
                        colorScheme="invokeBlue"
                        isDisabled={isLocked}
                      >
                        {t('promptOptimizer.replaceCurrent')}
                      </Button>
                      <Button
                        size="sm"
                        leftIcon={<PiPlusBold />}
                        onClick={saveAsNewPrompt}
                        variant="outline"
                      >
                        {t('promptOptimizer.saveAsNew')}
                      </Button>
                      <Button
                        size="sm"
                        leftIcon={<PiArrowCounterClockwiseBold />}
                        onClick={doRefine}
                        isLoading={isRefining}
                        variant="ghost"
                      >
                        {t('promptOptimizer.reroll')}
                      </Button>
                    </Flex>
                  </Flex>
                )}
              </Flex>
            ) : (
              <Flex flex={1} justify="center" align="center">
                <Text color="base.400">{t('promptOptimizer.selectAPrompt')}</Text>
              </Flex>
            )}
          </Flex>
        </ModalBody>
      </ModalContent>
    </Modal>
  );
});

SystemPromptLibraryModal.displayName = 'SystemPromptLibraryModal';
