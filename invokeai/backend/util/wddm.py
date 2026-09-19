"""The Windows video-memory budget of a ROCm device, read from the WDDM kernel thunks in gdi32.

On a ROCm build under Windows, ``torch.cuda.mem_get_info`` reports the device total minus this process's own usage. It
does not see other processes, and it keeps reporting free memory after Windows has started to page this process's
allocations out -- Windows does not fail an allocation that exceeds what it will keep resident, it places it in shared
system memory, silently and for as long as the allocation lives. What it will keep resident is the per-process budget
``D3DKMTQueryVideoMemoryInfo`` reports (the figure ``IDXGIAdapter3::QueryVideoMemoryInfo`` returns, without COM).

Measured on an RX 9060 XT (16 GB, torch 2.12+rocm7.14): alone, the budget is 15.09 of 15.92 GiB and paging starts
once the committed local usage passes budget + 0.38 GiB; next to another GPU process, Windows lowers the budget within
about a second. ``CurrentUsage`` is the committed usage, including bytes already paged out, so budget minus usage is
what this process can still allocate before paging.

Everything here is best-effort: any failure yields ``None`` ("unknown") rather than raising, and callers must keep their
existing behaviour when the answer is unknown.
"""

import ctypes
import functools
import sys
import threading
from dataclasses import dataclass
from typing import Optional

import torch

from invokeai.backend.util.logging import InvokeAILogger

_KMTQAITYPE_ADAPTERADDRESS = 6
_MEMORY_SEGMENT_GROUP_LOCAL = 0


# Win32 types spelled as fixed-width ctypes, so this module imports on every platform.
_UINT = ctypes.c_uint32
_ULONG = ctypes.c_uint32
_LONG = ctypes.c_int32
_BOOL = ctypes.c_int32


class _Luid(ctypes.Structure):
    _fields_ = [("LowPart", _UINT), ("HighPart", _LONG)]


class _AdapterInfo(ctypes.Structure):
    """``D3DKMT_ADAPTERINFO``."""

    _fields_ = [
        ("hAdapter", _UINT),
        ("AdapterLuid", _Luid),
        ("NumOfSources", _ULONG),
        ("bPrecisePresentRegionsPreferred", _BOOL),
    ]


class _EnumAdapters2(ctypes.Structure):
    """``D3DKMT_ENUMADAPTERS2``."""

    _fields_ = [("NumAdapters", _ULONG), ("pAdapters", ctypes.POINTER(_AdapterInfo))]


class _QueryAdapterInfo(ctypes.Structure):
    """``D3DKMT_QUERYADAPTERINFO``."""

    _fields_ = [
        ("hAdapter", _UINT),
        ("Type", ctypes.c_int),
        ("pPrivateDriverData", ctypes.c_void_p),
        ("PrivateDriverDataSize", _UINT),
    ]


class _AdapterAddress(ctypes.Structure):
    """``D3DKMT_ADAPTERADDRESS``: the adapter's PCI location."""

    _fields_ = [("BusNumber", _UINT), ("DeviceNumber", _UINT), ("FunctionNumber", _UINT)]


class _CloseAdapter(ctypes.Structure):
    """``D3DKMT_CLOSEADAPTER``."""

    _fields_ = [("hAdapter", _UINT)]


class _QueryVideoMemoryInfo(ctypes.Structure):
    """``D3DKMT_QUERYVIDEOMEMORYINFO``. A null ``hProcess`` means the calling process."""

    _fields_ = [
        ("hProcess", ctypes.c_void_p),
        ("hAdapter", _UINT),
        ("MemorySegmentGroup", ctypes.c_int),
        ("Budget", ctypes.c_uint64),
        ("CurrentUsage", ctypes.c_uint64),
        ("CurrentReservation", ctypes.c_uint64),
        ("AvailableForReservation", ctypes.c_uint64),
        ("PhysicalAdapterIndex", _UINT),
    ]


_GDI32_FUNCTIONS = (
    "D3DKMTEnumAdapters2",
    "D3DKMTQueryAdapterInfo",
    "D3DKMTQueryVideoMemoryInfo",
    "D3DKMTCloseAdapter",
)


@dataclass(frozen=True)
class _Adapter:
    handle: int
    total_bytes: int


_lock = threading.Lock()
# Per torch device index: the matching WDDM adapter, or None once resolution has failed.
_adapters: dict[int, Optional[_Adapter]] = {}


def _supported(device: torch.device) -> bool:
    return sys.platform == "win32" and torch.version.hip is not None and device.type == "cuda"


@functools.lru_cache(maxsize=1)
def _load_gdi32() -> Optional[ctypes.CDLL]:
    """Open gdi32 once and declare every thunk as taking a struct pointer and returning an NTSTATUS."""
    try:
        lib = ctypes.WinDLL("gdi32")
        for name in _GDI32_FUNCTIONS:
            fn = getattr(lib, name)
            fn.argtypes = [ctypes.c_void_p]
            fn.restype = ctypes.c_long
    except (AttributeError, OSError) as exc:
        InvokeAILogger.get_logger(__name__).debug(f"WDDM thunks unavailable: {exc}")
        return None
    return lib


def _close(lib: ctypes.CDLL, handle: int) -> None:
    try:
        lib.D3DKMTCloseAdapter(ctypes.byref(_CloseAdapter(handle)))
    except Exception:
        pass


def _resolve_adapter(lib: ctypes.CDLL, index: int) -> Optional[_Adapter]:
    """Open the WDDM adapter at the torch device's PCI location, closing every other handle the enumeration opened.

    ROCm's device properties carry no LUID, so the PCI bus and device numbers are the link. Anything but exactly one
    match is treated as unknown rather than guessed.
    """
    props = torch.cuda.get_device_properties(index)
    location = (int(props.pci_bus_id), int(props.pci_device_id))

    enum = _EnumAdapters2(0, None)
    if lib.D3DKMTEnumAdapters2(ctypes.byref(enum)) != 0:
        return None
    infos = (_AdapterInfo * enum.NumAdapters)()
    enum.pAdapters = infos
    if lib.D3DKMTEnumAdapters2(ctypes.byref(enum)) != 0:
        return None

    matches: list[_AdapterInfo] = []
    for info in infos[: enum.NumAdapters]:
        address = _AdapterAddress()
        query = _QueryAdapterInfo(
            info.hAdapter,
            _KMTQAITYPE_ADAPTERADDRESS,
            ctypes.cast(ctypes.byref(address), ctypes.c_void_p),
            ctypes.sizeof(address),
        )
        if (
            lib.D3DKMTQueryAdapterInfo(ctypes.byref(query)) == 0
            and (address.BusNumber, address.DeviceNumber) == location
        ):
            matches.append(info)
        else:
            _close(lib, info.hAdapter)

    if len(matches) != 1:
        for info in matches:
            _close(lib, info.hAdapter)
        return None
    return _Adapter(handle=matches[0].hAdapter, total_bytes=int(props.total_memory))


def _adapter_for(device: torch.device) -> Optional[tuple[ctypes.CDLL, _Adapter]]:
    lib = _load_gdi32()
    if lib is None:
        return None
    try:
        index = device.index if device.index is not None else torch.cuda.current_device()
    except Exception:
        return None
    with _lock:
        if index not in _adapters:
            try:
                _adapters[index] = _resolve_adapter(lib, index)
            except Exception as exc:
                InvokeAILogger.get_logger(__name__).debug(f"WDDM adapter lookup for {device} failed: {exc}")
                _adapters[index] = None
        adapter = _adapters[index]
    return None if adapter is None else (lib, adapter)


def local_video_memory(device: torch.device) -> Optional[tuple[int, int]]:
    """This process's WDDM budget and committed local usage on the device's adapter, as ``(budget, usage)`` in bytes.

    ``None`` off Windows ROCm, and whenever the driver cannot answer or answers something implausible.
    """
    if not _supported(device):
        return None
    resolved = _adapter_for(device)
    if resolved is None:
        return None
    lib, adapter = resolved
    info = _QueryVideoMemoryInfo(None, adapter.handle, _MEMORY_SEGMENT_GROUP_LOCAL)
    try:
        if lib.D3DKMTQueryVideoMemoryInfo(ctypes.byref(info)) != 0:
            return None
    except Exception:
        return None
    if not 0 < info.Budget <= adapter.total_bytes:
        return None
    return int(info.Budget), int(info.CurrentUsage)


def reset_cache() -> None:
    """Close the cached adapter handles and forget the loader (tests only)."""
    with _lock:
        opened = [adapter for adapter in _adapters.values() if adapter is not None]
        _adapters.clear()
    lib = _load_gdi32() if opened else None
    if lib is not None:
        for adapter in opened:
            _close(lib, adapter.handle)
    _load_gdi32.cache_clear()
