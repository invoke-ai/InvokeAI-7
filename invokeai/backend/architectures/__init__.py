"""Architecture facet registry.

Adding a model architecture should mean adding a file, not editing a dispatch chain in a dozen core
modules. Each architecture registers itself once, from `defs/<base>.py`, declaring the facets it
supports; core code reads those facts through the accessors re-exported here.

Core code imports *this* package -- never `architectures.registry`, `architectures.facet`,
`architectures.facets.*` or `architectures.defs.*` directly. The public surface is exactly
`__all__`, which gives the CI assertions in later PRs a fixed target.
`tests/backend/architectures/test_layering.py` enforces both directions of that rule.

The `defs` imports below exist for their side effects and must stay explicit rather than becoming a
glob: with a glob, `validate()` could not tell "you forgot to write defs/foo.py" from "there is no
such base". This one import line is the intended residual per-architecture core edit.
"""

from invokeai.backend.architectures.defs import (
    anima,  # noqa: F401
    cogview4,  # noqa: F401
    ernie_image,  # noqa: F401
    flux,  # noqa: F401
    flux2,  # noqa: F401
    ideogram_4,  # noqa: F401
    krea_2,  # noqa: F401
    qwen_image,  # noqa: F401
    sd_1,  # noqa: F401
    sd_2,  # noqa: F401
    sd_3,  # noqa: F401
    sdxl,  # noqa: F401
    sdxl_refiner,  # noqa: F401
    wan,  # noqa: F401
    z_image,  # noqa: F401
)
from invokeai.backend.architectures.facet import Facet
from invokeai.backend.architectures.facets.conditioning import (
    ConditioningFacet,
    conditioning_infos,
    get_conditioning_info,
)
from invokeai.backend.architectures.facets.latent_space import (
    LatentSpace,
    LatentSpaceFacet,
    get_latent_space,
    resolve_latent_space,
)
from invokeai.backend.architectures.facets.loader import (
    DEFAULT_LOADER_FLAGS,
    LoaderFlagsFacet,
    get_loader_flags,
)
from invokeai.backend.architectures.facets.unet import UNetDownscaleFacet, get_max_unet_downscale
from invokeai.backend.architectures.facets.variant import (
    VariantFacet,
    declared_variant_enums,
    get_variant_enum,
)
from invokeai.backend.architectures.registry import (
    ArchitectureError,
    defs_module_path,
    facets_of,
    generative_bases,
    get,
    register,
    require,
    validate,
)

__all__ = [
    "DEFAULT_LOADER_FLAGS",
    "ArchitectureError",
    "ConditioningFacet",
    "Facet",
    "LatentSpace",
    "LatentSpaceFacet",
    "LoaderFlagsFacet",
    "UNetDownscaleFacet",
    "VariantFacet",
    "conditioning_infos",
    "declared_variant_enums",
    "defs_module_path",
    "facets_of",
    "generative_bases",
    "get",
    "get_conditioning_info",
    "get_latent_space",
    "get_loader_flags",
    "get_max_unet_downscale",
    "get_variant_enum",
    "register",
    "require",
    "resolve_latent_space",
    "validate",
]
