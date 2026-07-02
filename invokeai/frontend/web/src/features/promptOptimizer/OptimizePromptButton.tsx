import { IconButton, Tooltip } from '@invoke-ai/ui-library';
import type { MouseEvent } from 'react';
import { memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { PiSparkleBold } from 'react-icons/pi';

type Props = {
  onClick: () => void;
  onRightClick: () => void;
};

export const OptimizePromptButton = memo(({ onClick, onRightClick }: Props) => {
  const { t } = useTranslation();

  const onContextMenu = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      onRightClick();
    },
    [onRightClick]
  );

  return (
    <Tooltip label={t('promptOptimizer.optimize')}>
      <IconButton
        variant="promptOverlay"
        aria-label={t('promptOptimizer.optimize')}
        icon={<PiSparkleBold />}
        onClick={onClick}
        onContextMenu={onContextMenu}
      />
    </Tooltip>
  );
});

OptimizePromptButton.displayName = 'OptimizePromptButton';
