import { IconButton, Tooltip } from '@invoke-ai/ui-library';
import { useSelectTool, useToolIsSelected } from 'features/controlLayers/components/Tool/hooks';
import { useRegisteredHotkeys } from 'features/system/components/HotkeysModal/useHotkeyData';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { PiStampBold } from 'react-icons/pi';

export const ToolCloneBrushButton = memo(() => {
  const { t } = useTranslation();
  const isSelected = useToolIsSelected('cloneBrush');
  const selectCloneBrush = useSelectTool('cloneBrush');

  useRegisteredHotkeys({
    id: 'selectCloneBrushTool',
    category: 'canvas',
    callback: selectCloneBrush,
    options: { enabled: !isSelected },
    dependencies: [isSelected, selectCloneBrush],
  });

  return (
    <Tooltip label={`${t('controlLayers.tool.cloneBrush')} (J)`} placement="end">
      <IconButton
        aria-label={`${t('controlLayers.tool.cloneBrush')} (J)`}
        icon={<PiStampBold />}
        colorScheme={isSelected ? 'invokeBlue' : 'base'}
        variant="solid"
        onClick={selectCloneBrush}
      />
    </Tooltip>
  );
});

ToolCloneBrushButton.displayName = 'ToolCloneBrushButton';
