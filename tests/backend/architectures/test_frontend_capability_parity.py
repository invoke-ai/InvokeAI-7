"""The architecture declarations and webv2's own table must state the same facts.

`FeaturesFacet` and `BASE_GENERATION` describe the same architectures: the dimension grid, the
scheduler family and whether the choice reaches the graph, what the guidance slider is called,
whether the negative prompt is shown and used, and which UI affordances exist. The frontend copy is
the one that ships behaviour today; the backend copy is what `GET /api/v2/models/capabilities`
serves to whatever consumes it next.

Neither side can see the other, so they drift in silence. ERNIE-Image shipped with
`scheduler_applies_to_graph` defaulting to `False` on the backend while webv2 said `true` and really
did pass the scheduler into `ernie_image_denoise` — sixteen declarations, one wrong field, nothing
red. Transcribing the frontend's values into assertions here would not have caught it either: the
transcription is the step that goes stale.

So the frontend writes its table out (`capabilityContract.test.ts`, regenerate with `vitest -u`) and
this reads it. Same shape as `tests/app/invocations/test_frontend_graph_node_types.py`, which does
it for node types.

Deliberately not compared: `defaults` and `dimensions.optimalSide`. Those differ by design — the
backend's numbers are per-model card values delivered through `default_settings`, the frontend's are
the fallback shown when no model is selected — so the contract does not record them.
"""

import json
from pathlib import Path
from typing import Any

import pytest

from invokeai.backend.architectures import generative_bases
from invokeai.backend.architectures.facets.features import FeaturesFacet
from invokeai.backend.architectures.registry import require
from invokeai.backend.model_manager.taxonomy import BaseModelType

CONTRACT_PATH = (
    Path(__file__).parents[3]
    / "invokeai"
    / "frontend"
    / "webv2"
    / "src"
    / "features"
    / "generation"
    / "core"
    / "__snapshots__"
    / "baseGenerationCapabilities.json"
)

BY_BASE: dict[str, dict[str, Any]] = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))["byBase"]


def _declared(base_value: str) -> FeaturesFacet:
    return require(BaseModelType(base_value), FeaturesFacet)


def test_the_contract_covers_bases_that_exist() -> None:
    """A base webv2 offers but the registry does not know is a broken generation path, and a
    shrunken contract would make every other test in this module vacuous — the per-base checks are
    parametrized over this file, so a truncated one takes the assertions with it rather than
    failing.

    14 is the current length of webv2's `BASE_GENERATION`; a new architecture updates this number
    and the file in the same commit.
    """
    assert len(BY_BASE) == 14, (
        f"{CONTRACT_PATH.name} records {len(BY_BASE)} bases, not 14; regenerate it with `vitest -u` "
        f"and update this count if webv2 really gained or dropped an architecture."
    )

    registered = {base.value for base in generative_bases()}
    assert sorted(set(BY_BASE) - registered) == []
    # The other direction is not an error, but it has to be a reviewable line: these two are the
    # only architectures nothing in this module checks, because webv2 has no generation path for
    # them. MiniMax H3 is video-first with its own hardcoded schedules, and the SDXL refiner is a
    # second pass rather than a model you generate with.
    assert sorted(registered - set(BY_BASE)) == ["minimax-h3", "sdxl-refiner"]


@pytest.mark.parametrize("base_value", sorted(BY_BASE))
def test_the_declaration_matches_the_frontend_table(base_value: str) -> None:
    features = _declared(base_value)
    frontend = BY_BASE[base_value]

    declared = {
        "dimensionGrid": features.dimension_grid,
        "guidanceLabel": features.guidance_label,
        "negativePrompt": {
            "visible": features.negative_prompt.visible,
            "usage": features.negative_prompt.usage,
        },
        "schedulerAppliesToGraph": features.scheduler_applies_to_graph,
        "schedulerSet": features.scheduler_set,
        "ui": {
            "cfgRescale": features.supports_cfg_rescale,
            "clipSkipMax": features.clip_skip_max,
            "colorCompensation": features.color_compensation,
            "sdVaeOverride": features.sd_vae_override,
            "seamless": features.supports_seamless,
            "vaePrecision": features.vae_precision,
        },
    }

    assert declared == frontend, (
        f"'{base_value}' disagrees with webv2. Whichever side is wrong, both have to say the same "
        f"thing: invokeai/backend/architectures/defs/ and baseGenerationPolicies.ts."
    )
