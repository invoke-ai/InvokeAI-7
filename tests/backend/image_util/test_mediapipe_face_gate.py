"""MediaPipe is absent on Windows ARM64 (no wheel carries its legacy `solutions` API there).

The face preprocessor and the Face Tools nodes must still import at startup -- every node module is
imported by `load_all_modules()` -- and fail with a message that names the platform when used.
"""

import sys

import numpy as np
import pytest
from PIL import Image

from invokeai.app.invocations.facetools import generate_face_box_mask
from invokeai.backend.image_util.mediapipe_face import MEDIAPIPE_UNAVAILABLE_MESSAGE, detect_faces


@pytest.fixture
def no_mediapipe(monkeypatch):
    """Make every `import mediapipe...` fail, including modules already cached from earlier tests."""
    for name in [m for m in sys.modules if m == "mediapipe" or m.startswith("mediapipe.")]:
        monkeypatch.delitem(sys.modules, name, raising=False)
    monkeypatch.delitem(sys.modules, "invokeai.backend.image_util.mediapipe_face.mediapipe_face_common", raising=False)
    monkeypatch.setitem(sys.modules, "mediapipe", None)


def _image() -> Image.Image:
    return Image.fromarray(np.zeros((64, 64, 3), dtype=np.uint8))


def test_detect_faces_reports_missing_mediapipe(no_mediapipe):
    with pytest.raises(RuntimeError, match="MediaPipe is not available"):
        detect_faces(_image())


def test_face_box_mask_reports_missing_mediapipe(no_mediapipe):
    with pytest.raises(RuntimeError) as excinfo:
        generate_face_box_mask(context=None, minimum_confidence=0.5, x_offset=0, y_offset=0, pil_image=_image())  # type: ignore[arg-type]
    assert str(excinfo.value) == MEDIAPIPE_UNAVAILABLE_MESSAGE
