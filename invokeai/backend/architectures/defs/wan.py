"""What the wan architecture declares."""

from invokeai.backend.architectures.registry import register
from invokeai.backend.model_manager.taxonomy import BaseModelType

register(BaseModelType.Wan)
