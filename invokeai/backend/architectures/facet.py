"""The `Facet` marker base class.

This module is a leaf: it imports nothing from `invokeai`. Keeping it separate from `registry` is
what makes the package's internal layering a directed acyclic graph, so that facet modules may
import the registry without the registry ever needing to import a facet:

    facet -> registry -> facets/* -> defs/* -> __init__

`tests/backend/architectures/test_layering.py` enforces that shape.
"""

from typing import Any, ClassVar


class Facet:
    """Marker base class for architecture facets.

    A facet is one immutable, self-contained fact about a model architecture -- its latent space, its
    conditioning types, its capabilities. Concrete facets are frozen dataclasses carrying plain data;
    never services, never model instances, never callables reaching back into core code.

    Facets are keyed in the registry by their *exact* runtime type, so a facet class must not be
    subclassed by another facet class.

    Subclasses are collected at class-creation time so `registry.validate()` can check every
    registered architecture against the facets that declare themselves required. This mirrors
    `Config_Base.CONFIG_CLASSES`, but uses a dict rather than a set: a set gives a non-deterministic
    iteration order, which has already bitten this codebase once (see
    tests/backend/model_manager/configs/test_wan_lora_probe_independence.py).
    """

    REQUIRED: ClassVar[bool] = False
    """When True, `registry.validate()` fails for any registered architecture not declaring it."""

    FACET_TYPES: ClassVar[dict[type["Facet"], None]] = {}
    """Every imported concrete facet class, in definition order. A dict used as an ordered set."""

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        Facet.FACET_TYPES[cls] = None
