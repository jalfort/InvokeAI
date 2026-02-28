import { createSelector } from '@reduxjs/toolkit';
import { createMemoizedSelector } from 'app/store/createMemoizedSelector';
import { useAppSelector } from 'app/store/storeHooks';
import { AnnotationLayer } from 'features/controlLayers/components/AnnotationLayer/AnnotationLayer';
import { CanvasEntityGroupList } from 'features/controlLayers/components/CanvasEntityList/CanvasEntityGroupList';
import { selectCanvasSlice, selectSelectedEntityIdentifier } from 'features/controlLayers/store/selectors';
import { getEntityIdentifier } from 'features/controlLayers/store/types';
import { memo } from 'react';

const selectEntityIdentifiers = createMemoizedSelector(selectCanvasSlice, (canvas) => {
  return canvas.annotationLayers.entities.map(getEntityIdentifier).toReversed();
});

const selectIsSelected = createSelector(selectSelectedEntityIdentifier, (selectedEntityIdentifier) => {
  return selectedEntityIdentifier?.type === 'annotation_layer';
});

export const AnnotationLayerEntityList = memo(() => {
  const isSelected = useAppSelector(selectIsSelected);
  const entityIdentifiers = useAppSelector(selectEntityIdentifiers);

  if (entityIdentifiers.length === 0) {
    return null;
  }

  return (
    <CanvasEntityGroupList type="annotation_layer" isSelected={isSelected} entityIdentifiers={entityIdentifiers}>
      {entityIdentifiers.map((entityIdentifier) => (
        <AnnotationLayer key={entityIdentifier.id} id={entityIdentifier.id} />
      ))}
    </CanvasEntityGroupList>
  );
});

AnnotationLayerEntityList.displayName = 'AnnotationLayerEntityList';
