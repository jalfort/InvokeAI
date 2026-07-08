# `controlLayers/fork/` — the JA toolbox (fork-owned canvas tools)

This directory holds **all net-new fork canvas-tool logic** re-layered onto upstream
InvokeAI 6.13 (plan P4). Everything here is additive: upstream's native toolset is left
pristine, and our tools (selection, soft brush, clone brush, annotation) live under a
single **"JA toolbox"** drawer button in the tool rail.

## The bolt-on discipline

- **New logic lives here** (`fork/`) — these files never conflict on an upstream merge.
- **Upstream files are touched only at tiny seams**, each tagged `// FORK:` in-code and
  logged in [`FORK_GRAFT_MANIFEST.md`](./FORK_GRAFT_MANIFEST.md). After an upstream bump,
  re-apply the manifest's seams — _"they update, we re-bolt."_
- **Do NOT refactor upstream** into a plugin system — tiny documented seams diverge less
  than a big architectural change we'd fight on every update.

## Adding a tool

1. Build its module + button component under `fork/`.
2. Push one entry to [`toolbox/registry.ts`](./toolbox/registry.ts).
3. Add its `Tool` enum value (`store/types.ts` `_zTool`) and its hotkey
   (`useHotkeyData.ts`) — both `// FORK:` seams, both logged in the manifest.

That's it — the drawer shell and rail active-state pick it up automatically.

## Layout

- `toolbox/` — the JA drawer shell:
  - `JaToolboxButton.tsx` — rail button + popover drawer (never changes as tools land).
  - `registry.ts` — the per-tool list (the one file that grows per tool).
  - `useIsJaToolActive.ts` — lights the rail button when a JA tool is active.
  - `JaToolboxIcon.tsx` — the "JA" monogram.
- Per-tool folders land here as phases ship (`selection/`, `brush/`, `annotation/`).
