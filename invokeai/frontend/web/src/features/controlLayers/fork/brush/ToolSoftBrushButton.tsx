import { IconButton, Tooltip } from '@invoke-ai/ui-library';
import { useSelectTool, useToolIsSelected } from 'features/controlLayers/components/Tool/hooks';
import { useRegisteredHotkeys } from 'features/system/components/HotkeysModal/useHotkeyData';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { PiPaintBrushBold } from 'react-icons/pi';

export const ToolSoftBrushButton = memo(() => {
  const { t } = useTranslation();
  const isSelected = useToolIsSelected('softBrush');
  const selectSoftBrush = useSelectTool('softBrush');

  useRegisteredHotkeys({
    id: 'selectSoftBrushTool',
    category: 'canvas',
    callback: selectSoftBrush,
    options: { enabled: !isSelected },
    dependencies: [isSelected, selectSoftBrush],
  });

  return (
    <Tooltip label={`${t('controlLayers.tool.softBrush')} (K)`} placement="end">
      <IconButton
        aria-label={`${t('controlLayers.tool.softBrush')} (K)`}
        icon={<PiPaintBrushBold />}
        colorScheme={isSelected ? 'invokeBlue' : 'base'}
        variant="solid"
        onClick={selectSoftBrush}
      />
    </Tooltip>
  );
});

ToolSoftBrushButton.displayName = 'ToolSoftBrushButton';
