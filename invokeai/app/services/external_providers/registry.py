"""Provider registry — discovers, loads, and manages external providers."""

from invokeai.app.services.external_providers.base import BaseProvider, ModelInfo


class ProviderRegistry:
    """Central registry for all external image generation providers.

    Providers register themselves at startup. The rest of the application
    queries the registry to discover available providers and their models.
    """

    def __init__(self) -> None:
        self._providers: dict[str, BaseProvider] = {}

    def register(self, provider: BaseProvider) -> None:
        """Register a provider instance. Overwrites any existing provider with the same id."""
        self._providers[provider.provider_id] = provider

    def get_provider(self, provider_id: str) -> BaseProvider:
        """Get a provider by its id. Raises KeyError if not found."""
        try:
            return self._providers[provider_id]
        except KeyError:
            available = ", ".join(sorted(self._providers.keys())) or "(none)"
            raise KeyError(f"Unknown provider '{provider_id}'. Available providers: {available}")

    def get_all_providers(self) -> list[BaseProvider]:
        """Return all registered providers."""
        return list(self._providers.values())

    def resolve_credential_id(self, provider_id: str) -> str:
        """Return the api_keys name that holds the credential for a provider.

        Most providers store their key under their own id, but some share one
        credential (e.g. openai_image reuses "openai"). Falls back to the given
        provider_id for unknown/unregistered providers.
        """
        provider = self._providers.get(provider_id)
        return provider.api_key_name if provider is not None else provider_id

    def get_providers_for_model(self, model_id: str) -> list[BaseProvider]:
        """Return all providers that support a given model id."""
        result: list[BaseProvider] = []
        for provider in self._providers.values():
            model_ids = [m.id for m in provider.get_supported_models()]
            if model_id in model_ids:
                result.append(provider)
        return result

    def get_all_models(self) -> list[ModelInfo]:
        """Return all models across all registered providers."""
        models: list[ModelInfo] = []
        for provider in self._providers.values():
            models.extend(provider.get_supported_models())
        return models


# Module-level singleton — providers register against this instance at import time.
_registry = ProviderRegistry()
_initialized = False


def get_provider_registry() -> ProviderRegistry:
    """Get the global provider registry singleton, registering built-in providers on first call."""
    global _initialized
    if not _initialized:
        _initialized = True
        _register_builtin_providers()
    return _registry


def _register_builtin_providers() -> None:
    """Register all built-in providers. Called once on first registry access."""
    import logging

    log = logging.getLogger("InvokeAI")

    # Gemini provider (google-genai SDK)
    try:
        from invokeai.app.services.external_providers.gemini_provider import GeminiProvider

        _registry.register(GeminiProvider())
        log.debug("Registered Gemini provider")
    except ImportError:
        log.debug("google-genai not installed, skipping Gemini provider")

    # OpenAI provider (text-only, prompt optimization)
    try:
        from invokeai.app.services.external_providers.openai_provider import OpenAIProvider

        _registry.register(OpenAIProvider())
        log.debug("Registered OpenAI provider")
    except ImportError:
        log.debug("Failed to load OpenAI provider")

    # OpenAI image generation provider (gpt-image-2)
    try:
        from invokeai.app.services.external_providers.openai_image_provider import OpenAIImageProvider

        _registry.register(OpenAIImageProvider())
        log.debug("Registered OpenAI Image provider")
    except ImportError:
        log.debug("Failed to load OpenAI Image provider")

    # Anthropic provider (text-only, prompt optimization)
    try:
        from invokeai.app.services.external_providers.anthropic_provider import AnthropicProvider

        _registry.register(AnthropicProvider())
        log.debug("Registered Anthropic provider")
    except ImportError:
        log.debug("Failed to load Anthropic provider")

    # OpenRouter provider (text-only, prompt optimization)
    try:
        from invokeai.app.services.external_providers.openrouter_provider import OpenRouterProvider

        _registry.register(OpenRouterProvider())
        log.debug("Registered OpenRouter provider")
    except ImportError:
        log.debug("Failed to load OpenRouter provider")

    # FAL.ai dynamic provider (reads models from dynamic_endpoints.json)
    try:
        from invokeai.app.services.external_providers.fal_dynamic_provider import FalDynamicProvider

        _registry.register(FalDynamicProvider())
        log.debug("Registered FAL.ai dynamic provider")
    except ImportError:
        log.debug("Failed to load FAL.ai dynamic provider")

    # Replicate dynamic provider (reads models from dynamic_endpoints.json)
    try:
        from invokeai.app.services.external_providers.replicate_provider import ReplicateDynamicProvider

        _registry.register(ReplicateDynamicProvider())
        log.debug("Registered Replicate dynamic provider")
    except ImportError:
        log.debug("Failed to load Replicate dynamic provider")
