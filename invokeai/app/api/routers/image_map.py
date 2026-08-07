import asyncio
from typing import Literal, Optional

import numpy as np
from fastapi import File, HTTPException, Query, UploadFile, status
from fastapi.routing import APIRouter
from pydantic import BaseModel, Field

from invokeai.app.api.auth_dependencies import CurrentUserOrDefault
from invokeai.app.api.dependencies import ApiDependencies
from invokeai.app.api.routers._access import assert_image_read_access
from invokeai.app.services.image_index.image_index_base import TextSearchUnavailableError
from invokeai.app.services.image_index.image_index_common import ImageIndexStatus
from invokeai.app.services.image_index.projection import (
    DEFAULT_CLUSTER_MIN_SAMPLES,
    MAX_CLUSTERED_POINTS,
    compute_clusters,
    resolve_cluster_eps,
    scope_hash,
)

image_map_router = APIRouter(prefix="/v1/image_map", tags=["image_map"])

ImageMapState = Literal["disabled", "model_missing", "empty", "computing", "ready"]


class ImageMapPoint(BaseModel):
    """One image's position on the 2D semantic map."""

    x: float = Field(description="UMAP x coordinate")
    y: float = Field(description="UMAP y coordinate")
    image_name: str = Field(description="The image this point represents")
    cluster: int = Field(description="DBSCAN cluster label; -1 means unclustered")


class ImageMapPointsResponse(BaseModel):
    """The current user's semantic map."""

    points: list[ImageMapPoint] = Field(description="The projected points")
    state: ImageMapState = Field(
        description="disabled: indexing is off; model_missing: indexing is enabled but the configured embedding "
        "model is not installed; empty: nothing to show; computing: a projection is being built; ready: points are served"
    )
    model_name: Optional[str] = Field(
        default=None,
        description="The configured embedding model's name; only set when state is model_missing, so the client "
        "can tell the user which model to install",
    )
    stale: bool = Field(
        description="True when the accessible image set has changed since this projection was computed; a refresh has been requested"
    )
    point_count: int = Field(description="Number of points returned")
    cluster_eps: Optional[float] = Field(
        default=None,
        description="The effective DBSCAN eps used for these points (adaptive default resolved, clamps applied). "
        "Pass it back explicitly to get an identical clustering from a later request.",
    )
    visible_hash: Optional[str] = Field(
        default=None,
        description="Fingerprint of the visible image set these points were computed over; compare across "
        "image-map responses to detect accessible-set drift between requests.",
    )
    updated_at: Optional[str] = Field(default=None, description="When the served projection was computed")


class ImageMapProjectionStatus(BaseModel):
    """Status of the current user's cached projection."""

    state: ImageMapState = Field(description="Projection cache state")
    stale: bool = Field(description="Whether the cached projection lags the accessible image set")
    point_count: int = Field(description="Points in the cached projection")
    updated_at: Optional[str] = Field(default=None, description="When the cached projection was computed")


class ImageMapStatusResponse(BaseModel):
    """Combined index + projection status for the current user."""

    enabled: bool = Field(description="Whether the embedding index is running")
    model_name: Optional[str] = Field(
        default=None,
        description="The configured embedding model's name; only set when the projection state is model_missing",
    )
    index: Optional[ImageIndexStatus] = Field(
        default=None,
        description="Embedding index progress counts. Admin-only: the counts aggregate over all users' images, so they are omitted for regular users.",
    )
    projection: ImageMapProjectionStatus = Field(description="The user's projection cache status")


class ImageMapRefreshResponse(BaseModel):
    """Result of a projection refresh request."""

    enqueued: bool = Field(description="True if the recompute was accepted (or already pending)")


ClusterEpsQuery = Query(
    default=None,
    ge=0.01,
    le=2.0,
    description="DBSCAN eps for clustering. Defaults to an adaptive value derived from the projection's "
    "k-distance distribution. Clamped server-side relative to the projection's coordinate span.",
)
ClusterMinSamplesQuery = Query(
    default=DEFAULT_CLUSTER_MIN_SAMPLES, ge=2, le=100, description="DBSCAN min_samples for clustering"
)


def _scope(current_user) -> tuple[str, bool]:
    """(projection cache key, admin-wide scope flag) for the requesting user."""
    return current_user.user_id, current_user.is_admin


@image_map_router.get("/points", operation_id="get_image_map_points", response_model=ImageMapPointsResponse)
async def get_image_map_points(
    current_user: CurrentUserOrDefault,
    eps: Optional[float] = ClusterEpsQuery,
    min_samples: int = ClusterMinSamplesQuery,
) -> ImageMapPointsResponse:
    """Gets the current user's semantic image map.

    Serves the cached UMAP projection (never blocks on a UMAP fit) and runs
    DBSCAN per request, so `eps` is live-adjustable. If the cache is missing
    or stale, a recompute is enqueued and reflected in `state`/`stale`.
    """
    services = ApiDependencies.invoker.services
    model_id = services.image_index.model_id
    if model_id is None:
        # The service is also inert when indexing is enabled but the
        # configured model is not installed; tell the client which case
        # this is so it can show an actionable message.
        if services.configuration.image_index_enabled:
            return ImageMapPointsResponse(
                points=[],
                state="model_missing",
                model_name=services.configuration.image_index_model,
                stale=False,
                point_count=0,
            )
        return ImageMapPointsResponse(points=[], state="disabled", stale=False, point_count=0)

    user_id, is_admin = _scope(current_user)
    current_names = services.image_index_records.list_accessible_embedded_images(
        None if is_admin else user_id, model_id
    )
    record = services.image_index_records.get_projection(user_id, model_id)

    if record is None:
        if not current_names:
            return ImageMapPointsResponse(points=[], state="empty", stale=False, point_count=0)
        enqueued = services.image_index.request_projection(user_id, all_images=is_admin)
        return ImageMapPointsResponse(points=[], state="computing" if enqueued else "empty", stale=True, point_count=0)

    stale = record.scope_hash != scope_hash(model_id, current_names)
    if stale:
        services.image_index.request_projection(user_id, all_images=is_admin)

    # Serve only points still in the user's current accessible set, so images
    # un-shared (or deleted) since the projection was computed never leak out
    # of a stale cache. Filtering happens BEFORE clustering: labels computed
    # over hidden points would let density-chaining through an inaccessible
    # image leak its existence (and be wrong besides). The clustering and
    # response assembly are CPU-bound, so they run off the event loop.
    def build_points() -> tuple[list[ImageMapPoint], Optional[float], str]:
        accessible = set(current_names)
        mask = np.fromiter(
            (name in accessible for name in record.image_names), dtype=bool, count=len(record.image_names)
        )
        visible_names = [name for name, keep in zip(record.image_names, mask, strict=True) if keep]
        visible_coords = record.coords[mask]
        resolved_eps = (
            resolve_cluster_eps(visible_coords, eps, min_samples)
            if 0 < visible_coords.shape[0] <= MAX_CLUSTERED_POINTS
            else None
        )
        labels = compute_clusters(visible_coords, eps=resolved_eps, min_samples=min_samples)
        return (
            [
                ImageMapPoint(x=float(x), y=float(y), image_name=name, cluster=int(label))
                for name, (x, y), label in zip(visible_names, visible_coords, labels, strict=True)
            ],
            resolved_eps,
            scope_hash(model_id, visible_names),
        )

    points, resolved_eps, visible_hash = await asyncio.to_thread(build_points)
    state: ImageMapState = "ready" if points else "empty"
    return ImageMapPointsResponse(
        points=points,
        state=state,
        stale=stale,
        point_count=len(points),
        cluster_eps=resolved_eps,
        visible_hash=visible_hash,
        updated_at=record.updated_at,
    )


class ImageMapSearchResult(BaseModel):
    """One semantic search hit."""

    image_name: str = Field(description="The matching image")
    score: float = Field(description="Cosine similarity to the query; higher is more similar")


class ImageMapSearchResponse(BaseModel):
    """Semantic search results over the user's embedded images."""

    results: list[ImageMapSearchResult] = Field(description="Ranked results, most similar first")


@image_map_router.get("/search", operation_id="search_image_map", response_model=ImageMapSearchResponse)
async def search_image_map(
    current_user: CurrentUserOrDefault,
    q: Optional[str] = Query(default=None, max_length=500, description="Text query to embed and search with"),
    image_name: Optional[str] = Query(default=None, description="Reference image for similarity search"),
    limit: int = Query(default=100, ge=1, le=500, description="Maximum number of results"),
) -> ImageMapSearchResponse:
    """Ranks the user's accessible images by semantic similarity.

    Provide exactly one of `q` (text search — requires the embedding model's
    text encoder to be installed) or `image_name` (visual similarity — uses
    the reference image's stored embedding when it exists, and otherwise
    embeds the image file on demand, so unindexed images such as assets can
    be reference images too).
    """
    services = ApiDependencies.invoker.services
    if (q is None) == (image_name is None):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Provide exactly one of q or image_name"
        )

    model_id = services.image_index.model_id
    if model_id is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The image index is not enabled; semantic search is unavailable",
        )

    user_id, is_admin = _scope(current_user)
    scope_user = None if is_admin else user_id

    if q is not None:
        try:
            query_embedding = await asyncio.to_thread(services.image_index.embed_text, q)
        except TextSearchUnavailableError as e:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    else:
        assert image_name is not None
        assert_image_read_access(image_name, current_user)
        found, matrix = services.image_index_records.get_embeddings([image_name], model_id)
        if found:
            query_embedding = matrix[0]
        else:
            # Not in the index (assets and intermediates are never indexed) —
            # embed the stored file on demand for this one query.
            def embed_from_file() -> np.ndarray:
                pil = services.images.get_pil_image(image_name)
                return services.image_index.embed_image(pil)

            try:
                query_embedding = await asyncio.to_thread(embed_from_file)
            except Exception:
                services.logger.warning(f"Image search: failed to embed '{image_name}' on demand", exc_info=True)
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail="This image could not be embedded for search (its file may be missing)",
                )

    results = await asyncio.to_thread(services.image_index.search_similar, scope_user, query_embedding, limit)
    return ImageMapSearchResponse(
        results=[ImageMapSearchResult(image_name=name, score=score) for name, score in results]
    )


# One-off reference images are small; cap what we will buffer from an upload
# or a URL download before decoding, and how many pixels we will decode.
MAX_SEARCH_IMAGE_BYTES = 32 * 1024 * 1024
MAX_SEARCH_IMAGE_PIXELS = 64_000_000
_URL_TIMEOUT_SECONDS = 10.0
_URL_TOTAL_DEADLINE_SECONDS = 30.0
_URL_MAX_REDIRECTS = 5

# Downloads run on the loop's shared default executor; a handful of slow
# remote servers must not be able to park every thread in it.
_download_slots = asyncio.Semaphore(4)


def _assert_url_host_allowed(url: str) -> None:
    """Reject URLs whose scheme is not http(s) or whose host resolves to any
    non-global address (loopback, RFC1918, link-local, reserved).

    Resolving via getaddrinfo covers hostnames like 'localhost' and the
    non-canonical IP notations (decimal, hex, octal, shortened) that a plain
    ip_address() literal parse misses. DNS rebinding between this check and
    the actual request is accepted residual risk: the endpoint is
    authenticated, and nothing about the response is revealed beyond whether
    it decoded as an image.
    """
    import ipaddress
    import socket
    from urllib.parse import urlparse

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="image_url must be an http(s) URL")

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    try:
        infos = socket.getaddrinfo(parsed.hostname, port, proto=socket.IPPROTO_TCP)
    except OSError:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="image_url host could not be resolved"
        )
    for info in infos:
        if not ipaddress.ip_address(info[4][0]).is_global:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="image_url must not target a private or loopback address",
            )


def _download_search_image(url: str) -> bytes:
    """Fetch a reference image for a one-off similarity search.

    Redirects are followed manually so every hop is re-validated by
    _assert_url_host_allowed — requests' automatic redirect handling would
    happily follow a public URL into a private address. The wall-clock
    deadline bounds slow-trickle servers that never trip the per-read
    timeout.
    """
    import time
    from urllib.parse import urljoin

    import requests

    deadline = time.monotonic() + _URL_TOTAL_DEADLINE_SECONDS
    try:
        for _ in range(_URL_MAX_REDIRECTS + 1):
            _assert_url_host_allowed(url)
            with requests.get(url, stream=True, timeout=_URL_TIMEOUT_SECONDS, allow_redirects=False) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        break
                    url = urljoin(url, location)
                    continue
                response.raise_for_status()
                chunks: list[bytes] = []
                received = 0
                for chunk in response.iter_content(chunk_size=64 * 1024):
                    received += len(chunk)
                    if received > MAX_SEARCH_IMAGE_BYTES:
                        raise HTTPException(
                            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="The reference image is too large",
                        )
                    if time.monotonic() > deadline:
                        raise HTTPException(
                            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                            detail="The image download took too long",
                        )
                    chunks.append(chunk)
                return b"".join(chunks)
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="The image could not be downloaded from image_url",
        )
    raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Too many redirects for image_url")


@image_map_router.post(
    "/search_by_image", operation_id="search_image_map_by_image", response_model=ImageMapSearchResponse
)
async def search_image_map_by_image(
    current_user: CurrentUserOrDefault,
    image: Optional[UploadFile] = File(default=None, description="Reference image file"),
    image_url: Optional[str] = Query(default=None, max_length=2000, description="URL of a reference image"),
    limit: int = Query(default=100, ge=1, le=500, description="Maximum number of results"),
) -> ImageMapSearchResponse:
    """Ranks the user's accessible images by similarity to an arbitrary reference image.

    Provide exactly one of `image` (multipart upload) or `image_url` (the
    server downloads it). The reference is embedded for this query only —
    nothing is stored.
    """
    services = ApiDependencies.invoker.services
    if (image is None) == (image_url is None):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Provide exactly one of image or image_url"
        )

    model_id = services.image_index.model_id
    if model_id is None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="The image index is not enabled; semantic search is unavailable",
        )

    user_id, is_admin = _scope(current_user)
    scope_user = None if is_admin else user_id

    if image is not None:
        data = await image.read(MAX_SEARCH_IMAGE_BYTES + 1)
        if len(data) > MAX_SEARCH_IMAGE_BYTES:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="The reference image is too large"
            )
    else:
        assert image_url is not None
        async with _download_slots:
            data = await asyncio.to_thread(_download_search_image, image_url)

    def embed_bytes() -> np.ndarray:
        from io import BytesIO

        from PIL import Image

        pil = Image.open(BytesIO(data))
        # The encoder downscales to ~224px anyway; refuse decompression bombs
        # before convert() materializes hundreds of MB of RGB.
        if pil.width * pil.height > MAX_SEARCH_IMAGE_PIXELS:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, detail="The reference image has too many pixels"
            )
        return services.image_index.embed_image(pil)

    try:
        query_embedding = await asyncio.to_thread(embed_bytes)
    except HTTPException:
        raise
    except Exception:
        services.logger.warning("Image search: failed to decode or embed an uploaded reference image", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail="The reference could not be decoded as an image",
        )

    results = await asyncio.to_thread(services.image_index.search_similar, scope_user, query_embedding, limit)
    return ImageMapSearchResponse(
        results=[ImageMapSearchResult(image_name=name, score=score) for name, score in results]
    )


class ImageMapClusterLabel(BaseModel):
    """The best vocabulary label for one cluster."""

    label: str = Field(description="Best-matching vocabulary phrase")
    alternates: list[str] = Field(description="Runner-up phrases")
    score: float = Field(description="Cosine similarity of the best phrase to the cluster centroid")


class ImageMapClusterLabelsResponse(BaseModel):
    """Automatic labels for the current user's visible clusters, keyed by cluster id."""

    labels: dict[str, ImageMapClusterLabel] = Field(description="Cluster id -> label; noise (-1) is omitted")
    visible_hash: Optional[str] = Field(
        default=None,
        description="Fingerprint of the visible image set these labels were clustered over; clients must discard "
        "labels whose visible_hash does not match their points response",
    )
    updated_at: Optional[str] = Field(
        default=None,
        description="The projection these labels were computed against; clients must discard labels whose projection does not match their points",
    )


@image_map_router.get(
    "/cluster_labels", operation_id="get_image_map_cluster_labels", response_model=ImageMapClusterLabelsResponse
)
async def get_image_map_cluster_labels(
    current_user: CurrentUserOrDefault,
    eps: Optional[float] = ClusterEpsQuery,
    min_samples: int = ClusterMinSamplesQuery,
    top_k: int = Query(default=3, ge=1, le=10, description="Candidate labels per cluster"),
) -> ImageMapClusterLabelsResponse:
    """Labels the user's visible clusters with the most similar vocabulary phrases.

    Clustering mirrors `/points` (same eps semantics, computed over the
    caller's currently-accessible points), so cluster ids line up with the
    served map. Pass the `cluster_eps` reported by `/points` so both requests
    cluster with the same eps; cluster ids can still differ if the accessible
    set changes between the requests, so compare the two responses'
    `visible_hash` (and `updated_at`) and discard labels on mismatch.
    Requires the embedding model's text encoder; the first call per model
    embeds the whole vocabulary and is slow.
    """
    from invokeai.app.services.image_index.cluster_labels import label_clusters

    services = ApiDependencies.invoker.services
    model_id = services.image_index.model_id
    if model_id is None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="The image index is not enabled")

    user_id, is_admin = _scope(current_user)
    record = services.image_index_records.get_projection(user_id, model_id)
    if record is None or record.point_count == 0:
        return ImageMapClusterLabelsResponse(labels={})

    try:
        vocabulary, vocab_embeddings = await asyncio.to_thread(services.image_index.get_vocab_embeddings)
    except TextSearchUnavailableError as e:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))

    current_names = services.image_index_records.list_accessible_embedded_images(
        None if is_admin else user_id, model_id
    )

    def build() -> tuple[dict[int, dict], str]:
        accessible = set(current_names)
        mask = np.fromiter(
            (name in accessible for name in record.image_names), dtype=bool, count=len(record.image_names)
        )
        visible_names = [name for name, keep in zip(record.image_names, mask, strict=True) if keep]
        visible_hash = scope_hash(model_id, visible_names)
        if not visible_names:
            return {}, visible_hash
        cluster_ids = compute_clusters(record.coords[mask], eps=eps, min_samples=min_samples)
        cluster_by_name = dict(zip(visible_names, cluster_ids, strict=True))
        # The accessible matrix comes from the same LRU the search endpoint
        # uses — this endpoint fires after every points refresh, and a full
        # BLOB read per request would not scale to large galleries.
        accessible_names, accessible_matrix = services.image_index.get_accessible_embeddings(
            None if is_admin else user_id
        )
        row_by_name = {name: index for index, name in enumerate(accessible_names)}
        found_names = [name for name in visible_names if name in row_by_name]
        if not found_names:
            return {}, visible_hash
        embeddings = accessible_matrix[[row_by_name[name] for name in found_names]]
        aligned = np.fromiter((cluster_by_name[name] for name in found_names), dtype=np.int64, count=len(found_names))
        return label_clusters(aligned, embeddings, vocabulary, vocab_embeddings, top_k=top_k), visible_hash

    labels, visible_hash = await asyncio.to_thread(build)
    return ImageMapClusterLabelsResponse(
        labels={
            str(cluster_id): ImageMapClusterLabel(
                alternates=info["alternates"], label=info["label"], score=info["score"]
            )
            for cluster_id, info in labels.items()
        },
        visible_hash=visible_hash,
        updated_at=record.updated_at,
    )


@image_map_router.post(
    "/refresh",
    operation_id="refresh_image_map",
    response_model=ImageMapRefreshResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def refresh_image_map(current_user: CurrentUserOrDefault) -> ImageMapRefreshResponse:
    """Requests a recompute of the current user's image map projection."""
    user_id, is_admin = _scope(current_user)
    enqueued = ApiDependencies.invoker.services.image_index.request_projection(user_id, all_images=is_admin)
    return ImageMapRefreshResponse(enqueued=enqueued)


@image_map_router.get("/status", operation_id="get_image_map_status", response_model=ImageMapStatusResponse)
async def get_image_map_status(current_user: CurrentUserOrDefault) -> ImageMapStatusResponse:
    """Gets embedding index progress and the user's projection cache status."""
    services = ApiDependencies.invoker.services
    model_id = services.image_index.model_id
    if model_id is None:
        model_missing = services.configuration.image_index_enabled
        return ImageMapStatusResponse(
            enabled=False,
            model_name=services.configuration.image_index_model if model_missing else None,
            projection=ImageMapProjectionStatus(
                state="model_missing" if model_missing else "disabled", stale=False, point_count=0
            ),
        )

    user_id, is_admin = _scope(current_user)
    record = services.image_index_records.get_projection(user_id, model_id)
    if record is None:
        projection = ImageMapProjectionStatus(state="empty", stale=False, point_count=0)
    else:
        current_names = services.image_index_records.list_accessible_embedded_images(
            None if is_admin else user_id, model_id
        )
        # Count only currently-accessible points; a stale record's raw count
        # would reveal the size of a since-revoked scope.
        visible_count = len(set(record.image_names) & set(current_names))
        projection = ImageMapProjectionStatus(
            state="ready" if visible_count else "empty",
            stale=record.scope_hash != scope_hash(model_id, current_names),
            point_count=visible_count,
            updated_at=record.updated_at,
        )
    # Index counts aggregate over all users' images; expose them to admins only.
    index = services.image_index.get_status() if is_admin else None
    return ImageMapStatusResponse(enabled=True, index=index, projection=projection)
