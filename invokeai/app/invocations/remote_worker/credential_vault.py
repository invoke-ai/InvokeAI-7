"""Per-InvokeAI-user remote-worker passwords protected with Windows DPAPI.

The encrypted vault lives beneath the configured InvokeAI runtime root, not the source
checkout. Decryption is restricted to the Windows account running this InvokeAI
server. Moving the portable install to another Windows user/PC requires re-entry.
"""
from __future__ import annotations

import ctypes
import json
import os
import threading
import uuid
from ctypes import wintypes
from pathlib import Path
from urllib.parse import urlsplit

_LOCK = threading.RLock()


def normalize_url(value: str) -> str:
    url = value.strip().rstrip('/')
    parsed = urlsplit(url)
    if (parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or not parsed.netloc):
        raise ValueError('Enter a worker URL beginning with http:// or https:// (without login details or query strings)')
    try:
        _ = parsed.port
    except ValueError as exc:
        raise ValueError('Invalid port in worker URL') from exc
    return url


def _vault_path() -> Path:
    # Import lazily: remote_client is discovered during core invocation import.
    from invokeai.app.services.config.config_default import get_config

    return get_config().root_path / 'remote_workers' / 'credentials.dpapi'


def _dpapi(data: bytes, *, decrypt: bool) -> bytes:
    if os.name != 'nt':
        raise RuntimeError('Encrypted Remote Workers credentials currently require Windows DPAPI on the master')

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_byte))]

    source = ctypes.create_string_buffer(data, max(1, len(data)))
    source_blob = DATA_BLOB(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_byte)))
    result = DATA_BLOB()
    crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    function = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    function.argtypes = (
        [ctypes.POINTER(DATA_BLOB), ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(DATA_BLOB),
         ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DATA_BLOB)] if decrypt
        else [ctypes.POINTER(DATA_BLOB), wintypes.LPCWSTR, ctypes.POINTER(DATA_BLOB),
              ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(DATA_BLOB)]
    )
    function.restype = wintypes.BOOL
    # CRYPTPROTECT_UI_FORBIDDEN: do not pop up UI during a background render.
    if not function(ctypes.byref(source_blob), None, None, None, None, 0x1, ctypes.byref(result)):
        raise OSError(ctypes.get_last_error(), 'Windows could not decrypt/encrypt Remote Workers credentials')
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        kernel32.LocalFree.restype = ctypes.c_void_p
        kernel32.LocalFree(ctypes.cast(result.pbData, ctypes.c_void_p))


def _read() -> dict[str, dict[str, dict[str, object]]]:
    path = _vault_path()
    if not path.exists():
        return {}
    data = json.loads(_dpapi(path.read_bytes(), decrypt=True).decode('utf-8'))
    if not isinstance(data, dict) or data.get('version') != 1 or not isinstance(data.get('users'), dict):
        raise ValueError('Remote Workers credentials file has an unsupported format')
    return data['users']


def _write(users: dict[str, dict[str, dict[str, object]]]) -> None:
    path = _vault_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps({'version': 1, 'users': users}, separators=(',', ':')).encode('utf-8')
    encrypted = _dpapi(payload, decrypt=False)
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}.tmp')
    try:
        temporary.write_bytes(encrypted)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def get_saved_credentials(user_id: str, url: str) -> dict[str, object] | None:
    with _LOCK:
        entry = _read().get(user_id, {}).get(normalize_url(url))
        return dict(entry) if isinstance(entry, dict) else None


def save_credentials(user_id: str, url: str, email: str, password: str, remember_me: bool = True) -> None:
    if not user_id or not email.strip() or not password:
        raise ValueError('A user, email, and password are required')
    normalized = normalize_url(url)
    with _LOCK:
        users = _read()
        users.setdefault(user_id, {})[normalized] = {
            'email': email.strip(), 'password': password, 'remember_me': remember_me,
        }
        _write(users)


def delete_credentials(user_id: str, url: str) -> None:
    normalized = normalize_url(url)
    with _LOCK:
        users = _read()
        if normalized in users.get(user_id, {}):
            del users[user_id][normalized]
            if not users[user_id]:
                del users[user_id]
            _write(users)
