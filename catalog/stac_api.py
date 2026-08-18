"""Configure the pinned pgSTAC API with Item free-text search enabled."""

from contextlib import asynccontextmanager
from typing import cast

from brotli_asgi import BrotliMiddleware
from fastapi import APIRouter, FastAPI
from stac_fastapi.api.app import StacApi
from stac_fastapi.api.middleware import ProxyHeaderMiddleware
from stac_fastapi.api.models import (
    EmptyRequest,
    ItemCollectionUri,
    JSONResponse,
    create_get_request_model,
    create_post_request_model,
    create_request_model,
)
from stac_fastapi.extensions import (
    BulkTransactionExtension,
    CollectionSearchExtension,
    CollectionSearchFilterExtension,
    FieldsExtension,
    ItemCollectionFilterExtension,
    OffsetPaginationExtension,
    SearchFilterExtension,
    SortExtension,
    TokenPaginationExtension,
    TransactionExtension,
)
from stac_fastapi.extensions.fields import FieldsConformanceClasses
from stac_fastapi.extensions.free_text import FreeTextConformanceClasses
from stac_fastapi.extensions.query import QueryConformanceClasses
from stac_fastapi.extensions.sort import SortConformanceClasses
from stac_fastapi.types.extension import ApiExtension
from stac_fastapi.types.search import APIRequest
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware

from stac_fastapi.pgstac.config import Settings
from stac_fastapi.pgstac.core import CoreCrudClient, health_check
from stac_fastapi.pgstac.db import close_db_connection, connect_to_db
from stac_fastapi.pgstac.extensions import FreeTextExtension, QueryExtension
from stac_fastapi.pgstac.extensions.filter import FiltersClient
from stac_fastapi.pgstac.transactions import (
    BulkTransactionsClient,
    TransactionsClient,
)
from stac_fastapi.pgstac.types.search import PgstacSearch


def create_app() -> FastAPI:
    """Create the STAC API with standard Item and Collection free-text search."""
    settings = Settings()
    # stac-fastapi-pgstac 6.3.1 wires free-text search into Collections but not
    # Item Search. Use the same upstream extension for the standard Item q field.
    search_extensions_map: dict[str, ApiExtension] = {
        "query": QueryExtension(),
        "sort": SortExtension(),
        "fields": FieldsExtension(),
        "filter": SearchFilterExtension(client=FiltersClient()),
        "free_text": FreeTextExtension(),
        "pagination": TokenPaginationExtension(),
    }
    collection_extensions_map: dict[str, ApiExtension] = {
        "query": QueryExtension(
            conformance_classes=[QueryConformanceClasses.COLLECTIONS]
        ),
        "sort": SortExtension(
            conformance_classes=[SortConformanceClasses.COLLECTIONS]
        ),
        "fields": FieldsExtension(
            conformance_classes=[FieldsConformanceClasses.COLLECTIONS]
        ),
        "filter": CollectionSearchFilterExtension(client=FiltersClient()),
        "free_text": FreeTextExtension(
            conformance_classes=[FreeTextConformanceClasses.COLLECTIONS]
        ),
        "pagination": OffsetPaginationExtension(),
    }
    item_extensions_map: dict[str, ApiExtension] = {
        "query": QueryExtension(
            conformance_classes=[QueryConformanceClasses.ITEMS]
        ),
        "sort": SortExtension(conformance_classes=[SortConformanceClasses.ITEMS]),
        "fields": FieldsExtension(
            conformance_classes=[FieldsConformanceClasses.ITEMS]
        ),
        "filter": ItemCollectionFilterExtension(client=FiltersClient()),
        "pagination": TokenPaginationExtension(),
    }

    enabled_extension_names = (
        set(settings.enabled_extensions.split(","))
        if settings.enabled_extensions
        else {
            *search_extensions_map,
            *collection_extensions_map,
            *item_extensions_map,
            "collection_search",
        }
    )
    search_extensions = [
        extension
        for name, extension in search_extensions_map.items()
        if name in enabled_extension_names
    ]
    item_extensions = [
        extension
        for name, extension in item_extensions_map.items()
        if name in enabled_extension_names
    ]
    collection_extensions = [
        extension
        for name, extension in collection_extensions_map.items()
        if name in enabled_extension_names
    ]

    post_search_model = create_post_request_model(
        search_extensions,
        base_model=PgstacSearch,
    )
    get_search_model = create_get_request_model(search_extensions)
    item_collection_model: type[APIRequest] = ItemCollectionUri
    if item_extensions:
        item_collection_model = cast(
            type[APIRequest],
            create_request_model(
                model_name="ItemCollectionUri",
                base_model=ItemCollectionUri,
                extensions=item_extensions,
                request_type="GET",
            ),
        )
    collections_model: type[APIRequest] = EmptyRequest
    collection_search_extension = None
    if "collection_search" in enabled_extension_names:
        collection_search_extension = CollectionSearchExtension.from_extensions(
            collection_extensions
        )
        collections_model = collection_search_extension.GET

    transaction_extensions: list[ApiExtension] = []
    if settings.enable_transactions_extensions:
        transaction_extensions = [
            TransactionExtension(
                client=TransactionsClient(),
                settings=settings,
                response_class=JSONResponse,
            ),
            BulkTransactionExtension(client=BulkTransactionsClient()),
        ]
    application_extensions = [
        *transaction_extensions,
        *search_extensions,
        *item_extensions,
    ]
    if collection_search_extension is not None:
        application_extensions.append(collection_search_extension)

    @asynccontextmanager
    async def lifespan(application: FastAPI):
        """Open the configured pgSTAC connection pools for the API lifespan."""
        await connect_to_db(
            application,
            add_write_connection_pool=bool(transaction_extensions),
        )
        yield
        await close_db_connection(application)

    api = StacApi(
        app=FastAPI(
            openapi_url=settings.openapi_url,
            docs_url=settings.docs_url,
            redoc_url=None,
            root_path=settings.root_path,
            title=settings.stac_fastapi_title,
            version=settings.stac_fastapi_version,
            description=settings.stac_fastapi_description,
            lifespan=lifespan,
        ),
        router=APIRouter(prefix=settings.prefix_path),
        settings=settings,
        extensions=application_extensions,
        client=CoreCrudClient(pgstac_search_model=post_search_model),
        response_class=JSONResponse,
        items_get_request_model=item_collection_model,
        search_get_request_model=get_search_model,
        search_post_request_model=post_search_model,
        collections_get_request_model=collections_model,
        middlewares=[
            Middleware(BrotliMiddleware),
            Middleware(ProxyHeaderMiddleware),
            Middleware(
                CORSMiddleware,
                allow_origins=settings.cors_origins,
                allow_origin_regex=settings.cors_origin_regex,
                allow_methods=settings.cors_methods,
                allow_credentials=settings.cors_credentials,
                allow_headers=settings.cors_headers,
                max_age=600,
            ),
        ],
        health_check=health_check,
    )
    return api.app
