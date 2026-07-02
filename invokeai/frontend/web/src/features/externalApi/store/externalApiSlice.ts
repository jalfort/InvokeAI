import type { PayloadAction, Selector } from '@reduxjs/toolkit';
import { createSelector, createSlice } from '@reduxjs/toolkit';
import type { RootState } from 'app/store/store';
import type { SliceConfig } from 'app/store/types';
import { isPlainObject } from 'es-toolkit';
import { assert } from 'tsafe';
import { z } from 'zod';

// Relaxed to z.string() so each model can define its own valid values via schema.
// Legacy enum values are still valid but new models can use any string (e.g., "1:4", "512px", "1024x1024").
const zExternalApiAspectRatio = z.string();
export type ExternalApiAspectRatio = z.infer<typeof zExternalApiAspectRatio>;

const zExternalApiResolution = z.string();
export type ExternalApiResolution = z.infer<typeof zExternalApiResolution>;

const zExternalApiOutputFormat = z.enum(['jpeg', 'png', 'webp']);
export type ExternalApiOutputFormat = z.infer<typeof zExternalApiOutputFormat>;

const zExternalApiGenerationMode = z.enum(['generate', 'edit']);
export type ExternalApiGenerationMode = z.infer<typeof zExternalApiGenerationMode>;

const zExternalApiModeSource = z.enum(['user', 'auto']);
// ExternalApiModeSource type inferred via state schema

const zExternalApiSortBy = z.enum(['provider', 'api_category', 'user_category']);
export type ExternalApiSortBy = z.infer<typeof zExternalApiSortBy>;

const zExternalApiState = z.object({
  _version: z.literal(7),
  isEnabled: z.boolean(),
  providerId: z.string(),
  modelId: z.string(),
  generationMode: zExternalApiGenerationMode,
  modeSource: zExternalApiModeSource,
  aspectRatio: zExternalApiAspectRatio,
  resolution: zExternalApiResolution,
  enableWebSearch: z.boolean(),
  safetyTolerance: z.number().int().min(1).max(6),
  numImages: z.number().int().min(1).max(4),
  outputFormat: zExternalApiOutputFormat,
  referenceImageNames: z.array(z.string()),
  dynamicParams: z.record(z.string(), z.unknown()),
  dynamicImageParams: z.record(z.string(), z.array(z.string())),
  sortEndpointsBy: zExternalApiSortBy,
});
export type ExternalApiState = z.infer<typeof zExternalApiState>;

const getInitialState = (): ExternalApiState => ({
  _version: 7,
  isEnabled: false,
  providerId: 'fal',
  modelId: 'fal-ai/nano-banana-pro',
  generationMode: 'generate',
  modeSource: 'user',
  aspectRatio: '1:1',
  resolution: '1K',
  enableWebSearch: false,
  safetyTolerance: 6,
  numImages: 1,
  outputFormat: 'png',
  referenceImageNames: [],
  dynamicParams: {},
  dynamicImageParams: {},
  sortEndpointsBy: 'provider',
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
      // Reset dynamic params when switching models — each model has its own schema
      state.dynamicParams = {};
      state.dynamicImageParams = {};
    },
    externalApiGenerationModeChanged: (state, action: PayloadAction<ExternalApiGenerationMode>) => {
      state.generationMode = action.payload;
      state.modeSource = 'user';
    },
    externalApiGenerationModeAutoSet: (state, action: PayloadAction<ExternalApiGenerationMode>) => {
      state.generationMode = action.payload;
      state.modeSource = 'auto';
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
    externalApiDynamicParamChanged: (state, action: PayloadAction<{ key: string; value: unknown }>) => {
      state.dynamicParams[action.payload.key] = action.payload.value;
    },
    externalApiDynamicParamsReset: (state) => {
      state.dynamicParams = {};
    },
    externalApiDynamicImageAdded: (state, action: PayloadAction<{ fieldKey: string; imageName: string }>) => {
      const { fieldKey, imageName } = action.payload;
      if (!state.dynamicImageParams[fieldKey]) {
        state.dynamicImageParams[fieldKey] = [];
      }
      if (!state.dynamicImageParams[fieldKey]!.includes(imageName)) {
        state.dynamicImageParams[fieldKey]!.push(imageName);
      }
    },
    externalApiDynamicImageRemoved: (state, action: PayloadAction<{ fieldKey: string; imageName: string }>) => {
      const { fieldKey, imageName } = action.payload;
      const arr = state.dynamicImageParams[fieldKey];
      if (arr) {
        state.dynamicImageParams[fieldKey] = arr.filter((n) => n !== imageName);
      }
    },
    externalApiDynamicImageFieldCleared: (state, action: PayloadAction<string>) => {
      delete state.dynamicImageParams[action.payload];
    },
    externalApiDynamicImageParamsReset: (state) => {
      state.dynamicImageParams = {};
    },
    externalApiSortByChanged: (state, action: PayloadAction<ExternalApiSortBy>) => {
      state.sortEndpointsBy = action.payload;
    },
  },
});

export const {
  externalApiToggled,
  externalApiProviderChanged,
  externalApiModelChanged,
  externalApiGenerationModeChanged,
  externalApiGenerationModeAutoSet,
  externalApiAspectRatioChanged,
  externalApiResolutionChanged,
  externalApiWebSearchToggled,
  externalApiSafetyToleranceChanged,
  // externalApiNumImagesChanged, // @knipignore - not yet wired up
  externalApiOutputFormatChanged,
  externalApiReferenceImageAdded,
  externalApiReferenceImageRemoved,
  // externalApiReferenceImagesCleared, // knipignore - used via string dispatch
  externalApiDynamicParamChanged,
  // externalApiDynamicParamsReset, // @knipignore - not yet wired up
  externalApiDynamicImageAdded,
  externalApiDynamicImageRemoved,
  externalApiDynamicImageFieldCleared,
  // externalApiDynamicImageParamsReset, // @knipignore - not yet wired up
  externalApiSortByChanged,
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

      // Migrate v3 -> v4: add modeSource
      if (state._version === 3) {
        state._version = 4;
        if (!('modeSource' in state)) {
          state.modeSource = 'user';
        }
      }

      // Migrate v4 -> v5: add dynamicParams, sortEndpointsBy
      if (state._version === 4) {
        state._version = 5;
        if (!('dynamicParams' in state)) {
          state.dynamicParams = {};
        }
        if (!('sortEndpointsBy' in state)) {
          state.sortEndpointsBy = 'provider';
        }
      }

      // Migrate v5 -> v6: add dynamicImageParams
      if (state._version === 5) {
        state._version = 6;
        if (!('dynamicImageParams' in state)) {
          state.dynamicImageParams = {};
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
// export const selectExternalApiNumImages = createExternalApiSelector((s) => s.numImages); // @knipignore - not yet wired up
export const selectExternalApiOutputFormat = createExternalApiSelector((s) => s.outputFormat);
export const selectExternalApiModeSource = createExternalApiSelector((s) => s.modeSource);
export const selectExternalApiReferenceImageNames = createExternalApiSelector((s) => s.referenceImageNames);
export const selectExternalApiDynamicParams = createExternalApiSelector((s) => s.dynamicParams);
export const selectExternalApiDynamicImageParams = createExternalApiSelector((s) => s.dynamicImageParams);
export const selectExternalApiSortBy = createExternalApiSelector((s) => s.sortEndpointsBy);
