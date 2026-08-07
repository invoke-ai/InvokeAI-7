#!/usr/bin/env python
"""Scaffold the per-architecture files a new `BaseModelType` needs, and list what is left by hand.

Adding an architecture used to mean editing ~16 core files, most of which failed at generation time
rather than at boot when forgotten. The architecture registry moved those facts into one file per
architecture; this generates that file, its starter-model module, and the two import lines that make
them load -- then prints the edits that genuinely cannot be generated.

Usage:

    python scripts/new_architecture.py --enum-name NewModel --enum-value new-model
    python scripts/new_architecture.py --enum-name NewModel --enum-value new-model --write

Without ``--write`` it only reports what it would do.

The rendering functions are the testable part; `tests/test_new_architecture_scaffold.py` checks them
against the fifteen architectures that already exist, so this cannot drift from what the registry
actually expects.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
ARCHITECTURES_INIT = REPO_ROOT / "invokeai" / "backend" / "architectures" / "__init__.py"
STARTER_MODELS_INIT = REPO_ROOT / "invokeai" / "backend" / "model_manager" / "starter_models" / "__init__.py"


def module_name(enum_value: str) -> str:
    """The module stem for an architecture: its enum *value*, dashes to underscores.

    Derived rather than chosen, so `registry.defs_module_path()` and this script cannot disagree
    about where a definition lives.
    """
    return enum_value.replace("-", "_")


def render_defs_module(enum_name: str, enum_value: str) -> str:
    """`invokeai/backend/architectures/defs/<module>.py`.

    Both required facets are present but obviously unfinished: `validate()` refuses to start the app
    while either is missing, so leaving them out would only move the error later.
    """
    return f"""from invokeai.backend.architectures.facets.conditioning import ConditioningFacet
from invokeai.backend.architectures.facets.latent_space import LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

# TODO({enum_value}): replace the two placeholders below.
#
#   LatentSpaceFacet   - reuse an existing LatentSpace from facets/latent_space.py if this
#                        architecture shares a VAE with one that already ships (most do: eleven of
#                        the fifteen introduce no new preview data at all). Only add a new one if
#                        the channel count or the projection factors genuinely differ.
#   ConditioningFacet  - the *ConditioningInfo dataclass this architecture's text encoder puts in a
#                        ConditioningFieldData. Add it to conditioning_data.py and to the
#                        `conditionings` union there; the safe_globals allowlist is derived from
#                        this registration, so nothing else needs updating.
#
# Optional facets, only if they apply:
#   VariantFacet({{ModelType.Main: {enum_name}VariantType}})  - if the architecture has variants
#   LoaderFlagsFacet(supports_fp8_storage=False)      - only to opt out of a general loader rule
#   UNetDownscaleFacet(max_unet_downscale=8)          - UNet architectures with T2I-Adapter support

register(
    BaseModelType.{enum_name},
    LatentSpaceFacet(...),
    ConditioningFacet(...),
)
"""


def render_starter_models_module(enum_name: str, enum_value: str) -> str:
    """`invokeai/backend/model_manager/starter_models/<module>.py`."""
    return f'''"""Starter models for the {enum_value} architecture."""

from invokeai.backend.model_manager.starter_models.types import StarterModel
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType

# Shared components -- encoders, and VAEs used by more than one architecture -- belong in
# `common.py`, not here. Import them from there; `dependencies` holds object references, so an
# unknown name is an ImportError rather than a broken install.

{module_name(enum_value)}_main = StarterModel(
    name="TODO",
    base=BaseModelType.{enum_name},
    source="TODO/repo-id",
    description="TODO. ~0GB",
    type=ModelType.Main,
)
'''


def defs_import_line(enum_value: str) -> str:
    """The line `architectures/__init__.py` must contain for this architecture to register."""
    return f"    {module_name(enum_value)},  # noqa: F401"


def starter_import_line(enum_value: str) -> str:
    """The import `starter_models/__init__.py` must contain to reach the new entries."""
    return f"from invokeai.backend.model_manager.starter_models.{module_name(enum_value)} import ("


RESIDUAL_EDITS = [
    (
        "invokeai/backend/model_manager/taxonomy.py",
        "Add the `BaseModelType` member. If the architecture has variants, add its variant enum too, "
        "and widen `AnyVariant` plus both halves of `variant_type_adapter` -- CI checks all three "
        "against the registry, and checks that variant *values* stay globally unique.",
    ),
    (
        "invokeai/app/services/model_records/model_records_base.py",
        "Widen `ModelRecordChanges.variant` with the new variant enum. Same CI check as above.",
    ),
    (
        "invokeai/backend/model_manager/configs/main.py (and lora.py / vae.py / controlnet.py)",
        "Add the config classes and their probes. This is also where `MainModelDefaultSettings."
        "from_base` gains a case if the architecture needs non-default steps/CFG.",
    ),
    (
        "invokeai/backend/model_manager/configs/factory.py",
        "Add the config classes to the `AnyModelConfig` union. Deliberately explicit: a dynamically "
        "built union loses type information in IDEs.",
    ),
    (
        "invokeai/backend/stable_diffusion/diffusion/conditioning_data.py",
        "Add the `*ConditioningInfo` dataclass and list it in the `conditionings` union. The "
        "`safe_globals` allowlist is derived from the registry, so there is nothing to update in "
        "dependencies.py -- but CI asserts the union and the registry agree.",
    ),
    (
        "invokeai/app/invocations/metadata.py",
        "Add the `GENERATION_MODES` literals. These strings are persisted in image metadata and "
        "cannot be changed later.",
    ),
    (
        "invokeai/backend/model_manager/starter_models/__init__.py",
        "Import the new module, add the entries to `STARTER_MODELS` where they should appear -- that "
        "order is what the model manager shows and is not sorted -- and add a bundle if the "
        "architecture ships one.",
    ),
    (
        "invokeai/backend/model_manager/configs/lora.py",
        "If the architecture has LoRAs: add the probe, including the negative clauses that keep other "
        "architectures' probes from matching it. Known wart, out of scope of the registry.",
    ),
    (
        "invokeai/invocation_api/__init__.py",
        "Export the new `*ConditioningInfo` so custom nodes can build conditioning. CI checks this "
        "against the registry.",
    ),
]


def _insert_sorted(source: str, line: str, block_start: str) -> str:
    """Insert `line` into the alphabetically sorted import block beginning at `block_start`."""
    lines = source.splitlines()
    try:
        start = next(i for i, text in enumerate(lines) if text.startswith(block_start))
    except StopIteration as exc:
        raise SystemExit(f"could not find the import block starting with {block_start!r}") from exc
    end = next(i for i in range(start, len(lines)) if lines[i].rstrip() == ")")
    body = lines[start + 1 : end]
    if any(entry.strip() == line.strip() for entry in body):
        return source
    body = sorted([*body, line], key=lambda text: text.strip().lstrip("#").strip())
    return "\n".join([*lines[: start + 1], *body, *lines[end:]]) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--enum-name", required=True, help="the BaseModelType member name, e.g. ZImage")
    parser.add_argument("--enum-value", required=True, help="its value, e.g. z-image")
    parser.add_argument("--write", action="store_true", help="write the files instead of only reporting")
    args = parser.parse_args(argv)

    if not re.fullmatch(r"[A-Z][A-Za-z0-9]*", args.enum_name):
        raise SystemExit(f"--enum-name must be a CamelCase identifier, got {args.enum_name!r}")
    if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", args.enum_value):
        raise SystemExit(f"--enum-value must be lowercase with dashes, got {args.enum_value!r}")

    stem = module_name(args.enum_value)
    targets = {
        REPO_ROOT / "invokeai" / "backend" / "architectures" / "defs" / f"{stem}.py": render_defs_module(
            args.enum_name, args.enum_value
        ),
        REPO_ROOT / "invokeai" / "backend" / "model_manager" / "starter_models" / f"{stem}.py": (
            render_starter_models_module(args.enum_name, args.enum_value)
        ),
    }

    for path, content in targets.items():
        rel = path.relative_to(REPO_ROOT).as_posix()
        if path.exists():
            print(f"  exists, left alone   {rel}")
            continue
        print(f"  {'write' if args.write else 'would write'}  {rel}")
        if args.write:
            path.write_text(content, encoding="utf-8")

    init_edit = (
        ARCHITECTURES_INIT,
        defs_import_line(args.enum_value),
        "from invokeai.backend.architectures.defs import",
    )
    path, line, block = init_edit
    rel = path.relative_to(REPO_ROOT).as_posix()
    updated = _insert_sorted(path.read_text(encoding="utf-8"), line, block)
    if updated == path.read_text(encoding="utf-8"):
        print(f"  already imported     {rel}")
    else:
        print(f"  {'patch' if args.write else 'would patch'}  {rel}  ->  {line.strip()}")
        if args.write:
            path.write_text(updated, encoding="utf-8")

    print("\nStill to do by hand -- these cannot be generated:\n")
    for target, why in RESIDUAL_EDITS:
        print(f"  {target}\n      {why}\n")
    print("Then run:  pytest tests/backend/architectures  --  it will name anything still missing.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
