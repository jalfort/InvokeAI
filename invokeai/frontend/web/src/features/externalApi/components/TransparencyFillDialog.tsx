import {
  AlertDialog,
  AlertDialogBody,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogOverlay,
  Button,
  Flex,
  Text,
} from '@invoke-ai/ui-library';
import { useStore } from '@nanostores/react';
import { useAssertSingleton } from 'common/hooks/useAssertSingleton';
import {
  $transparencyFillRequest,
  clearTransparencyFillRequest,
} from 'features/externalApi/store/transparencyFillAtom';
import { GenerationCancelledError } from 'features/nodes/util/graph/types';
import { memo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

export const TransparencyFillDialog = memo(() => {
  useAssertSingleton('TransparencyFillDialog');
  const { t } = useTranslation();
  const request = useStore($transparencyFillRequest);
  const cancelRef = useRef<HTMLButtonElement>(null);

  const handleFillWhite = useCallback(() => {
    if (request) {
      request.resolve('white');
      clearTransparencyFillRequest();
    }
  }, [request]);

  const handleFillBlack = useCallback(() => {
    if (request) {
      request.resolve('black');
      clearTransparencyFillRequest();
    }
  }, [request]);

  const handleCancel = useCallback(() => {
    if (request) {
      request.reject(new GenerationCancelledError());
      clearTransparencyFillRequest();
    }
  }, [request]);

  if (!request) {
    return null;
  }

  return (
    <AlertDialog isOpen={true} onClose={handleCancel} leastDestructiveRef={cancelRef} isCentered>
      <AlertDialogOverlay>
        <AlertDialogContent>
          <AlertDialogHeader fontSize="lg" fontWeight="bold">
            {t('externalApi.transparencyDetected', 'Transparency Detected')}
          </AlertDialogHeader>
          <AlertDialogBody>
            <Text>
              {t(
                'externalApi.transparencyMessage',
                'The canvas contains transparent areas that external APIs cannot process. Choose a background fill color:'
              )}
            </Text>
          </AlertDialogBody>
          <AlertDialogFooter>
            <Flex w="full" gap={2} justifyContent="end">
              <Button ref={cancelRef} onClick={handleCancel}>
                {t('common.cancel', 'Cancel')}
              </Button>
              <Button colorScheme="invokeBlue" onClick={handleFillBlack}>
                {t('externalApi.fillBlack', 'Fill Black')}
              </Button>
              <Button colorScheme="invokeBlue" onClick={handleFillWhite}>
                {t('externalApi.fillWhite', 'Fill White')}
              </Button>
            </Flex>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialogOverlay>
    </AlertDialog>
  );
});

TransparencyFillDialog.displayName = 'TransparencyFillDialog';
