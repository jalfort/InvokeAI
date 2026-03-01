import { ButtonGroup } from '@invoke-ai/ui-library';
import { ToolAnnotateButton } from 'features/controlLayers/components/Tool/ToolAnnotateButton';
import { ToolBboxButton } from 'features/controlLayers/components/Tool/ToolBboxButton';
import { ToolBrushButton } from 'features/controlLayers/components/Tool/ToolBrushButton';
import { ToolCloneBrushButton } from 'features/controlLayers/components/Tool/ToolCloneBrushButton';
import { ToolColorPickerButton } from 'features/controlLayers/components/Tool/ToolColorPickerButton';
import { ToolGradientButton } from 'features/controlLayers/components/Tool/ToolGradientButton';
import { ToolMoveButton } from 'features/controlLayers/components/Tool/ToolMoveButton';
import { ToolRectButton } from 'features/controlLayers/components/Tool/ToolRectButton';
import { ToolSelectionButton } from 'features/controlLayers/components/Tool/ToolSelectionButton';
import { ToolTextButton } from 'features/controlLayers/components/Tool/ToolTextButton';
import React from 'react';

import { ToolEraserButton } from './ToolEraserButton';
import { ToolViewButton } from './ToolViewButton';

export const ToolChooser: React.FC = () => {
  return (
    <>
      <ButtonGroup isAttached orientation="vertical">
        <ToolBrushButton />
        <ToolEraserButton />
        <ToolCloneBrushButton />
        <ToolRectButton />
        <ToolGradientButton />
        <ToolSelectionButton />
        <ToolTextButton />
        <ToolAnnotateButton />
        <ToolMoveButton />
        <ToolViewButton />
        <ToolBboxButton />
        <ToolColorPickerButton />
      </ButtonGroup>
    </>
  );
};
