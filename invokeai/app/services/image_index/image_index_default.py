import threading
from pathlib import Path
from queue import Empty, Queue
from typing import TYPE_CHECKING, Any, Callable, Optional

import numpy as np
import torch
from PIL import Image

from invokeai.app.services.image_index.image_index_base import ImageIndexServiceBase, TextSearchUnavailableError
from invokeai.app.services.image_index.image_index_common import EMBEDDING_DTYPE, ImageIndexStatus
from invokeai.app.services.image_index.projection import compute_umap, projection_params, scope_hash
from invokeai.app.services.image_records.image_records_common import ImageCategory
from invokeai.app.services.images.images_common import ImageDTO
from invokeai.app.services.session_queue.session_queue_common import DEFAULT_QUEUE_ID
from invokeai.backend.model_manager.load.optimizations import skip_torch_weight_init
from invokeai.backend.model_manager.taxonomy import ModelType
from invokeai.backend.util.devices import TorchDevice

if TYPE_CHECKING:
    from logging import Logger

    from invokeai.app.services.config.config_default import InvokeAIAppConfig
    from invokeai.app.services.invoker import Invoker
    from invokeai.backend.model_manager.configs.factory import AnyModelConfig

# A batch of PIL images in, an (N, dim) float32 embedding matrix out.
EncodeFn = Callable[[list[Image.Image]], np.ndarray]

# How long the worker sleeps between generation-idle checks and empty-queue polls.
_POLL_SECONDS = 1.0

# An image is retried this many times (transient failures: OOM, file locks,
# model briefly unavailable) before being marked permanently failed.
_MAX_ATTEMPTS = 3


def warm_up_attention(config: "InvokeAIAppConfig", logger: "Logger") -> None:
    """Run one tiny scaled_dot_product_attention call while the process is still single-threaded.

    ROCm's AOTriton backend initializes its SDPA kernels lazily on the first
    call, and that init is not thread-safe: two threads making their first
    call concurrently can get a spurious "Accelerated SDPA only supports..."
    error or crash the process. The image index adds the first threads that
    run attention concurrently with the session processor, so its startup
    wiring calls this before any service thread exists (a warmup issued any
    later — e.g. from the service's own start() — could itself race a
    generation resumed from a queue that was non-empty at shutdown).
    """
    if not config.image_index_enabled:
        return
    try:
        device = (
            torch.device(config.image_index_device) if config.image_index_device else TorchDevice.choose_torch_device()
        )
        if device.type != "cuda":
            return
        query = torch.zeros((1, 1, 8, 8), device=device, dtype=torch.float16)
        torch.nn.functional.scaled_dot_product_attention(query, query, query)
        torch.cuda.synchronize(device)
    except Exception:
        logger.warning("Attention warm-up failed", exc_info=True)


class ImageIndexService(ImageIndexServiceBase):
    """Embeds gallery images on a daemon worker thread.

    The image-service callbacks only enqueue work and set a status-dirty
    flag — they fire synchronously on the caller's thread and must never do
    I/O. All embedding and all status emission happens on the worker, which
    pauses while a generation is in progress unless it is configured to run
    on the CPU.
    """

    def __init__(self, encode_fn: Optional[EncodeFn] = None, model_id: Optional[str] = None) -> None:
        """Args:
        encode_fn: Test seam. When provided, it is used instead of loading the
            configured model, and `model_id` identifies the index it writes.
        model_id: Required when `encode_fn` is provided.
        """
        if (encode_fn is None) != (model_id is None):
            raise ValueError("encode_fn and model_id must be provided together")
        self._encode_fn_override = encode_fn
        self._model_id_override = model_id

        self._queue: Queue[str] = Queue()
        self._pending: set[str] = set()
        self._pending_lock = threading.Lock()
        # Per-image failure counts; after _MAX_ATTEMPTS the name moves to
        # _failed, which is excluded from backfill so a bad file cannot make
        # the backfill loop spin forever. Transient failures get retried.
        self._attempts: dict[str, int] = {}
        self._failed: set[str] = set()
        self._stop_event = threading.Event()
        self._backfill_pending = threading.Event()
        # Set by the image-service callbacks when counts changed; the worker
        # (the only emitter) turns it into one status event per sweep.
        self._status_dirty = threading.Event()
        # Owners of freshly embedded images, awaiting a per-user poke once
        # the index goes quiescent. Worker-thread only — no locking.
        self._pending_pokes: set[str] = set()
        self._worker: Optional[threading.Thread] = None
        # user_id -> all_images. Deduplicates projection requests per user;
        # a request arriving while that user's projection is being computed
        # lands here again and is honored on the next pass.
        self._projection_requests: dict[str, bool] = {}
        self._projection_lock = threading.Lock()

        self._invoker: Optional["Invoker"] = None
        self._model_config: Optional["AnyModelConfig"] = None
        self._model_id: Optional[str] = None
        self._encode_fn: Optional[EncodeFn] = None
        # RAM-resident model used only in CPU mode; see _encode_with_model.
        self._cpu_model: Optional[Any] = None
        self._processor: Optional[Any] = None
        # Lazily-loaded (tokenizer, text_model, is_siglip); None until first text search.
        self._text_encoder: Optional[tuple[Any, Any, bool]] = None
        self._text_encoder_lock = threading.Lock()
        # Guards the lazy _processor/_cpu_model init: embed_image runs on
        # request threads concurrently with the indexer worker.
        self._vision_init_lock = threading.Lock()
        # scope_hash -> (names, matrix): the accessible embedding matrix for
        # similarity search, so repeated queries skip re-reading BLOBs.
        self._search_cache: dict[str, tuple[list[str], np.ndarray]] = {}
        self._search_cache_lock = threading.Lock()

    @property
    def model_id(self) -> str | None:
        return self._model_id

    def get_status(self) -> ImageIndexStatus | None:
        if self._invoker is None or self._model_id is None:
            return None
        status = self._invoker.services.image_index_records.count_index_status(self._model_id)
        return status.model_copy(update={"failed": len(self._failed)})

    def embed_image(self, image: Image.Image) -> np.ndarray:
        if self._encode_fn is None:
            raise RuntimeError("The image index is not running")
        rgb = image.convert("RGB")
        try:
            matrix = np.asarray(self._encode_fn([rgb]), dtype=EMBEDDING_DTYPE)
        except Exception:
            # The model cache deletes an entry whose load failed precisely so
            # the next attempt rebuilds it from disk (e.g. an entry left in a
            # bad state by VRAM contention with a concurrent generation).
            # One retry is the cache's designed recovery; the worker gets the
            # same effect from its batch retry loop.
            if self._invoker is not None:
                self._invoker.services.logger.warning(
                    "Image embed failed; retrying with a fresh model load", exc_info=True
                )
            matrix = np.asarray(self._encode_fn([rgb]), dtype=EMBEDDING_DTYPE)
        if matrix.ndim != 2 or matrix.shape[0] != 1:
            raise RuntimeError(f"Encoder returned shape {matrix.shape}; expected (1, D)")
        norm = float(np.linalg.norm(matrix[0]))
        return matrix[0] / norm if norm > 0 else matrix[0]

    def embed_text(self, text: str) -> np.ndarray:
        if self._model_id is None:
            raise TextSearchUnavailableError("The image index is not running")

        tokenizer, model, is_siglip = self._get_text_encoder()
        with torch.no_grad():
            # SigLIP was trained with pad-to-max-length; pad-to-longest degrades
            # its text embeddings. CLIP uses ordinary longest-padding.
            inputs = tokenizer(
                [text], padding="max_length" if is_siglip else True, return_tensors="pt", truncation=True
            )
            outputs = model(**inputs)
            embedding = outputs.pooler_output[0] if is_siglip else outputs.text_embeds[0]
            vector = embedding.float().cpu().numpy()
        norm = np.linalg.norm(vector)
        return vector / norm if norm > 0 else vector

    def _get_text_encoder(self) -> tuple[Any, Any, bool]:
        with self._text_encoder_lock:
            if self._text_encoder is None:
                if self._model_config is None:
                    raise TextSearchUnavailableError("The image index has no embedding model loaded")

                from transformers import AutoTokenizer, CLIPTextModelWithProjection, SiglipTextModel

                model_path = str(self._model_abs_path())
                is_siglip = self._model_config.type is ModelType.SigLIP
                try:
                    tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
                    text_cls = SiglipTextModel if is_siglip else CLIPTextModelWithProjection
                    # skip_torch_weight_init serializes torch module construction
                    # process-wide; an unserialized from_pretrained racing another
                    # thread's model load leaks meta-device parameters.
                    with skip_torch_weight_init():
                        model = text_cls.from_pretrained(model_path, local_files_only=True)
                except Exception as e:
                    # Vision-only or partial installs (e.g. the IP-Adapter image
                    # encoder, or a full-CLIP checkpoint shipped without tokenizer
                    # files) fail in assorted ways — transformers raises OSError,
                    # TypeError, or ValueError depending on which file is missing.
                    # Image-similarity search still works either way.
                    raise TextSearchUnavailableError(
                        "The configured embedding model's text encoder could not be loaded "
                        f"({type(e).__name__}: {e}); install the full CLIP model, including its "
                        "tokenizer files, to enable semantic text search"
                    ) from e
                model.eval()
                self._text_encoder = (tokenizer, model, is_siglip)
            return self._text_encoder

    def get_accessible_embeddings(self, user_id: str | None) -> tuple[list[str], np.ndarray]:
        if self._invoker is None or self._model_id is None:
            return [], np.empty((0, 0), dtype=EMBEDDING_DTYPE)
        records = self._invoker.services.image_index_records

        names = records.list_accessible_embedded_images(user_id, self._model_id)
        if not names:
            return [], np.empty((0, 0), dtype=EMBEDDING_DTYPE)

        # Memory math: one entry is N x dim float32 (~300 MB at 100k x 768),
        # so the LRU holds two entries and evicts oldest-first rather than
        # clearing wholesale. Keys self-invalidate: any change to the
        # accessible set changes the scope hash.
        cache_key = scope_hash(self._model_id, names)
        with self._search_cache_lock:
            cached = self._search_cache.get(cache_key)
            if cached is not None:
                # LRU touch.
                del self._search_cache[cache_key]
                self._search_cache[cache_key] = cached
        if cached is None:
            # Built outside the lock: a concurrent miss for the same scope
            # transiently builds a duplicate, which beats serializing every
            # search behind a multi-second BLOB read.
            cached = records.get_embeddings(names, self._model_id)
            with self._search_cache_lock:
                while len(self._search_cache) >= 2:
                    self._search_cache.pop(next(iter(self._search_cache)))
                self._search_cache[cache_key] = cached

        return cached

    def search_similar(self, user_id: str | None, query_embedding: np.ndarray, limit: int) -> list[tuple[str, float]]:
        found_names, matrix = self.get_accessible_embeddings(user_id)
        if matrix.size == 0:
            return []

        scores = matrix @ query_embedding.astype(matrix.dtype)
        top = min(limit, len(found_names))
        order = np.argpartition(-scores, top - 1)[:top]
        order = order[np.argsort(-scores[order])]
        return [(found_names[index], float(scores[index])) for index in order]

    def request_projection(self, user_id: str, all_images: bool = False) -> bool:
        if self._model_id is None or self._worker is None or not self._worker.is_alive():
            return False
        with self._projection_lock:
            # Last writer wins: the scope reflects the requester's most recent
            # admin status, so a promotion/demotion between requests cannot
            # pin a stale scope.
            self._projection_requests[user_id] = all_images
        return True

    def start(self, invoker: "Invoker") -> None:
        self._invoker = invoker
        config = invoker.services.configuration
        if not config.image_index_enabled:
            return
        if self._worker is not None and self._worker.is_alive():
            # A second start would register duplicate image callbacks and race
            # a prior worker that outlived its stop() join.
            invoker.services.logger.warning("Image index service started twice; ignoring the second start")
            return

        if self._encode_fn_override is not None:
            self._encode_fn = self._encode_fn_override
            self._model_id = self._model_id_override
        else:
            model_config = self._resolve_model_config(config.image_index_model)
            if model_config is None:
                invoker.services.logger.warning(self._model_not_installed_message(config.image_index_model))
                return
            self._model_config = model_config
            self._model_id = model_config.hash
            self._encode_fn = self._encode_with_model

        discarded = invoker.services.image_index_records.delete_embeddings_for_other_models(self._model_id)
        if discarded:
            invoker.services.logger.info(
                f"Discarded {discarded} image embeddings computed by a previously-configured model"
            )

        invoker.services.images.on_changed(self._on_image_changed)
        invoker.services.images.on_deleted(self._on_image_deleted)

        self._backfill_pending.set()
        self._stop_event.clear()
        self._worker = threading.Thread(target=self._worker_loop, name="image_index_worker", daemon=True)
        self._worker.start()

    def stop(self, invoker: Optional["Invoker"] = None) -> None:
        self._stop_event.set()
        if self._worker is not None and self._worker.is_alive():
            self._worker.join(timeout=10)
            if self._worker.is_alive() and self._invoker is not None:
                self._invoker.services.logger.warning(
                    "Image index worker did not stop within 10s (likely mid-encode); abandoning daemon thread"
                )

    # --- Image service callbacks (caller's thread — enqueue and flag only, never I/O) ---

    def _on_image_changed(self, image_dto: ImageDTO) -> None:
        if image_dto.is_intermediate or image_dto.image_category != ImageCategory.GENERAL:
            # The image may have just LEFT eligibility (e.g. adopted as a
            # canvas asset). Drop any failure bookkeeping so a name no longer
            # counted in the totals cannot skew `failed` (and thus `pending`)
            # for the rest of the process. Flag only when something was
            # actually forgotten — this branch also fires for every
            # intermediate save during generation, which must stay silent.
            if image_dto.image_name in self._failed:
                self._failed.discard(image_dto.image_name)
                self._attempts.pop(image_dto.image_name, None)
                self._status_dirty.set()
            return
        with self._pending_lock:
            if image_dto.image_name in self._pending:
                return
            self._pending.add(image_dto.image_name)
        # Flagged before the enqueue so the worker reports the image as
        # pending before it starts (and certainly before it finishes) the
        # embed. The worker does the emit: callbacks stay free of DB reads
        # (which could block the generation thread behind the worker's own
        # long transactions), and single-threaded emission means events can
        # never be dispatched with out-of-order counts.
        self._status_dirty.set()
        self._queue.put(image_dto.image_name)

    def _on_image_deleted(self, image_name: str) -> None:
        # The DB row is removed by the images FK cascade; just forget local state.
        with self._pending_lock:
            self._pending.discard(image_name)
        self._failed.discard(image_name)
        self._attempts.pop(image_name, None)
        # A deletion gives the worker nothing to embed, so this flag is the
        # only signal clients get that the index shrank; the worker notices
        # within its poll interval. Bulk deletes coalesce into one emit.
        self._status_dirty.set()

    # --- Worker ---

    def _worker_loop(self) -> None:
        assert self._invoker is not None
        logger = self._invoker.services.logger
        while not self._stop_event.is_set():
            try:
                batch = self._next_batch()
                if self._status_dirty.is_set():
                    # The worker is the only emitter, so events are totally
                    # ordered by one thread and can never carry out-of-order
                    # counts. Checked after _next_batch so a just-enqueued
                    # image is reported pending before its embed runs.
                    self._status_dirty.clear()
                    try:
                        self._emit_status()
                    except Exception:
                        # For deletions this flag is the only signal clients
                        # get, so a failed emit must not consume it. Cleared
                        # before emitting (not after) so a set arriving
                        # mid-emit is never lost either.
                        self._status_dirty.set()
                        raise
                if batch is not None:
                    self._wait_for_idle_generation()
                    if self._stop_event.is_set():
                        break
                    ok = self._process_batch(batch)
                    self._emit_status()
                    if not ok:
                        # Re-sweep so queue-sourced images that failed
                        # transiently are retried to _MAX_ATTEMPTS instead of
                        # lingering unembedded until the next restart.
                        self._backfill_pending.set()
                        # Back off after a failed batch so a systemic failure
                        # (broken model, OOM loop) cannot spin hot through the
                        # backlog re-fetching the same names.
                        self._stop_event.wait(_POLL_SECONDS)
                    continue
                if self._pending_pokes and not self._backfill_pending.is_set():
                    # The index just went quiescent: poke each owner whose
                    # images were embedded since the last flush. Deferred to
                    # quiescence so a long backfill does not trigger a
                    # refetch (and possibly a projection recompute) per
                    # batch. Cleared only after all emits, so a raise here
                    # retries on the next pass (duplicate pokes are cheap).
                    for user_id in sorted(self._pending_pokes):
                        self._invoker.services.events.emit_image_index_updated(user_id=user_id)
                    self._pending_pokes.clear()
                    continue
                # No embedding work right now — projections run when the
                # index is quiescent so they cover the freshest state.
                projection_job = self._next_projection_job()
                if projection_job is not None:
                    self._process_projection(*projection_job)
            except Exception:
                logger.exception("Unexpected error in the image index worker")
                # Whatever was in flight may have skipped its accounting, so
                # re-sweep for anything left unembedded and re-emit counts —
                # otherwise an image dropped here lingers with pending stuck
                # above zero until the next restart.
                self._backfill_pending.set()
                self._status_dirty.set()
                self._stop_event.wait(_POLL_SECONDS)

    def _next_batch(self) -> Optional[list[str]]:
        """Get the next batch of image names, preferring backfill work.

        Returns None when there is nothing to do right now.
        """
        assert self._invoker is not None
        batch_size = self._invoker.services.configuration.image_index_batch_size

        if self._backfill_pending.is_set():
            assert self._model_id is not None
            # Over-fetch by the failed count so permanently-failing images
            # cannot occlude the rest of the backlog.
            candidates = self._invoker.services.image_index_records.list_unembedded_image_names(
                self._model_id, limit=batch_size + len(self._failed)
            )
            batch = [name for name in candidates if name not in self._failed][:batch_size]
            if batch:
                return batch
            self._backfill_pending.clear()
            self._emit_status()

        try:
            first = self._queue.get(timeout=_POLL_SECONDS)
        except Empty:
            return None
        batch = [first]
        while len(batch) < batch_size:
            try:
                batch.append(self._queue.get_nowait())
            except Empty:
                break
        return batch

    def _process_batch(self, image_names: list[str]) -> bool:
        """Embed one batch. Returns False when anything in it failed."""
        assert self._invoker is not None
        assert self._encode_fn is not None
        assert self._model_id is not None
        logger = self._invoker.services.logger

        try:
            images: list[Image.Image] = []
            loaded_names: list[str] = []
            for name in image_names:
                try:
                    images.append(self._invoker.services.images.get_pil_image(name).convert("RGB"))
                    loaded_names.append(name)
                except Exception as e:
                    logger.warning(f"Image index: could not load '{name}' ({e})")
                    self._record_failure([name])

            if not loaded_names:
                return False

            try:
                embeddings = np.asarray(self._encode_fn(images), dtype=EMBEDDING_DTYPE)
            except Exception:
                logger.exception(f"Image index: failed to embed a batch of {len(loaded_names)} images")
                self._record_failure(loaded_names)
                return False

            if embeddings.ndim != 2 or embeddings.shape[0] != len(loaded_names):
                logger.error(f"Image index: encoder returned shape {embeddings.shape} for {len(loaded_names)} images")
                self._record_failure(loaded_names)
                return False

            # L2-normalize so cosine similarity is a plain dot product downstream.
            norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            embeddings = embeddings / norms

            stored: list[str] = []
            try:
                for name, embedding in zip(loaded_names, embeddings, strict=True):
                    self._invoker.services.image_index_records.upsert_embedding(name, self._model_id, embedding)
                    stored.append(name)
                    self._attempts.pop(name, None)
                    # An image that recovers (e.g. re-embedded after an
                    # update) must stop counting against the failed total.
                    self._failed.discard(name)
            except Exception:
                # A raise here (e.g. "database is locked") must still route
                # the unstored names through the failure path, or they linger
                # unembedded — with pending stuck above zero — until restart.
                logger.exception(f"Image index: failed to store embeddings for a batch of {len(loaded_names)} images")
                self._record_failure([name for name in loaded_names if name not in stored])
                return False
            finally:
                self._record_owner_pokes(stored)
            return len(loaded_names) == len(image_names)
        finally:
            # Always release the batch from the dedup set — a name stuck in
            # _pending can never be re-enqueued by callbacks.
            self._forget_pending(image_names)

    def _record_failure(self, image_names: list[str]) -> None:
        """Count a failure; move an image to the permanent-failure set only after repeated attempts."""
        for name in image_names:
            attempts = self._attempts.get(name, 0) + 1
            self._attempts[name] = attempts
            if attempts >= _MAX_ATTEMPTS:
                self._failed.add(name)

    def _forget_pending(self, image_names: list[str]) -> None:
        with self._pending_lock:
            self._pending.difference_update(image_names)

    # --- Projections ---

    def _next_projection_job(self) -> Optional[tuple[str, bool]]:
        with self._projection_lock:
            if not self._projection_requests:
                return None
            user_id = next(iter(self._projection_requests))
            return user_id, self._projection_requests.pop(user_id)

    def _process_projection(self, user_id: str, all_images: bool) -> None:
        assert self._invoker is not None
        assert self._model_id is not None
        logger = self._invoker.services.logger
        records = self._invoker.services.image_index_records

        scope_user = None if all_images else user_id
        names = records.list_accessible_embedded_images(scope_user, self._model_id)
        found_names, matrix = records.get_embeddings(names, self._model_id)
        try:
            coords = compute_umap(matrix)
            if coords.shape[0] != len(found_names):
                raise RuntimeError(f"projection produced {coords.shape[0]} points for {len(found_names)} images")
        except Exception:
            logger.exception(f"Image map: UMAP projection failed for user '{user_id}' ({len(found_names)} points)")
            # Cache an empty projection under the CURRENT scope hash. Serving
            # "empty" is honest, and it stops the client from re-enqueueing a
            # doomed recompute on every poll; the next gallery change flips
            # the hash and retries naturally.
            found_names = []
            coords = np.empty((0, 2), dtype=EMBEDDING_DTYPE)

        # Hash the scope the projection was computed against (on failure the
        # empty cache still claims the current scope, so staleness detection —
        # not client polling — decides when to retry).
        records.set_projection(
            user_id,
            self._model_id,
            scope_hash(self._model_id, names),
            projection_params(n_points=len(found_names)),
            found_names,
            coords,
        )
        self._invoker.services.events.emit_image_map_projection_ready(user_id=user_id, point_count=len(found_names))

    def _wait_for_idle_generation(self) -> None:
        """Block until no generation is in progress, unless embedding on CPU.

        The embedding model shares the model cache (and therefore VRAM) with
        generation; embedding on the GPU mid-generation would thrash both.
        """
        assert self._invoker is not None
        if self._device().type == "cpu":
            return
        session_queue = self._invoker.services.session_queue
        if session_queue is None:
            return
        while not self._stop_event.is_set():
            try:
                status = session_queue.get_queue_status(DEFAULT_QUEUE_ID)
            except Exception:
                return
            if status.in_progress == 0:
                return
            self._stop_event.wait(_POLL_SECONDS)

    def _emit_status(self) -> None:
        assert self._invoker is not None
        status = self.get_status()
        if status is None:
            return
        self._invoker.services.events.emit_image_index_status(
            total=status.total, embedded=status.embedded, pending=status.pending
        )

    def _record_owner_pokes(self, image_names: list[str]) -> None:
        """Queue a per-user poke for each owner of freshly stored embeddings.

        The status event is admin-only (its counts aggregate every user's
        images), so without this, non-admin clients would never hear that
        their own generations reached the index. Owner lookups are DB reads,
        which is fine here: this runs on the worker thread.
        """
        assert self._invoker is not None
        for name in image_names:
            try:
                user_id = self._invoker.services.image_records.get_user_id(name)
            except Exception:
                continue
            if user_id:
                self._pending_pokes.add(user_id)

    # --- Model handling ---

    def _model_not_installed_message(self, model_name: str) -> str:
        assert self._invoker is not None
        # The starter catalog ships same-named models of different types (the
        # 'clip-vit-large-patch14' CLIP-L text encoder vs. the CLIP Vision
        # image encoder), so name the type mismatch when that is the problem.
        # search_by_attr drops the name filter for a falsy name and would
        # return every installed model.
        same_name = (
            self._invoker.services.model_manager.store.search_by_attr(model_name=model_name) if model_name else []
        )
        if same_name:
            types = ", ".join(sorted({config.type.value for config in same_name}))
            return (
                f"Image indexing is enabled, but the installed model named '{model_name}' is of type "
                f"'{types}', not a CLIP Vision or SigLIP image encoder. Install the image-encoder model of "
                "the same name (for the default, the 'CLIP ViT-L Image Encoder' starter model from source "
                "'InvokeAI/clip-vit-large-patch14'). The image index will not be updated."
            )
        return (
            f"Image indexing is enabled but the embedding model '{model_name}' is not installed "
            "(expected a CLIP Vision or SigLIP model). The image index will not be updated."
        )

    def _resolve_model_config(self, model_name: str) -> Optional["AnyModelConfig"]:
        assert self._invoker is not None
        store = self._invoker.services.model_manager.store
        for model_type in (ModelType.CLIPVision, ModelType.SigLIP):
            configs = store.search_by_attr(model_name=model_name, model_type=model_type)
            if len(configs) > 1:
                # Names are not unique. A different pick after a reinstall
                # changes the model hash and discards the whole index.
                self._invoker.services.logger.warning(
                    f"Multiple {model_type.value} models named '{model_name}' are installed; "
                    f"using '{configs[0].key}' for the image index"
                )
            if configs:
                return configs[0]
        return None

    def _device(self) -> torch.device:
        override = self._invoker.services.configuration.image_index_device if self._invoker else None
        if override:
            return torch.device(override)
        return TorchDevice.choose_torch_device()

    def _model_abs_path(self) -> Path:
        assert self._invoker is not None
        assert self._model_config is not None
        model_path = Path(self._model_config.path)
        if model_path.is_absolute():
            return model_path
        return self._invoker.services.configuration.models_path / model_path

    def _get_processor(self) -> Any:
        # embed_image runs on request threads concurrently with the worker,
        # so the lazy init must be guarded (like _get_text_encoder).
        with self._vision_init_lock:
            if self._processor is None:
                from transformers import CLIPImageProcessor, SiglipImageProcessor

                assert self._model_config is not None
                processor_cls = (
                    SiglipImageProcessor if self._model_config.type is ModelType.SigLIP else CLIPImageProcessor
                )
                try:
                    self._processor = processor_cls.from_pretrained(str(self._model_abs_path()), local_files_only=True)
                except OSError:
                    # InvokeAI-published CLIP Vision model dirs ship no
                    # preprocessor_config.json; IP-Adapter and FLUX construct the
                    # processor with defaults for the same reason.
                    self._processor = processor_cls()
            return self._processor

    def _embed(self, model: Any, images: list[Image.Image], device: torch.device) -> np.ndarray:
        from transformers import CLIPVisionModelWithProjection, SiglipVisionModel

        with torch.no_grad():
            inputs = self._get_processor()(images=images, return_tensors="pt")
            # The cached model may be fp16 on GPU; inputs must match its dtype.
            pixel_values = inputs["pixel_values"].to(device=device, dtype=next(model.parameters()).dtype)
            if isinstance(model, SiglipVisionModel):
                embeddings = model(pixel_values=pixel_values).pooler_output
            elif isinstance(model, CLIPVisionModelWithProjection):
                embeddings = model(pixel_values=pixel_values).image_embeds
            else:
                raise TypeError(f"Unsupported embedding model class: {type(model).__name__}")
            return embeddings.float().cpu().numpy()

    def _encode_with_model(self, images: list[Image.Image]) -> np.ndarray:
        assert self._invoker is not None
        assert self._model_config is not None

        if self._device().type == "cpu":
            # CPU mode exists to avoid touching the model cache (and VRAM) at
            # all, so it keeps its own RAM-resident copy of the model. The
            # lazy init is guarded: embed_image calls in from request threads.
            with self._vision_init_lock:
                if self._cpu_model is None:
                    from transformers import CLIPVisionModelWithProjection, SiglipVisionModel

                    model_path = str(self._model_abs_path())
                    model_cls = (
                        SiglipVisionModel
                        if self._model_config.type is ModelType.SigLIP
                        else CLIPVisionModelWithProjection
                    )
                    # skip_torch_weight_init serializes torch module construction
                    # process-wide (see _get_text_encoder).
                    with skip_torch_weight_init():
                        model = model_cls.from_pretrained(model_path, local_files_only=True)
                    model.eval()
                    self._cpu_model = model
            return self._embed(self._cpu_model, images, torch.device("cpu"))

        loaded = self._invoker.services.model_manager.load.load_model(self._model_config)
        with loaded.model_on_device() as (_, model):
            # The cache decides where the model actually lives; follow it.
            device = next(model.parameters()).device
            return self._embed(model, images, device)
