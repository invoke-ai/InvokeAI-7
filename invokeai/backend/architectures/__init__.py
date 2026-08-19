"""Facts about model architectures, one file per architecture.

Import this package to use the registry; importing it fills the registry as a side effect. Modules
*inside* the package import `architectures.registry` directly instead — see `defs/__init__.py`.
"""

from invokeai.backend.architectures import defs as defs  # noqa: F401  (imported for side effects)
from invokeai.backend.architectures import facets as facets  # noqa: F401  (imported for side effects)
from invokeai.backend.architectures.facet import Facet
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
    "Facet",
    "defs_module_path",
    "facets_of",
    "generative_bases",
    "get",
    "register",
    "require",
    "validate",
]
