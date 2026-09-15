# Adapted from https://github.com/huggingface/controlnet_aux

from PIL import Image

from invokeai.backend.image_util.util import np_to_pil, pil_to_np

# mediapipe is imported lazily: the package is absent on Windows ARM64, where its only wheel is the
# Tasks-API build without the legacy `solutions` API these modules use, and every node module is
# imported at startup.
MEDIAPIPE_UNAVAILABLE_MESSAGE = (
    "MediaPipe is not available on this platform (its legacy `solutions` API has no Windows ARM64 build), "
    "so the MediaPipe face detection preprocessor and the Face Tools nodes cannot run here."
)


def detect_faces(image: Image.Image, max_faces: int = 1, min_confidence: float = 0.5) -> Image.Image:
    """Detects faces in an image using MediaPipe."""

    try:
        from invokeai.backend.image_util.mediapipe_face.mediapipe_face_common import generate_annotation
    except ImportError as e:
        raise RuntimeError(MEDIAPIPE_UNAVAILABLE_MESSAGE) from e

    np_img = pil_to_np(image)
    detected_map = generate_annotation(np_img, max_faces, min_confidence)
    detected_map_pil = np_to_pil(detected_map)
    return detected_map_pil
