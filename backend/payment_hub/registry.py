from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

from .adapters import GatewayAdapter, GenericRestAdapter, MockSandboxAdapter
from .domain import GatewayError


AdapterFactory = Callable[[Mapping[str, Any], Mapping[str, str], set[str]], GatewayAdapter]


class ProviderRegistry:
    def __init__(self):
        self._factories: dict[str, AdapterFactory] = {}

    def register(self, code: str, factory: AdapterFactory) -> None:
        normalized = str(code).strip().upper()
        if not normalized or normalized in self._factories:
            raise ValueError(f"Adapter {normalized or code!r} is already registered or invalid")
        self._factories[normalized] = factory

    def create(
        self, code: str, config: Mapping[str, Any] | None = None,
        secrets: Mapping[str, str] | None = None, allowed_domains: set[str] | None = None,
    ) -> GatewayAdapter:
        normalized = str(code).strip().upper()
        factory = self._factories.get(normalized)
        if not factory:
            raise GatewayError("GATEWAY_ADAPTER_NOT_INSTALLED", f"Adapter {normalized} is not installed.", status_code=503)
        return factory(dict(config or {}), dict(secrets or {}), set(allowed_domains or set()))

    def codes(self) -> tuple[str, ...]:
        return tuple(sorted(self._factories))


registry = ProviderRegistry()
registry.register("MOCK_SANDBOX", lambda config, secrets, domains: MockSandboxAdapter(config, secrets))
registry.register("GENERIC_REST", lambda config, secrets, domains: GenericRestAdapter(config, secrets, domains))
