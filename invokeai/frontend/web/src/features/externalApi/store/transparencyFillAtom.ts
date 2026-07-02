import type { Deferred } from 'common/util/createDeferredPromise';
import { createDeferredPromise } from 'common/util/createDeferredPromise';
import { atom } from 'nanostores';

type TransparencyFillChoice = 'white' | 'black';

/**
 * When non-null, the TransparencyFillDialog is open and awaiting user choice.
 * The deferred promise resolves with the fill color or rejects on cancel.
 */
export const $transparencyFillRequest = atom<Deferred<TransparencyFillChoice> | null>(null);

/**
 * Show the transparency fill dialog and await the user's choice.
 * Returns 'white' or 'black'.
 * The promise rejects with GenerationCancelledError if user cancels.
 */
export const requestTransparencyFill = (): Promise<TransparencyFillChoice> => {
  const deferred = createDeferredPromise<TransparencyFillChoice>();
  $transparencyFillRequest.set(deferred);
  return deferred.promise;
};

export const clearTransparencyFillRequest = () => {
  $transparencyFillRequest.set(null);
};
