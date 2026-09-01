"""Validation-level tests for the MiniMax H3 Ref2VA reference invocations.

No models are loaded: these exercise field construction, kind/cap validation, the
prompt-vs-conditioning signature cross-checks in the denoise node, and the task-variant
guard. The numerics live in tests/backend/minimax_h3/.
"""

from unittest.mock import MagicMock

import pytest
import torch

from invokeai.app.invocations.fields import (
    ImageField,
    MiniMaxH3ConditioningField,
    MiniMaxH3EncodedReferenceField,
    MiniMaxH3ReferenceConditioningField,
    MiniMaxH3ReferenceMediaField,
    VideoField,
)
from invokeai.app.invocations.minimax_h3_denoise import MiniMaxH3DenoiseInvocation
from invokeai.app.invocations.minimax_h3_reference import (
    normalize_reference_list,
    reference_has_audio,
    reference_kind,
    reference_signature_entry,
)
from invokeai.app.invocations.minimax_h3_text_encoder import MiniMaxH3TextEncoderInvocation
from invokeai.app.invocations.model import MiniMaxH3TransformerField, ModelIdentifierField
from invokeai.backend.model_manager.taxonomy import BaseModelType, ModelType
from invokeai.backend.stable_diffusion.diffusion.conditioning_data import MiniMaxH3ConditioningInfo


def _image_ref(name: str = "img.png", detail: str = "max") -> MiniMaxH3ReferenceMediaField:
    return MiniMaxH3ReferenceMediaField(image=ImageField(image_name=name), image_detail=detail)


def _video_ref(name: str = "clip.mp4", conditioning: str = "video_audio") -> MiniMaxH3ReferenceMediaField:
    return MiniMaxH3ReferenceMediaField(video=VideoField(video_name=name), video_conditioning=conditioning)


class TestMediaField:
    def test_kind_mapping(self):
        assert reference_kind(_image_ref()) == "image"
        assert reference_kind(_video_ref()) == "video"
        assert reference_kind(_video_ref(conditioning="video")) == "video"
        assert reference_kind(_video_ref(conditioning="audio")) == "audio"

    def test_has_audio(self):
        assert not reference_has_audio(_image_ref())
        assert reference_has_audio(_video_ref())
        assert not reference_has_audio(_video_ref(conditioning="video"))
        assert reference_has_audio(_video_ref(conditioning="audio"))

    def test_normalize_rejects_both_or_neither_media(self):
        with pytest.raises(ValueError, match="exactly one"):
            normalize_reference_list([MiniMaxH3ReferenceMediaField()])
        with pytest.raises(ValueError, match="exactly one"):
            normalize_reference_list(
                [MiniMaxH3ReferenceMediaField(image=ImageField(image_name="a"), video=VideoField(video_name="b"))]
            )

    def test_normalize_rejects_all_audio(self):
        with pytest.raises(ValueError, match="cannot be used alone"):
            normalize_reference_list([_video_ref(conditioning="audio")])

    def test_normalize_rejects_caps(self):
        with pytest.raises(ValueError, match="At most 3 video"):
            normalize_reference_list([_video_ref(name=f"v{i}.mp4") for i in range(4)])
        with pytest.raises(ValueError, match="At most 9 image"):
            normalize_reference_list([_image_ref(name=f"i{i}.png") for i in range(10)])

    def test_normalize_wraps_single_reference(self):
        assert len(normalize_reference_list(_video_ref())) == 1

    def test_signature_distinguishes_options_and_order_inputs(self):
        base = reference_signature_entry(_video_ref(), None, 124)
        assert reference_signature_entry(_video_ref(conditioning="video"), None, 124) != base
        assert reference_signature_entry(_video_ref(name="other.mp4"), None, 124) != base
        assert reference_signature_entry(_video_ref(), None, 141) != base
        trimmed = _video_ref()
        trimmed.start_frame = 10
        assert reference_signature_entry(trimmed, None, 124) != base
        image = reference_signature_entry(_image_ref(), (2048, 2048), 124)
        assert reference_signature_entry(_image_ref(detail="match"), (2048, 2048), 124) != image
        assert reference_signature_entry(_image_ref(), (1024, 1024), 124) != image


def _transformer_field(variant: str | None) -> MiniMaxH3TransformerField:
    return MiniMaxH3TransformerField(
        transformer=ModelIdentifierField(
            key="t", hash="h", name="T", base=BaseModelType.MiniMaxH3, type=ModelType.Main
        ),
        variant=variant,
    )


def _reference_conditioning(signature: list[str], num_frames: int = 124) -> MiniMaxH3ReferenceConditioningField:
    return MiniMaxH3ReferenceConditioningField(
        references=[MiniMaxH3EncodedReferenceField(kind="image", video_rows_name="rows")],
        num_frames=num_frames,
        signature=signature,
    )


def _denoise(reference_conditioning=None, variant="ref2va", num_frames="124") -> MiniMaxH3DenoiseInvocation:
    return MiniMaxH3DenoiseInvocation(
        id="denoise",
        transformer=_transformer_field(variant),
        positive_conditioning=MiniMaxH3ConditioningField(conditioning_name="cond"),
        reference_conditioning=reference_conditioning,
        num_frames=num_frames,
    )


def _context_with_conditioning(cond_info: MiniMaxH3ConditioningInfo) -> MagicMock:
    context = MagicMock()
    cond_data = MagicMock()
    cond_data.conditionings = [cond_info]
    context.conditioning.load.return_value = cond_data
    return context


def _cond_info(reference_signature=(), reference_num_frames=None) -> MiniMaxH3ConditioningInfo:
    return MiniMaxH3ConditioningInfo(
        prompt_embeds=torch.zeros(1, 3, 8),
        text_token_tags=torch.tensor([1, 1, 0]),
        reference_signature=reference_signature,
        reference_num_frames=reference_num_frames,
    )


class TestDenoiseGuards:
    def test_rejects_references_on_fl2va_transformer(self):
        node = _denoise(_reference_conditioning(["image:a:max:64x64"]), variant="fl2va")
        with pytest.raises(ValueError, match="FL2VA task checkpoint"):
            node.invoke(_context_with_conditioning(_cond_info()))

    def test_rejects_ref2va_transformer_without_references(self):
        node = _denoise(None, variant="ref2va")
        with pytest.raises(ValueError, match="requires reference conditioning"):
            node.invoke(_context_with_conditioning(_cond_info()))

    def test_rejects_prompt_references_without_wired_conditioning(self):
        node = _denoise(None, variant=None)
        with pytest.raises(ValueError, match="no reference conditioning is wired"):
            node.invoke(_context_with_conditioning(_cond_info(reference_signature=("image:a:max:64x64",))))

    def test_wired_conditioning_with_referenceless_prompt_names_the_right_remedy(self):
        # The prompt side has NO references: the error must say to wire them there, not to
        # change a frame count (the num_frames comparison would otherwise fire first).
        node = _denoise(_reference_conditioning(["image:a:max:64x64"]), variant=None)
        with pytest.raises(ValueError, match="Connect the same ordered references to Prompt"):
            node.invoke(_context_with_conditioning(_cond_info()))

    def test_rejects_canvas_mismatch(self):
        sig = "image:a:max:64x64"
        field = _reference_conditioning([sig])
        field.width = 768
        field.height = 768
        node = _denoise(field, variant=None)
        cond = _cond_info(reference_signature=(sig,), reference_num_frames=124)
        with pytest.raises(ValueError, match="768x768 canvas"):
            node.invoke(_context_with_conditioning(cond))

    def test_rejects_signature_mismatch(self):
        sig = "image:a:max:64x64"
        node = _denoise(_reference_conditioning([sig]), variant=None)
        cond = _cond_info(reference_signature=("image:OTHER:max:64x64",), reference_num_frames=124)
        with pytest.raises(ValueError, match="Reference mismatch"):
            node.invoke(_context_with_conditioning(cond))

    def test_rejects_num_frames_mismatch_between_nodes(self):
        sig = "image:a:max:64x64"
        node = _denoise(_reference_conditioning([sig], num_frames=141), variant=None)
        cond = _cond_info(reference_signature=(sig,), reference_num_frames=141)
        with pytest.raises(ValueError, match="prepared for 141 frames"):
            node.invoke(_context_with_conditioning(cond))

    def test_rejects_frame_and_reference_conditioning_together(self):
        from invokeai.app.invocations.fields import MiniMaxH3FrameConditioningField

        node = MiniMaxH3DenoiseInvocation(
            id="denoise",
            transformer=_transformer_field(None),
            positive_conditioning=MiniMaxH3ConditioningField(conditioning_name="cond"),
            frame_conditioning=MiniMaxH3FrameConditioningField(
                condition_rows_name="rows", keyframe_anchors=["first"], width=1344, height=768
            ),
            reference_conditioning=_reference_conditioning(["image:a:max:64x64"]),
        )
        with pytest.raises(ValueError, match="mutually exclusive"):
            node.invoke(_context_with_conditioning(_cond_info()))

    def test_rejects_still_image_frame_count_with_references(self):
        sig = "image:a:max:64x64"
        node = _denoise(_reference_conditioning([sig], num_frames=5), variant=None, num_frames="5")
        cond = _cond_info(reference_signature=(sig,), reference_num_frames=5)
        with pytest.raises(ValueError, match="still-image"):
            node.invoke(_context_with_conditioning(cond))


class TestTextEncoderGuards:
    def _node(self, **kwargs) -> MiniMaxH3TextEncoderInvocation:
        identifier = ModelIdentifierField(
            key="te", hash="h", name="TE", base=BaseModelType.MiniMaxH3, type=ModelType.Main
        )
        from invokeai.app.invocations.model import MiniMaxH3TextEncoderField

        return MiniMaxH3TextEncoderInvocation(
            id="prompt",
            prompt="p",
            text_encoder=MiniMaxH3TextEncoderField(tokenizer=identifier, processor=identifier, text_encoder=identifier),
            **kwargs,
        )

    def test_rejects_keyframes_with_references(self):
        node = self._node(
            first_image=ImageField(image_name="kf.png"),
            references=_image_ref(),
            num_frames=124,
        )
        with pytest.raises(ValueError, match="mutually exclusive"):
            node.invoke(MagicMock())

    def test_requires_num_frames_with_references(self):
        node = self._node(references=_image_ref())
        with pytest.raises(ValueError, match="num_frames is required"):
            node.invoke(MagicMock())
