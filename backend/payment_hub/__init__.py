"""Universal, provider-neutral payment administration domain.

The hub is additive to the established wallet/ledger implementation.  It owns
provider configuration, routing, operational evidence and adapter resolution;
financial postings remain in :mod:`financial_wallet`.
"""

from .domain import Capability, GatewayError, PayinStatus, PayoutStatus
from .registry import registry

__all__ = ["Capability", "GatewayError", "PayinStatus", "PayoutStatus", "registry"]
