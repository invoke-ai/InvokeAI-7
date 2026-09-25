"""Library workflows keep the media reference index current, like project documents do."""

import pytest

from invokeai.app.services.invoker import Invoker
from invokeai.app.services.shared.media_references import extract_media_references
from invokeai.app.services.workflow_records.workflow_records_common import (
    Workflow,
    WorkflowCategory,
    WorkflowMeta,
    WorkflowRecordDTO,
    WorkflowWithoutID,
)
from invokeai.app.services.workflow_records.workflow_records_sqlite import SqliteWorkflowRecordsStorage


@pytest.fixture
def workflow_records(mock_invoker: Invoker) -> SqliteWorkflowRecordsStorage:
    return mock_invoker.services.workflow_records


def _workflow(image_name: str) -> WorkflowWithoutID:
    return WorkflowWithoutID(
        name="Refs",
        author="",
        description="",
        version="1.0.0",
        contact="",
        tags="",
        notes="",
        exposedFields=[],
        meta=WorkflowMeta(version="3.0.0", category=WorkflowCategory.User),
        nodes=[{"id": "n1", "data": {"inputs": {"image": {"value": {"image_name": image_name}}}}}],
        edges=[],
    )


def _references(records: SqliteWorkflowRecordsStorage, workflow_id: str) -> set[tuple[str, str, str]]:
    with records._db.transaction() as cursor:
        cursor.execute(
            "SELECT user_id, media_kind, media_name FROM media_references WHERE owner_kind = 'workflow' AND owner_id = ?;",
            (workflow_id,),
        )
        return {tuple(row) for row in cursor.fetchall()}


def test_create_update_and_delete_keep_the_index_current(workflow_records: SqliteWorkflowRecordsStorage) -> None:
    created = workflow_records.create(_workflow("input.png"), user_id="user-1")
    assert _references(workflow_records, created.workflow_id) == {("user-1", "image", "input.png")}

    workflow_records.update(Workflow(**_workflow("replaced.png").model_dump(), id=created.workflow_id))
    assert _references(workflow_records, created.workflow_id) == {("user-1", "image", "replaced.png")}

    workflow_records.delete(created.workflow_id, user_id="user-1")
    assert _references(workflow_records, created.workflow_id) == set()


def test_an_update_refused_by_ownership_leaves_the_index_alone(workflow_records: SqliteWorkflowRecordsStorage) -> None:
    created = workflow_records.create(_workflow("input.png"), user_id="user-1")

    workflow_records.update(Workflow(**_workflow("stolen.png").model_dump(), id=created.workflow_id), user_id="user-2")

    assert _references(workflow_records, created.workflow_id) == {("user-1", "image", "input.png")}


def test_visibility_change_keeps_the_reference_index_of_the_document_it_writes(
    workflow_records: SqliteWorkflowRecordsStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    created = workflow_records.create(_workflow("old.png"), user_id="user-1")
    original_get = workflow_records.get

    def concurrent_edit(workflow_id: str) -> WorkflowRecordDTO:
        previous = original_get(workflow_id)
        monkeypatch.setattr(workflow_records, "get", original_get)
        workflow_records.update(Workflow(**_workflow("new.png").model_dump(), id=workflow_id), user_id="user-1")
        return previous

    monkeypatch.setattr(workflow_records, "get", concurrent_edit)
    workflow_records.update_is_public(created.workflow_id, True, user_id="user-1")
    actual = original_get(created.workflow_id)

    assert _references(workflow_records, created.workflow_id) == {
        ("user-1", "image", name) for name in extract_media_references(actual.workflow.model_dump()).images
    }
