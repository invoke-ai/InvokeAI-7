"""The latent-space data, pinned against what the dispatch chain in step_callback.py used to select.

The reference table below is the point of this file. Each row was read off the pre-registry
`elif` chain, and together they are what makes moving that data provably behaviour-preserving.

Fingerprints rather than 600 lines of copied matrices: the per-column sums are plain IEEE-754
addition in a fixed order, so they are exact and platform-independent, and the first and last rows
catch a reordering that a column sum is blind to.
"""

from dataclasses import dataclass

import pytest
import torch
from PIL import Image

from invokeai.backend.architectures import generative_bases, get_latent_space, require, resolve_latent_space
from invokeai.backend.architectures.facets.latent_space import (
    LatentSpace,
    LatentSpaceFacet,
    sample_to_lowres_estimated_image,
)
from invokeai.backend.model_manager.taxonomy import BaseModelType

# The closed set. A new name here means a genuinely new VAE geometry, not a new architecture.
LATENT_SPACE_NAMES = {"SD15_4", "SDXL_4", "SD3_16", "COGVIEW4_16", "FLUX_16", "WAN21_16", "FLUX2_32", "WAN22_48"}


@dataclass(frozen=True)
class Expected:
    space: str
    channels: int
    spatial_compression: int
    has_bias: bool
    has_smooth: bool
    first_row: list[float]
    last_row: list[float]


# base -> what step_callback.py's chain selected for it before the registry existed.
REFERENCE = {
    BaseModelType.StableDiffusion1: Expected(
        "SD15_4", 4, 8, False, False, [0.3444, 0.1385, 0.0670], [-0.1307, -0.1874, -0.7445]
    ),
    BaseModelType.StableDiffusion2: Expected(
        "SD15_4", 4, 8, False, False, [0.3444, 0.1385, 0.0670], [-0.1307, -0.1874, -0.7445]
    ),
    BaseModelType.StableDiffusionXL: Expected(
        "SDXL_4", 4, 8, False, True, [0.3816, 0.4930, 0.5320], [-0.4350, -0.2644, -0.4289]
    ),
    BaseModelType.StableDiffusionXLRefiner: Expected(
        "SDXL_4", 4, 8, False, True, [0.3816, 0.4930, 0.5320], [-0.4350, -0.2644, -0.4289]
    ),
    BaseModelType.StableDiffusion3: Expected(
        "SD3_16", 16, 8, False, False, [-0.05240681, 0.03251581, 0.0749016], [-0.03392309, -0.0804029, -0.06078822]
    ),
    BaseModelType.CogView4: Expected(
        "COGVIEW4_16",
        16,
        8,
        False,
        False,
        [0.00408832, -0.00082485, -0.00214816],
        [-0.00955853, -0.00980067, -0.00977842],
    ),
    BaseModelType.Flux: Expected(
        "FLUX_16", 16, 8, False, False, [-0.0412, 0.0149, 0.0521], [-0.1146, -0.0827, -0.0598]
    ),
    BaseModelType.ZImage: Expected(
        "FLUX_16", 16, 8, False, False, [-0.0412, 0.0149, 0.0521], [-0.1146, -0.0827, -0.0598]
    ),
    BaseModelType.QwenImage: Expected(
        "WAN21_16", 16, 8, True, False, [-0.1299, -0.1692, 0.2932], [0.1984, 0.0913, 0.1861]
    ),
    BaseModelType.Krea2: Expected("WAN21_16", 16, 8, True, False, [-0.1299, -0.1692, 0.2932], [0.1984, 0.0913, 0.1861]),
    BaseModelType.Anima: Expected("WAN21_16", 16, 8, True, False, [-0.1299, -0.1692, 0.2932], [0.1984, 0.0913, 0.1861]),
    BaseModelType.Wan: Expected("WAN21_16", 16, 8, True, False, [-0.1299, -0.1692, 0.2932], [0.1984, 0.0913, 0.1861]),
    BaseModelType.Flux2: Expected(
        "FLUX2_32", 32, 8, True, False, [0.0058, 0.0113, 0.0073], [-0.0111, -0.0460, -0.0614]
    ),
    BaseModelType.ErnieImage: Expected(
        "FLUX2_32", 32, 8, True, False, [0.0058, 0.0113, 0.0073], [-0.0111, -0.0460, -0.0614]
    ),
    # Ideogram 4 had no branch in the chain -- it drives its own preview loop -- but it inlined the
    # FLUX.2 factors and a hardcoded x8, which is this row.
    BaseModelType.Ideogram4: Expected(
        "FLUX2_32", 32, 8, True, False, [0.0058, 0.0113, 0.0073], [-0.0111, -0.0460, -0.0614]
    ),
}

WAN21_BIAS = [-0.1835, -0.0868, -0.3360]
FLUX2_BIAS = [-0.0329, -0.0718, -0.0851]
WAN22_BIAS = [0.0317, -0.0878, -0.1388]


def _column_sums(factors: list[list[float]]) -> list[float]:
    return [round(sum(row[c] for row in factors), 9) for c in range(3)]


def test_the_reference_table_covers_every_architecture() -> None:
    assert set(REFERENCE) == set(generative_bases())


@pytest.mark.parametrize("base", sorted(REFERENCE, key=lambda b: b.value))
def test_latent_space_matches_the_pre_registry_dispatch(base: BaseModelType) -> None:
    expected = REFERENCE[base]
    latent_space = get_latent_space(base)

    assert latent_space.name == expected.space
    assert latent_space.channels == expected.channels
    assert latent_space.spatial_compression == expected.spatial_compression
    assert (latent_space.rgb_bias is not None) is expected.has_bias
    assert (latent_space.smooth_matrix is not None) is expected.has_smooth
    assert len(latent_space.rgb_factors) == expected.channels
    assert latent_space.rgb_factors[0] == expected.first_row
    assert latent_space.rgb_factors[-1] == expected.last_row


def test_wan22_matches_the_pre_registry_dispatch() -> None:
    # The only latent space no base uses by default, so it is not in the table above.
    wan22 = resolve_latent_space(BaseModelType.Wan, torch.zeros(1, 48, 4, 4))

    assert wan22.name == "WAN22_48"
    assert wan22.channels == 48
    assert wan22.spatial_compression == 16
    assert wan22.rgb_factors[0] == [0.0119, 0.0103, 0.0046]
    assert wan22.rgb_factors[-1] == [-0.0837, 0.0168, 0.0055]
    assert wan22.rgb_bias == WAN22_BIAS


@pytest.mark.parametrize(
    ("base", "expected_bias"),
    [
        (BaseModelType.QwenImage, WAN21_BIAS),
        (BaseModelType.Krea2, WAN21_BIAS),
        (BaseModelType.Anima, WAN21_BIAS),
        (BaseModelType.Wan, WAN21_BIAS),
        (BaseModelType.Flux2, FLUX2_BIAS),
        (BaseModelType.ErnieImage, FLUX2_BIAS),
        (BaseModelType.Ideogram4, FLUX2_BIAS),
    ],
)
def test_biases_match_the_pre_registry_dispatch(base: BaseModelType, expected_bias: list[float]) -> None:
    assert get_latent_space(base).rgb_bias == expected_bias


@pytest.mark.parametrize(
    ("base", "expected_sums"),
    [
        (BaseModelType.StableDiffusion1, [0.0192, 0.6051, -0.3178]),
        (BaseModelType.StableDiffusionXL, [-0.2517, 0.7505, 0.0722]),
        (BaseModelType.QwenImage, [0.3887, 0.8771, 1.3152]),
    ],
)
def test_column_sums_are_an_exact_fingerprint(base: BaseModelType, expected_sums: list[float]) -> None:
    """Hand-checked totals for three spaces, as a guard against a single edited number.

    Note that the docstring of the test this replaces claimed 0.3677/0.4577/0.9101 for the Wan 2.1
    space. Those numbers were stale: that test recomputed its expectation from the same constants
    it was checking, so it would have passed against a corrupted matrix and nothing ever caught the
    drift. These totals are the real ones.
    """
    assert [round(s, 4) for s in _column_sums(get_latent_space(base).rgb_factors)] == expected_sums


def test_qwen_krea_anima_and_wan_share_one_latent_space_object() -> None:
    """The three byte-identical Wan 2.1 matrices were merged into one; this is the proof.

    Identity, not equality: they must be the same object, or the duplication has crept back.
    """
    spaces = [
        get_latent_space(base)
        for base in (BaseModelType.QwenImage, BaseModelType.Krea2, BaseModelType.Anima, BaseModelType.Wan)
    ]
    assert all(space is spaces[0] for space in spaces)


@pytest.mark.parametrize(
    "bases",
    [
        (BaseModelType.StableDiffusion1, BaseModelType.StableDiffusion2),
        (BaseModelType.StableDiffusionXL, BaseModelType.StableDiffusionXLRefiner),
        (BaseModelType.Flux, BaseModelType.ZImage),
        (BaseModelType.Flux2, BaseModelType.ErnieImage, BaseModelType.Ideogram4),
    ],
)
def test_architectures_sharing_a_latent_space_share_the_object(bases: tuple[BaseModelType, ...]) -> None:
    spaces = [get_latent_space(base) for base in bases]
    assert all(space is spaces[0] for space in spaces)


def test_the_latent_space_set_is_closed() -> None:
    """Every declared latent space, defaults and alternates alike, is one of the eight."""
    names: set[str] = set()
    for base in generative_bases():
        facet = require(base, LatentSpaceFacet)
        names.add(facet.default.name)
        names.update(alternate.name for alternate in facet.alternates)

    assert names == LATENT_SPACE_NAMES


# --- runtime resolution ---------------------------------------------------------------------------


def test_wan_resolves_by_channel_count() -> None:
    assert resolve_latent_space(BaseModelType.Wan, torch.zeros(1, 48, 4, 4)).name == "WAN22_48"
    assert resolve_latent_space(BaseModelType.Wan, torch.zeros(1, 16, 4, 4)).name == "WAN21_16"


def test_wan_falls_back_to_the_default_for_an_unexpected_channel_count() -> None:
    # The pre-registry code was an `if shape[-3] == 48 / else`, so anything not 48 took the A14B
    # branch. That must not become an error.
    assert resolve_latent_space(BaseModelType.Wan, torch.zeros(1, 32, 4, 4)).name == "WAN21_16"


def test_a_single_space_architecture_never_inspects_the_sample() -> None:
    # Only the Wan branch ever read sample.shape[-3]. A rank-2 tensor would raise IndexError if the
    # resolver looked at it unconditionally.
    assert resolve_latent_space(BaseModelType.StableDiffusion1, torch.zeros(2, 2)).name == "SD15_4"


def test_latent_spaces_within_a_facet_must_have_distinct_channel_counts() -> None:
    space = get_latent_space(BaseModelType.Flux)

    with pytest.raises(ValueError, match="selected by channel count"):
        LatentSpaceFacet(space, alternates=(space,))


def test_channel_count_must_match_the_factor_rows() -> None:
    with pytest.raises(ValueError, match="declares 4 channels but carries 1 rgb_factors rows"):
        LatentSpace(name="BROKEN", channels=4, spatial_compression=8, rgb_factors=[[0.0, 0.0, 0.0]])


# --- the projection itself, relocated from tests/app/util/test_step_callback.py -------------------


def test_preview_produces_a_valid_rgb_image() -> None:
    torch.manual_seed(42)
    sample = torch.randn(1, 16, 4, 4)

    image = get_latent_space(BaseModelType.QwenImage).preview(sample)

    assert isinstance(image, Image.Image)
    assert image.size == (4, 4)
    assert image.mode == "RGB"


def test_preview_is_deterministic() -> None:
    sample = torch.ones(1, 16, 2, 2)
    latent_space = get_latent_space(BaseModelType.QwenImage)

    assert latent_space.preview(sample).tobytes() == latent_space.preview(sample).tobytes()


def test_preview_known_value() -> None:
    """Hand-calculated pixel for a 1x16x1x1 tensor of ones, on the Wan 2.1 space.

    latent_image = [1,...,1] @ factors = the column sums, 0.3887 / 0.8771 / 1.3152.
    After bias:        0.2052 / 0.7903 / 0.9792
    After ((x+1)/2):   0.6026 / 0.8952 / 0.9896
    After clamp, *255: 153    / 228    / 252

    Hardcoded on purpose. The test this replaces derived its expectation by summing the very
    matrix under test, which made it a tautology.
    """
    image = get_latent_space(BaseModelType.QwenImage).preview(torch.ones(1, 16, 1, 1))

    assert image.size == (1, 1)
    assert image.getpixel((0, 0)) == (153, 228, 252)


def test_preview_of_zeros_reflects_only_the_bias() -> None:
    latent_space = get_latent_space(BaseModelType.QwenImage)
    assert latent_space.rgb_bias is not None

    image = latent_space.preview(torch.zeros(1, 16, 2, 2))

    pixels = [image.getpixel((x, y)) for y in range(image.height) for x in range(image.width)]
    assert all(pixel == pixels[0] for pixel in pixels)
    assert pixels[0] == tuple(int(max(0.0, min(1.0, (b + 1) / 2)) * 255) for b in latent_space.rgb_bias)


def test_preview_accepts_input_without_a_batch_dimension() -> None:
    image = get_latent_space(BaseModelType.QwenImage).preview(torch.randn(16, 4, 4))

    assert image.size == (4, 4)


def test_preview_applies_the_smooth_matrix_only_where_declared() -> None:
    # SDXL is the only latent space with one, and it must actually change the result.
    sample = torch.zeros(1, 4, 3, 3)
    sample[0, 0, 1, 1] = 4.0
    sdxl = get_latent_space(BaseModelType.StableDiffusionXL)
    assert sdxl.smooth_matrix is not None

    smoothed = sdxl.preview(sample)
    unsmoothed = sample_to_lowres_estimated_image(
        samples=sample,
        latent_rgb_factors=torch.tensor(sdxl.rgb_factors, dtype=sample.dtype),
    )

    assert smoothed.tobytes() != unsmoothed.tobytes()
