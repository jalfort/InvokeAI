import {
  ButtonGroup,
  Flex,
  IconButton,
  Popover,
  PopoverArrow,
  PopoverBody,
  PopoverContent,
  PopoverTrigger,
  Portal,
  Text,
  useDisclosure,
} from '@invoke-ai/ui-library';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';

import { JaToolboxIcon } from './JaToolboxIcon';
import { JA_TOOL_REGISTRY } from './registry';
import { useIsJaToolActive } from './useIsJaToolActive';

/**
 * FORK ("JA toolbox"): a single rail button that opens a popover drawer housing all
 * fork-built canvas tools (selection, soft/clone brush, annotation). Upstream's native
 * toolset stays untouched — our tools live under this one icon (the "Nuke studio menu"
 * model). Tools are added via `registry.ts`; this shell never changes.
 */
export const JaToolboxButton = memo(() => {
  const { t } = useTranslation();
  const disclosure = useDisclosure();
  const isJaToolActive = useIsJaToolActive();
  const label = t('controlLayers.tool.jaToolbox', { defaultValue: 'JA Toolbox' });

  return (
    <Popover
      isLazy
      isOpen={disclosure.isOpen}
      onOpen={disclosure.onOpen}
      onClose={disclosure.onClose}
      placement="right"
    >
      <PopoverTrigger>
        <IconButton
          aria-label={label}
          icon={<JaToolboxIcon />}
          colorScheme={isJaToolActive ? 'invokeBlue' : 'base'}
          variant="solid"
        />
      </PopoverTrigger>
      <Portal>
        <PopoverContent w="auto">
          <PopoverArrow />
          <PopoverBody>
            {JA_TOOL_REGISTRY.length > 0 ? (
              <ButtonGroup isAttached orientation="vertical">
                {JA_TOOL_REGISTRY.map(({ tool, Button }) => (
                  <Button key={tool} />
                ))}
              </ButtonGroup>
            ) : (
              <Flex p={2} maxW={48}>
                <Text fontSize="sm" color="base.300">
                  {t('controlLayers.tool.jaToolboxEmpty', {
                    defaultValue: 'JA tools appear here as they ship (selection, brushes, annotation).',
                  })}
                </Text>
              </Flex>
            )}
          </PopoverBody>
        </PopoverContent>
      </Portal>
    </Popover>
  );
});

JaToolboxButton.displayName = 'JaToolboxButton';
