"""The latent-space facet: the projection maths, and what each architecture declares."""

import torch

from invokeai.backend.architectures import generative_bases, resolve_latent_space
from invokeai.backend.architectures.facets.latent_space import (
    SDXL_4,
    WAN21_16,
    WAN22_48,
    LatentSpace,
    LatentSpaceFacet,
)
from invokeai.backend.architectures.registry import get
from invokeai.backend.model_manager.taxonomy import BaseModelType


class TestProjection:
    def test_a_known_pixel(self) -> None:
        """One reference value, written down rather than recomputed.

        The previous version of this test derived its expectation by summing the columns of the very
        matrix under test, which made it a tautology: any change to the matrix changed both sides
        and the test stayed green. Its docstring claimed 0.3677/0.4577/0.9101 for these column sums;
        the real values are 0.3887/0.8771/1.3152, and nothing noticed for as long as it existed.

        A 1x16x1x1 tensor of ones projects to the column sums of WAN21, plus the bias, mapped from
        -1..1 to 0..255.
        """
        assert WAN21_16.preview(torch.ones(1, 16, 1, 1)).getpixel((0, 0)) == (153, 228, 252)

    def test_a_zero_sample_shows_the_bias(self) -> None:
        assert WAN21_16.preview(torch.zeros(1, 16, 1, 1)).getpixel((0, 0)) == (104, 116, 84)

    def test_the_preview_is_one_pixel_per_latent(self) -> None:
        assert WAN21_16.preview(torch.zeros(1, 16, 5, 7)).size == (7, 5)

    def test_a_sample_without_a_batch_dimension_is_accepted(self) -> None:
        assert WAN21_16.preview(torch.randn(16, 4, 4)).size == (4, 4)

    def test_a_uniform_sample_gives_a_uniform_preview(self) -> None:
        image = WAN21_16.preview(torch.zeros(1, 16, 3, 3))
        pixels = [image.getpixel((x, y)) for y in range(3) for x in range(3)]
        assert all(p == pixels[0] for p in pixels)

    def test_the_smoothing_kernel_changes_the_result(self) -> None:
        """SDXL is the only space with one; without this, dropping it would go unnoticed."""
        unsmoothed = LatentSpace(channels=4, spatial_compression=8, rgb_factors=SDXL_4.rgb_factors)
        sample = torch.randn(1, 4, 8, 8)
        torch.manual_seed(0)
        assert SDXL_4.preview(sample).tobytes() != unsmoothed.preview(sample).tobytes()


class TestResolution:
    def test_wan_picks_its_space_by_channel_count(self) -> None:
        """A14B and TI2V-5B are one `BaseModelType`; only the loaded checkpoint tells them apart."""
        assert resolve_latent_space(BaseModelType.Wan, torch.zeros(1, 16, 4, 4)) is WAN21_16
        assert resolve_latent_space(BaseModelType.Wan, torch.zeros(1, 48, 4, 4)) is WAN22_48

    def test_an_unknown_channel_count_falls_back_to_the_primary(self) -> None:
        assert resolve_latent_space(BaseModelType.Wan, torch.zeros(1, 7, 4, 4)) is WAN21_16

    def test_a_single_space_never_looks_at_the_sample(self) -> None:
        """The short circuit, pinned: an architecture with one space must not depend on tensor shape.

        A zero-dimensional tensor has no `shape[-3]`, so reading it would raise here.
        """
        facet = LatentSpaceFacet(WAN21_16)
        assert facet.resolve(torch.empty(0)) is WAN21_16


class TestWhatArchitecturesDeclare:
    def test_every_architecture_declares_a_latent_space(self) -> None:
        """`REQUIRED = True` makes `validate()` enforce this at boot; this says what it means."""
        undeclared = sorted(b.value for b in generative_bases() if get(b, LatentSpaceFacet) is None)
        assert undeclared == []

    def test_each_matrix_has_one_row_per_channel(self) -> None:
        """A projection that disagrees with its own channel count fails only at generation time."""
        wrong = [
            (b.value, space.channels, len(space.rgb_factors))
            for b in generative_bases()
            for facet in [get(b, LatentSpaceFacet)]
            if facet is not None
            for space in (facet.primary, *facet.alternates)
            if len(space.rgb_factors) != space.channels or any(len(row) != 3 for row in space.rgb_factors)
        ]
        assert wrong == []

    def test_no_two_declared_spaces_hold_the_same_matrix(self) -> None:
        """Three byte-identical Wan 2.1 matrices lived under three names before the merge.

        Duplicates are how a projection gets fixed in one place and stays wrong in two others, so
        this fails the next time one is pasted rather than shared.
        """
        spaces: list[LatentSpace] = []
        for base in generative_bases():
            facet = get(base, LatentSpaceFacet)
            assert facet is not None
            for space in (facet.primary, *facet.alternates):
                if space not in spaces:
                    spaces.append(space)
        matrices = [tuple(tuple(row) for row in s.rgb_factors) for s in spaces]
        assert len(set(matrices)) == len(matrices)

    def test_the_shared_spaces_are_actually_shared(self) -> None:
        """Sharing is by identity, not by an equal copy — the point of naming the spaces."""
        for base in (BaseModelType.QwenImage, BaseModelType.Krea2, BaseModelType.Anima, BaseModelType.Wan):
            facet = get(base, LatentSpaceFacet)
            assert facet is not None and facet.primary is WAN21_16, base.value

    def test_only_wan_has_alternates(self) -> None:
        """Every other architecture stays independent of what shape its latents happen to be."""
        with_alternates = sorted(
            b.value for b in generative_bases() if (f := get(b, LatentSpaceFacet)) is not None and f.alternates
        )
        assert with_alternates == ["wan"]
