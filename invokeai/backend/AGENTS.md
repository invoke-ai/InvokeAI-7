# Inference and model backend

## Design and resources

- Trace the caller, model loader/cache, tensor shapes, device/dtype handling, and cleanup before changing inference. Keep reusable model/inference policy here rather than in UI or API adapters.
- Use existing device selection and model-management abstractions, including `util/devices.py`. Do not hardcode CUDA, GPU zero, or a dtype when CPU, MPS, ROCm, XPU, or multiple devices need to work.
- Respect session/thread device ownership. Restore temporary model patches, device state, hooks, and allocations on success, cancellation, and exceptions. Avoid request-specific mutable process-wide state.
- Keep model/cache lifetimes and working-memory estimates explicit. Bound queues, caches, downloads, batches, and temporary buffers; consider peak memory as well as throughput.
- Preserve model format validation and loading safeguards. Respect vendored-code exclusions and upstream provenance; avoid unrelated formatting or rewrites in vendored modules.

## Performance

- Hunt for efficiency wins on the affected inference path: duplicate work, device transfers, dtype conversions, tensor copies, CPU/GPU synchronization, repeated loading, and retained tensors.
- Use representative shapes, resolutions, batch sizes, and supported device paths. Measure material latency/throughput and peak-memory changes; distinguish cold loading/compilation from warmed inference.
- Retain numerical correctness with appropriate tolerances and reproducible seeds where supported. A faster path is not an improvement if it changes output semantics, breaks cancellation, or shifts failures to larger inputs.
- Do not add speculative kernels, caches, compilation, or concurrent execution without a demonstrated benefit and clear fallback/lifecycle behavior.

## Verification

- Read `tests/AGENTS.md` and the relevant existing suites under `tests/backend/`, `tests/model_identification/`, or `tests/test_model_manager/`.
- Use small CPU fixtures for logic where possible, plus targeted hardware checks for device-specific behavior. Test real tensor operations when mocks would hide shape, dtype, numerical, or memory errors.
- Cover failure cleanup, unsupported configurations, boundary shapes, and cancellation where affected. Do not download large models or use the user's model/output directories as routine unit-test setup.
- Run focused pytest and root Ruff checks. Record tested hardware, dtype, shapes, and measurements for material inference changes. Explicitly state untested platforms and model paths; CPU tests do not prove accelerator behavior.
