import { logger } from 'app/logging/logger';
import { getPrefixedId } from 'features/controlLayers/konva/util';
import { selectCanvasSlice } from 'features/controlLayers/store/selectors';
import { selectExternalApiSlice } from 'features/externalApi/store/externalApiSlice';
import { Graph } from 'features/nodes/util/graph/generation/Graph';
import { selectCanvasOutputFields } from 'features/nodes/util/graph/graphBuilderUtils';
import type { GraphBuilderArg, GraphBuilderReturn } from 'features/nodes/util/graph/types';

const log = logger('system');

export const buildExternalAPIGraph = async (arg: GraphBuilderArg): Promise<GraphBuilderReturn> => {
  const { generationMode, state, manager } = arg;
  const externalApi = selectExternalApiSlice(state);

  log.debug(
    { generationMode, provider: externalApi.providerId, modelId: externalApi.modelId },
    'Building External API graph'
  );

  const g = new Graph(getPrefixedId('external_api_graph'));

  // Prompt node - needed for the batch system (seed/prompt variation)
  const positivePrompt = g.addNode({
    id: getPrefixedId('positive_prompt'),
    type: 'string',
  });

  // Seed node - needed for the batch system
  const seed = g.addNode({
    id: getPrefixedId('seed'),
    type: 'integer',
  });

  // Collect reference images from the external API slice
  const referenceImageFields: { image_name: string }[] = externalApi.referenceImageNames.map((name) => ({
    image_name: name,
  }));

  // For edit/inpaint mode on canvas: composite the raster layers and prepend as first reference image
  let maskImageField: { image_name: string } | undefined;

  if ((generationMode === 'img2img' || generationMode === 'inpaint') && manager) {
    const canvas = selectCanvasSlice(state);
    const { rect } = canvas.bbox;
    const rasterAdapters = manager.compositor.getVisibleAdaptersOfType('raster_layer');
    const compositeDTO = await manager.compositor.getCompositeImageDTO(rasterAdapters, rect, {
      is_intermediate: true,
      silent: true,
    });
    referenceImageFields.unshift({ image_name: compositeDTO.image_name });

    // For inpaint mode: get the mask composite for mask-as-annotation pipeline
    if (generationMode === 'inpaint') {
      const inpaintMaskAdapters = manager.compositor.getVisibleAdaptersOfType('inpaint_mask');
      if (inpaintMaskAdapters.length > 0) {
        const maskDTO = await manager.compositor.getCompositeImageDTO(inpaintMaskAdapters, rect, {
          is_intermediate: true,
          silent: true,
        });
        maskImageField = { image_name: maskDTO.image_name };
      }
    }
  }

  // Build the external_api_generate node (provider-agnostic)
  // external_api_generate not in generated schema yet — run `pnpm typegen` with backend to resolve
  const externalApiGenerate = g.addNode({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    type: 'external_api_generate' as any,
    id: getPrefixedId('external_api_generate'),
    provider_id: externalApi.providerId,
    model_id: externalApi.modelId,
    mode: externalApi.generationMode,
    reference_images: referenceImageFields,
    mask_image: maskImageField ?? null,
    aspect_ratio: externalApi.aspectRatio,
    resolution: externalApi.resolution,
    num_images: 1,
    enable_web_search: externalApi.enableWebSearch,
    output_format: externalApi.outputFormat,
    safety_tolerance: externalApi.safetyTolerance,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  // Wire prompt and seed into the external_api_generate node
  // @ts-expect-error external_api_generate types not yet generated via typegen
  g.addEdge(positivePrompt, 'value', externalApiGenerate, 'prompt');
  // @ts-expect-error external_api_generate types not yet generated via typegen
  g.addEdge(seed, 'value', externalApiGenerate, 'seed');

  // Metadata
  g.upsertMetadata({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    generation_mode: `external_api_${externalApi.generationMode}` as any,
  });
  g.addEdgeToMetadata(seed, 'value', 'seed');
  g.addEdgeToMetadata(positivePrompt, 'value', 'positive_prompt');

  // Set canvas output fields (is_intermediate, board, use_cache)
  g.updateNode(externalApiGenerate, selectCanvasOutputFields(state));

  g.setMetadataReceivingNode(externalApiGenerate);

  return {
    g,
    seed,
    positivePrompt,
  };
};
