import { api, buildV1Url } from '..';

const buildExternalApiUrl = (path: string = '') => buildV1Url(`external_api/${path}`);

type ProviderStatus = {
  provider: string;
  display_name: string;
  is_configured: boolean;
};

type ProviderListResponse = {
  providers: ProviderStatus[];
};

type SetKeyRequest = {
  provider: 'fal';
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
    setExternalApiKey: build.mutation<SetKeyResponse, SetKeyRequest>({
      query: (body) => ({
        url: buildExternalApiUrl('set_key'),
        method: 'POST',
        body,
      }),
      invalidatesTags: ['ExternalApiProviders'],
    }),
    testExternalApiKey: build.mutation<TestKeyResponse, 'fal'>({
      query: (provider) => ({
        url: buildExternalApiUrl('test_key'),
        method: 'POST',
        body: { provider },
      }),
    }),
  }),
});

export const { useGetExternalApiProvidersQuery, useSetExternalApiKeyMutation, useTestExternalApiKeyMutation } =
  externalApiEndpoints;
