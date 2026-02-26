import type { ComboboxOnChange, ComboboxOption } from '@invoke-ai/ui-library';
import {
  Button,
  Combobox,
  Flex,
  IconButton,
  Popover,
  PopoverArrow,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Portal,
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
import { useAppSelector } from 'app/store/storeHooks';
import { selectPositivePrompt } from 'features/controlLayers/store/paramsSlice';
import { memo, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiArrowCounterClockwiseBold, PiCheckBold, PiGearSixBold } from 'react-icons/pi';
import {
  useGetSystemPromptsQuery,
  useGetTextCapableProvidersQuery,
  useOptimizePromptMutation,
} from 'services/api/endpoints/externalApi';

import { OptimizePromptButton } from './OptimizePromptButton';
import { SystemPromptLibraryModal } from './SystemPromptLibraryModal';

type OptimizationResult = {
  text: string;
  provider: string;
  model: string;
};

type Props = {
  onAccept: (optimizedPrompt: string) => void;
};

export const PromptOptimizerPopover = memo(({ onAccept }: Props) => {
  const { t } = useTranslation();
  const prompt = useAppSelector(selectPositivePrompt);

  const { data: textProvidersData } = useGetTextCapableProvidersQuery();
  const { data: systemPromptsData } = useGetSystemPromptsQuery();
  const [optimizePrompt, { isLoading }] = useOptimizePromptMutation();

  const [isOpen, setIsOpen] = useState(false);
  const [results, setResults] = useState<OptimizationResult[]>([]);
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [activeSystemPromptId, setActiveSystemPromptId] = useState<string | null>(null);
  const [isLibraryOpen, setIsLibraryOpen] = useState(false);

  const providers = useMemo(() => textProvidersData?.providers ?? [], [textProvidersData]);

  const providerOptions = useMemo((): ComboboxOption[] => {
    return providers.map((p) => ({ value: p, label: p.charAt(0).toUpperCase() + p.slice(1) }));
  }, [providers]);

  const selectedProviderOption = useMemo(
    () => providerOptions.find((o) => o.value === selectedProvider) ?? null,
    [providerOptions, selectedProvider]
  );

  const activeSystemPrompt = useMemo(() => {
    if (!systemPromptsData) {
      return null;
    }
    if (activeSystemPromptId) {
      return systemPromptsData.prompts.find((p) => p.id === activeSystemPromptId) ?? systemPromptsData.prompts[0] ?? null;
    }
    return systemPromptsData.prompts[0] ?? null;
  }, [systemPromptsData, activeSystemPromptId]);

  const onProviderChange = useCallback<ComboboxOnChange>((v) => {
    if (v) {
      setSelectedProvider(v.value);
    }
  }, []);

  const doOptimize = useCallback(async () => {
    const provider = selectedProvider ?? providers[0];
    if (!provider || !prompt.trim()) {
      return;
    }
    const systemPromptText = activeSystemPrompt?.system_prompt ?? '';
    if (!systemPromptText) {
      return;
    }

    try {
      const result = await optimizePrompt({
        prompt,
        system_prompt: systemPromptText,
        provider,
      }).unwrap();
      setResults((prev) => [...prev, { text: result.optimized_prompt, provider: result.provider, model: result.model }]);
      setActiveTabIndex((prev) => prev + 1 || 0);
    } catch {
      // Error handled by RTK Query
    }
  }, [selectedProvider, providers, prompt, activeSystemPrompt, optimizePrompt]);

  const openPopover = useCallback(
    (autoOptimize: boolean) => {
      setIsOpen(true);
      // Auto-select first provider if none selected
      if (!selectedProvider && providers.length > 0) {
        setSelectedProvider(providers[0]!);
      }
      // Auto-optimize on left-click if we have what we need
      if (autoOptimize && prompt.trim() && (selectedProvider || providers.length > 0)) {
        const provider = selectedProvider ?? providers[0];
        const systemPromptText = activeSystemPrompt?.system_prompt ?? '';
        if (provider && systemPromptText) {
          optimizePrompt({
            prompt,
            system_prompt: systemPromptText,
            provider,
          })
            .unwrap()
            .then((result) => {
              setResults([{ text: result.optimized_prompt, provider: result.provider, model: result.model }]);
              setActiveTabIndex(0);
            })
            .catch(() => {
              // Handled by RTK Query
            });
        }
      }
    },
    [selectedProvider, providers, prompt, activeSystemPrompt, optimizePrompt]
  );

  const onOpen = useCallback(() => {
    openPopover(true);
  }, [openPopover]);

  const onOpenWithoutOptimize = useCallback(() => {
    openPopover(false);
  }, [openPopover]);

  const onClose = useCallback(() => {
    setIsOpen(false);
    setResults([]);
    setActiveTabIndex(0);
  }, []);

  const handleAccept = useCallback(() => {
    const result = results[activeTabIndex];
    if (result) {
      onAccept(result.text);
      onClose();
    }
  }, [results, activeTabIndex, onAccept, onClose]);

  const handleReroll = useCallback(() => {
    doOptimize();
  }, [doOptimize]);

  const openLibrary = useCallback(() => {
    setIsLibraryOpen(true);
  }, []);

  const closeLibrary = useCallback(() => {
    setIsLibraryOpen(false);
  }, []);

  const onSystemPromptSelect = useCallback((id: string) => {
    setActiveSystemPromptId(id);
  }, []);

  const hasNoProviders = providers.length === 0;

  return (
    <>
      <Popover isOpen={isOpen} onClose={onClose} isLazy placement="bottom-end">
        <PopoverTrigger>
          <span>
            <OptimizePromptButton onClick={onOpen} onRightClick={onOpenWithoutOptimize} />
          </span>
        </PopoverTrigger>
        <Portal>
          <PopoverContent w="420px" maxH="500px">
            <PopoverArrow />
            <PopoverBody p={3}>
              {hasNoProviders ? (
                <Flex direction="column" gap={2} align="center" py={4}>
                  <Text fontSize="sm" color="base.400" textAlign="center">
                    {t('promptOptimizer.noProviders')}
                  </Text>
                </Flex>
              ) : (
                <Flex direction="column" gap={3}>
                  {/* Provider selector + system prompt gear */}
                  <Flex gap={2} alignItems="center">
                    <Flex flex={1}>
                      <Combobox
                        value={selectedProviderOption}
                        options={providerOptions}
                        onChange={onProviderChange}
                        placeholder={t('promptOptimizer.selectProvider')}
                      />
                    </Flex>
                    <Tooltip label={t('promptOptimizer.systemPromptLibrary')}>
                      <IconButton
                        aria-label={t('promptOptimizer.systemPromptLibrary')}
                        icon={<PiGearSixBold />}
                        size="sm"
                        variant="ghost"
                        onClick={openLibrary}
                      />
                    </Tooltip>
                  </Flex>

                  {/* Active system prompt indicator */}
                  {activeSystemPrompt && (
                    <Text fontSize="xs" color="base.400" noOfLines={1}>
                      {t('promptOptimizer.using')}: {activeSystemPrompt.name}
                    </Text>
                  )}

                  {/* Results area */}
                  {isLoading && results.length === 0 ? (
                    <Flex justify="center" py={6}>
                      <Spinner size="md" />
                    </Flex>
                  ) : results.length > 0 ? (
                    <Tabs
                      variant="line"
                      size="sm"
                      index={activeTabIndex}
                      onChange={setActiveTabIndex}
                    >
                      <TabList>
                        {results.map((_, i) => (
                          <Tab key={i} fontSize="xs">
                            {t('promptOptimizer.result')} {i + 1}
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
                            <Textarea
                              value={result.text}
                              readOnly
                              fontSize="sm"
                              minH="120px"
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
                  ) : (
                    <Flex justify="center" py={4}>
                      <Text fontSize="sm" color="base.400">
                        {t('promptOptimizer.clickToOptimize')}
                      </Text>
                    </Flex>
                  )}

                  {/* Action buttons */}
                  <Flex gap={2} justifyContent="flex-end">
                    <Button
                      size="sm"
                      leftIcon={<PiArrowCounterClockwiseBold />}
                      onClick={handleReroll}
                      isLoading={isLoading}
                      isDisabled={!prompt.trim()}
                      variant="ghost"
                    >
                      {t('promptOptimizer.reroll')}
                    </Button>
                    <Button
                      size="sm"
                      leftIcon={<PiCheckBold />}
                      onClick={handleAccept}
                      isDisabled={results.length === 0}
                      colorScheme="invokeBlue"
                    >
                      {t('promptOptimizer.accept')}
                    </Button>
                  </Flex>
                </Flex>
              )}
            </PopoverBody>
          </PopoverContent>
        </Portal>
      </Popover>

      <SystemPromptLibraryModal
        isOpen={isLibraryOpen}
        onClose={closeLibrary}
        activeSystemPromptId={activeSystemPrompt?.id ?? null}
        onSelect={onSystemPromptSelect}
      />
    </>
  );
});

PromptOptimizerPopover.displayName = 'PromptOptimizerPopover';
