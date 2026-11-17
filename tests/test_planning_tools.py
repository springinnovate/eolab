"""Exercise Planning documents, author isolation and source-validation boundaries."""

import asyncio
from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from threading import Event
from typing import Any
from uuid import UUID, uuid4

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.testclient import TestClient
from pydantic import ValidationError
import pytest
import httpx2

from eolab_app.attribute_filter import VectorFilter
from eolab_app.catalog_selection import CatalogSelection
from eolab_app.planning.models import (
    MAX_REQUEST_BYTES,
    PlanningError,
    PlanningTool,
    PlanningToolDocument,
    PlanningToolSummary,
    UpdatePlanningTool,
)
from eolab_app.planning.service import PlanningToolService
from eolab_app.planning.store import PlanningToolStore
from eolab_app.routes.planning_tools import create_planning_tools_router
from eolab_app.vector.errors import VectorConflictError
from eolab_app.vector.filters import CatalogVectorFilterRequest
from eolab_app.vector.parcel_models import ParcelIdRequest, ParcelIdValidationResponse
from test_outline_jobs import outline_case

BASE = "/api/planning/tools"
HEADERS = {"X-EOLab-Planning": "1"}


def tool_document() -> dict[str, Any]:
    """Return two durable views of one Catalog source with different role filters.

    Returns:
        Independent JSON-shaped configuration with opaque layer/intervention IDs.
    """
    first, second = str(uuid4()), str(uuid4())
    layer = {
        "catalogItem": {"collection": "eolab-mounted-vectors", "id": "regions"},
        "isCustom": True,
        "customName": "Watershed",
        "visible": True,
        "opacity": 0.7,
        "legendIncluded": False,
        "style": {
            "kind": "vector",
            "definition": {"geometryKind": "polygon", "fillColor": "#123456"},
        },
        "filter": {"enabled": True, "match": "all", "rules": []},
    }
    parcels = deepcopy(layer)
    parcels["customName"] = "Parcels"
    parcels["filter"]["rules"] = [{"field": "area", "operator": "gt", "value": 10}]
    return {
        "title": "Watershed restoration",
        "layers": [
            {"id": first, "definition": layer},
            {"id": second, "definition": parcels},
        ],
        "aoiLayerId": first,
        "parcelLayerId": second,
        "parcelIdField": "parcel_id",
        "interventions": [
            {"id": str(uuid4()), "label": "Reforestation"},
            {"id": str(uuid4()), "label": "Silvopasture"},
        ],
    }


class MemoryPlanningStore(PlanningToolStore):
    """Retain owned records for HTTP/service checks without replacing PostgreSQL tests."""

    def __init__(self) -> None:
        """Initialize isolated records and a schema-startup observation event."""
        self.records: dict[UUID, tuple[str, PlanningTool]] = {}
        self.initialized = Event()

    def initialize_schema(self) -> None:
        """Record independent schema initialization without a database connection."""
        self.initialized.set()

    def create_tool(self, owner: str, document: PlanningToolDocument) -> PlanningTool:
        """Retain an owned tool for this fixture.

        Args:
            owner: Test browser identity.
            document: Validated definition.

        Returns:
            Newly created record.
        """
        now = datetime.now(timezone.utc)
        result = PlanningTool(
            **document.model_dump(exclude_unset=True),
            id=uuid4(),
            revision=1,
            createdAt=now,
            updatedAt=now,
        )
        self.records[result.id] = (owner, result)
        return result

    def get_tool(self, owner: str, identifier: UUID) -> PlanningTool:
        """Return an owned test record or the same private not-found error.

        Args:
            owner: Requesting browser identity.
            identifier: Requested record.

        Returns:
            Current owned record.

        Raises:
            PlanningError: The record is absent or belongs to another browser.
        """
        stored = self.records.get(identifier)
        if stored is None or stored[0] != owner:
            raise PlanningError(404, "Planning tool not found.")
        return stored[1]

    def list_tools(self, owner: str) -> list[PlanningToolSummary]:
        """List this fixture author's summaries.

        Args:
            owner: Requesting browser identity.

        Returns:
            Only owned summaries.
        """
        return [
            PlanningToolSummary.model_validate(
                record.model_dump(
                    include={"id", "title", "revision", "createdAt", "updatedAt"}
                )
            )
            for author, record in self.records.values()
            if author == owner
        ]

    def update_tool(
        self,
        owner: str,
        identifier: UUID,
        expected_revision: int,
        document: PlanningToolDocument,
    ) -> PlanningTool:
        """Check the fixture revision again before replacing a definition.

        Args:
            owner: Requesting browser identity.
            identifier: Existing record.
            expected_revision: Last acknowledged revision.
            document: Validated replacement.

        Returns:
            Updated record.

        Raises:
            PlanningError: Ownership or revision prevents the update.
        """
        self.require_revision(owner, identifier, expected_revision)
        previous = self.get_tool(owner, identifier)
        result = PlanningTool(
            **document.model_dump(exclude_unset=True),
            id=identifier,
            revision=expected_revision + 1,
            createdAt=previous.createdAt,
            updatedAt=datetime.now(timezone.utc),
        )
        self.records[identifier] = (owner, result)
        return result


async def authorize_layer(request: CatalogVectorFilterRequest) -> CatalogSelection:
    """Return an authoritative fixture source while preserving ordinary filter state.

    Args:
        request: Layer identity, live predicate and ordered calculations.

    Returns:
        Accepted original asset/layer descriptor.
    """
    return CatalogSelection(
        **request.model_dump(by_alias=True), assetKey="data", layerName="parcels"
    )


async def validate_ids(request: ParcelIdRequest) -> ParcelIdValidationResponse:
    """Represent complete validation by the existing parcel capability.

    Args:
        request: Original source and chosen parcel ID column.

    Returns:
        Successful whole-layer validation without the current live filter.
    """
    source = CatalogVectorFilterRequest(
        collectionId=request.collection_id,
        itemId=request.item_id,
        filter=VectorFilter(),
    )
    return ParcelIdValidationResponse(
        idField=request.idField,
        idType="string",
        featureCount=7,
        selection=await authorize_layer(source),
    )


def make_app(store: PlanningToolStore) -> FastAPI:
    """Compose the actual Planning service/router around an isolated store.

    Args:
        store: Memory or real PostgreSQL store.

    Returns:
        FastAPI app using independent source-validation fixtures.
    """
    app = FastAPI()
    app.include_router(
        create_planning_tools_router(
            PlanningToolService(store, authorize_layer, validate_ids)
        )
    )
    return app


def test_document_preserves_two_filtered_clones_and_allows_shared_role() -> None:
    """Keep duplicate source views distinct through stored durable role bindings."""
    original = tool_document()
    parsed = PlanningToolDocument.model_validate(original)
    assert parsed.model_dump(mode="json", exclude_unset=True) == original
    shared = deepcopy(original)
    shared["layers"] = shared["layers"][:1]
    shared["parcelLayerId"] = shared["aoiLayerId"]
    assert PlanningToolDocument.model_validate(shared).aoiLayerId == UUID(
        shared["aoiLayerId"]
    )


@pytest.mark.parametrize(
    "invalid",
    [
        "runtime",
        "geometry",
        "upload",
        "artifact",
        "ordinary",
        "raster",
        "binding",
        "intervention",
        "source",
    ],
)
def test_document_rejects_unapproved_layers_and_role_state(invalid: str) -> None:
    """Reject runtime/private-source/geometry payloads and inconsistent durable roles.

    Args:
        invalid: Independent invalid contract case.
    """
    document = tool_document()
    layer = document["layers"][0]
    if invalid == "runtime":
        layer["runtimeKey"] = "map-row-1"
    elif invalid == "geometry":
        layer["definition"]["geometry"] = {"type": "Polygon", "coordinates": []}
    elif invalid in {"upload", "artifact"}:
        layer["definition"].pop("catalogItem")
        layer["definition"]["uploadId" if invalid == "upload" else "runArtifact"] = str(
            uuid4()
        )
    elif invalid == "ordinary":
        layer["definition"]["isCustom"] = False
    elif invalid == "raster":
        layer["definition"]["style"]["kind"] = "raster"
    elif invalid == "binding":
        document["aoiLayerId"] = str(uuid4())
    elif invalid == "intervention":
        document["interventions"][1]["label"] = " REFORESTATION "
    elif invalid == "source":
        layer["definition"]["catalogItem"]["collection"] = "rasters"
    with pytest.raises(ValidationError):
        PlanningToolDocument.model_validate(document)


def test_http_author_isolation_revisions_and_private_headers() -> None:
    """Keep two browsers independent and reject stale writes through actual routes."""
    store = MemoryPlanningStore()
    app = make_app(store)
    with (
        TestClient(app, base_url="https://testserver", headers=HEADERS) as author,
        TestClient(app, base_url="https://testserver", headers=HEADERS) as other,
    ):
        response = author.post(BASE, json=tool_document())
        assert response.status_code == 201, response.text
        record = response.json()
        location = response.headers["location"]
        assert location == f"{BASE}/{record['id']}"
        assert response.headers["cache-control"] == "private, no-store"
        assert "Secure" in response.headers["set-cookie"]
        assert "owner" not in record
        assert author.get(location).json() == record
        assert [item["id"] for item in author.get(BASE).json()] == [record["id"]]
        assert other.get(BASE).json() == []
        assert other.get(location).status_code == 404
        replacement = {
            key: value
            for key, value in record.items()
            if key not in {"id", "revision", "createdAt", "updatedAt"}
        }
        replacement.update(title="Revised", expectedRevision=1)
        assert other.put(location, json=replacement).status_code == 404
        changed = author.put(location, json=replacement)
        assert changed.status_code == 200, changed.text
        assert changed.json()["revision"] == 2
        assert author.put(location, json=replacement).status_code == 409
        assert author.get(location).json() == changed.json()


def test_header_origin_size_and_contract_errors_are_private() -> None:
    """Require same-origin mutation intent and reject malformed bodies before source reads."""
    with TestClient(
        make_app(MemoryPlanningStore()), base_url="https://testserver"
    ) as client:
        for headers in ({}, {**HEADERS, "Origin": "https://other.example"}):
            response = client.post(BASE, json=tool_document(), headers=headers)
            assert response.status_code == 403
            assert response.headers["cache-control"] == "private, no-store"
        oversized = client.post(
            BASE, content=b"x" * (MAX_REQUEST_BYTES + 1), headers=HEADERS
        )
        assert oversized.status_code == 413
        assert oversized.headers["cache-control"] == "private, no-store"
        invalid = client.post(BASE, json={"owner": "forged"}, headers=HEADERS)
        assert invalid.status_code == 422
        assert invalid.headers["cache-control"] == "private, no-store"


def test_invalid_source_or_ids_never_write_and_stale_edits_skip_native_work() -> None:
    """Validate author/revision early, then reject source failures before persistence."""

    async def scenario() -> None:
        """Exercise invalid sources and stale revisions without browser-specific behavior."""
        store = MemoryPlanningStore()
        calls: list[str] = []

        async def reject(request: ParcelIdRequest) -> ParcelIdValidationResponse:
            """Reject the original ID column through the vector-owned validation seam.

            Args:
                request: Original parcel source and chosen ID column.

            Raises:
                VectorConflictError: Fixture source contains duplicate IDs.
            """
            calls.append(request.idField)
            raise VectorConflictError("Parcel IDs must be unique")

        service = PlanningToolService(store, authorize_layer, reject)
        document = PlanningToolDocument.model_validate(tool_document())
        with pytest.raises(PlanningError, match="unique") as invalid:
            await service.create_tool("author", document)
        assert invalid.value.status == 422
        assert not store.records
        stored = store.create_tool("author", document)
        update = UpdatePlanningTool(
            **document.model_dump(exclude_unset=True), expectedRevision=2
        )
        with pytest.raises(PlanningError) as stale:
            await service.update_tool("author", stored.id, update)
        assert stale.value.status == 409
        assert calls == [document.parcelIdField]
        assert store.get_tool("author", stored.id) == stored

    asyncio.run(scenario())


def test_http_invalid_parcel_ids_are_configuration_errors_not_revision_conflicts() -> (
    None
):
    """Report duplicate IDs as editable configuration errors rather than stale records."""

    async def reject(request: ParcelIdRequest) -> ParcelIdValidationResponse:
        """Reject this source's duplicate original IDs.

        Args:
            request: Parcel source and selected original ID field.

        Raises:
            VectorConflictError: Fixture original IDs are duplicated.
        """
        raise VectorConflictError("Parcel IDs must be unique")

    store = MemoryPlanningStore()
    app = FastAPI()
    app.include_router(
        create_planning_tools_router(
            PlanningToolService(store, authorize_layer, reject)
        )
    )
    with TestClient(app, base_url="https://testserver", headers=HEADERS) as client:
        response = client.post(BASE, json=tool_document())
        assert response.status_code == 422
        assert "unique" in response.json()["detail"]
        assert not store.records


def test_disconnect_cancels_validation_without_creating_tool() -> None:
    """Abandon in-flight source validation through the existing disconnect coordinator."""

    async def scenario() -> None:
        """Disconnect after native validation starts and require its cancellation."""
        started, cancelled = asyncio.Event(), asyncio.Event()
        store = MemoryPlanningStore()

        async def validate(request: ParcelIdRequest) -> ParcelIdValidationResponse:
            """Wait like a native validation job and expose cancellation to the test.

            Args:
                request: Original parcel source request.

            Raises:
                asyncio.CancelledError: The browser abandoned the request.
            """
            started.set()
            try:
                await asyncio.Future()
            finally:
                cancelled.set()

        async def receive() -> dict[str, str]:
            """Return disconnect only after validation has started.

            Returns:
                ASGI disconnect message.
            """
            await started.wait()
            return {"type": "http.disconnect"}

        router = create_planning_tools_router(
            PlanningToolService(store, authorize_layer, validate)
        )
        endpoint = next(
            route.endpoint
            for route in router.routes
            if route.path == BASE and "POST" in route.methods
        )
        with pytest.raises(HTTPException) as disconnected:
            await endpoint(
                PlanningToolDocument.model_validate(tool_document()),
                Request({"type": "http"}, receive),
                Response(),
                "author",
            )
        assert disconnected.value.status_code == 499
        assert cancelled.is_set() and not store.records

    asyncio.run(scenario())


def test_schema_outage_does_not_block_unrelated_routes() -> None:
    """Keep app startup and other capabilities available while Planning initialization retries."""

    class UnavailableStore(MemoryPlanningStore):
        """Expose startup failure without requiring an unavailable real database."""

        def initialize_schema(self) -> None:
            """Observe initialization and raise the ordinary storage-unavailable error.

            Raises:
                PlanningError: Simulated temporary database outage.
            """
            self.initialized.set()
            raise PlanningError(503, "Unavailable")

    store = UnavailableStore()
    app = make_app(store)

    @app.get("/unrelated")
    def unrelated() -> dict[str, bool]:
        """Return an independent capability's ready state.

        Returns:
            A successful unrelated result.
        """
        return {"ready": True}

    with TestClient(app) as client:
        assert store.initialized.wait(2)
        assert client.get("/unrelated").json() == {"ready": True}


@pytest.mark.parametrize(
    "catalog_case",
    [
        "Polygon",
        "MultiPolygon",
        "Point",
        "null-properties",
        "null-columns",
        "non-object-columns",
    ],
)
def test_application_authorizes_original_polygon_metadata_and_live_filters(
    outline_case: tuple[CatalogSelection, dict[str, Any], str],
    tmp_path: Path,
    configured_environment: None,
    version_file_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    catalog_case: str,
) -> None:
    """Exercise composition's actual Catalog/selection seam without any rendering gate.

    Args:
        outline_case: Real mounted source and authoritative identity fixture.
        tmp_path: Fixture scan mount.
        configured_environment: Complete ordinary application configuration.
        version_file_path: Test application version file.
        monkeypatch: Capture composition's injected source-validation callable.
        catalog_case: Admitted geometry declaration or malformed external Catalog shape.
    """
    from eolab_app.catalog.geopackage import build_stac_items
    from eolab_app.calculated_fields import CalculatedField
    from eolab_app.main import create_app

    selection, _, _ = outline_case
    item = build_stac_items(tmp_path, tmp_path / "polygons.gpkg")[0]
    if catalog_case == "null-properties":
        item["properties"] = None
    elif catalog_case == "null-columns":
        item["properties"]["table:columns"] = None
    elif catalog_case == "non-object-columns":
        item["properties"]["table:columns"] = [None, 7, "Polygon"]
    else:
        primary = item["properties"]["table:primary_geometry"]
        for column in item["properties"]["table:columns"]:
            if column["name"] == primary:
                column["type"] = catalog_case
    captured: list[
        Callable[[CatalogVectorFilterRequest], Awaitable[CatalogSelection]]
    ] = []

    def capture_service(
        store: PlanningToolStore,
        authorize_layer: Callable[
            [CatalogVectorFilterRequest], Awaitable[CatalogSelection]
        ],
        validate_parcel_ids: Callable[
            [ParcelIdRequest], Awaitable[ParcelIdValidationResponse]
        ],
    ) -> PlanningToolService:
        """Capture the actual composition callback while retaining the ordinary service.

        Args:
            store: Production Planning store, unused by this source check.
            authorize_layer: Actual production Catalog polygon authorization.
            validate_parcel_ids: Existing native parcel validation dependency.

        Returns:
            Normally composed Planning service.
        """
        captured.append(authorize_layer)
        return PlanningToolService(store, authorize_layer, validate_parcel_ids)

    def catalog_response(request: httpx2.Request) -> httpx2.Response:
        """Return admitted Catalog metadata without any rendering assessment.

        Args:
            request: Real STAC adapter HTTP request.

        Returns:
            The original fixture Item, independently of GeoServer.
        """
        assert request.url.path.endswith(f"/items/{selection.item_id}")
        return httpx2.Response(200, json=item)

    monkeypatch.setenv("SCAN_MOUNT_PATH", str(tmp_path))
    monkeypatch.setattr("eolab_app.main.PlanningToolService", capture_service)
    create_app(
        version_file_path, catalog_transport=httpx2.MockTransport(catalog_response)
    )
    calculations = (CalculatedField(name="double", expression="'selected' * 2"),)
    request = CatalogVectorFilterRequest(
        collectionId=selection.collection_id,
        itemId=selection.item_id,
        filter=VectorFilter(rules=[{"field": "double", "operator": "gt", "value": 2}]),
        calculatedFields=calculations,
    )
    if catalog_case not in {"Polygon", "MultiPolygon"}:
        with pytest.raises(VectorConflictError, match="polygon"):
            asyncio.run(captured[0](request))
    else:
        result = asyncio.run(captured[0](request))
        assert (result.assetKey, result.layerName) == (
            selection.assetKey,
            selection.layerName,
        )
        assert result.filter == request.filter
        assert result.calculated_fields == calculations
