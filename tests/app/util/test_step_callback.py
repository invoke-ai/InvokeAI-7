"""End-to-end tests for `diffusion_step_callback`.

The signal this pins is the reported image size: `image.size * spatial_compression`. Before the
registry that factor came from a second dispatch over `base_model`, separate from the one choosing
the projection factors, and the two had to agree about Wan's 16- vs 48-channel VAE by hand. Nothing
covered it.

The projection itself is tested next to the data it uses, in
tests/backend/architectures/test_latent_space.py.
"""

import pytest
import torch
from PIL import Image

from invokeai.app.services.session_processor.session_processor_common import CanceledException
from invokeai.app.util.step_callback import calc_percentage, diffusion_step_callback
from invokeai.backend.architectures import ArchitectureError, generative_bases
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusers_pipeline import PipelineIntermediateState

# base -> (latent channels, expected spatial compression). Read off the pre-registry dispatch
# chain; every base used 8 except Wan's 48-channel TI2V-5B.
CHANNELS_AND_SCALE = {
    BaseModelType.StableDiffusion1: (4, 8),
    BaseModelType.StableDiffusion2: (4, 8),
    BaseModelType.StableDiffusionXL: (4, 8),
    BaseModelType.StableDiffusionXLRefiner: (4, 8),
    BaseModelType.StableDiffusion3: (16, 8),
    BaseModelType.CogView4: (16, 8),
    BaseModelType.Flux: (16, 8),
    BaseModelType.ZImage: (16, 8),
    BaseModelType.QwenImage: (16, 8),
    BaseModelType.Krea2: (16, 8),
    BaseModelType.Anima: (16, 8),
    BaseModelType.Flux2: (32, 8),
    BaseModelType.ErnieImage: (32, 8),
    BaseModelType.Ideogram4: (32, 8),
    BaseModelType.Wan: (16, 8),
}

LATENT_HEIGHT = 4
LATENT_WIDTH = 6


class _Spy:
    def __init__(self) -> None:
        self.calls: list[tuple[str, float | None, Image.Image | None, tuple[int, int] | None]] = []

    def __call__(
        self,
        message: str,
        percentage: float | None = None,
        image: Image.Image | None = None,
        image_size: tuple[int, int] | None = None,
    ) -> None:
        self.calls.append((message, percentage, image, image_size))


def _state(channels: int) -> PipelineIntermediateState:
    return PipelineIntermediateState(
        step=1,
        order=1,
        total_steps=4,
        timestep=0,
        latents=torch.zeros(1, channels, LATENT_HEIGHT, LATENT_WIDTH),
    )


def _run(base: BaseModelType, channels: int) -> _Spy:
    spy = _Spy()
    diffusion_step_callback(
        signal_progress=spy,
        intermediate_state=_state(channels),
        base_model=base,
        is_canceled=lambda: False,
    )
    return spy


def test_the_table_covers_every_architecture() -> None:
    assert set(CHANNELS_AND_SCALE) == set(generative_bases())


@pytest.mark.parametrize("base", sorted(CHANNELS_AND_SCALE, key=lambda b: b.value))
def test_reports_the_image_at_latent_resolution_scaled_by_the_compression(base: BaseModelType) -> None:
    channels, scale = CHANNELS_AND_SCALE[base]

    spy = _run(base, channels)

    assert len(spy.calls) == 1
    message, percentage, image, image_size = spy.calls[0]
    assert message == "Denoising"
    assert percentage == 0.25
    assert image is not None
    assert image.size == (LATENT_WIDTH, LATENT_HEIGHT)
    assert image_size == (LATENT_WIDTH * scale, LATENT_HEIGHT * scale)


def test_wan_switches_to_16x_for_the_48_channel_vae() -> None:
    """The one runtime-resolved case: TI2V-5B's Wan2.2-VAE is 48 channels at 16x, A14B 16 at 8x."""
    _, _, _, a14b_size = _run(BaseModelType.Wan, 16).calls[0]
    _, _, _, ti2v_size = _run(BaseModelType.Wan, 48).calls[0]

    assert a14b_size == (LATENT_WIDTH * 8, LATENT_HEIGHT * 8)
    assert ti2v_size == (LATENT_WIDTH * 16, LATENT_HEIGHT * 16)


def test_predicted_original_is_preferred_over_the_noisy_latents() -> None:
    state = _state(16)
    state.predicted_original = torch.ones(1, 16, 2, 2)

    spy = _Spy()
    diffusion_step_callback(
        signal_progress=spy,
        intermediate_state=state,
        base_model=BaseModelType.Flux,
        is_canceled=lambda: False,
    )

    _, _, image, _ = spy.calls[0]
    assert image is not None
    assert image.size == (2, 2)


def test_cancellation_is_checked_before_anything_else() -> None:
    spy = _Spy()

    with pytest.raises(CanceledException):
        diffusion_step_callback(
            signal_progress=spy,
            intermediate_state=_state(16),
            base_model=BaseModelType.Flux,
            is_canceled=lambda: True,
        )

    assert spy.calls == []


@pytest.mark.parametrize("base", [BaseModelType.Any, BaseModelType.External, BaseModelType.Unknown])
def test_a_non_architecture_base_raises_with_a_fix_it_message(base: BaseModelType) -> None:
    """This replaces `raise ValueError(f"Unsupported base model: {base}")`.

    ArchitectureError is a ValueError, so any caller catching ValueError is unaffected -- but the
    message now names the file to create rather than only the base that failed.
    """
    with pytest.raises(ArchitectureError, match="is not registered") as exc_info:
        _run(base, 16)

    assert "invokeai/backend/architectures/defs/" in str(exc_info.value)
    assert isinstance(exc_info.value, ValueError)


@pytest.mark.parametrize(
    ("step", "order", "total_steps", "expected"),
    [
        (1, 1, 4, 0.25),
        (0, 1, 0, 0.0),
        (2, 2, 4, 0.5),
        (1, 2, 1, 0.0),
    ],
)
def test_calc_percentage(step: int, order: int, total_steps: int, expected: float) -> None:
    state = PipelineIntermediateState(
        step=step, order=order, total_steps=total_steps, timestep=0, latents=torch.zeros(1, 4, 1, 1)
    )

    assert calc_percentage(state) == expected
