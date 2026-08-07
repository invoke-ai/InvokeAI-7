from invokeai.backend.architectures.facets.latent_space import FLUX2_32, LatentSpaceFacet
from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(
    BaseModelType.Ideogram4,
    # Ideogram 4 uses a FLUX.2-style 32-channel VAE. Its denoise loop drives the preview itself
    # rather than going through diffusion_step_callback, because its callback signature is
    # (step, total, packed_latents) and it must unpatchify and denormalize first -- but the latent
    # space it ends up projecting is this one.
    LatentSpaceFacet(FLUX2_32),
)
