import type { AlertStatus } from '@invoke-ai/ui-library';
import { logger } from 'app/logging/logger';
import type { AppStore } from 'app/store/store';
import { useAppStore } from 'app/store/storeHooks';
import { extractMessageFromAssertionError } from 'common/util/extractMessageFromAssertionError';
import { withResult, withResultAsync } from 'common/util/result';
import { $canvasManager } from 'features/controlLayers/store/ephemeral';
import {
  positivePromptAddedToHistory,
  selectNegativePrompt,
  selectPositivePrompt,
} from 'features/controlLayers/store/paramsSlice';
import { selectCanvasSlice } from 'features/controlLayers/store/selectors';
import { selectExternalApiIsEnabled } from 'features/externalApi/store/externalApiSlice';
import { prepareCanvasComposite } from 'features/externalApi/util/prepareCanvasComposite';
import type { BaseModelType } from 'features/nodes/types/common';
import { prepareLinearUIBatch } from 'features/nodes/util/graph/buildLinearBatchConfig';
import { buildAnimaGraph } from 'features/nodes/util/graph/generation/buildAnimaGraph';
import { buildCogView4Graph } from 'features/nodes/util/graph/generation/buildCogView4Graph';
import { buildExternalAPIGraph } from 'features/nodes/util/graph/generation/buildExternalAPIGraph';
import { buildFLUXGraph } from 'features/nodes/util/graph/generation/buildFLUXGraph';
import { buildQwenImageGraph } from 'features/nodes/util/graph/generation/buildQwenImageGraph';
import { buildSD1Graph } from 'features/nodes/util/graph/generation/buildSD1Graph';
import { buildSD3Graph } from 'features/nodes/util/graph/generation/buildSD3Graph';
import { buildSDXLGraph } from 'features/nodes/util/graph/generation/buildSDXLGraph';
import { buildZImageGraph } from 'features/nodes/util/graph/generation/buildZImageGraph';
import type { GraphBuilderArg } from 'features/nodes/util/graph/types';
import { GenerationCancelledError, UnsupportedGenerationModeError } from 'features/nodes/util/graph/types';
import { toast } from 'features/toast/toast';
import { useCallback } from 'react';
import { serializeError } from 'serialize-error';
import { enqueueMutationFixedCacheKeyOptions, queueApi } from 'services/api/endpoints/queue';
import { assert, AssertionError } from 'tsafe';

const log = logger('generation');

const enqueueGenerate = async (store: AppStore, prepend: boolean) => {
  const { dispatch, getState } = store;

  const state = getState();

  const isExternalApi = selectExternalApiIsEnabled(state);

  let base: BaseModelType;
  if (isExternalApi) {
    base = 'any';
  } else {
    const model = state.params.model;
    if (!model) {
      log.error('No model found in state');
      return;
    }
    base = model.base;
  }

  const buildGraphResult = await withResultAsync(async () => {
    // For External API: provide canvas manager so the graph builder can access raster layers
    const manager = isExternalApi ? $canvasManager.get() : null;
    const graphBuilderArg: GraphBuilderArg = { generationMode: 'txt2img', state, manager };

    // Pre-process canvas for External API: transparency flatten + 75% downscale
    if (isExternalApi && manager) {
      const canvas = selectCanvasSlice(state);
      const { rect } = canvas.bbox;
      const preComposited = await prepareCanvasComposite(manager, rect);
      if (preComposited) {
        graphBuilderArg.preCompositedCanvas = preComposited;
      }
    }

    if (isExternalApi) {
      return await buildExternalAPIGraph(graphBuilderArg);
    }

    switch (base) {
      case 'sdxl':
        return await buildSDXLGraph(graphBuilderArg);
      case 'sd-1':
      case `sd-2`:
        return await buildSD1Graph(graphBuilderArg);
      case `sd-3`:
        return await buildSD3Graph(graphBuilderArg);
      case 'flux':
      case 'flux2':
        return await buildFLUXGraph(graphBuilderArg);
      case 'cogview4':
        return await buildCogView4Graph(graphBuilderArg);
      case 'qwen-image':
        return await buildQwenImageGraph(graphBuilderArg);
      case 'z-image':
        return await buildZImageGraph(graphBuilderArg);
      case 'anima':
        return await buildAnimaGraph(graphBuilderArg);
      default:
        assert(false, `No graph builders for base ${base}`);
    }
  });

  if (buildGraphResult.isErr()) {
    // Silent abort when user cancels (e.g. transparency fill dialog)
    if (buildGraphResult.error instanceof GenerationCancelledError) {
      return;
    }
    let title = 'Failed to build graph';
    let status: AlertStatus = 'error';
    let description: string | null = null;
    if (buildGraphResult.error instanceof AssertionError) {
      description = extractMessageFromAssertionError(buildGraphResult.error);
    } else if (buildGraphResult.error instanceof UnsupportedGenerationModeError) {
      title = 'Unsupported generation mode';
      description = buildGraphResult.error.message;
      status = 'warning';
    }
    const error = serializeError(buildGraphResult.error);
    log.error({ error }, 'Failed to build graph');
    toast({
      status,
      title,
      description,
    });
    return;
  }

  const { g, seed, positivePrompt, negativePrompt } = buildGraphResult.value;

  const prepareBatchResult = withResult(() =>
    prepareLinearUIBatch({
      state,
      g,
      base: base as BaseModelType,
      prepend,
      seedNode: seed,
      positivePromptNode: positivePrompt,
      negativePromptNode: negativePrompt,
      origin: 'generate',
      destination: 'generate',
    })
  );

  if (prepareBatchResult.isErr()) {
    log.error({ error: serializeError(prepareBatchResult.error) }, 'Failed to prepare batch');
    return;
  }

  const batchConfig = prepareBatchResult.value;

  const req = dispatch(
    queueApi.endpoints.enqueueBatch.initiate(batchConfig, {
      ...enqueueMutationFixedCacheKeyOptions,
      track: false,
    })
  );

  const enqueueResult = await req.unwrap();

  // Push to prompt history on successful enqueue
  dispatch(
    positivePromptAddedToHistory({
      positivePrompt: selectPositivePrompt(state),
      negativePrompt: selectNegativePrompt(state),
    })
  );

  return { batchConfig, enqueueResult };
};

export const useEnqueueGenerate = () => {
  const store = useAppStore();
  const enqueue = useCallback(
    (prepend: boolean) => {
      return enqueueGenerate(store, prepend);
    },
    [store]
  );
  return enqueue;
};
