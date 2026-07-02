import { MenuItem } from '@invoke-ai/ui-library';
import { useEntityAdapterSafe } from 'features/controlLayers/contexts/EntityAdapterContext';
import { useEntityIdentifierContext } from 'features/controlLayers/contexts/EntityIdentifierContext';
import { useCanvasIsBusy } from 'features/controlLayers/hooks/useCanvasIsBusy';
import { setDescribeImageFile } from 'features/imageDescriber/CanvasDescribeModal';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PiChatCircleTextBold } from 'react-icons/pi';

/**
 * Convert a data URL to a File object synchronously.
 */
const dataURLtoFile = (dataURL: string, filename: string): File => {
  const [header, data] = dataURL.split(',') as [string, string];
  const mime = header.match(/:(.*?);/)?.[1] ?? 'image/png';
  const binary = atob(data);
  const array = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    array[i] = binary.charCodeAt(i);
  }
  return new File([array], filename, { type: mime });
};

export const CanvasEntityMenuItemsDescribe = memo(() => {
  const { t } = useTranslation();
  const entityIdentifier = useEntityIdentifierContext();
  const adapter = useEntityAdapterSafe(entityIdentifier);
  const isBusy = useCanvasIsBusy();

  const onClick = useCallback(() => {
    if (!adapter) {
      return;
    }
    const canvas = adapter.getCanvas();
    const dataURL = canvas.toDataURL('image/png');
    const file = dataURLtoFile(dataURL, `describe-${adapter.id}.png`);
    setDescribeImageFile(file);
  }, [adapter]);

  return (
    <MenuItem onClick={onClick} icon={<PiChatCircleTextBold />} isDisabled={isBusy || !adapter}>
      {t('imageDescriber.describeImage')}
    </MenuItem>
  );
});

CanvasEntityMenuItemsDescribe.displayName = 'CanvasEntityMenuItemsDescribe';
