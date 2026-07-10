import { ToolCloneBrushButton } from 'features/controlLayers/fork/brush/ToolCloneBrushButton';
import { ToolSoftBrushButton } from 'features/controlLayers/fork/brush/ToolSoftBrushButton';
import { ToolSelectionButton } from 'features/controlLayers/fork/selection/ToolSelectionButton';
import type { Tool } from 'features/controlLayers/store/types';
import type { FC } from 'react';

/**
 * One entry per fork ("JA toolbox") tool.
 * - `tool` is the {@link Tool} enum value the button activates (added to `_zTool` in
 *   `store/types.ts` as a `// FORK:` seam when the tool lands).
 * - `Button` is the drawer button component (lives under `fork/`).
 *
 * This is the single fork-owned list that grows per tool. It keeps the JA drawer body
 * and the rail-button active-state detection ({@link JA_TOOLS}) in sync from one source
 * of truth — adding a tool is one push here plus its enum + hotkey seams.
 */
type JaToolEntry = {
  tool: Tool;
  Button: FC;
};

export const JA_TOOL_REGISTRY: JaToolEntry[] = [
  { tool: 'selection', Button: ToolSelectionButton },
  { tool: 'softBrush', Button: ToolSoftBrushButton },
  { tool: 'cloneBrush', Button: ToolCloneBrushButton },
  // Phase C — { tool: 'annotate', Button: ToolAnnotateButton },
];

/** Tool enum values belonging to the JA toolbox — used to light up the rail button. */
export const JA_TOOLS: Tool[] = JA_TOOL_REGISTRY.map((entry) => entry.tool);
