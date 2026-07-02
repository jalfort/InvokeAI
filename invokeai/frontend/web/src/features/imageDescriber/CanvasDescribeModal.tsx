import { useStore } from '@nanostores/react';
import { useAssertSingleton } from 'common/hooks/useAssertSingleton';
import { ImageDescriberModal } from 'features/imageDescriber/ImageDescriberModal';
import { atom } from 'nanostores';
import { memo } from 'react';

const $describeImageFile = atom<File | null>(null);
export const setDescribeImageFile = (file: File) => $describeImageFile.set(file);
const clearDescribeImageFile = () => $describeImageFile.set(null);

export const CanvasDescribeModal = memo(() => {
  useAssertSingleton('CanvasDescribeModal');
  const imageFile = useStore($describeImageFile);

  if (!imageFile) {
    return null;
  }

  return <ImageDescriberModal isOpen onClose={clearDescribeImageFile} imageFile={imageFile} />;
});

CanvasDescribeModal.displayName = 'CanvasDescribeModal';
