"""Ideal Size computes from what the architecture declares, not from a list of six bases."""

import math
from types import SimpleNamespace
from typing import Any
from unittest.mock import MagicMock

import pytest

from invokeai.app.invocations.ideal_size import IdealSizeInvocation
from invokeai.app.invocations.model import ModelIdentifierField, UNetField
from invokeai.backend.architectures import ArchitectureError, generative_bases, resolve_default_settings
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType


def _unet(base: BaseModelType) -> UNetField:
    """A UNetField the node can hold. Only `unet.key` is read, and only to look up the config."""
    identifier = ModelIdentifierField(key="test", hash="test", name="test", base=base, type=ModelType.Main)
    return UNetField(unet=identifier, scheduler=identifier, loras=[])


def _invoke(base: BaseModelType, width: int = 1024, height: int = 576, multiplier: float = 1.0) -> Any:
    node = IdealSizeInvocation(width=width, height=height, multiplier=multiplier, unet=_unet(base))
    context = MagicMock()
    context.models.get_config.return_value = SimpleNamespace(base=base)
    return node.invoke(context)


@pytest.mark.parametrize(
    ("base", "expected"),
    [
        # The six the old if/elif covered, at the aspect ratio of the node's own defaults.
        (BaseModelType.StableDiffusion1, (680, 384)),
        (BaseModelType.StableDiffusion2, (1024, 576)),
        (BaseModelType.StableDiffusionXL, (1360, 768)),
    ],
)
def test_the_previously_supported_bases_are_unchanged(base: BaseModelType, expected: tuple[int, int]) -> None:
    """SD 1.x, 2.x and XL have an 8-pixel grid, which is what the old hardcoded value was."""
    output = _invoke(base)
    assert (output.width, output.height) == expected


def test_flux_now_lands_on_its_own_grid() -> None:
    """The old code trimmed to 8 for every architecture. FLUX needs 16, so a size could come back
    off-grid — the node would hand the graph a width the denoise node then rejects."""
    output = _invoke(BaseModelType.Flux)
    assert output.width % 16 == 0 and output.height % 16 == 0


def test_every_architecture_gets_an_answer() -> None:
    """The old dispatch raised `Unsupported model type` for nine of the sixteen — at generation
    time, after the model had loaded."""
    failed = []
    for base in generative_bases():
        settings = resolve_default_settings(base)
        if settings is None or settings.width is None:
            continue  # the refiner, which declares a canvas but is not run on its own
        try:
            _invoke(base)
        except Exception as exc:  # noqa: BLE001 - the point is that nothing raises
            failed.append(f"{base.value}: {type(exc).__name__}")
    assert failed == []


def test_the_result_stays_on_the_declared_grid_for_every_architecture() -> None:
    from invokeai.backend.architectures import FeaturesFacet, require

    off_grid = []
    for base in generative_bases():
        settings = resolve_default_settings(base)
        if settings is None or settings.width is None:
            continue
        grid = require(base, FeaturesFacet).dimension_grid
        output = _invoke(base)
        if output.width % grid or output.height % grid:
            off_grid.append(f"{base.value}: {output.width}x{output.height} not a multiple of {grid}")
    assert off_grid == []


def test_an_architecture_without_dimensions_says_so() -> None:
    """The SDXL refiner declares a canvas; nothing declares none today, so this pins the message
    rather than a current state."""
    with pytest.raises(ArchitectureError, match="no default dimensions"):
        node = IdealSizeInvocation(width=1024, height=576, unet=_unet(BaseModelType.Any))
        context = MagicMock()
        context.models.get_config.return_value = SimpleNamespace(base=BaseModelType.Any)
        node.invoke(context)


def test_the_multiplier_still_scales_the_area() -> None:
    single = _invoke(BaseModelType.StableDiffusionXL)
    doubled = _invoke(BaseModelType.StableDiffusionXL, multiplier=2.0)
    assert doubled.width > single.width
    assert math.isclose(doubled.width / single.width, 2.0, rel_tol=0.02)
