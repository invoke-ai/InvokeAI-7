"""MiniMax H3 (Hailuo 3.0) support.

The model, autoencoder and scheduler classes ship in diffusers as of 0.40.0 and
are imported from there (``AutoencoderKLMiniMaxH3``,
``AutoencoderKLMiniMaxH3Audio``, ``MiniMaxH3Scheduler``,
``MiniMaxH3Transformer3DModel``); they were vendored from the in-progress
integration until that release.

What remains here is InvokeAI's own H3 machinery: the packed-sequence geometry
(``packing.py``, still vendored — upstream keeps that code inside its modular
pipeline blocks rather than as an importable module), the sampling and denoise
loop, the text/keyframe conditioning encoders, the pruned transformer, the
int8-convrot linear, the TAEH3 preview decoder and the ROCm conv3d patch.
"""
