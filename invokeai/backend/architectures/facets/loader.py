"""Per-architecture exceptions to the generic model-loading policy.

Generic loading code should not know architecture names. `ModelLoader._should_use_fp8` did: it
carried a `config.base == BaseModelType.ZImage` branch in the middle of otherwise architecture-blind
logic, behind a function-local import.

The flags here are scalars an architecture *declares*, not implementations it *provides*. Choosing a
different loader or a different conversion function per architecture is dispatch, and belongs in the
`ModelLoaderRegistry` where it already lives -- not here. `model_loaders/lora.py` is the clearest
example of that distinction: its base chain picks a different state-dict conversion per
architecture, so it stays where it is.

Optional by design, with defaults describing the ordinary case. An architecture that needs no
exception declares nothing, and `get_loader_flags()` hands back the defaults -- the Null Object of
`.ideas/ArchitectureSpec.md` §3, which is what keeps callers free of `is None` checks.
"""

from dataclasses import dataclass

from invokeai.backend.architectures.facet import Facet
from invokeai.backend.architectures.registry import get
from invokeai.backend.model_manager.taxonomy import BaseModelType


@dataclass(frozen=True)
class LoaderFlagsFacet(Facet):
    """Architecture-level answers the generic loader needs, where the general rule does not hold."""

    supports_fp8_storage: bool = True
    """Whether fp8 layerwise casting may be applied to this architecture's weights.

    The other exclusions in `_should_use_fp8` are keyed on model *type* (VAEs degrade in decode,
    LoRAs are patched in rather than run) or on submodel type, and stay generic -- they hold for
    every architecture.
    """


DEFAULT_LOADER_FLAGS = LoaderFlagsFacet()
"""What an architecture gets when it declares nothing: the general rule, unqualified."""


def get_loader_flags(base: BaseModelType) -> LoaderFlagsFacet:
    """The loader flags for `base`, or the defaults.

    Also returns the defaults for `Any`, `External` and `Unknown`, which are never registered --
    matching the previous behaviour, where only an exact match on Z-Image changed anything.
    """
    facet = get(base, LoaderFlagsFacet)
    return facet if facet is not None else DEFAULT_LOADER_FLAGS
