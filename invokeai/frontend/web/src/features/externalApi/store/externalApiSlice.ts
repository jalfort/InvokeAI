import type { PayloadAction, Selector } from '@reduxjs/toolkit';
import { createSelector, createSlice } from '@reduxjs/toolkit';
import type { RootState } from 'app/store/store';
import type { SliceConfig } from 'app/store/types';
import { isPlainObject } from 'es-toolkit';
import { assert } from 'tsafe';
import { z } from 'zod';

const zExternalApiAspectRatio = z.enum([
  'auto',
  '21:9',
  '16:9',
  '3:2',
  '4:3',
  '5:4',
  '1:1',
  '4:5',
  '3:4',
  '2:3',
  '9:16',
]);
export type ExternalApiAspectRatio = z.infer<typeof zExternalApiAspectRatio>;

const zExternalApiResolution = z.enum(['1K', '2K', '4K']);
export type ExternalApiResolution = z.infer<typeof zExternalApiResolution>;

const zExternalApiOutputFormat = z.enum(['jpeg', 'png', 'webp']);
export type ExternalApiOutputFormat = z.infer<typeof zExternalApiOutputFormat>;

const zExternalApiGenerationMode = z.enum(['generate', 'edit']);
export type ExternalApiGenerationMode = z.infer<typeof zExternalApiGenerationMode>;

const zExternalApiState = z.object({
  _version: z.literal(3),
  isEnabled: z.boolean(),
  providerId: z.string(),
  modelId: z.string(),
  generationMode: zExternalApiGenerationMode,
  aspectRatio: zExternalApiAspectRatio,
  resolution: zExternalApiResolution,
  enableWebSearch: z.boolean(),
  safetyTolerance: z.number().int().min(1).max(6),
  numImages: z.number().int().min(1).max(4),
  outputFormat: zExternalApiOutputFormat,
  referenceImageNames: z.array(z.string()),
});
export type ExternalApiState = z.infer<typeof zExternalApiState>;

const getInitialState = (): ExternalApiState => ({
  _version: 3,
  isEnabled: false,
  providerId: 'fal',
  modelId: 'fal-ai/nano-banana-pro',
  generationMode: 'generate',
  aspectRatio: '1:1',
  resolution: '1K',
  enableWebSearch: false,
  safetyTolerance: 6,
  numImages: 1,
  outputFormat: 'png',
  referenceImageNames: [],
});

const slice = createSlice({
  name: 'externalApi',
  initialState: getInitialState(),
  reducers: {
    externalApiToggled: (state, action: PayloadAction<boolean>) => {
      state.isEnabled = action.payload;
    },
    externalApiProviderChanged: (state, action: PayloadAction<string>) => {
      state.providerId = action.payload;
    },
    externalApiModelChanged: (state, action: PayloadAction<string>) => {
      state.modelId = action.payload;
    },
    externalApiGenerationModeChanged: (state, action: PayloadAction<ExternalApiGenerationMode>) => {
      state.generationMode = action.payload;
    },
    externalApiAspectRatioChanged: (state, action: PayloadAction<ExternalApiAspectRatio>) => {
      state.aspectRatio = action.payload;
    },
    externalApiResolutionChanged: (state, action: PayloadAction<ExternalApiResolution>) => {
      state.resolution = action.payload;
    },
    externalApiWebSearchToggled: (state, action: PayloadAction<boolean>) => {
      state.enableWebSearch = action.payload;
    },
    externalApiSafetyToleranceChanged: (state, action: PayloadAction<number>) => {
      state.safetyTolerance = action.payload;
    },
    externalApiNumImagesChanged: (state, action: PayloadAction<number>) => {
      state.numImages = action.payload;
    },
    externalApiOutputFormatChanged: (state, action: PayloadAction<ExternalApiOutputFormat>) => {
      state.outputFormat = action.payload;
    },
    externalApiReferenceImageAdded: (state, action: PayloadAction<string>) => {
      if (!state.referenceImageNames.includes(action.payload)) {
        state.referenceImageNames.push(action.payload);
      }
    },
    externalApiReferenceImageRemoved: (state, action: PayloadAction<string>) => {
      state.referenceImageNames = state.referenceImageNames.filter((n) => n !== action.payload);
    },
    externalApiReferenceImagesCleared: (state) => {
      state.referenceImageNames = [];
    },
  },
});

export const {
  externalApiToggled,
  externalApiProviderChanged,
  externalApiModelChanged,
  externalApiGenerationModeChanged,
  externalApiAspectRatioChanged,
  externalApiResolutionChanged,
  externalApiWebSearchToggled,
  externalApiSafetyToleranceChanged,
  externalApiNumImagesChanged,
  externalApiOutputFormatChanged,
  externalApiReferenceImageAdded,
  externalApiReferenceImageRemoved,
  externalApiReferenceImagesCleared,
} = slice.actions;

export const externalApiSliceConfig: SliceConfig<typeof slice> = {
  slice,
  schema: zExternalApiState,
  getInitialState,
  persistConfig: {
    migrate: (state) => {
      assert(isPlainObject(state));

      // Migrate v1 -> v2: rename 'provider' to 'providerId'
      if (!('_version' in state) || state._version === 1) {
        state._version = 2;
        if ('provider' in state && !('providerId' in state)) {
          state.providerId = state.provider;
          delete state.provider;
        }
        if (!('providerId' in state)) {
          state.providerId = 'fal';
        }
      }

      // Migrate v2 -> v3: add referenceImageNames
      if (state._version === 2) {
        state._version = 3;
        if (!('referenceImageNames' in state)) {
          state.referenceImageNames = [];
        }
      }

      return zExternalApiState.parse(state);
    },
  },
};

export const selectExternalApiSlice = (state: RootState) => state.externalApi;
const createExternalApiSelector = <T>(selector: Selector<ExternalApiState, T>) =>
  createSelector(selectExternalApiSlice, selector);

export const selectExternalApiIsEnabled = createExternalApiSelector((s) => s.isEnabled);
export const selectExternalApiProviderId = createExternalApiSelector((s) => s.providerId);
export const selectExternalApiModelId = createExternalApiSelector((s) => s.modelId);
export const selectExternalApiGenerationMode = createExternalApiSelector((s) => s.generationMode);
export const selectExternalApiAspectRatio = createExternalApiSelector((s) => s.aspectRatio);
export const selectExternalApiResolution = createExternalApiSelector((s) => s.resolution);
export const selectExternalApiEnableWebSearch = createExternalApiSelector((s) => s.enableWebSearch);
export const selectExternalApiSafetyTolerance = createExternalApiSelector((s) => s.safetyTolerance);
export const selectExternalApiNumImages = createExternalApiSelector((s) => s.numImages);
export const selectExternalApiOutputFormat = createExternalApiSelector((s) => s.outputFormat);
export const selectExternalApiReferenceImageNames = createExternalApiSelector((s) => s.referenceImageNames);
