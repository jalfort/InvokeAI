import { Box, Divider, Flex } from '@invoke-ai/ui-library';
import { CanvasSettingsPopover } from 'features/controlLayers/components/Settings/CanvasSettingsPopover';
import { TextToolOptions } from 'features/controlLayers/components/Text/TextToolOptions';
import { useToolIsSelected } from 'features/controlLayers/components/Tool/hooks';
import { ToolAnnotateSettings } from 'features/controlLayers/components/Tool/ToolAnnotateSettings';
import { ToolBrushSettings } from 'features/controlLayers/components/Tool/ToolBrushSettings';
import { ToolCloneBrushSettings } from 'features/controlLayers/components/Tool/ToolCloneBrushSettings';
import { ToolFillColorPicker } from 'features/controlLayers/components/Tool/ToolFillColorPicker';
import { ToolGradientClipToggle } from 'features/controlLayers/components/Tool/ToolGradientClipToggle';
import { ToolGradientModeToggle } from 'features/controlLayers/components/Tool/ToolGradientModeToggle';
import { ToolOptionsRowContainer } from 'features/controlLayers/components/Tool/ToolOptionsRowContainer';
import { ToolSelectionSettings } from 'features/controlLayers/components/Tool/ToolSelectionSettings';
import { ToolWidthPicker } from 'features/controlLayers/components/Tool/ToolWidthPicker';
import { CanvasToolbarFitBboxToLayersButton } from 'features/controlLayers/components/Toolbar/CanvasToolbarFitBboxToLayersButton';
import { CanvasToolbarFitBboxToMasksButton } from 'features/controlLayers/components/Toolbar/CanvasToolbarFitBboxToMasksButton';
import { CanvasToolbarNewSessionMenuButton } from 'features/controlLayers/components/Toolbar/CanvasToolbarNewSessionMenuButton';
import { CanvasToolbarRedoButton } from 'features/controlLayers/components/Toolbar/CanvasToolbarRedoButton';
import { CanvasToolbarResetViewButton } from 'features/controlLayers/components/Toolbar/CanvasToolbarResetViewButton';
import { CanvasToolbarSaveToGalleryButton } from 'features/controlLayers/components/Toolbar/CanvasToolbarSaveToGalleryButton';
import { CanvasToolbarScale } from 'features/controlLayers/components/Toolbar/CanvasToolbarScale';
import { CanvasToolbarUndoButton } from 'features/controlLayers/components/Toolbar/CanvasToolbarUndoButton';
import { useCanvasDeleteLayerHotkey } from 'features/controlLayers/hooks/useCanvasDeleteLayerHotkey';
import { useCanvasEntityQuickSwitchHotkey } from 'features/controlLayers/hooks/useCanvasEntityQuickSwitchHotkey';
import { useCanvasFilterHotkey } from 'features/controlLayers/hooks/useCanvasFilterHotkey';
import { useCanvasInvertMaskHotkey } from 'features/controlLayers/hooks/useCanvasInvertMaskHotkey';
import { useCanvasResetLayerHotkey } from 'features/controlLayers/hooks/useCanvasResetLayerHotkey';
import { useCanvasToggleBboxHotkey } from 'features/controlLayers/hooks/useCanvasToggleBboxHotkey';
import { useCanvasToggleNonRasterLayersHotkey } from 'features/controlLayers/hooks/useCanvasToggleNonRasterLayersHotkey';
import { useCanvasTransformHotkey } from 'features/controlLayers/hooks/useCanvasTransformHotkey';
import { useCanvasUndoRedoHotkeys } from 'features/controlLayers/hooks/useCanvasUndoRedoHotkeys';
import { useNextPrevEntityHotkeys } from 'features/controlLayers/hooks/useNextPrevEntity';
import { memo } from 'react';

export const CanvasToolbar = memo(() => {
  const isBrushSelected = useToolIsSelected('brush');
  const isCloneBrushSelected = useToolIsSelected('cloneBrush');
  const isEraserSelected = useToolIsSelected('eraser');
  const isTextSelected = useToolIsSelected('text');
  const isGradientSelected = useToolIsSelected('gradient');
  const isSelectionSelected = useToolIsSelected('selection');
  const isAnnotateSelected = useToolIsSelected('annotate');

  useCanvasResetLayerHotkey();
  useCanvasDeleteLayerHotkey();
  useCanvasUndoRedoHotkeys();
  useCanvasEntityQuickSwitchHotkey();
  useNextPrevEntityHotkeys();
  useCanvasTransformHotkey();
  useCanvasFilterHotkey();
  useCanvasInvertMaskHotkey();
  useCanvasToggleNonRasterLayersHotkey();
  useCanvasToggleBboxHotkey();

  return (
    <Flex w="full" gap={2} alignItems="center" px={2}>
      <ToolOptionsRowContainer gap={4} alignItems="center" h="full">
        <ToolFillColorPicker />
        {isGradientSelected && (
          <Box ms={2} mt="-2px" display="flex" alignItems="center" gap={2}>
            <ToolGradientClipToggle />
            <ToolGradientModeToggle />
          </Box>
        )}
        {isTextSelected && <TextToolOptions />}
        {isBrushSelected && <ToolBrushSettings />}
        {isCloneBrushSelected && <ToolCloneBrushSettings />}
        {isEraserSelected && <ToolWidthPicker />}
        {isSelectionSelected && <ToolSelectionSettings />}
        {isAnnotateSelected && <ToolAnnotateSettings />}
      </ToolOptionsRowContainer>
      <Flex alignItems="center" h="full">
        <CanvasToolbarScale />
        <CanvasToolbarResetViewButton />
        <CanvasToolbarFitBboxToLayersButton />
        <CanvasToolbarFitBboxToMasksButton />
      </Flex>
      <Divider orientation="vertical" />
      <Flex alignItems="center" h="full">
        <CanvasToolbarSaveToGalleryButton />
        <CanvasToolbarUndoButton />
        <CanvasToolbarRedoButton />
        <CanvasToolbarNewSessionMenuButton />
        <CanvasSettingsPopover />
      </Flex>
    </Flex>
  );
});

CanvasToolbar.displayName = 'CanvasToolbar';
