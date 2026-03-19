from fastapi import Depends, FastAPI, Request, status
from sqlalchemy.orm import Session

from .db import get_session, init_db
from .schemas import (
    BulkRegisterRequest,
    CollectionCreate,
    RegisterItemRequest,
    ResolveAssetsRequest,
    SearchRequest,
)
from .service import (
    create_collection,
    delete_item,
    resolve_asset,
    get_item_record,
    provenance_doc,
    register_bulk,
    register_item,
    resolve_assets_doc,
    search_doc,
    serialize_collection_doc,
    serialize_collection_items_doc,
    serialize_root_doc,
)
from .stac import serialize_item

app = FastAPI(title="Immutable STAC Catalog", version="0.1.0")


@app.on_event("startup")
def startup() -> None:
    init_db()


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True}


@app.get("/")
def root(request: Request, session: Session = Depends(get_session)) -> dict:
    return serialize_root_doc(session, str(request.base_url))


@app.get("/collections")
def collections(
    request: Request, session: Session = Depends(get_session)
) -> dict:
    root_doc = serialize_root_doc(session, str(request.base_url))
    child_links = [link for link in root_doc["links"] if link["rel"] == "child"]
    return {
        "collections": [
            serialize_collection_doc(
                session, link["href"].split("/")[-1], str(request.base_url)
            )
            for link in child_links
        ],
        "links": [
            {
                "rel": "self",
                "href": f'{str(request.base_url).rstrip("/")}/collections',
                "type": "application/json",
            },
            {
                "rel": "root",
                "href": str(request.base_url),
                "type": "application/json",
            },
        ],
    }


@app.post("/collections", status_code=status.HTTP_201_CREATED)
def create_collection_route(
    payload: CollectionCreate,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    create_collection(session, payload)
    return serialize_collection_doc(session, payload.id, str(request.base_url))


@app.get("/collections/{collection_id}")
def get_collection(
    collection_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    return serialize_collection_doc(
        session, collection_id, str(request.base_url)
    )


@app.get("/collections/{collection_id}/items")
def collection_items(
    collection_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    return serialize_collection_items_doc(
        session, collection_id, str(request.base_url)
    )


@app.get("/collections/{collection_id}/items/{item_id}")
def item(
    collection_id: str,
    item_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    record = get_item_record(session, collection_id, item_id)
    return serialize_item(record, str(request.base_url))


@app.delete("/collections/{collection_id}/items/{item_id}")
def remove_item(
    collection_id: str,
    item_id: str,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    record = delete_item(session, collection_id, item_id)
    return {
        "deleted": True,
        "item": serialize_item(record, str(request.base_url)),
    }


@app.post("/register", status_code=status.HTTP_201_CREATED)
def register(
    payload: RegisterItemRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    record = register_item(session, payload)
    return serialize_item(record, str(request.base_url))


@app.post("/register/bulk", status_code=status.HTTP_201_CREATED)
def register_bulk_route(
    payload: BulkRegisterRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    records = register_bulk(session, payload.entries)
    return {
        "items": [
            serialize_item(record, str(request.base_url)) for record in records
        ]
    }


@app.post("/search")
def search(
    payload: SearchRequest,
    request: Request,
    session: Session = Depends(get_session),
) -> dict:
    return search_doc(session, payload, str(request.base_url))


@app.get("/resolve/assets/{stable_id}")
def resolve_asset(
    stable_id: str, session: Session = Depends(get_session)
) -> dict:
    return resolve_asset(session, stable_id)


@app.post("/resolve/assets")
def resolve_assets(
    payload: ResolveAssetsRequest, session: Session = Depends(get_session)
) -> dict:
    return resolve_assets_doc(session, payload.asset_ids)


@app.get("/assets/{stable_id}/provenance")
def asset_provenance(
    stable_id: str, session: Session = Depends(get_session)
) -> dict:
    return provenance_doc(session, stable_id)
