"""scripts/check_platform_locks.py must reject the lockfile shapes that `uv lock --locked` accepts.

The fixtures are minimal synthetic lockfiles: one conflicting extra (`cuda`), the two torch packages and a
handful of closure packages, written in uv's real encoding (per-extra `extra-8-invokeai-<extra>` marker
tokens, percent-encoded `+` in WHL-index URLs). The repo lockfile itself is checked last, as CI does.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "scripts" / "check_platform_locks.py"

spec = importlib.util.spec_from_file_location("check_platform_locks", SCRIPT)
assert spec is not None and spec.loader is not None
check_platform_locks = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = check_platform_locks
spec.loader.exec_module(check_platform_locks)

NVIDIA = check_platform_locks.NVIDIA_WIN_ARM64_REGISTRY
PYPI = "https://pypi.org/simple"
CU128 = "https://download.pytorch.org/whl/cu128"
WIN_ARM = "platform_machine == 'ARM64' and sys_platform == 'win32'"
NOT_WIN_ARM = "(platform_machine != 'ARM64' or sys_platform != 'win32')"
AARCH64 = "platform_machine == 'aarch64' and sys_platform == 'linux'"
NOT_AARCH64 = "(platform_machine != 'aarch64' or sys_platform != 'linux')"
CUDA = "extra == 'extra-8-invokeai-cuda'"
NO_CUDA = "extra != 'extra-8-invokeai-cuda' and extra != 'extra-8-invokeai-cpu'"


def wheel(name: str, version: str, tag: str, registry: str) -> str:
    return f'{{ url = "{registry}/{name}-{version.replace("+", "%2B")}-{tag}.whl", hash = "sha256:0" }}'


def package(
    name: str,
    version: str,
    registry: str,
    wheels: list[str],
    deps: list[str] = (),
    extras: dict[str, list[str]] | None = None,
    sdist: bool = False,
) -> str:
    dep_lines = "\n".join(f"    {d}," for d in deps)
    text = f'''
[[package]]
name = "{name}"
version = "{version}"
source = {{ registry = "{registry}" }}
dependencies = [
{dep_lines}
]
'''
    if sdist:
        text += f'sdist = {{ url = "{registry}/{name}-{version}.tar.gz", hash = "sha256:0" }}\n'
    text += "wheels = [\n" + "\n".join("    " + w + "," for w in wheels) + "\n]\n"
    if extras:
        text += "\n[package.optional-dependencies]\n"
        for extra, edges in extras.items():
            text += f"{extra} = [\n" + "\n".join("    " + e + "," for e in edges) + "\n]\n"
    return text


def dep(
    name: str,
    version: str | None = None,
    registry: str | None = None,
    marker: str | None = None,
    extra: list[str] | None = None,
) -> str:
    parts = [f'name = "{name}"']
    if extra:
        parts.append("extra = [" + ", ".join(f'"{e}"' for e in extra) + "]")
    if version:
        parts.append(f'version = "{version}"')
    if registry:
        parts.append(f'source = {{ registry = "{registry}" }}')
    if marker:
        parts.append(f'marker = "{marker}"')
    return "{ " + ", ".join(parts) + " }"


def make_lock(
    *,
    win_arm_torch_registry: str = NVIDIA,
    win_arm_torch_tag: str = "cp312-cp312-win_arm64",
    aarch64_torchvision_tag: str = "cp312-cp312-manylinux_2_28_aarch64",
    closure_tag: str = "cp312-abi3-win_arm64",
    transitive_tag: str = "cp312-cp312-win_arm64",
    extra_dep_tag: str = "cp312-cp312-win_arm64",
    sdist_only: str | None = None,
) -> str:
    base_torch = [
        dep("torch", "2.7.1", PYPI, f"({AARCH64}) or ({NOT_WIN_ARM} and {NO_CUDA})"),
        dep("torch", "2.7.1+cu128", CU128, f"{NOT_AARCH64} and {NOT_WIN_ARM} and {CUDA}"),
        dep("torch", "2.14.0+cu134", win_arm_torch_registry, WIN_ARM),
        dep("torchvision", "0.22.1", PYPI, f"({AARCH64}) or ({NOT_WIN_ARM} and {NO_CUDA})"),
        dep("torchvision", "0.22.1+cu128", CU128, f"{NOT_AARCH64} and {NOT_WIN_ARM} and {CUDA}"),
        dep("torchvision", "0.29.0+cu134", win_arm_torch_registry, WIN_ARM),
    ]
    return f"""
version = 1
requires-python = ">=3.12, <3.13"
supported-markers = [
    "sys_platform == 'win32' or sys_platform == 'darwin' or (sys_platform == 'linux' and (platform_machine == 'x86_64' or platform_machine == 'aarch64'))",
]
conflicts = [[
    {{ package = "invokeai", extra = "cuda" }},
    {{ package = "invokeai", extra = "cpu" }},
]]

[[package]]
name = "invokeai"
source = {{ editable = "." }}
dependencies = [
    {dep("numpy")},
    {dep("python-jose")},
    {dep("imageio", extra=["ffmpeg"])},
{("    " + dep(sdist_only) + ",") if sdist_only else ""}
    {dep("cryptography", "46.0.3", PYPI, WIN_ARM)},
    {dep("cryptography", "49.0.0", PYPI, NOT_WIN_ARM)},
{chr(10).join("    " + d + "," for d in base_torch)}
]

[package.optional-dependencies]
cuda = [
{chr(10).join("    " + d + "," for d in base_torch)}
]
cpu = [
{chr(10).join("    " + d + "," for d in base_torch)}
]
{package("numpy", "2.3.5", PYPI, [wheel("numpy", "2.3.5", "cp312-cp312-win_arm64", PYPI), wheel("numpy", "2.3.5", "cp312-cp312-manylinux_2_28_aarch64", PYPI)])}
{package("python-jose", "3.5.0", PYPI, [wheel("python_jose", "3.5.0", "py3-none-any", PYPI)], deps=[dep("rsa")])}
{package("rsa", "4.9", PYPI, [wheel("rsa", "4.9", transitive_tag, PYPI)])}
{package("imageio", "2.37.4", PYPI, [wheel("imageio", "2.37.4", "py3-none-any", PYPI)], deps=[dep("pillow")], extras={"ffmpeg": [dep("imageio-ffmpeg")]})}
{package("pillow", "12.2.0", PYPI, [wheel("pillow", "12.2.0", extra_dep_tag, PYPI)])}
{package("imageio-ffmpeg", "0.6.0", PYPI, [], sdist=True)}
{package(sdist_only, "1.0", PYPI, [], sdist=True) if sdist_only else ""}
{package("cryptography", "46.0.3", PYPI, [wheel("cryptography", "46.0.3", closure_tag, PYPI)])}
{package("cryptography", "49.0.0", PYPI, [wheel("cryptography", "49.0.0", "cp312-abi3-win_amd64", PYPI)])}
{package("torch", "2.7.1", PYPI, [wheel("torch", "2.7.1", "cp312-cp312-manylinux_2_28_aarch64", PYPI)])}
{package("torch", "2.7.1+cu128", CU128, [wheel("torch", "2.7.1+cu128", "cp312-cp312-win_amd64", CU128)])}
{package("torch", "2.14.0+cu134", win_arm_torch_registry, [wheel("torch", "2.14.0+cu134", win_arm_torch_tag, win_arm_torch_registry)])}
{package("torchvision", "0.22.1", PYPI, [wheel("torchvision", "0.22.1", aarch64_torchvision_tag, PYPI)])}
{package("torchvision", "0.22.1+cu128", CU128, [wheel("torchvision", "0.22.1+cu128", "cp312-cp312-win_amd64", CU128)])}
{package("torchvision", "0.29.0+cu134", win_arm_torch_registry, [wheel("torchvision", "0.29.0+cu134", win_arm_torch_tag, win_arm_torch_registry)])}
"""


def run(tmp_path: Path, text: str, *platforms: str) -> int:
    lock = tmp_path / "uv.lock"
    lock.write_text(text)
    args = [str(lock)]
    for platform in platforms:
        args += ["--platform", platform]
    return check_platform_locks.main(args)


def test_well_formed_lock_passes_both_platforms(tmp_path: Path):
    assert run(tmp_path, make_lock()) == 0


def test_win_arm64_torch_from_the_wrong_registry_fails(tmp_path: Path):
    """The NVIDIA index is the only source of a win_arm64 CUDA torch; a PyPI-sourced torch means the
    sources markers were lost even if a wheel happened to match."""
    assert run(tmp_path, make_lock(win_arm_torch_registry=PYPI), "win_arm64") == 1


def test_win_arm64_torch_without_arm64_wheel_fails(tmp_path: Path):
    assert run(tmp_path, make_lock(win_arm_torch_tag="cp312-cp312-win_amd64"), "win_arm64") == 1


def test_win_arm64_closure_package_without_arm64_wheel_fails(tmp_path: Path):
    """uv locks a package that has an sdist even when it has no ARM64 wheel; the closure walk is what
    catches it."""
    assert run(tmp_path, make_lock(closure_tag="cp312-abi3-win_amd64"), "win_arm64") == 1
    # The same lock is still fine for aarch64, whose closure is not checked.
    assert run(tmp_path, make_lock(closure_tag="cp312-abi3-win_amd64"), "aarch64") == 0


def test_win_arm64_transitive_package_without_arm64_wheel_fails(tmp_path: Path):
    """The walk must follow a package's own dependencies, not just the root's edges."""
    assert run(tmp_path, make_lock(transitive_tag="cp312-cp312-win_amd64"), "win_arm64") == 1


def test_win_arm64_package_reached_through_an_extra_without_arm64_wheel_fails(tmp_path: Path):
    """`imageio[ffmpeg]`-style edges add the extra's dependencies to the closure."""
    assert run(tmp_path, make_lock(extra_dep_tag="cp312-cp312-win_amd64"), "win_arm64") == 1


def test_win_arm64_sdist_only_package_fails_unless_allow_listed(tmp_path: Path):
    """imageio-ffmpeg is allow-listed (pure sdist); any other wheel-less package is a build on the user's machine."""
    assert run(tmp_path, make_lock(), "win_arm64") == 0
    assert run(tmp_path, make_lock(sdist_only="some-native-package"), "win_arm64") == 1


def test_aarch64_torchvision_without_aarch64_wheel_fails(tmp_path: Path):
    assert run(tmp_path, make_lock(aarch64_torchvision_tag="cp312-cp312-manylinux_2_28_x86_64"), "aarch64") == 1


def test_lock_excluding_a_platform_fails(tmp_path: Path):
    text = make_lock().replace(
        "(platform_machine == 'x86_64' or platform_machine == 'aarch64')", "platform_machine == 'x86_64'"
    )
    assert run(tmp_path, text, "aarch64") == 1


@pytest.mark.parametrize("platform", ["aarch64", "win_arm64"])
def test_repo_lockfile_passes(platform: str):
    assert check_platform_locks.main([str(REPO_ROOT / "uv.lock"), "--platform", platform]) == 0
