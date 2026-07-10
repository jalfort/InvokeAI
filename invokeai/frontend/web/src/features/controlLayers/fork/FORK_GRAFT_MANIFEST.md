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

## Phase B — soft + clone brush

Soft brush persists as a `soft_brush_line` object (position lives in entity-local `points`; baked to a
`Konva.Image` on commit so `clone()` survives; re-renders on reload). Clone brush is buffer-only (a
`clone_brush_line` has no meaning without its source snapshot) and bakes to a 0-origin `image` object on
commit. Both live under `fork/brush/`; only the seams below touch upstream files.

| Status  | Upstream file                                                 | Seam                                                                                                                                                                                                                                      | Why                                                      |
| ------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| ✅ live | `features/controlLayers/store/types.ts`                       | `_zTool` += `softBrush`,`cloneBrush`; 4 soft Zod object-state schemas + types; 4 soft members in `zCanvasObjectState`; `EntitySoftBrushLineAddedPayload` + `EntityImageAddedPayload`                                                      | tool enum, persisted soft state, add-payload types       |
| ✅ live | `features/controlLayers/konva/CanvasObject/types.ts`          | `AnyObjectRenderer` += `CanvasObjectSoftBrushLine`,`CanvasObjectCloneBrushLine`; `AnyObjectState` += 4 soft + 2 clone state types                                                                                                         | renderer/state unions accept the fork objects            |
| ✅ live | `konva/CanvasEntity/CanvasEntityBufferObjectRenderer.ts`      | import 2 fork classes + upload helpers; live render branches (4 soft, 2 clone); **commitBuffer double-push fix** (`{ pushToState = true } = options ?? {}`); commit switch soft→`addSoftBrushLine`, clone→bake+`commitCloneStrokeAsImage` | live buffer render + commit (rasterize/persist)          |
| ✅ live | `konva/CanvasEntity/CanvasEntityObjectRenderer.ts`            | import `CanvasObjectSoftBrushLine`; `renderObject` combined soft branch (re-render persisted soft strokes); `needsPixelBbox` += `isSoftBrush`                                                                                             | persisted soft strokes re-render + accurate bbox         |
| ✅ live | `konva/CanvasStateApiModule.ts`                               | `addSoftBrushLine` + `addImage` (dispatch the two new actions)                                                                                                                                                                            | state-API entry points for commit                        |
| ✅ live | `store/canvasSlice.ts`                                        | `entitySoftBrushLineAdded` + `entityImageAdded` reducers/actions/exports; added to `doNotGroupMatcher`                                                                                                                                    | reducers pushing the committed objects                   |
| ✅ live | `store/canvasSettingsSlice.ts`                                | soft: `softBrushHardness`/`softBrushOpacity`/`softBrushErase`; clone: `brushHardness`/`brushOpacity`/`cloneBrushAlignedMode`/`cloneBrushSampleMode` (+ enum) — schema/defaults/reducers/actions/selectors (size reuses `brushWidth`)      | per-brush settings                                       |
| ✅ live | `konva/CanvasTool/CanvasToolModule.ts`                        | import 2 fork tool modules; `tools` field+init+`group.add`; `syncCursorStyle` (entity branch); `render()`; pointer enter/down/up/move dispatch (behind `getCanDraw()`); `repr()`                                                          | tool integration (drawing tools, need a drawable entity) |
| ✅ live | `features/ui/layouts/canvasToolModifierHints.ts`              | `softBrush` + `cloneBrush` resolver entries (Record<Tool> is exhaustive)                                                                                                                                                                  | compiler-required per-tool hint entries                  |
| ✅ live | `features/system/components/HotkeysModal/useHotkeyData.ts`    | `addHotkey('canvas','selectSoftBrushTool',['k'])` + `selectCloneBrushTool',['j']`                                                                                                                                                         | brush hotkeys                                            |
| ✅ live | `features/controlLayers/components/Toolbar/CanvasToolbar.tsx` | mount `<ToolSoftBrushSettings/>` / `<ToolCloneBrushSettings/>` when the tool is selected                                                                                                                                                  | brush settings rows                                      |
| ✅ live | `public/locales/en.json`                                      | `controlLayers.tool.softBrush`/`cloneBrush` + `hotkeys.canvas.selectSoftBrushTool.*` / `selectCloneBrushTool.*`                                                                                                                           | i18n (button + hotkeys modal)                            |

_Fork-owned (not seams): `fork/brush/` (brushBuffer, 2 object renderers, 2 tool modules, 2 buttons, 2 settings rows) + registration in `fork/toolbox/registry.ts`._

> **Clone commit positioning note:** the baked clone stroke is a clip-sized canvas at entity-local
> `(strokeOffsetX, strokeOffsetY)`. Image objects render at the entity origin `(0,0)` with no position
> field, so `commitCloneStrokeAsImage` re-draws the stroke onto a 0-origin canvas at that offset before
> upload. Non-negative offsets (the common `clipToBbox` case) are exact; a negative offset only clips
> the transparent falloff pad (≤ brush radius) off the top/left — never painted content.

## Phase C — annotation directive overlay (planned, re-architected lighter)

| Status     | Upstream file                                                                                                                                                                       | Seam                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| ⏳ Phase C | `_zTool`; `features/nodes/util/graph/generation/buildExternalAPIGraph.ts` (:68 annotation-composite re-wire); `konva/CanvasCompositorModule.ts` (overlay helper); settings; hotkeys | annotation directive overlay |

_Legend: ✅ applied · ⏳ planned. Line numbers approximate — match by content._

> **commitBuffer note (Phase B):** `CanvasEntityBufferObjectRenderer.ts:270` reads
> `const { pushToState } = { ...options, pushToState: true }` — `pushToState` is always
> true (latent upstream bug). When brush cases are added to the commit switch, re-apply
> `{ pushToState: true, ...options }` or committed brush state double-pushes.
