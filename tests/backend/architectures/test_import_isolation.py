"""The architecture registry must be complete by the time `dependencies` is merely imported.

`ApiDependencies.initialize()` builds an `ObjectSerializerDisk` whose `safe_globals` argument is
handed to `torch.serialization.add_safe_globals`, which mutates torch process-globally. Once that
allowlist is derived from the registry, a registry that fills in later is not a missing entry --
it is a `torch.load` failure mid-graph. So the requirement is stricter than "complete before first
read": it is "complete on import", which is why `dependencies.py` imports
`invokeai.backend.architectures` at module level rather than lazily inside a function.

This runs in a fresh interpreter rather than the shared pytest process, where every module has
already been imported by some other test and the property would hold vacuously.
"""

from tests.dangerously_run_function_in_subprocess import dangerously_run_function_in_subprocess


def _registry_is_complete_after_importing_dependencies_alone() -> None:
    # No arguments, no closures, all imports inside: see dangerously_run_function_in_subprocess.
    import invokeai.app.api.dependencies  # noqa: F401
    from invokeai.backend.architectures import generative_bases
    from invokeai.backend.architectures.registry import _NOT_ARCHITECTURES
    from invokeai.backend.model_manager.taxonomy import BaseModelType

    expected = set(BaseModelType) - set(_NOT_ARCHITECTURES)
    registered = set(generative_bases())

    assert registered == expected, (
        f"importing invokeai.app.api.dependencies did not populate the architecture registry; "
        f"missing {sorted(b.value for b in expected - registered)}. The module-level "
        f"`from invokeai.backend.architectures import ...` in dependencies.py is what populates it "
        f"-- it must not be moved into a function."
    )


def test_registry_is_complete_after_importing_dependencies_alone() -> None:
    _, stderr, returncode = dangerously_run_function_in_subprocess(
        _registry_is_complete_after_importing_dependencies_alone
    )

    assert returncode == 0, stderr
