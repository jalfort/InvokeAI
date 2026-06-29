import type { TabName } from 'features/ui/store/uiTypes';
import type { AnyModelConfig } from 'services/api/types';

export const isExternalModelUnsupportedForTab = (_model: AnyModelConfig, _tab: TabName): boolean => {
  return false;
};
