import { MenuDivider, MenuGroup, MenuItem } from '@invoke-ai/ui-library';
import { useStore } from '@nanostores/react';
import { useCanvasManager } from 'features/controlLayers/contexts/CanvasManagerProviderGate';
import { useCanvasIsBusy } from 'features/controlLayers/hooks/useCanvasIsBusy';
import { computed } from 'nanostores';
import { memo, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  PiArrowCounterClockwiseBold,
  PiPaintBucketBold,
  PiSelectionInverseBold,
  PiSelectionSlashBold,
  PiTrashBold,
} from 'react-icons/pi';

export const CanvasContextMenuSelectionItems = memo(() => {
  const { t } = useTranslation();
  const canvasManager = useCanvasManager();
  const isBusy = useCanvasIsBusy();

  const $isSelectionTool = useMemo(
    () => computed(canvasManager.tool.$tool, (tool) => tool === 'selection'),
    [canvasManager.tool.$tool]
  );
  const isSelectionTool = useStore($isSelectionTool);

  const $hasSelection = useMemo(
    () => computed(canvasManager.tool.tools.selection.$selectionMask, (mask) => mask !== null),
    [canvasManager.tool.tools.selection.$selectionMask]
  );
  const hasSelection = useStore($hasSelection);

  const $canUndoShape = useMemo(
    () => computed(canvasManager.tool.tools.selection.$subSelections, (stack) => stack.length > 1),
    [canvasManager.tool.tools.selection.$subSelections]
  );
  const canUndoShape = useStore($canUndoShape);

  const onFill = useCallback(() => {
    canvasManager.tool.tools.selection.fillSelection();
  }, [canvasManager]);

  const onDelete = useCallback(() => {
    canvasManager.tool.tools.selection.deleteSelection();
  }, [canvasManager]);

  const onInvert = useCallback(() => {
    canvasManager.tool.tools.selection.invertSelection();
  }, [canvasManager]);

  const onUndoShape = useCallback(() => {
    canvasManager.tool.tools.selection.undoLastSubSelection();
  }, [canvasManager]);

  const onDeselect = useCallback(() => {
    canvasManager.tool.tools.selection.clearSelection();
  }, [canvasManager]);

  if (!isSelectionTool || !hasSelection) {
    return null;
  }

  return (
    <MenuGroup title={t('controlLayers.selection.selectionGroup', { defaultValue: 'Selection' })}>
      <MenuItem icon={<PiPaintBucketBold />} isDisabled={isBusy} onClick={onFill}>
        {t('controlLayers.selection.fill', { defaultValue: 'Fill with Color' })}
      </MenuItem>
      <MenuItem icon={<PiTrashBold />} isDisabled={isBusy} onClick={onDelete}>
        {t('controlLayers.selection.delete', { defaultValue: 'Delete' })}
      </MenuItem>
      <MenuItem icon={<PiSelectionInverseBold />} isDisabled={isBusy} onClick={onInvert}>
        {t('controlLayers.selection.invert', { defaultValue: 'Invert Selection' })}
      </MenuItem>
      {canUndoShape && (
        <MenuItem icon={<PiArrowCounterClockwiseBold />} isDisabled={isBusy} onClick={onUndoShape}>
          {t('controlLayers.selection.undoLastShape', { defaultValue: 'Undo Last Shape' })}
        </MenuItem>
      )}
      <MenuDivider />
      <MenuItem icon={<PiSelectionSlashBold />} onClick={onDeselect}>
        {t('controlLayers.selection.deselect', { defaultValue: 'Deselect' })}
      </MenuItem>
    </MenuGroup>
  );
});

CanvasContextMenuSelectionItems.displayName = 'CanvasContextMenuSelectionItems';
