"""The starter-model data types.

A leaf module: it defines the shapes and imports no starter entries, so architecture modules and
`common` can both depend on it.

These are part of the public API -- `GET /starter_models` serves them and they appear in
`openapi.json` -- so the field types must not change.
"""

from typing import Optional

from pydantic import BaseModel

from invokeai.backend.model_manager.configs.external_api import (
    ExternalApiModelDefaultSettings,
    ExternalModelCapabilities,
    ExternalModelPanelSchema,
)
from invokeai.backend.model_manager.taxonomy import (
    AnyVariant,
    BaseModelType,
    ModelFormat,
    ModelType,
)


class StarterModelWithoutDependencies(BaseModel):
    description: str
    source: str
    name: str
    base: BaseModelType
    type: ModelType
    format: Optional[ModelFormat] = None
    variant: Optional[AnyVariant] = None
    is_installed: bool = False
    capabilities: ExternalModelCapabilities | None = None
    default_settings: ExternalApiModelDefaultSettings | None = None
    panel_schema: ExternalModelPanelSchema | None = None
    # allows us to track what models a user has installed across name changes within starter models
    # if you update a starter model name, please add the old one to this list for that starter model
    previous_names: list[str] = []


class StarterModel(StarterModelWithoutDependencies):
    # Optional list of model source dependencies that need to be installed before this model can be used
    dependencies: Optional[list[StarterModelWithoutDependencies]] = None


class StarterModelBundle(BaseModel):
    name: str
    models: list[StarterModel]
