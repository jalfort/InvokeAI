import { IconButton, Tooltip } from '@invoke-ai/ui-library';
import { useSelectTool, useToolIsSelected } from 'features/controlLayers/components/Tool/hooks';
import { useRegisteredHotkeys } from 'features/system/components/HotkeysModal/useHotkeyData';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { PiSelectionBold } from 'react-icons/pi';

export const ToolSelectionButton = memo(() => {
  const { t } = useTranslation();
  const isSelected = useToolIsSelected('selection');
  const selectSelection = useSelectTool('selection');

  useRegisteredHotkeys({
    id: 'selectSelectionTool',
    category: 'canvas',
    callback: selectSelection,
    options: { enabled: !isSelected },
    dependencies: [isSelected, selectSelection],
  });

  return (
    <Tooltip label={`${t('controlLayers.tool.selection')} (S)`} placement="end">
      <IconButton
        aria-label={`${t('controlLayers.tool.selection')} (S)`}
        icon={<PiSelectionBold />}
        colorScheme={isSelected ? 'invokeBlue' : 'base'}
        variant="solid"
        onClick={selectSelection}
      />
    </Tooltip>
  );
});

ToolSelectionButton.displayName = 'ToolSelectionButton';
