import { useStore } from '@nanostores/react';
import { useCanvasManager } from 'features/controlLayers/contexts/CanvasManagerProviderGate';
import { computed } from 'nanostores';

import { JA_TOOLS } from './registry';

/** True when the active canvas tool is one of the fork (JA toolbox) tools. */
export const useIsJaToolActive = (): boolean => {
  const canvasManager = useCanvasManager();
  return useStore(computed(canvasManager.tool.$tool, (tool) => JA_TOOLS.includes(tool)));
};
