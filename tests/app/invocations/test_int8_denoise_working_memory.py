"""The per-forward int8 dequant transient has to reach `model_on_device()`.

`Int8ConvrotLinear` keeps its weight int8 and materializes the dequantized, derotated weight per
forward. That allocation is not part of the model's resident size, so unless the node asks the
cache to hold room for it, the cache is free to pack the device with weights right up to the
default working memory and the first forward competes with what it just placed.

`peak_int8_dequant_transient_bytes` is unit-tested next to the module it belongs to. What is
pinned here is the wire: deleting the `working_mem_bytes=` argument from the node leaves every
other test green. Z-Image only -- MiniMax H3 adds the same term; reaching its `model_on_device()` call needs a packed sequence.
Krea-2's wiring is pinned separately, in `tests/app/invocations/test_krea2_denoise.py`.
"""

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
import torch

from invokeai.app.invocations.fields import ZImageConditioningField
from invokeai.app.invocations.z_image_denoise import ZImageDenoiseInvocation
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelFormat, ModelType
from invokeai.backend.quantization.int8_convrot import CONVROT_GROUP_SIZE, Int8ConvrotLinear


class _StopBeforeLoad(Exception):
    """Raised out of the mocked `model_on_device()` so the node stops at the reservation."""


def _int8_model(out_features: int, in_features: int) -> torch.nn.Module:
    model = torch.nn.Module()
    model.proj = Int8ConvrotLinear(
        torch.zeros(out_features, in_features, dtype=torch.int8),
        torch.ones(out_features, 1),
        convrot=False,
    )
    return model


class TestZImage:
    """Z-Image has no activation estimate, so the transient is the whole request; the cache floors
    it at `device_working_mem_gb`, which is what covers activations there."""

    def _reserved_by(self, transformer: torch.nn.Module) -> int:
        from invokeai.backend.stable_diffusion.diffusion.conditioning_data import (
            ConditioningFieldData,
            ZImageConditioningInfo,
        )

        transformer_info = MagicMock()
        transformer_info.model = transformer
        transformer_info.model_on_device = MagicMock(side_effect=_StopBeforeLoad)

        context = MagicMock()
        context.models.load.return_value = transformer_info
        context.models.get_config.return_value = SimpleNamespace(
            base=BaseModelType.ZImage, type=ModelType.Main, format=ModelFormat.Checkpoint
        )
        context.conditioning.load.return_value = ConditioningFieldData(
            conditionings=[ZImageConditioningInfo(prompt_embeds=torch.zeros(1, 8, 2560))]
        )

        invocation = ZImageDenoiseInvocation.model_construct(
            latents=None,
            noise=None,
            denoise_mask=None,
            denoising_start=0.0,
            denoising_end=1.0,
            add_noise=True,
            transformer=MagicMock(transformer=MagicMock(), loras=[]),
            positive_conditioning=ZImageConditioningField(conditioning_name="pos"),
            negative_conditioning=None,
            control=None,
            vae=None,
            guidance_scale=1.0,
            width=256,
            height=256,
            steps=2,
            scheduler="euler",
            seed=0,
            cfg_scale_start_step=0,
            cfg_scale_end_step=-1,
        )

        with (
            patch(
                "invokeai.app.invocations.z_image_denoise.TorchDevice.choose_torch_device",
                return_value=torch.device("cpu"),
            ),
            patch(
                "invokeai.app.invocations.z_image_denoise.TorchDevice.choose_bfloat16_safe_dtype",
                return_value=torch.bfloat16,
            ),
            patch.object(ZImageDenoiseInvocation, "_get_noise", return_value=torch.zeros(1, 16, 32, 32)),
            pytest.raises(_StopBeforeLoad),
        ):
            invocation._run_diffusion(context)

        transformer_info.model_on_device.assert_called_once()
        return transformer_info.model_on_device.call_args.kwargs["working_mem_bytes"]

    def test_the_transient_reaches_the_model_cache(self) -> None:
        """Two weight-sized bf16 tensors of the largest int8 layer."""
        reserved = self._reserved_by(_int8_model(1024, CONVROT_GROUP_SIZE))

        assert reserved == 2 * 1024 * CONVROT_GROUP_SIZE * torch.bfloat16.itemsize

    def test_an_unquantized_transformer_asks_for_nothing_extra(self) -> None:
        """Zero falls through the cache's `or`, leaving the configured default exactly as before."""
        dense = torch.nn.Module()
        dense.proj = torch.nn.Linear(CONVROT_GROUP_SIZE, 8)

        assert self._reserved_by(dense) == 0
