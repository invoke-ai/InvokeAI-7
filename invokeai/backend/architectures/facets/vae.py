"""Which VAEs an architecture can decode with.

Not derivable from the latent geometry. Eight architectures share a 16-channel space at 8x
compression, but their VAEs are not interchangeable: SD 3.5 and CogView 4 are 16-channel too and
belong to neither the Wan/Qwen family nor FLUX's. Compatibility is a fact about the decoder class,
so it is declared.

Nor is it derivable from the VAE's `base` alone. The same physical file is registered under
`anima` or `qwen-image` depending on which family it was installed for -- byte-identical, 194
tensors -- and a `wan` VAE may be either the 16-channel Wan 2.1 file (the same family again) or
TI2V-5B's 48-channel Wan2.2-VAE, which fits nothing else. `VAE_Checkpoint_Wan_Config` already
records `latent_channels`; this facet is what finally reads it.
"""

from dataclasses import dataclass
from typing import ClassVar

from invokeai.backend.architectures.facet import Facet
from invokeai.backend.architectures.registry import get
from invokeai.backend.model_manager.taxonomy import BaseModelType


@dataclass(frozen=True)
class VaeCompatibility:
    """One VAE an architecture accepts, as a model record can be matched against it."""

    base: BaseModelType

    latent_channels: int | None = None
    """Required channel count, where the base alone is ambiguous.

    Only `wan` is: its VAEs carry `latent_channels` of 16 or 48 and only the 16-channel ones belong
    to the shared family. `None` means the base is unambiguous and the field is not consulted --
    which is also what happens for VAE configs that do not carry it.
    """

    def matches(self, vae_base: BaseModelType, vae_latent_channels: int | None = None) -> bool:
        if vae_base != self.base:
            return False
        if self.latent_channels is None:
            return True
        return vae_latent_channels == self.latent_channels


@dataclass(frozen=True)
class VaeFacet(Facet):
    """The VAEs a model of this architecture can be paired with.

    Includes the architecture's own base wherever that is accepted, so the set is complete on its
    own and a consumer never has to add an implicit "or its own".
    """

    REQUIRED: ClassVar[bool] = False

    accepted: frozenset[VaeCompatibility]

    def accepts(self, vae_base: BaseModelType, vae_latent_channels: int | None = None) -> bool:
        return any(entry.matches(vae_base, vae_latent_channels) for entry in self.accepted)

    @property
    def accepted_bases(self) -> frozenset[BaseModelType]:
        """The bases alone, for the UI's first-pass filter and for comparing against a loader's
        `ui_model_base`, which cannot express a channel constraint."""
        return frozenset(entry.base for entry in self.accepted)


def accepts_vae(base: BaseModelType, vae_base: BaseModelType, vae_latent_channels: int | None = None) -> bool:
    """Whether `base` can decode with this VAE.

    Architectures that declare no `VaeFacet` accept only their own base -- the SD family and
    anything whose loader has no VAE input at all.
    """
    facet = get(base, VaeFacet)

    if facet is None:
        return vae_base == base

    return facet.accepts(vae_base, vae_latent_channels)
