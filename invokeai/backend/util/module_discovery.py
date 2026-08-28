"""Import-for-side-effect discovery of the modules in a package tree.

Two registries in this codebase are filled by importing modules rather than from a hand-maintained
list: node invocations (`invokeai.app.invocations`) and model architectures
(`invokeai.backend.architectures.defs`). Both fail the same way when discovery is subtly wrong —
they find nothing, register nothing, and stay green — so both go through this one function, and its
pitfalls are handled and tested in one place.
"""

import pkgutil
from pathlib import Path


def _reraise(name: str) -> None:
    """Refuse to continue past a subpackage that would not import.

    `pkgutil.walk_packages` swallows such errors by default, which turns "this package's
    `__init__.py` is broken" into "the things it holds quietly do not exist" — the exact failure
    mode a registry filled by import is meant to avoid.
    """
    raise ImportError(f"Failed to walk package {name!r} while discovering modules.")


def discover_modules(root: Path, prefix: str) -> list[str]:
    """Fully-qualified names of every non-private module in the package tree rooted at `root`.

    `prefix` is the dotted path of the package that lives at `root`, trailing dot included; it is
    what the returned names are prefixed with, and what `walk_packages` uses to import subpackages
    so it can descend into them.

    A path component starting with `_` excludes the module: that covers `__pycache__` and marks a
    module as internal. Packages themselves are skipped — importing them is a side effect of the
    walk, and it is their contents that carry the registrations.

    Names only; importing them is the caller's job. Keeping the two apart is what lets the walk be
    tested against a synthetic tree, which matters because a walker with a bug returns an empty list
    and no test that merely asserts "some modules were found" would notice.
    """
    names: list[str] = []
    for info in pkgutil.walk_packages([str(root)], prefix=prefix, onerror=_reraise):
        relative = info.name.removeprefix(prefix)
        if info.ispkg or any(part.startswith("_") for part in relative.split(".")):
            continue
        names.append(info.name)
    return names
