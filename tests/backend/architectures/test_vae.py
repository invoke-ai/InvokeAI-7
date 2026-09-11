"""Which VAEs each architecture accepts, and that the loaders agree.

The facts here were duplicated three times before -- once per loader as `ui_model_base`, once in
webv2's VAE picker, once more in its related-models linker -- and all three disagreed. Anima's
loader declared nothing at all while its description named three families; FLUX.2 Klein's offered
FLUX VAEs that crash in `decode()`.
"""

import pytest

from invokeai.app.invocations.baseinvocation import InvocationRegistry
from invokeai.app.services.shared.graph import Graph  # noqa: F401 -- imports every invocation
from invokeai.backend.architectures import generative_bases, get
from invokeai.backend.architectures.facets.latent_space import LatentSpace, LatentSpaceFacet
from invokeai.backend.architectures.facets.vae import VaeCompatibility, VaeFacet, accepts_vae
from invokeai.backend.architectures.registry import require
from invokeai.backend.model_manager.taxonomy import BaseModelType

# The loader that owns each architecture's VAE input. Architectures absent from this map take no
# standalone VAE: the SD family overrides it through model settings instead.
VAE_LOADER = {
    BaseModelType.Anima: "anima_model_loader",
    BaseModelType.Flux: "flux_model_loader",
    BaseModelType.Flux2: "flux2_klein_model_loader",
    BaseModelType.Krea2: "krea2_model_loader",
    BaseModelType.QwenImage: "qwen_image_model_loader",
    BaseModelType.StableDiffusion3: "sd3_model_loader",
    BaseModelType.Wan: "wan_model_loader",
    BaseModelType.ZImage: "z_image_model_loader",
}


def _ui_model_bases() -> dict[str, list[str] | None]:
    out: dict[str, list[str] | None] = {}
    for cls in InvocationRegistry.get_invocation_classes():
        vae = cls.model_json_schema().get("properties", {}).get("vae_model")
        if vae is not None:
            out[cls.get_type()] = vae.get("ui_model_base")
    return out


def test_the_declaration_and_the_loader_agree() -> None:
    """`ui_model_base` is what the UI filters on today; the facet is what it will filter on.

    While both exist they must say the same thing, or a model the graph accepts is hidden -- or
    worse, one it rejects is offered. `ui_model_base` cannot express a channel constraint, so the
    comparison is over bases; the channel rules are checked separately below.
    """
    ui_bases = _ui_model_bases()

    disagreements = []
    for base, node_type in sorted(VAE_LOADER.items(), key=lambda item: item[0].value):
        declared = ui_bases.get(node_type)
        if declared is None:
            continue  # covered by test_every_loader_with_a_vae_input_declares_its_bases

        facet = get(base, VaeFacet)
        accepted = facet.accepted_bases if facet else frozenset({base})
        if {b.value for b in accepted} != set(declared):
            disagreements.append(
                f"{base.value}: facet accepts {sorted(b.value for b in accepted)}, "
                f"{node_type} offers {sorted(declared)}"
            )

    assert disagreements == []


def test_flux2_no_longer_offers_a_vae_that_crashes() -> None:
    """Klein advertised FLUX VAEs. Decoding a FLUX.2 latent with one raises
    `AutoEncoder.decode() got an unexpected keyword argument 'return_dict'` -- the legacy FLUX
    `AutoEncoder` against a 32-channel latent. Verified by generating with it."""
    assert accepts_vae(BaseModelType.Flux2, BaseModelType.Flux2) is True
    assert accepts_vae(BaseModelType.Flux2, BaseModelType.Flux) is False


def test_anima_accepts_the_wan_family_under_each_base_it_registers_as() -> None:
    """One 194-tensor checkpoint, three registrations. All three decode the same latent."""
    for vae_base in (BaseModelType.Anima, BaseModelType.QwenImage):
        assert accepts_vae(BaseModelType.Anima, vae_base) is True, vae_base.value

    assert accepts_vae(BaseModelType.Anima, BaseModelType.Wan, 16) is True
    # TI2V-5B's Wan2.2-VAE is the same class but a 48-channel latent space; it fits nothing else.
    assert accepts_vae(BaseModelType.Anima, BaseModelType.Wan, 48) is False


def test_anima_no_longer_offers_a_flux_vae_that_decodes_to_noise() -> None:
    """Anima denoises in WAN21_16; a FLUX VAE reads the same 16 channels in a different basis.

    `anima_l2i` takes the `FluxAutoEncoder` branch without raising and without the Wan per-channel
    denormalisation the `AutoencoderKLWan` branch applies, so nothing fails and nothing is logged.
    Measured on real weights (`qwenImage_qwenImageVAE.safetensors` vs FLUX `ae.safetensors`,
    512x512, float32) by encoding an image with the Anima VAE and decoding that one latent down
    both production branches:

        Anima VAE vs original   46.18 dB PSNR, 0.0041 MAE, 0.327 max abs
        FLUX VAE  vs original    6.10 dB PSNR, 0.9325 MAE, 2.000 max abs

    Per-channel means move from R +0.858 / G +0.804 / B +0.666 to R +0.156 / G -0.212 / B +0.111 --
    a magenta, moire-patterned image in which the subject is barely discernible. It is not a
    fallback, so it is not offered.
    """
    assert accepts_vae(BaseModelType.Anima, BaseModelType.Flux) is False


def test_an_architecture_without_the_facet_accepts_only_its_own_base() -> None:
    assert accepts_vae(BaseModelType.StableDiffusionXL, BaseModelType.StableDiffusionXL) is True
    assert accepts_vae(BaseModelType.StableDiffusionXL, BaseModelType.Flux) is False


@pytest.mark.parametrize("base", sorted(VAE_LOADER, key=lambda b: b.value))
def test_every_loader_with_a_vae_input_declares_its_bases(base: BaseModelType) -> None:
    """Anima's did not, so nothing constrained its picker and the two frontend copies drifted."""
    assert _ui_model_bases().get(VAE_LOADER[base]) is not None, (
        f"{VAE_LOADER[base]} takes a VAE but declares no `ui_model_base`, so the UI offers every "
        f"VAE ever installed. Declare it, and keep it in step with {base.value}'s VaeFacet."
    )


def _declared_latent_space(base: BaseModelType, latent_channels: int | None) -> LatentSpace | None:
    """The space a VAE registered under `base` decodes, or None if `latent_channels` matches none.

    `latent_channels` narrows only where the base has alternates -- today only `wan`, whose 48 is
    TI2V-5B's Wan2.2-VAE. Everywhere else the base has exactly one space and the field is unused.
    """
    facet = require(base, LatentSpaceFacet)
    if latent_channels is None:
        return facet.primary
    spaces = (facet.primary, *facet.alternates)
    return next((space for space in spaces if space.channels == latent_channels), None)


def test_every_accepted_vae_shares_the_architectures_latent_space() -> None:
    """Compatibility is about the basis, not the channel count, and nothing else enforces that.

    Eight architectures denoise in 16 channels at 8x and their VAEs are still not interchangeable:
    WAN21_16 and FLUX_16 have different `rgb_factors` and only WAN21_16 carries an `rgb_bias`.
    Anima declared `VaeCompatibility(Flux)` and `anima_l2i` decoded it without raising -- 6.10 dB
    PSNR against the correct decode, measured on real weights; see
    `test_anima_no_longer_offers_a_flux_vae_that_decodes_to_noise`.

    There is no exception list. A new entry that fails this is a silently wrong decode, so the fix
    is to drop the entry, not to name it here.
    """

    def _sort_key(entry: VaeCompatibility) -> tuple[str, int]:
        return (entry.base.value, entry.latent_channels or 0)

    violations = []
    for base in generative_bases():
        facet = get(base, VaeFacet)
        if facet is None:
            continue

        own = require(base, LatentSpaceFacet)
        own_spaces = (own.primary, *own.alternates)

        for entry in sorted(facet.accepted, key=_sort_key):
            space = _declared_latent_space(entry.base, entry.latent_channels)
            if space is None:
                violations.append(
                    f"{base.value} accepts {entry.base.value} at {entry.latent_channels} channels, "
                    f"but {entry.base.value} declares no such latent space"
                )
            elif space not in own_spaces:
                violations.append(
                    f"{base.value} denoises in {own.primary.channels}ch/"
                    f"{own.primary.spatial_compression}x but accepts a {entry.base.value} VAE, "
                    f"whose latent space is a different basis of {space.channels}ch/"
                    f"{space.spatial_compression}x"
                )

    assert violations == []


def test_the_facet_is_only_declared_where_it_says_something_new() -> None:
    """A facet repeating "its own base, no constraints" would be noise; `accepts_vae` says that
    already for every architecture without one.

    Wan declares only its own base and is *not* redundant: it carries the channel split that tells
    A14B's 16-channel VAE from TI2V-5B's 48-channel one.
    """
    redundant = []
    for base in generative_bases():
        facet = get(base, VaeFacet)
        if facet is None:
            continue
        says_nothing_new = facet.accepted_bases == frozenset({base}) and all(
            entry.latent_channels is None for entry in facet.accepted
        )
        if says_nothing_new:
            redundant.append(base.value)

    assert redundant == []
