import os
import sys
from unittest.mock import MagicMock

import pytest
import torch

import invokeai.app.util.torch_cuda_allocator as torch_cuda_allocator
from invokeai.app.util.torch_cuda_allocator import ROCM_WINDOWS_ALLOC_CONF, apply_rocm_windows_allocator_default
from tests.dangerously_run_function_in_subprocess import dangerously_run_function_in_subprocess

_ALLOCATOR_ENV_VARS = ("PYTORCH_ALLOC_CONF", "PYTORCH_CUDA_ALLOC_CONF", "PYTORCH_HIP_ALLOC_CONF")


@pytest.fixture
def rocm_windows(monkeypatch: pytest.MonkeyPatch):
    """A Windows ROCm install with no allocator configuration in the environment."""
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(torch_cuda_allocator, "_installed_torch_version", lambda: "2.12.0+rocm7.14.1")
    for var in _ALLOCATOR_ENV_VARS:
        monkeypatch.delenv(var, raising=False)
    return monkeypatch


class TestRocmWindowsAllocatorDefault:
    def test_defaults_to_expandable_segments(self, rocm_windows):
        logger = MagicMock()

        apply_rocm_windows_allocator_default(logger)

        assert os.environ["PYTORCH_CUDA_ALLOC_CONF"] == ROCM_WINDOWS_ALLOC_CONF
        logger.info.assert_called_once()

    @pytest.mark.parametrize("var", _ALLOCATOR_ENV_VARS)
    def test_any_existing_allocator_configuration_wins(self, rocm_windows, var):
        rocm_windows.setenv(var, "expandable_segments:False")

        apply_rocm_windows_allocator_default(MagicMock())

        assert os.environ[var] == "expandable_segments:False"
        if var != "PYTORCH_CUDA_ALLOC_CONF":
            assert "PYTORCH_CUDA_ALLOC_CONF" not in os.environ

    @pytest.mark.parametrize(
        ("platform", "version"),
        [("linux", "2.13.0+rocm7.2"), ("win32", "2.7.1+cu128"), ("win32", "2.7.1"), ("win32", None)],
        ids=["linux-rocm", "windows-cuda", "windows-cpu", "no-torch-metadata"],
    )
    def test_other_installs_are_left_alone(self, rocm_windows, platform, version):
        rocm_windows.setattr(sys, "platform", platform)
        rocm_windows.setattr(torch_cuda_allocator, "_installed_torch_version", lambda: version)
        logger = MagicMock()

        apply_rocm_windows_allocator_default(logger)

        assert "PYTORCH_CUDA_ALLOC_CONF" not in os.environ
        logger.info.assert_not_called()


# These tests are a bit fiddly, because the depend on the import behaviour of torch. They use subprocesses to isolate
# the import behaviour of torch, and then check that the function behaves as expected. We have to hack in some logging
# to check that the tested function is behaving as expected.


@pytest.mark.skipif(not torch.cuda.is_available(), reason="Requires CUDA device.")
def test_configure_torch_cuda_allocator_configures_backend():
    """Test that configure_torch_cuda_allocator() raises a RuntimeError if the configured backend does not match the
    expected backend."""

    def test_func():
        import os

        # Unset the environment variable if it is set so that we can test setting it
        try:
            del os.environ["PYTORCH_CUDA_ALLOC_CONF"]
        except KeyError:
            pass

        from unittest.mock import MagicMock

        from invokeai.app.util.torch_cuda_allocator import configure_torch_cuda_allocator

        mock_logger = MagicMock()

        # Set the PyTorch CUDA memory allocator to cudaMallocAsync
        configure_torch_cuda_allocator("backend:cudaMallocAsync", logger=mock_logger)

        # Verify that the PyTorch CUDA memory allocator was configured correctly
        import torch

        assert torch.cuda.get_allocator_backend() == "cudaMallocAsync"

        # Verify that the logger was called with the correct message
        mock_logger.info.assert_called_once()
        args, _kwargs = mock_logger.info.call_args
        logged_message = args[0]
        print(logged_message)

    stdout, _stderr, returncode = dangerously_run_function_in_subprocess(test_func)
    assert returncode == 0
    assert "PyTorch CUDA memory allocator: cudaMallocAsync" in stdout


@pytest.mark.skipif(not torch.cuda.is_available(), reason="Requires CUDA device.")
def test_configure_torch_cuda_allocator_raises_if_torch_already_imported():
    """Test that configure_torch_cuda_allocator() raises a RuntimeError if torch was already imported."""

    def test_func():
        from unittest.mock import MagicMock

        # Import torch before calling configure_torch_cuda_allocator()
        import torch  # noqa: F401

        from invokeai.app.util.torch_cuda_allocator import configure_torch_cuda_allocator

        try:
            configure_torch_cuda_allocator("backend:cudaMallocAsync", logger=MagicMock())
        except RuntimeError as e:
            print(e)

    stdout, _stderr, returncode = dangerously_run_function_in_subprocess(test_func)
    assert returncode == 0
    assert "configure_torch_cuda_allocator() must be called before importing torch." in stdout


@pytest.mark.skipif(not torch.cuda.is_available(), reason="Requires CUDA device.")
def test_configure_torch_cuda_allocator_warns_if_env_var_is_set_differently():
    """Test that configure_torch_cuda_allocator() logs at WARNING level if PYTORCH_CUDA_ALLOC_CONF is set and doesn't
    match the requested configuration."""

    def test_func():
        import os

        # Explicitly set the environment variable
        os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "backend:native"

        from unittest.mock import MagicMock

        from invokeai.app.util.torch_cuda_allocator import configure_torch_cuda_allocator

        mock_logger = MagicMock()

        # Set the PyTorch CUDA memory allocator a different configuration
        configure_torch_cuda_allocator("backend:cudaMallocAsync", logger=mock_logger)

        # Verify that the logger was called with the correct message
        mock_logger.warning.assert_called_once()
        args, _kwargs = mock_logger.warning.call_args
        logged_message = args[0]
        print(logged_message)

    stdout, _stderr, returncode = dangerously_run_function_in_subprocess(test_func)
    assert returncode == 0
    assert "Attempted to configure the PyTorch CUDA memory allocator with 'backend:cudaMallocAsync'" in stdout


@pytest.mark.skipif(not torch.cuda.is_available(), reason="Requires CUDA device.")
def test_configure_torch_cuda_allocator_logs_if_env_var_is_already_set_correctly():
    """Test that configure_torch_cuda_allocator() logs at INFO level if PYTORCH_CUDA_ALLOC_CONF is set and matches the
    requested configuration."""

    def test_func():
        import os

        os.environ["PYTORCH_CUDA_ALLOC_CONF"] = "backend:native"
        from unittest.mock import MagicMock

        from invokeai.app.util.torch_cuda_allocator import configure_torch_cuda_allocator

        mock_logger = MagicMock()

        configure_torch_cuda_allocator("backend:native", logger=mock_logger)

        mock_logger.info.assert_called_once()
        args, _kwargs = mock_logger.info.call_args
        logged_message = args[0]
        print(logged_message)

    stdout, _stderr, returncode = dangerously_run_function_in_subprocess(test_func)
    assert returncode == 0
    assert "PYTORCH_CUDA_ALLOC_CONF is already set to 'backend:native'" in stdout
