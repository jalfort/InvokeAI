import { MenuItem } from '@invoke-ai/ui-library';
import { useImageDTOContext } from 'features/gallery/contexts/ImageDTOContext';
import { ImageDescriberModal } from 'features/imageDescriber/ImageDescriberModal';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PiChatCircleTextBold } from 'react-icons/pi';

export const ContextMenuItemDescribeImage = memo(() => {
  const { t } = useTranslation();
  const imageDTO = useImageDTOContext();
  const [isOpen, setIsOpen] = useState(false);

  const onClick = useCallback(() => {
    setIsOpen(true);
  }, []);

  const onClose = useCallback(() => {
    setIsOpen(false);
  }, []);

  return (
    <>
      <MenuItem icon={<PiChatCircleTextBold />} onClickCapture={onClick}>
        {t('imageDescriber.describeImage')}
      </MenuItem>
      {isOpen && <ImageDescriberModal isOpen={isOpen} onClose={onClose} imageName={imageDTO.image_name} />}
    </>
  );
});

ContextMenuItemDescribeImage.displayName = 'ContextMenuItemDescribeImage';
