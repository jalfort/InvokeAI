import { IconButton, Tooltip } from '@invoke-ai/ui-library';
import { useSelectTool, useToolIsSelected } from 'features/controlLayers/components/Tool/hooks';
import { useRegisteredHotkeys } from 'features/system/components/HotkeysModal/useHotkeyData';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { PiNotePencilBold } from 'react-icons/pi';

export const ToolAnnotateButton = memo(() => {
  const { t } = useTranslation();
  const isSelected = useToolIsSelected('annotate');
  const selectAnnotate = useSelectTool('annotate');

  useRegisteredHotkeys({
    id: 'selectAnnotateTool',
    category: 'canvas',
    callback: selectAnnotate,
    options: { enabled: !isSelected },
    dependencies: [isSelected, selectAnnotate],
  });

  return (
    <Tooltip label={`${t('controlLayers.tool.annotate')} (N)`} placement="end">
      <IconButton
        aria-label={`${t('controlLayers.tool.annotate')} (N)`}
        icon={<PiNotePencilBold />}
        colorScheme={isSelected ? 'invokeBlue' : 'base'}
        variant="solid"
        onClick={selectAnnotate}
      />
    </Tooltip>
  );
});

ToolAnnotateButton.displayName = 'ToolAnnotateButton';
