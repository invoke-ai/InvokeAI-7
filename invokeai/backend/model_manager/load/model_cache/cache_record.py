import weakref
from dataclasses import dataclass

from invokeai.backend.model_manager.load.model_cache.cached_model.cached_model_only_full_load import (
    CachedModelOnlyFullLoad,
)
from invokeai.backend.model_manager.load.model_cache.cached_model.cached_model_with_partial_load import (
    CachedModelWithPartialLoad,
)


@dataclass
class CacheRecord:
    """A class that represents a model in the model cache."""

    # Cache key.
    key: str
    # Model in memory.
    cached_model: CachedModelWithPartialLoad | CachedModelOnlyFullLoad
    _locks: int = 0
    # Set by ModelCache.drop_model() when the entry was locked at invalidation time.
    # ModelCache.unlock() evicts the entry as soon as the last lock releases so a setting
    # change (e.g. fp8_storage toggled during an in-flight generation) takes effect on the
    # next load instead of silently being ignored.
    is_stale: bool = False
    # Post-admission grace: set by ModelCache.put() (unless the admission is a prefetch of a
    # model nothing will come back for) and cleared on the entry's first lock(). A freshly
    # admitted model is about to be used — its loader calls get() as soon as put() returns,
    # constructs a LoadedModel handle, and locks it for inference — so no eviction path
    # (make_room, shared-budget reconcile, peer-requested eviction) may treat it as idle:
    # evicting it frees nothing (the handle keeps the model alive) while detaching the record
    # from the cache's RAM accounting. The window is NOT confined to a single load: multi-model
    # invocations load their whole set (e.g. text encoder, then tokenizer, then processor)
    # before locking any of it, so a sibling's cold load legitimately runs make_room — and
    # put() — while earlier entries sit graced with live handles. The grace deliberately
    # survives get(): get() is synchronized, and its own lock-release hook may run a pending
    # reconcile before the caller can lock the record it was just handed.
    #
    # The flag cannot shield a record forever. Its owner is the LoadedModel handle
    # (`grace_holder` below): a dropped handle releases the grace through its finalizer, and
    # ModelCache.put()'s sweep clears any grace that is provably orphaned — no handle was ever
    # registered (the load raised between put() and LoadedModel construction), or the handle
    # died without its finalizer running (deferred worker lost) — so an orphaned record cannot
    # dodge budget reconciles indefinitely. The keep-alive timeout clear also ignores the grace:
    # after an idle period it is abandoned by definition.
    awaiting_first_use: bool = False

    # Weak reference to the LoadedModel handle that owns `awaiting_first_use`, registered at
    # handle construction (see LoadedModelWithoutConfig.__init__). None until then — which is
    # exactly what put()'s sweep uses to tell an in-flight sibling (live holder: keep the grace)
    # from an orphaned admission (no holder, or a dead one: clear it).
    grace_holder: "weakref.ref[object] | None" = None

    def lock(self) -> None:
        """Lock this record."""
        self._locks += 1

    def unlock(self) -> None:
        """Unlock this record."""
        self._locks -= 1
        assert self._locks >= 0

    @property
    def is_locked(self) -> bool:
        """Return true if record is locked."""
        return self._locks > 0
