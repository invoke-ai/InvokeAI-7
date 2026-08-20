"""GET /api/v2/models/capabilities — the static architecture table.

It touches no service and no database: the rows come from what the architectures declare at import
time. That is what lets this test use a bare client, and it is also the property worth pinning —
a later version that reaches for `ApiDependencies.invoker` would fail here rather than in production.
"""

from fastapi.testclient import TestClient

from invokeai.app.api_app import app
from invokeai.backend.architectures import architecture_capabilities, generative_bases

client = TestClient(app)
URL = "/api/v2/models/capabilities"


def test_it_serves_a_row_for_every_architecture() -> None:
    response = client.get(URL)
    assert response.status_code == 200

    rows = response.json()
    base_rows = [r for r in rows if r["variant"] is None]
    assert {r["base"] for r in base_rows} == {b.value for b in generative_bases()}
    assert len(base_rows) == len(generative_bases()), "one row per architecture, no duplicates"


def test_variant_rows_override_their_base_row() -> None:
    """FLUX is the clearest case: three variants, three genuinely different answers."""
    rows = client.get(URL).json()
    flux = {r["variant"]: r for r in rows if r["base"] == "flux"}

    assert set(flux) == {None, "schnell", "dev_fill"}
    assert flux["schnell"]["defaults"]["steps"] == 4
    assert flux["dev_fill"]["defaults"]["guidance"] == 30.0
    assert flux[None]["defaults"]["steps"] == 28, "the base row is dev"


def test_the_variant_is_the_value_a_client_holds() -> None:
    """Not `str(enum)`, which would serialize as `FluxVariantType.DevFill`."""
    variants = {r["variant"] for r in client.get(URL).json() if r["variant"] is not None}
    assert all("." not in v for v in variants), variants
    assert "dev_fill" in variants


def test_it_needs_no_services() -> None:
    """No auth, no invoker, no database — the same table for every install and every user."""
    assert client.get(URL).status_code == 200


def test_the_response_matches_what_the_registry_renders() -> None:
    """The route is a pass-through; anything it added would be a second source of truth."""
    served = client.get(URL).json()
    rendered = [row.model_dump(mode="json") for row in architecture_capabilities()]
    assert served == rendered


def test_the_rows_are_ordered_stably() -> None:
    """Sorted by base, so a client diffing two responses sees only real changes."""
    rows = client.get(URL).json()
    bases = [r["base"] for r in rows]
    assert bases == sorted(bases)
