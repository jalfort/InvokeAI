import { api, buildV1Url } from '..';

const buildExternalApiUrl = (path: string = '') => buildV1Url(`external_api/${path}`);

type ProviderStatus = {
  provider: string;
  display_name: string;
  is_configured: boolean;
  is_available: boolean;
  capability_type: 'image' | 'text' | 'image_text';
};

type ProviderListResponse = {
  providers: ProviderStatus[];
};

type ProviderCapabilities = {
  supports_refs_in_generate: boolean;
  supports_masks: boolean;
  max_refs: number;
  max_images_per_call: number;
  supported_resolutions: string[];
  has_seed: boolean;
  has_guidance_scale: boolean;
  output_formats: string[];
  capability_type: 'image' | 'text' | 'image_text';
};

type ModelWithCapabilities = {
  id: string;
  name: string;
  provider_id: string;
  description: string;
  capabilities: ProviderCapabilities | null;
};

type ModelListResponse = {
  models: ModelWithCapabilities[];
};

type SetKeyRequest = {
  provider: string;
  api_key: string;
  persist?: boolean;
};

type SetKeyResponse = {
  provider: string;
  is_configured: boolean;
};

type TestKeyResponse = {
  provider: string;
  is_valid: boolean;
  message: string;
};

export const externalApiEndpoints = api.injectEndpoints({
  endpoints: (build) => ({
    getExternalApiProviders: build.query<ProviderListResponse, void>({
      query: () => ({
        url: buildExternalApiUrl('providers'),
        method: 'GET',
      }),
      providesTags: ['FetchOnReconnect', 'ExternalApiProviders'],
    }),
    getExternalApiModels: build.query<ModelListResponse, void>({
      query: () => ({
        url: buildExternalApiUrl('models'),
        method: 'GET',
      }),
      providesTags: ['FetchOnReconnect', 'ExternalApiProviders'],
    }),
    setExternalApiKey: build.mutation<SetKeyResponse, SetKeyRequest>({
      query: (body) => ({
        url: buildExternalApiUrl('set_key'),
        method: 'POST',
        body,
      }),
      invalidatesTags: ['ExternalApiProviders'],
    }),
    testExternalApiKey: build.mutation<TestKeyResponse, string>({
      query: (provider) => ({
        url: buildExternalApiUrl('test_key'),
        method: 'POST',
        body: { provider },
      }),
    }),
  }),
});

export const {
  useGetExternalApiProvidersQuery,
  useGetExternalApiModelsQuery,
  useSetExternalApiKeyMutation,
  useTestExternalApiKeyMutation,
} = externalApiEndpoints;
