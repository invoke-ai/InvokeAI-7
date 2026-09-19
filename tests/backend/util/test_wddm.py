"""The Windows video-memory budget reader, against a scripted stand-in for the gdi32 kernel thunks.

The thunks are driven through the same ctypes structures the module passes, so struct layout, the two-call adapter
enumeration, the PCI match and handle cleanup are exercised; only the kernel behind them is fake.
"""

import ctypes
import functools
import sys
from types import SimpleNamespace

import pytest
import torch

from invokeai.backend.util import wddm

GIB = 1024**3
DEVICE = torch.device("cuda", 0)
OUR_BUS, OUR_DEVICE = 3, 0


class _FakeGdi32:
    """Adapters as (handle, bus, device); every thunk returns NTSTATUS 0 unless told otherwise."""

    def __init__(self, adapters, budget=15 * GIB, usage=2 * GIB, query_status=0):
        self.adapters = adapters
        self.budget = budget
        self.usage = usage
        self.query_status = query_status
        self.enum_calls = 0
        self.closed: list[int] = []

    def D3DKMTEnumAdapters2(self, ref):
        self.enum_calls += 1
        enum = ref._obj
        if not enum.pAdapters:
            enum.NumAdapters = len(self.adapters)
            return 0
        for i, (handle, _bus, _device) in enumerate(self.adapters):
            enum.pAdapters[i].hAdapter = handle
        return 0

    def D3DKMTQueryAdapterInfo(self, ref):
        query = ref._obj
        address = wddm._AdapterAddress.from_address(query.pPrivateDriverData)
        _handle, bus, device = next(a for a in self.adapters if a[0] == query.hAdapter)
        address.BusNumber, address.DeviceNumber = bus, device
        return 0

    def D3DKMTQueryVideoMemoryInfo(self, ref):
        info = ref._obj
        info.Budget, info.CurrentUsage = self.budget, self.usage
        return self.query_status

    def D3DKMTCloseAdapter(self, ref):
        self.closed.append(ref._obj.hAdapter)
        return 0


@pytest.fixture
def windows_rocm(monkeypatch: pytest.MonkeyPatch):
    """A Windows ROCm build whose device 0 sits at PCI bus 3 with 16 GiB. Returns an installer for a fake gdi32."""
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(torch.version, "hip", "7.14.0")
    props = SimpleNamespace(pci_bus_id=OUR_BUS, pci_device_id=OUR_DEVICE, total_memory=16 * GIB)
    monkeypatch.setattr(torch.cuda, "get_device_properties", lambda index: props)
    wddm.reset_cache()

    def install(fake: _FakeGdi32) -> _FakeGdi32:
        monkeypatch.setattr(wddm, "_load_gdi32", functools.lru_cache(maxsize=1)(lambda: fake))
        return fake

    yield install
    wddm.reset_cache()


def test_reads_the_budget_of_the_adapter_at_the_devices_pci_location(windows_rocm):
    gdi32 = windows_rocm(
        _FakeGdi32([(10, 7, 0), (20, OUR_BUS, OUR_DEVICE), (30, 0xFFFFFFFF, 0xFFFF)], budget=15 * GIB, usage=2 * GIB)
    )

    assert wddm.local_video_memory(DEVICE) == (15 * GIB, 2 * GIB)
    assert sorted(gdi32.closed) == [10, 30], "the other adapters' handles are closed, ours stays open"


def test_resolves_the_adapter_once(windows_rocm):
    gdi32 = windows_rocm(_FakeGdi32([(20, OUR_BUS, OUR_DEVICE)]))

    wddm.local_video_memory(DEVICE)
    gdi32.usage = 5 * GIB
    assert wddm.local_video_memory(DEVICE) == (15 * GIB, 5 * GIB)
    assert gdi32.enum_calls == 2, "one count call and one fill call, for the first query only"


@pytest.mark.parametrize(
    ("adapters", "kwargs"),
    [
        ([(10, 7, 0)], {}),
        ([(20, OUR_BUS, OUR_DEVICE), (21, OUR_BUS, OUR_DEVICE)], {}),
        ([(20, OUR_BUS, OUR_DEVICE)], {"query_status": -1073741823}),
        ([(20, OUR_BUS, OUR_DEVICE)], {"budget": 0}),
        ([(20, OUR_BUS, OUR_DEVICE)], {"budget": 17 * GIB}),
    ],
    ids=[
        "no-adapter-at-the-location",
        "two-adapters-at-the-location",
        "query-fails",
        "zero-budget",
        "budget-over-total",
    ],
)
def test_unknown_rather_than_guessed(windows_rocm, adapters, kwargs):
    gdi32 = windows_rocm(_FakeGdi32(adapters, **kwargs))

    assert wddm.local_video_memory(DEVICE) is None
    if len(adapters) == 2:
        assert sorted(gdi32.closed) == [20, 21], "an ambiguous match must not leak either handle"


@pytest.mark.parametrize(
    ("platform", "hip", "device"),
    [("linux", "7.2.0", DEVICE), ("win32", None, DEVICE), ("win32", "7.14.0", torch.device("cpu"))],
    ids=["linux-rocm", "windows-cuda", "cpu-device"],
)
def test_elsewhere_gdi32_is_never_touched(windows_rocm, monkeypatch, platform, hip, device):
    def loader():
        raise AssertionError("gdi32 must not be loaded outside Windows ROCm")

    monkeypatch.setattr(wddm, "_load_gdi32", functools.lru_cache(maxsize=1)(loader))
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(torch.version, "hip", hip)

    assert wddm.local_video_memory(device) is None


def test_reset_closes_the_cached_handle(windows_rocm):
    gdi32 = windows_rocm(_FakeGdi32([(20, OUR_BUS, OUR_DEVICE)]))
    wddm.local_video_memory(DEVICE)

    wddm.reset_cache()

    assert gdi32.closed == [20]


def test_structures_match_the_d3dkmt_layout():
    """The kernel reads these by offset: a shifted field would read a neighbour's bytes, not fail."""
    assert ctypes.sizeof(wddm._AdapterInfo) == 20
    assert wddm._QueryVideoMemoryInfo.Budget.offset == 16
    assert ctypes.sizeof(wddm._QueryVideoMemoryInfo) == 56


needs_windows_rocm = pytest.mark.skipif(
    sys.platform != "win32" or torch.version.hip is None or not torch.cuda.is_available(),
    reason="needs a ROCm GPU under Windows",
)


@pytest.mark.slow
@needs_windows_rocm
def test_on_hardware_the_usage_follows_an_allocation():
    wddm.reset_cache()
    device = torch.device("cuda", 0)
    torch.empty(1, device=device)
    before = wddm.local_video_memory(device)
    assert before is not None and before[0] > 0

    block = torch.empty(256 * 2**20, dtype=torch.uint8, device=device).fill_(1)
    torch.cuda.synchronize()
    after = wddm.local_video_memory(device)

    assert after is not None
    assert after[1] - before[1] >= 0.9 * block.numel()
