"""Facts about model architectures, one file per architecture.

Import this package to use the registry; importing it fills the registry as a side effect. Modules
*inside* the package import `architectures.registry` directly instead — see `defs/__init__.py`.
"""

from invokeai.backend.architectures import defs as defs  # noqa: F401  (imported for side effects)
from invokeai.backend.architectures import facets as facets  # noqa: F401  (imported for side effects)
from invokeai.backend.architectures.facet import Facet
from invokeai.backend.architectures.facets.conditioning import ConditioningFacet, conditioning_infos
from invokeai.backend.architectures.facets.default_settings import (
    DefaultSettingsFacet,
    resolve_default_settings,
)
from invokeai.backend.architectures.facets.features import (
    ControlKind,
    FeaturesFacet,
    NegativePrompt,
)
from invokeai.backend.architectures.facets.latent_space import (
    LatentSpace,
    LatentSpaceFacet,
    resolve_latent_space,
)
from invokeai.backend.architectures.facets.modality import (
    GenerationModeKind,
    ModalityFacet,
    generation_modes,
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
    "ArchitectureError",
    "ConditioningFacet",
    "DefaultSettingsFacet",
    "ControlKind",
    "Facet",
    "FeaturesFacet",
    "NegativePrompt",
    "GenerationModeKind",
    "ModalityFacet",
    "LatentSpace",
    "LatentSpaceFacet",
    "conditioning_infos",
    "generation_modes",
    "resolve_default_settings",
    "resolve_latent_space",
    "defs_module_path",
    "facets_of",
    "generative_bases",
    "get",
    "register",
    "require",
    "validate",
]
