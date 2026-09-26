"""Authenticated per-user remote-worker credential management.

Only a saved/not-saved indicator and email are returned; no passwords or JWTs.
"""

from __future__ import annotations

from typing import Any, Literal

from fastapi import HTTPException, Query
from fastapi.routing import APIRouter
from pydantic import BaseModel, Field

from invokeai.app.api.auth_dependencies import AdminUserOrDefault, CurrentUserOrDefault
from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.invocations.remote_worker.credential_vault import (
    delete_credentials,
    get_saved_credentials,
    normalize_url,
    save_credentials,
)
from invokeai.app.invocations.remote_worker.diffusers_transfer import (
    cancel_directory_install_job,
    get_directory_install_job,
    start_directory_install,
)
from invokeai.app.invocations.remote_worker.remote_bridge import (
    cancel_remote_bridges,
    cancel_remote_bridges_by_backend_item,
    cancel_remote_bridges_scoped,
    snapshot_active_remote_bridges,
)
from invokeai.app.invocations.remote_worker.remote_client import RemoteConfig, RemoteInvokeClient, RemoteInvokeError

remote_workers_router = APIRouter(prefix="/v1/remote_workers", tags=["remote_workers"])


class RemoteWorkerCredentialRequest(BaseModel):
    url: str = Field(min_length=1, max_length=2048)
    email: str = Field(min_length=1, max_length=320)
    password: str = Field(min_length=1, max_length=4096)
    remember_me: bool = True


class RemoteWorkerCancelRequest(BaseModel):
    queue_item_id: str = Field(min_length=8, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")


class RemoteWorkerCancelByBackendItemRequest(BaseModel):
    item_id: int = Field(ge=1)


class RemoteWorkerCancelScopedRequest(BaseModel):
    origin_prefix: str | None = Field(default=None, max_length=256)
    keep_current: bool = False


class RemoteWorkerCancelResponse(BaseModel):
    matched: int
    canceled: int
    already_finished: int
    failed: int
    transfers_signaled: int = 0


class RemoteWorkerCredentialStatus(BaseModel):
    saved: bool
    email: str | None = None


def _status(user_id: str, url: str) -> RemoteWorkerCredentialStatus:
    record = get_saved_credentials(user_id, url)
    return RemoteWorkerCredentialStatus(
        saved=record is not None,
        email=str(record["email"]) if record and isinstance(record.get("email"), str) else None,
    )


class RemoteWorkerAvailability(BaseModel):
    status: Literal["online", "offline", "login_required"]


@remote_workers_router.get("/active-bridges", response_model=list[dict[str, Any]])
def get_active_remote_bridges(current_user: CurrentUserOrDefault) -> list[dict[str, Any]]:
    """Replay only this user's still-running bridge UI events after browser reconnect.

    Read-only: does not query workers, modify queues, or restart jobs.
    """
    return snapshot_active_remote_bridges(user_id=current_user.user_id)


@remote_workers_router.get("/status", response_model=RemoteWorkerAvailability)
def get_remote_worker_status(
    current_user: CurrentUserOrDefault,
    url: str = Query(min_length=1, max_length=2048),
) -> RemoteWorkerAvailability:
    """Probe this user's ability to reach a configured worker using existing InvokeAI APIs.

    Keep the probe short; credentials stay in the primary's per-user vault.
    Do not mistake a reachable worker with rejected credentials for an offline host.
    """
    try:
        normalized = normalize_url(url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    client = RemoteInvokeClient(
        RemoteConfig.from_environment(base_url=normalized, verify_ssl=False, user_id=current_user.user_id),
        request_timeout_seconds=2.5,
    )
    try:
        client.get_current_item()
        return RemoteWorkerAvailability(status="online")
    except RemoteInvokeError as exc:
        message = str(exc).lower()
        if any(
            marker in message
            for marker in (
                "requires login",
                "login failed",
                "initial admin setup",
                "http 401",
                "http 403",
                "credentials file",
            )
        ):
            return RemoteWorkerAvailability(status="login_required")
        return RemoteWorkerAvailability(status="offline")
    except Exception:
        # An unreachable worker should never make the primary's status API fail.
        return RemoteWorkerAvailability(status="offline")


@remote_workers_router.get("/credentials", response_model=RemoteWorkerCredentialStatus)
def get_remote_worker_credentials_status(
    current_user: CurrentUserOrDefault,
    url: str = Query(min_length=1, max_length=2048),
) -> RemoteWorkerCredentialStatus:
    try:
        return _status(current_user.user_id, normalize_url(url))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@remote_workers_router.put("/credentials", response_model=RemoteWorkerCredentialStatus)
def put_remote_worker_credentials(
    current_user: CurrentUserOrDefault,
    body: RemoteWorkerCredentialRequest,
) -> RemoteWorkerCredentialStatus:
    try:
        save_credentials(current_user.user_id, body.url, body.email, body.password, body.remember_me)
        return _status(current_user.user_id, body.url)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@remote_workers_router.delete("/credentials", response_model=RemoteWorkerCredentialStatus)
def remove_remote_worker_credentials(
    current_user: CurrentUserOrDefault,
    url: str = Query(min_length=1, max_length=2048),
) -> RemoteWorkerCredentialStatus:
    try:
        delete_credentials(current_user.user_id, url)
        return RemoteWorkerCredentialStatus(saved=False)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@remote_workers_router.post("/diffusers/install")
def install_remote_directory(current_admin: AdminUserOrDefault, body: dict[str, Any]) -> dict[str, Any]:
    """Admin-only receiver for short-lived, manifest-verified model transfers."""
    try:
        return start_directory_install(body, ApiDependencies.invoker.services)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@remote_workers_router.get("/diffusers/install/{job_id}")
def get_remote_directory_install(current_admin: AdminUserOrDefault, job_id: int) -> dict[str, Any]:
    """Poll a directory download and normal model installation."""
    job = get_directory_install_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Directory transfer job not found")
    return job


@remote_workers_router.delete("/diffusers/install/{job_id}")
def cancel_remote_directory_install(current_admin: AdminUserOrDefault, job_id: int) -> dict[str, Any]:
    """Cancel only this temporary download, preserving completed models."""
    job = cancel_directory_install_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Directory transfer job not found")
    return job


@remote_workers_router.put("/cancel", response_model=RemoteWorkerCancelResponse)
def cancel_remote_worker_generation(
    current_user: CurrentUserOrDefault,
    body: RemoteWorkerCancelRequest,
) -> RemoteWorkerCancelResponse:
    """Cancel only this signed-in user's remotes for the specified local generation.

    No remote URLs or remote queue item IDs are accepted from the caller.
    """
    return RemoteWorkerCancelResponse(
        **cancel_remote_bridges(user_id=current_user.user_id, local_queue_item_id=body.queue_item_id)
    )


@remote_workers_router.put("/cancel-queue-item", response_model=RemoteWorkerCancelResponse)
def cancel_remote_worker_backend_item(
    current_user: CurrentUserOrDefault,
    body: RemoteWorkerCancelByBackendItemRequest,
) -> RemoteWorkerCancelResponse:
    """Cancel the authenticated owner's native item, including pre-bridge transfers."""
    try:
        item = ApiDependencies.invoker.services.session_queue.get_queue_item(body.item_id)
    except Exception as exc:
        raise HTTPException(status_code=404, detail="Queue item not found") from exc
    if item.queue_id != "default":
        raise HTTPException(status_code=404, detail="Queue item not found in default queue")
    if item.user_id != current_user.user_id:
        # Never use an admin's authority to cancel another user's remotes.
        raise HTTPException(status_code=403, detail="Remote worker cancellation requires the generation owner")
    return RemoteWorkerCancelResponse(
        **cancel_remote_bridges_by_backend_item(user_id=current_user.user_id, backend_item_id=body.item_id)
    )


@remote_workers_router.put("/cancel-scoped", response_model=RemoteWorkerCancelResponse)
def cancel_remote_worker_scoped(
    current_user: CurrentUserOrDefault,
    body: RemoteWorkerCancelScopedRequest,
) -> RemoteWorkerCancelResponse:
    """Cancel the signed-in owner's matching live bridges, including completed locals."""
    return RemoteWorkerCancelResponse(
        **cancel_remote_bridges_scoped(
            user_id=current_user.user_id,
            origin_prefix=body.origin_prefix,
            keep_current=body.keep_current,
            queue_service=ApiDependencies.invoker.services.session_queue,
        )
    )
