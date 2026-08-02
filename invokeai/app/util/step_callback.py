from math import floor
from typing import Callable, TypeAlias

from PIL import Image

from invokeai.app.services.session_processor.session_processor_common import CanceledException
from invokeai.backend.architectures import resolve_latent_space
from invokeai.backend.model_manager.taxonomy import BaseModelType
from invokeai.backend.stable_diffusion.diffusers_pipeline import PipelineIntermediateState


def calc_percentage(intermediate_state: PipelineIntermediateState) -> float:
    """Calculate the percentage of completion of denoising."""

    step = intermediate_state.step
    total_steps = intermediate_state.total_steps
    order = intermediate_state.order

    if total_steps == 0:
        return 0.0
    if order == 2:
        # Prevent division by zero when total_steps is 1 or 2
        denominator = floor(total_steps / 2)
        if denominator == 0:
            return 0.0
        return floor(step / 2) / denominator
    # order == 1
    return step / total_steps


SignalProgressFunc: TypeAlias = Callable[[str, float | None, Image.Image | None, tuple[int, int] | None], None]


def diffusion_step_callback(
    signal_progress: SignalProgressFunc,
    intermediate_state: PipelineIntermediateState,
    base_model: BaseModelType,
    is_canceled: Callable[[], bool],
) -> None:
    if is_canceled():
        raise CanceledException

    # Some schedulers report not only the noisy latents at the current timestep,
    # but also their estimate so far of what the de-noised latents will be. Use
    # that estimate if it is available.
    if intermediate_state.predicted_original is not None:
        sample = intermediate_state.predicted_original
    else:
        sample = intermediate_state.latents

    # The projection factors and the spatial scale are two halves of one fact, and used to be
    # selected by two separate dispatches over base_model -- both of which had to agree about Wan's
    # 16- vs 48-channel VAE. Resolving one latent space settles both.
    latent_space = resolve_latent_space(base_model, sample)
    image = latent_space.preview(sample)

    width = image.width * latent_space.spatial_compression
    height = image.height * latent_space.spatial_compression
    percentage = calc_percentage(intermediate_state)

    signal_progress("Denoising", percentage, image, (width, height))
