import { Flex, Icon, Spacer, Text } from '@invoke-ai/ui-library';
import { CanvasEntityContainer } from 'features/controlLayers/components/CanvasEntityList/CanvasEntityContainer';
import { CanvasEntityDeleteButton } from 'features/controlLayers/components/common/CanvasEntityDeleteButton';
import { CanvasEntityEnabledToggle } from 'features/controlLayers/components/common/CanvasEntityEnabledToggle';
import { CanvasEntityHeader } from 'features/controlLayers/components/common/CanvasEntityHeader';
import { CanvasEntityStateGate } from 'features/controlLayers/contexts/CanvasEntityStateGate';
import {
  EntityIdentifierContext,
  useEntityIdentifierContext,
} from 'features/controlLayers/contexts/EntityIdentifierContext';
import { useEntityTitle } from 'features/controlLayers/hooks/useEntityTitle';
import type { CanvasEntityIdentifier } from 'features/controlLayers/store/types';
import { memo, useMemo } from 'react';
import { PiNotePencilBold } from 'react-icons/pi';

type Props = {
  id: string;
};

const AnnotationLayerTitle = memo(() => {
  const entityIdentifier = useEntityIdentifierContext();
  const title = useEntityTitle(entityIdentifier);
  return (
    <Text fontStyle="italic" fontSize="sm" fontWeight="semibold" userSelect="none" color="base.300">
      {title}
    </Text>
  );
});
AnnotationLayerTitle.displayName = 'AnnotationLayerTitle';

export const AnnotationLayer = memo(({ id }: Props) => {
  const entityIdentifier = useMemo<CanvasEntityIdentifier<'annotation_layer'>>(
    () => ({ id, type: 'annotation_layer' }),
    [id]
  );

  return (
    <EntityIdentifierContext.Provider value={entityIdentifier}>
      <CanvasEntityStateGate entityIdentifier={entityIdentifier}>
        <CanvasEntityContainer>
          <CanvasEntityHeader>
            <Flex alignItems="center" gap={2} ps={1}>
              <Icon as={PiNotePencilBold} boxSize={4} color="invokeYellow.400" />
              <AnnotationLayerTitle />
            </Flex>
            <Spacer />
            <Flex alignSelf="stretch">
              <CanvasEntityEnabledToggle />
              <CanvasEntityDeleteButton />
            </Flex>
          </CanvasEntityHeader>
        </CanvasEntityContainer>
      </CanvasEntityStateGate>
    </EntityIdentifierContext.Provider>
  );
});

AnnotationLayer.displayName = 'AnnotationLayer';
