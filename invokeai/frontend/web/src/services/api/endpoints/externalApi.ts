import { api, buildV1Url } from '..';

const buildExternalApiUrl = (path: string = '') => buildV1Url(`external_api/${path}`);
const buildPromptLibraryUrl = (path: string = '') => buildV1Url(`prompt_library/${path}`);
const buildDynamicEndpointsUrl = (path: string = '') => buildV1Url(`dynamic_endpoints/${path}`);

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
  is_dynamic: boolean;
  cached_schema: Record<string, unknown> | null;
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

type DeleteKeyRequest = {
  provider: string;
};

type DeleteKeyResponse = {
  provider: string;
  is_configured: boolean;
};

type TestKeyResponse = {
  provider: string;
  is_valid: boolean;
  message: string;
};

// --- Prompt Optimization Types ---

type TextCapableProvidersResponse = {
  providers: string[];
};

type OptimizePromptRequest = {
  prompt: string;
  system_prompt: string;
  provider: string;
  model?: string | null;
};

type OptimizePromptResponse = {
  optimized_prompt: string;
  provider: string;
  model: string;
};

// --- Prompt Library Types ---

export type SystemPromptEntry = {
  id: string;
  name: string;
  system_prompt: string;
  is_default: boolean;
  is_locked: boolean;
  created_at: string;
  updated_at: string;
};

type PromptLibraryListResponse = {
  prompts: SystemPromptEntry[];
};

type CreateSystemPromptRequest = {
  name: string;
  system_prompt: string;
};

type UpdateSystemPromptRequest = {
  id: string;
  name?: string;
  system_prompt?: string;
  is_locked?: boolean;
};

type DeleteSystemPromptRequest = {
  id: string;
};

type RefineSystemPromptRequest = {
  system_prompt: string;
  instruction: string;
  reference_prompt?: string | null;
  provider: string;
  model?: string | null;
};

type RefineSystemPromptResponse = {
  refined_prompt: string;
  provider: string;
  model: string;
};

// --- Dynamic Endpoint Types ---

export type DynamicEndpoint = {
  id: string;
  provider: 'fal' | 'replicate';
  endpoint_id: string;
  display_name: string;
  api_category: string;
  user_category: string;
  cached_schema: Record<string, unknown>;
  cached_at: string;
  model_version: string;
};

type DynamicEndpointListResponse = {
  endpoints: DynamicEndpoint[];
};

type AddEndpointRequest = {
  endpoint_input: string;
};

type RenameEndpointRequest = {
  id: string;
  display_name: string;
};

type SetCategoryRequest = {
  id: string;
  user_category: string;
};

type RefreshEndpointRequest = {
  id: string;
};

type DeleteEndpointRequest = {
  id: string;
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
    deleteExternalApiKey: build.mutation<DeleteKeyResponse, DeleteKeyRequest>({
      query: (body) => ({
        url: buildExternalApiUrl('delete_key'),
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
    // --- Prompt Optimization ---
    getTextCapableProviders: build.query<TextCapableProvidersResponse, void>({
      query: () => ({
        url: buildExternalApiUrl('text_providers'),
        method: 'GET',
      }),
      providesTags: ['FetchOnReconnect', 'ExternalApiProviders'],
    }),
    optimizePrompt: build.mutation<OptimizePromptResponse, OptimizePromptRequest>({
      query: (body) => ({
        url: buildExternalApiUrl('optimize_prompt'),
        method: 'POST',
        body,
      }),
    }),
    // --- Prompt Library ---
    getSystemPrompts: build.query<PromptLibraryListResponse, void>({
      query: () => ({
        url: buildPromptLibraryUrl('list'),
        method: 'GET',
      }),
      providesTags: ['PromptLibrary'],
    }),
    createSystemPrompt: build.mutation<SystemPromptEntry, CreateSystemPromptRequest>({
      query: (body) => ({
        url: buildPromptLibraryUrl('create'),
        method: 'POST',
        body,
      }),
      invalidatesTags: ['PromptLibrary'],
    }),
    updateSystemPrompt: build.mutation<SystemPromptEntry, UpdateSystemPromptRequest>({
      query: (body) => ({
        url: buildPromptLibraryUrl('update'),
        method: 'PUT',
        body,
      }),
      invalidatesTags: ['PromptLibrary'],
    }),
    deleteSystemPrompt: build.mutation<{ deleted: boolean; id: string }, DeleteSystemPromptRequest>({
      query: (body) => ({
        url: buildPromptLibraryUrl('delete'),
        method: 'DELETE',
        body,
      }),
      invalidatesTags: ['PromptLibrary'],
    }),
    refineSystemPrompt: build.mutation<RefineSystemPromptResponse, RefineSystemPromptRequest>({
      query: (body) => ({
        url: buildPromptLibraryUrl('refine'),
        method: 'POST',
        body,
      }),
    }),
    // --- Dynamic Endpoints ---
    getDynamicEndpoints: build.query<DynamicEndpointListResponse, void>({
      query: () => ({
        url: buildDynamicEndpointsUrl('list'),
        method: 'GET',
      }),
      providesTags: ['DynamicEndpoints', 'FetchOnReconnect'],
    }),
    addDynamicEndpoint: build.mutation<DynamicEndpoint, AddEndpointRequest>({
      query: (body) => ({
        url: buildDynamicEndpointsUrl('add'),
        method: 'POST',
        body,
      }),
      invalidatesTags: ['DynamicEndpoints', 'ExternalApiProviders'],
    }),
    renameDynamicEndpoint: build.mutation<DynamicEndpoint, RenameEndpointRequest>({
      query: (body) => ({
        url: buildDynamicEndpointsUrl('rename'),
        method: 'POST',
        body,
      }),
      invalidatesTags: ['DynamicEndpoints', 'ExternalApiProviders'],
    }),
    setDynamicEndpointCategory: build.mutation<DynamicEndpoint, SetCategoryRequest>({
      query: (body) => ({
        url: buildDynamicEndpointsUrl('set_category'),
        method: 'POST',
        body,
      }),
      invalidatesTags: ['DynamicEndpoints'],
    }),
    refreshDynamicEndpoint: build.mutation<DynamicEndpoint, RefreshEndpointRequest>({
      query: (body) => ({
        url: buildDynamicEndpointsUrl('refresh'),
        method: 'POST',
        body,
      }),
      invalidatesTags: ['DynamicEndpoints', 'ExternalApiProviders'],
    }),
    deleteDynamicEndpoint: build.mutation<{ deleted: boolean }, DeleteEndpointRequest>({
      query: (body) => ({
        url: buildDynamicEndpointsUrl('delete'),
        method: 'POST',
        body,
      }),
      invalidatesTags: ['DynamicEndpoints', 'ExternalApiProviders'],
    }),
  }),
});

export const {
  useGetExternalApiProvidersQuery,
  useGetExternalApiModelsQuery,
  useSetExternalApiKeyMutation,
  useDeleteExternalApiKeyMutation,
  useTestExternalApiKeyMutation,
  useGetTextCapableProvidersQuery,
  useOptimizePromptMutation,
  useGetSystemPromptsQuery,
  useCreateSystemPromptMutation,
  useUpdateSystemPromptMutation,
  useDeleteSystemPromptMutation,
  useRefineSystemPromptMutation,
  useGetDynamicEndpointsQuery,
  useAddDynamicEndpointMutation,
  useRenameDynamicEndpointMutation,
  useSetDynamicEndpointCategoryMutation,
  useRefreshDynamicEndpointMutation,
  useDeleteDynamicEndpointMutation,
} = externalApiEndpoints;
