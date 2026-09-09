"""
Tier policy -- spend the free capacity first, and only then spend money.

The router already knows how to avoid a provider that is failing, rate limited,
or over budget. Tiering adds the other half: of the providers that *can* serve
this request, which one costs the least. Candidates are grouped by the tier
their catalog entry declares, and the cheapest group with anyone left in it
wins. When a free provider trips its rate limit the quota manager takes it out
of the running, that group empties, and the next request escalates on its own.

Every escalation is recorded, so the dashboard can show why a task that ran on
free capacity this morning is costing money this afternoon.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from enum import Enum

from ..providers.catalog import CATALOG, Tier


class TierMode(Enum):
    """How hard the policy tries to avoid paying."""

    ESCALATE = "escalate"      # cheapest tier with capacity; step up when it empties
    FREE_ONLY = "free_only"    # never leave local/free/freemium, even if it means failing
    PREFER_PAID = "prefer_paid"  # most capable first; free tiers are the fallback
    OFF = "off"                # ignore tiers entirely, leave ordering to the router


@dataclass
class Escalation:
    """A record of the moment a task stopped being free."""

    from_tier: str
    to_tier: str
    reason: str
    provider: str
    timestamp: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        return {
            "from_tier": self.from_tier,
            "to_tier": self.to_tier,
            "reason": self.reason,
            "provider": self.provider,
            "timestamp": self.timestamp,
        }


def tier_of(provider_id: str) -> Tier:
    """
    The tier a provider belongs to.

    Anything not in the catalog is treated as paid: assuming a stranger is
    free is the expensive mistake, so the policy makes the safe one.
    """
    entry = CATALOG.get(provider_id)
    return entry.tier if entry else Tier.PAID


@dataclass
class TierPolicy:
    """
    Which tiers a run may use, and in what order.

    `max_tier` is the spending ceiling: with it set to FREE, a task will fail
    rather than reach for a metered provider, which is the point -- an
    unattended loop should not be able to quietly start billing.
    """

    mode: TierMode = TierMode.ESCALATE
    max_tier: Tier | None = None
    blocked: set[str] = field(default_factory=set)

    def allows(self, provider_id: str) -> bool:
        if provider_id in self.blocked:
            return False
        tier = tier_of(provider_id)
        if self.mode is TierMode.FREE_ONLY and tier not in _FREE_TIERS:
            return False
        if self.max_tier is not None and tier.rank > self.max_tier.rank:
            return False
        return True

    def groups(self, candidates: list[str]) -> list[tuple[Tier, list[str]]]:
        """
        Split candidates into tier groups, in the order they should be tried.

        Returns an empty list when the policy rules out every candidate; the
        caller decides whether that is a failure or a reason to widen the
        policy, because only the caller knows if the task can wait.
        """
        allowed = [p for p in candidates if self.allows(p)]
        if not allowed:
            return []

        buckets: dict[Tier, list[str]] = {}
        for provider in allowed:
            buckets.setdefault(tier_of(provider), []).append(provider)

        tiers = sorted(buckets, key=lambda t: t.rank)
        if self.mode is TierMode.PREFER_PAID:
            tiers.reverse()
        elif self.mode is TierMode.OFF:
            # One group, original order: the router's own strategy decides.
            return [(tier_of(allowed[0]), allowed)]

        return [(tier, buckets[tier]) for tier in tiers]

    def to_dict(self) -> dict:
        return {
            "mode": self.mode.value,
            "max_tier": self.max_tier.value if self.max_tier else None,
            "blocked": sorted(self.blocked),
        }


_FREE_TIERS = (Tier.LOCAL, Tier.FREE, Tier.FREEMIUM)


class TierLedger:
    """Remembers which tier served each request, and every escalation."""

    def __init__(self, history_limit: int = 200) -> None:
        self.usage: dict[str, int] = {}
        self.escalations: list[Escalation] = []
        self._last_tier: Tier | None = None
        self._history_limit = history_limit

    def record(self, provider_id: str, reason: str = "") -> Escalation | None:
        """
        Note that `provider_id` served a request.

        Returns an Escalation when this request cost more than the last one
        did, so callers can surface the moment rather than discover it on a
        bill.
        """
        tier = tier_of(provider_id)
        self.usage[tier.value] = self.usage.get(tier.value, 0) + 1

        escalation = None
        if self._last_tier is not None and tier.rank > self._last_tier.rank:
            escalation = Escalation(
                from_tier=self._last_tier.value,
                to_tier=tier.value,
                reason=reason or "no capacity left in the cheaper tier",
                provider=provider_id,
            )
            self.escalations.append(escalation)
            del self.escalations[:-self._history_limit]

        self._last_tier = tier
        return escalation

    @property
    def free_share(self) -> float:
        """The fraction of requests served without spending anything."""
        total = sum(self.usage.values())
        if not total:
            return 1.0
        free = sum(self.usage.get(t.value, 0) for t in _FREE_TIERS)
        return free / total

    def to_dict(self) -> dict:
        return {
            "usage_by_tier": dict(self.usage),
            "current_tier": self._last_tier.value if self._last_tier else None,
            "free_share": round(self.free_share, 4),
            "escalations": [e.to_dict() for e in self.escalations[-20:]],
        }
