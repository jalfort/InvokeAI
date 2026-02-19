import { logger } from 'app/logging/logger';
import { getPrefixedId } from 'features/controlLayers/konva/util';
import { selectReferenceImageEntities } from 'features/controlLayers/store/refImagesSlice';
import { selectExternalApiSlice } from 'features/externalApi/store/externalApiSlice';
import { Graph } from 'features/nodes/util/graph/generation/Graph';
import { selectCanvasOutputFields } from 'features/nodes/util/graph/graphBuilderUtils';
import type { GraphBuilderArg, GraphBuilderReturn } from 'features/nodes/util/graph/types';
import type { Invocation } from 'services/api/types';

const log = logger('system');

export const buildExternalAPIGraph = async (arg: GraphBuilderArg): Promise<GraphBuilderReturn> => {
  const { generationMode, state, manager } = arg;
  const externalApi = selectExternalApiSlice(state);

  log.debug({ generationMode, provider: externalApi.provider, modelId: externalApi.modelId }, 'Building External API graph');

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

  // Collect reference image names from the ref image entities
  const referenceImageFields: { image_name: string }[] = [];
  const refEntities = selectReferenceImageEntities(state);
  for (const entity of refEntities) {
    if (!entity.isEnabled) {
      continue;
    }
    const config = entity.config;
    const image = config.image;
    if (image) {
      // CroppableImageWithDims: use cropped image if available, otherwise original
      const imageName = image.crop?.image?.image_name ?? image.original.image.image_name;
      referenceImageFields.push({ image_name: imageName });
    }
  }

  // For edit mode on canvas: add the composite raster layer as the first reference image
  if (generationMode === 'img2img' && manager) {
    const compositeDTO = await manager.compositor.getCompositeRasterLayerImageDTO();
    referenceImageFields.unshift({ image_name: compositeDTO.image_name });
  }

  // Build the fal_generate node
  // Note: the 'fal_generate' type will be available after running `pnpm typegen` (Step 10).
  // Until then, TypeScript may show a type error here - this is expected and will be resolved.
  const falGenerate = g.addNode({
    type: 'fal_generate' as Invocation<'fal_generate'>['type'],
    id: getPrefixedId('fal_generate'),
    model_id: externalApi.modelId,
    mode: externalApi.generationMode,
    reference_images: referenceImageFields,
    aspect_ratio: externalApi.aspectRatio,
    resolution: externalApi.resolution,
    num_images: externalApi.numImages,
    enable_web_search: externalApi.enableWebSearch,
    output_format: externalApi.outputFormat,
    safety_tolerance: externalApi.safetyTolerance,
  } as Invocation<'fal_generate'>);

  // Wire prompt and seed into the fal_generate node
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fal_generate types not yet generated via typegen
  g.addEdge(positivePrompt, 'value', falGenerate, 'prompt' as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- fal_generate types not yet generated via typegen
  g.addEdge(seed, 'value', falGenerate, 'seed' as any);

  // Metadata
  g.upsertMetadata({
    generation_mode: `external_api_${externalApi.generationMode}`,
  });
  g.addEdgeToMetadata(seed, 'value', 'seed');
  g.addEdgeToMetadata(positivePrompt, 'value', 'positive_prompt');

  // Set canvas output fields (is_intermediate, board, use_cache)
  g.updateNode(falGenerate, selectCanvasOutputFields(state));

  g.setMetadataReceivingNode(falGenerate);

  return {
    g,
    seed,
    positivePrompt,
  };
};
