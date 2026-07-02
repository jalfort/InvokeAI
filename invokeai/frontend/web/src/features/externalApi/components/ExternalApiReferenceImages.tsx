import { Box, Flex, FormControl, FormLabel, IconButton, Text } from '@invoke-ai/ui-library';
import { useAppDispatch, useAppSelector } from 'app/store/storeHooks';
import { TRANSPARENCY_CHECKERBOARD_PATTERN_DARK_DATAURL } from 'features/controlLayers/konva/patterns/transparency-checkerboard-pattern';
import type { AddExternalApiReferenceImageDndTargetData } from 'features/dnd/dnd';
import { addExternalApiReferenceImageDndTarget } from 'features/dnd/dnd';
import { DndDropTarget } from 'features/dnd/DndDropTarget';
import { DndImage } from 'features/dnd/DndImage';
import { DndImageIcon } from 'features/dnd/DndImageIcon';
import {
  externalApiReferenceImageRemoved,
  selectExternalApiReferenceImageNames,
} from 'features/externalApi/store/externalApiSlice';
import { memo, useCallback, useMemo } from 'react';
import { PiTrashSimpleBold } from 'react-icons/pi';
import { useGetImageDTOQuery } from 'services/api/endpoints/images';

const MAX_REFERENCE_IMAGES = 14;

const ReferenceImageThumbnail = memo(({ imageName }: { imageName: string }) => {
  const dispatch = useAppDispatch();
  const { data: imageDTO } = useGetImageDTOQuery(imageName);

  const onRemove = useCallback(() => {
    dispatch(externalApiReferenceImageRemoved(imageName));
  }, [dispatch, imageName]);

  if (!imageDTO) {
    return (
      <Box w="64px" h="64px" borderRadius="md" bg="base.700" flexShrink={0} position="relative">
        <DndImageIcon
          onClick={onRemove}
          icon={<PiTrashSimpleBold />}
          tooltip="Remove reference image"
          position="absolute"
          top={0}
          insetInlineEnd={0}
        />
      </Box>
    );
  }

  return (
    <Box w="64px" h="64px" flexShrink={0} position="relative">
      <DndImage
        imageDTO={imageDTO}
        asThumbnail
        objectFit="cover"
        w="full"
        h="full"
        borderRadius="md"
        backgroundSize={8}
        backgroundImage={TRANSPARENCY_CHECKERBOARD_PATTERN_DARK_DATAURL}
      />
      <DndImageIcon
        onClick={onRemove}
        icon={<PiTrashSimpleBold />}
        tooltip="Remove reference image"
        position="absolute"
        top={0}
        insetInlineEnd={0}
      />
    </Box>
  );
});
ReferenceImageThumbnail.displayName = 'ReferenceImageThumbnail';

export const ExternalApiReferenceImages = memo(() => {
  const referenceImageNames = useAppSelector(selectExternalApiReferenceImageNames);
  const dispatch = useAppDispatch();

  const isFull = referenceImageNames.length >= MAX_REFERENCE_IMAGES;

  const dndTargetData = useMemo<AddExternalApiReferenceImageDndTargetData>(
    () => addExternalApiReferenceImageDndTarget.getData(),
    []
  );

  const onClearAll = useCallback(() => {
    dispatch({ type: 'externalApi/externalApiReferenceImagesCleared' });
  }, [dispatch]);

  return (
    <FormControl>
      <Flex alignItems="center" justifyContent="space-between">
        <FormLabel mb={0}>Reference Images</FormLabel>
        {referenceImageNames.length > 0 && (
          <IconButton
            aria-label="Clear all"
            icon={<PiTrashSimpleBold />}
            size="xs"
            variant="ghost"
            onClick={onClearAll}
          />
        )}
      </Flex>
      <Flex
        position="relative"
        minH="72px"
        p={2}
        gap={2}
        borderWidth={1}
        borderRadius="md"
        borderColor="base.700"
        overflowX="auto"
        alignItems="center"
      >
        {referenceImageNames.length === 0 && (
          <Text fontSize="xs" color="base.500" w="full" textAlign="center">
            Drop reference images here
          </Text>
        )}
        {referenceImageNames.map((name) => (
          <ReferenceImageThumbnail key={name} imageName={name} />
        ))}
        <DndDropTarget
          dndTarget={addExternalApiReferenceImageDndTarget}
          dndTargetData={dndTargetData}
          label="Add reference image"
          isDisabled={isFull}
        />
      </Flex>
      {referenceImageNames.length > 0 && (
        <Text fontSize="xs" color="base.500" mt={1}>
          {referenceImageNames.length}/{MAX_REFERENCE_IMAGES} reference images
        </Text>
      )}
    </FormControl>
  );
});
ExternalApiReferenceImages.displayName = 'ExternalApiReferenceImages';
