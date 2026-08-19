"""Core invocation modules, imported for their side effects.

Every module below registers its `@invocation`-decorated classes with `InvocationRegistry` as it is
imported, so the app is only correct once *all* of them have been imported. That import is triggered
by `from invokeai.app.invocations import *` in `invokeai.app.services.shared.graph`.

Discovery walks the whole package tree rather than globbing `*.py` in this directory. Node modules
are grouped into per-architecture subpackages (`flux/`, `wan/`, ...) and cross-cutting ones (`vae/`,
`text_encoder/`, `pid/`), and a flat glob would skip every one of them silently — the failure would
not surface at boot but later, as an "unknown node type" when a user opens a workflow that uses one.
"""

import pkgutil
from importlib import import_module
from pathlib import Path
from types import ModuleType

_PACKAGE_ROOT = Path(__file__).parent


def _on_discovery_error(name: str) -> None:
    """Re-raise whatever broke while walking the tree.

    `pkgutil.walk_packages` swallows errors raised while importing a *subpackage* by default, which
    would turn "this architecture's `__init__.py` is broken" into "these nodes quietly do not exist".
    That is the exact failure mode this module exists to prevent, so refuse to continue.
    """
    raise ImportError(f"Failed to walk invocation package {name!r} while discovering nodes.")


def discover_node_modules(root: Path = _PACKAGE_ROOT, prefix: str = f"{__name__}.") -> list[str]:
    """Fully-qualified names of every non-private module in the package tree rooted at `root`.

    A path component starting with `_` excludes the module: that covers `__pycache__` and marks a
    module as internal. Subpackages themselves are skipped — importing them is a side effect of the
    walk, and their `__init__.py` files hold no nodes.

    Parameterized on `root`/`prefix` so the walk can be exercised against a synthetic tree. A walker
    with a bug here finds nothing and stays green forever, so it needs a test that does not depend
    on the layout of this package.
    """
    names: list[str] = []
    for info in pkgutil.walk_packages([str(root)], prefix=prefix, onerror=_on_discovery_error):
        relative = info.name.removeprefix(prefix)
        if info.ispkg or any(part.startswith("_") for part in relative.split(".")):
            continue
        names.append(info.name)
    return names


_MODULES: dict[str, ModuleType] = {name: import_module(name) for name in discover_node_modules()}

# `import *` binds names, and a dotted name is not one. Only the top component of each module path
# is an attribute of this package, so a node in a subpackage contributes that subpackage's name.
# Binding is incidental here anyway — the registration this module exists for already happened above.
__all__ = sorted({name.removeprefix(f"{__name__}.").split(".", 1)[0] for name in _MODULES})
