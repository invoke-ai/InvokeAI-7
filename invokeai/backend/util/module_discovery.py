"""Import-for-side-effect discovery of the modules in a package tree.

Two registries in this codebase are filled by importing modules rather than from a hand-maintained
list: node invocations (`invokeai.app.invocations`) and model architectures
(`invokeai.backend.architectures.defs`). Both fail the same way when discovery is subtly wrong —
they find nothing, register nothing, and stay green — so both go through this one function, and its
pitfalls are handled and tested in one place.
"""

import pkgutil
from collections.abc import Iterator
from pathlib import Path


def _reraise(name: str) -> None:
    """Refuse to continue past a subpackage that would not import.

    `pkgutil.walk_packages` swallows such errors by default, which turns "this package's
    `__init__.py` is broken" into "the things it holds quietly do not exist" — the exact failure
    mode a registry filled by import is meant to avoid.
    """
    # `walk_packages` calls this from inside its own `except ImportError`, so the original failure
    # is chained implicitly and the traceback shows the offending file and line above this message.
    # An explicit `raise ... from` would need `sys.exc_info()` and would only change the wording.
    raise ImportError(f"Failed to walk package {name!r} while discovering modules.")


def _holds_modules(directory: Path) -> bool:
    """Whether `directory` contains any module that discovery would be expected to reach.

    Ignores `_`-prefixed path components, so a stale `__pycache__` does not make an ordinary data
    directory look like a package someone forgot to finish.
    """
    return any(
        not any(part.startswith("_") for part in module.relative_to(directory).parts)
        for module in directory.rglob("*.py")
    )


def _orphan_directories(package_dir: Path) -> Iterator[Path]:
    """Directories under `package_dir` that hold modules but have no `__init__.py`.

    `pkgutil.walk_packages` does not descend into such a directory, and says nothing about it: every
    module below it is simply absent from the result, which is indistinguishable from there being
    nothing to find. That is the discovery mistake that actually happens — one `__init__.py`
    forgotten in a new subdirectory — so it is looked for rather than waited for.
    """
    for child in sorted(package_dir.iterdir()):
        if not child.is_dir() or child.name.startswith("_"):
            continue
        if (child / "__init__.py").exists():
            yield from _orphan_directories(child)
        elif _holds_modules(child):
            yield child


def discover_modules(root: Path, prefix: str) -> list[str]:
    """Fully-qualified names of every non-private module in the package tree rooted at `root`.

    `prefix` is the dotted path of the package that lives at `root`, trailing dot included; it is
    what the returned names are prefixed with, and what `walk_packages` uses to import subpackages
    so it can descend into them.

    A path component starting with `_` excludes the module: that covers `__pycache__` and marks a
    module as internal. Packages themselves are skipped — importing them is a side effect of the
    walk, and it is their contents that carry the registrations.

    A directory holding modules but no `__init__.py` raises: `walk_packages` would skip it in
    silence, which is the one discovery failure that produces no symptom at all.

    Names only; importing them is the caller's job. Keeping the two apart is what lets the walk be
    tested against a synthetic tree, which matters because a walker with a bug returns an empty list
    and no test that merely asserts "some modules were found" would notice.
    """
    orphans = [d.relative_to(root).as_posix() for d in _orphan_directories(root)]
    if orphans:
        raise ImportError(
            f"These directories under {root} hold modules but no __init__.py, so nothing in them is "
            f"discovered and nothing registers: {', '.join(orphans)}. Add an __init__.py to each, or "
            f"rename it with a leading underscore if it is not meant to be imported."
        )

    names: list[str] = []
    for info in pkgutil.walk_packages([str(root)], prefix=prefix, onerror=_reraise):
        relative = info.name.removeprefix(prefix)
        if info.ispkg or any(part.startswith("_") for part in relative.split(".")):
            continue
        names.append(info.name)
    return names
