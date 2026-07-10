# FORK graft manifest

Every edit to an **upstream file** made to bolt on fork canvas tools (P4). Each seam is
tagged `// FORK:` in-code and listed here so it can be re-applied mechanically after an
upstream merge. Fork-owned files under `controlLayers/fork/` are **not** listed — they
never conflict. Paths are under `invokeai/frontend/web/src/`.

## Step 0 — JA toolbox scaffold

| Status  | Upstream file                                            | Seam                                                    | Why                          |
| ------- | -------------------------------------------------------- | ------------------------------------------------------- | ---------------------------- |
| ✅ live | `features/controlLayers/components/Tool/ToolChooser.tsx` | render `<JaToolboxButton/>` in the tool rail (+ import) | mounts the JA toolbox drawer |

## Phase A — selection suite

| Status  | Upstream file                                                            | Seam                                                                                                     | Why                                   |
| ------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| ✅ live | `features/controlLayers/store/types.ts`                                  | add `'selection'` to `_zTool`                                                                            | selection tool enum value             |
| ✅ live | `features/controlLayers/konva/CanvasTool/CanvasToolModule.ts`            | register + group.add + clear-on-switch + cursor + pointer dispatch + S+scroll + keyboard/modifier + repr | selection tool integration (largest)  |
| ✅ live | `features/controlLayers/konva/worker.ts` + `konva/CanvasWorkerModule.ts` | SDT compute (Felzenszwalb–Huttenlocher EDT) + `requestSdt` plumbing                                      | feathering off the main thread        |
| ✅ live | `features/controlLayers/konva/CanvasStageModule.ts`                      | wheel-zoom guard when selection + S held                                                                 | S+scroll feathers without zooming     |
| ✅ live | `features/controlLayers/store/canvasSettingsSlice.ts`                    | 2 enums + 5 fields + 5 reducers/actions/selectors                                                        | mode / feather / overlay prefs        |
| ✅ live | `features/ui/layouts/canvasToolModifierHints.ts`                         | `selection` resolver entry (compiler-required)                                                           | per-tool modifier hints Record        |
| ✅ live | `features/system/components/HotkeysModal/useHotkeyData.ts`               | `addHotkey('canvas','selectSelectionTool',['s'])`                                                        | selection hotkey                      |
| ✅ live | `features/controlLayers/components/Toolbar/CanvasToolbar.tsx`            | mount `<ToolSelectionSettings/>` when selected                                                           | selection settings row                |
| ✅ live | `features/ui/layouts/CanvasWorkspacePanel.tsx`                           | mount `<CanvasContextMenuSelectionItems/>`                                                               | fill/delete/invert/undo/deselect menu |
| ✅ live | `public/locales/en.json`                                                 | `controlLayers.tool.selection` + `hotkeys.canvas.selectSelectionTool.*`                                  | i18n (button + hotkeys modal)         |

_The selection button itself is registered in the fork drawer via `fork/toolbox/registry.ts` (fork-owned, not a seam)._

## Phase B — soft + clone brush (planned)

| Status     | Upstream file                                                                                                                                                                                                                  | Seam                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| ⏳ Phase B | `_zTool`; `konva/CanvasEntity/CanvasEntityBufferObjectRenderer.ts` (:130 render branch, **:270 commitBuffer fix**, :294 commit switch); `konva/CanvasEntity/CanvasEntityObjectRenderer.ts` (needsPixelBbox); settings; hotkeys | soft + clone brush integration |

## Phase C — annotation directive overlay (planned, re-architected lighter)

| Status     | Upstream file                                                                                                                                                                       | Seam                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| ⏳ Phase C | `_zTool`; `features/nodes/util/graph/generation/buildExternalAPIGraph.ts` (:68 annotation-composite re-wire); `konva/CanvasCompositorModule.ts` (overlay helper); settings; hotkeys | annotation directive overlay |

_Legend: ✅ applied · ⏳ planned. Line numbers approximate — match by content._

> **commitBuffer note (Phase B):** `CanvasEntityBufferObjectRenderer.ts:270` reads
> `const { pushToState } = { ...options, pushToState: true }` — `pushToState` is always
> true (latent upstream bug). When brush cases are added to the commit switch, re-apply
> `{ pushToState: true, ...options }` or committed brush state double-pushes.
