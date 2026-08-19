"""Core invocation modules, imported for their side effects.

Every module below registers its `@invocation`-decorated classes with `InvocationRegistry` as it is
imported, so the app is only correct once *all* of them have been imported. That import is triggered
by `from invokeai.app.invocations import *` in `invokeai.app.services.shared.graph`.

Discovery walks the whole package tree rather than globbing `*.py` in this directory. Node modules
are grouped into per-architecture subpackages (`flux/`, `wan/`, ...) and cross-cutting ones (`vae/`,
`text_encoder/`, `pid/`), and a flat glob would skip every one of them silently — the failure would
not surface at boot but later, as an "unknown node type" when a user opens a workflow that uses one.
"""

from importlib import import_module
from pathlib import Path
from types import ModuleType

from invokeai.backend.util.module_discovery import discover_modules

_MODULES: dict[str, ModuleType] = {
    name: import_module(name) for name in discover_modules(Path(__file__).parent, f"{__name__}.")
}

# `import *` binds names, and a dotted name is not one. Only the top component of each module path
# is an attribute of this package, so a node in a subpackage contributes that subpackage's name.
# Binding is incidental here anyway — the registration this module exists for already happened above.
__all__ = sorted({name.removeprefix(f"{__name__}.").split(".", 1)[0] for name in _MODULES})
