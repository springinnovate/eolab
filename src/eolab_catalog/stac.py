import copy
from datetime import UTC, datetime
from typing import Any

STAC_VERSION = '1.1.0'
RASTER_EXTENSION = 'https://stac-extensions.github.io/raster/v2.0.0/schema.json'
PROJECTION_EXTENSION = 'https://stac-extensions.github.io/projection/v2.0.0/schema.json'
FILE_EXTENSION = 'https://stac-extensions.github.io/file/v2.1.0/schema.json'


def now_iso() -> str:
    return datetime.now(UTC).isoformat().replace('+00:00', 'Z')


def ensure_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def normalize_base_url(base_url: str) -> str:
    return base_url[:-1] if base_url.endswith('/') else base_url


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    normalized = value.replace('Z', '+00:00')
    dt = datetime.fromisoformat(normalized)
    return ensure_utc(dt)


def dt_to_str(value: datetime | None) -> str | None:
    value = ensure_utc(value)
    if value is None:
        return None
    return value.isoformat().replace('+00:00', 'Z')


def extract_datetime(item: dict[str, Any]) -> datetime | None:
    properties = item.get('properties') or {}
    for key in ('datetime', 'start_datetime', 'end_datetime'):
        if properties.get(key):
            return parse_dt(properties[key])
    return None


def infer_kind(item: dict[str, Any]) -> str:
    properties = item.get('properties') or {}
    if properties.get('catalog:item_kind') in {'raster', 'vector', 'derived'}:
        return properties['catalog:item_kind']
    assets = item.get('assets') or {}
    for asset in assets.values():
        media_type = (asset.get('type') or '').lower()
        href = (asset.get('href') or '').lower()
        if 'raster:bands' in asset or any(part in media_type for part in ('geotiff', 'cog', 'netcdf', 'x-zarr')) or href.endswith(('.tif', '.tiff', '.cog', '.nc', '.zarr')):
            return 'raster'
    for asset in assets.values():
        media_type = (asset.get('type') or '').lower()
        href = (asset.get('href') or '').lower()
        if any(part in media_type for part in ('geo+json', 'geopackage', 'shapefile', 'parquet')) or href.endswith(('.geojson', '.gpkg', '.shp', '.parquet', '.fgb')):
            return 'vector'
    return 'vector'


def merge_extensions(item: dict[str, Any], kind: str) -> list[str]:
    extensions = list(item.get('stac_extensions') or [])
    has_projection = False
    has_file = False
    has_raster = kind == 'raster'
    if any(key.startswith('proj:') for key in item.keys()):
        has_projection = True
    assets = item.get('assets') or {}
    for asset in assets.values():
        keys = set(asset.keys())
        if any(key.startswith('proj:') for key in keys):
            has_projection = True
        if any(key.startswith('file:') for key in keys):
            has_file = True
        if any(key.startswith('raster:') for key in keys):
            has_raster = True
    if kind == 'raster':
        has_projection = True
        has_file = True
    if kind == 'vector':
        has_file = True
    for extension, enabled in (
        (FILE_EXTENSION, has_file),
        (PROJECTION_EXTENSION, has_projection),
        (RASTER_EXTENSION, has_raster),
    ):
        if enabled and extension not in extensions:
            extensions.append(extension)
    return extensions


def _collect_xy(coords: Any, out: list[tuple[float, float]]) -> None:
    if isinstance(coords, (list, tuple)):
        if coords and isinstance(coords[0], (int, float)):
            if len(coords) >= 2:
                out.append((float(coords[0]), float(coords[1])))
            return
        for value in coords:
            _collect_xy(value, out)


def bbox_from_geometry(geometry: dict[str, Any] | None) -> list[float] | None:
    if not geometry:
        return None
    coords = geometry.get('coordinates')
    points: list[tuple[float, float]] = []
    _collect_xy(coords, points)
    if not points:
        return None
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def bbox_2d(bbox: list[float] | None) -> list[float] | None:
    if not bbox:
        return None
    if len(bbox) >= 4:
        return [float(bbox[0]), float(bbox[1]), float(bbox[-2]), float(bbox[-1])]
    return None


def bbox_overlaps(left: list[float] | None, right: list[float] | None) -> bool:
    lhs = bbox_2d(left)
    rhs = bbox_2d(right)
    if lhs is None or rhs is None:
        return False
    return not (lhs[2] < rhs[0] or lhs[0] > rhs[2] or lhs[3] < rhs[1] or lhs[1] > rhs[3])


def parse_datetime_expr(expr: str | None) -> tuple[datetime | None, datetime | None, bool]:
    if not expr:
        return None, None, False
    if '/' not in expr:
        instant = parse_dt(expr)
        return instant, instant, True
    start_raw, end_raw = expr.split('/', 1)
    start = None if start_raw in {'', '..'} else parse_dt(start_raw)
    end = None if end_raw in {'', '..'} else parse_dt(end_raw)
    return start, end, False


def datetime_matches(value: datetime | None, expr: str | None) -> bool:
    if not expr:
        return True
    value = ensure_utc(value)
    if value is None:
        return False
    start, end, exact = parse_datetime_expr(expr)
    if exact:
        return value == start
    if start and value < start:
        return False
    if end and value > end:
        return False
    return True


def deep_get(doc: Any, path: str) -> Any:
    current = doc
    for part in path.split('.'):
        if not isinstance(current, dict) or part not in current:
            return None
        current = current[part]
    return current


def metadata_matches(item: dict[str, Any], metadata: dict[str, Any]) -> bool:
    if not metadata:
        return True
    properties = item.get('properties') or {}
    for key, expected in metadata.items():
        actual = deep_get(properties, key)
        if actual is None:
            actual = deep_get(item, key)
        if isinstance(expected, list):
            if isinstance(actual, list):
                if not all(value in actual for value in expected):
                    return False
            elif actual not in expected:
                return False
            continue
        if isinstance(actual, list):
            if expected not in actual and actual != expected:
                return False
            continue
        if actual != expected:
            return False
    return True


def canonical_item(
    collection_id: str,
    logical_id: str,
    version: int,
    item: dict[str, Any],
    kind: str,
    workflow_run_id: str | None = None,
    source_asset_ids: list[str] | None = None,
) -> dict[str, Any]:
    doc = copy.deepcopy(item)
    doc['type'] = 'Feature'
    doc['stac_version'] = doc.get('stac_version') or STAC_VERSION
    doc['collection'] = collection_id
    doc['id'] = f'{logical_id}.v{version}'
    properties = copy.deepcopy(doc.get('properties') or {})
    properties['catalog:logical_id'] = logical_id
    properties['catalog:version'] = version
    properties['catalog:item_kind'] = kind
    if workflow_run_id:
        properties['catalog:workflow_run_id'] = workflow_run_id
    if source_asset_ids:
        properties['catalog:lineage_asset_ids'] = list(source_asset_ids)
    doc['properties'] = properties
    doc['bbox'] = doc.get('bbox') or bbox_from_geometry(doc.get('geometry'))
    assets = copy.deepcopy(doc.get('assets') or {})
    if not assets:
        raise ValueError('STAC Item must include at least one asset')
    normalized_assets: dict[str, Any] = {}
    for asset_key, asset in assets.items():
        asset_doc = copy.deepcopy(asset)
        stable_id = asset_doc.get('catalog:stable_id') or f'{collection_id}:{logical_id}:v{version}:{asset_key}'
        asset_doc['catalog:stable_id'] = stable_id
        if 'roles' not in asset_doc:
            asset_doc['roles'] = []
        normalized_assets[asset_key] = asset_doc
    doc['assets'] = normalized_assets
    doc['links'] = [link for link in copy.deepcopy(doc.get('links') or []) if link.get('rel') not in {'self', 'root', 'parent', 'collection'}]
    doc['stac_extensions'] = merge_extensions(doc, kind)
    return doc


def item_links(base_url: str, collection_id: str, item_id: str) -> list[dict[str, Any]]:
    base = normalize_base_url(base_url)
    return [
        {'rel': 'self', 'href': f'{base}/collections/{collection_id}/items/{item_id}', 'type': 'application/geo+json'},
        {'rel': 'root', 'href': f'{base}/', 'type': 'application/json'},
        {'rel': 'parent', 'href': f'{base}/collections/{collection_id}', 'type': 'application/json'},
        {'rel': 'collection', 'href': f'{base}/collections/{collection_id}', 'type': 'application/json'},
    ]


def serialize_item(record: Any, base_url: str) -> dict[str, Any]:
    item = copy.deepcopy(record.raw_json)
    item['links'] = list(item.get('links') or []) + item_links(base_url, record.collection_id, record.item_id)
    return item


def collection_extent(items: list[Any]) -> dict[str, Any]:
    active = [item for item in items if item.deleted_at is None]
    bboxes = [bbox_2d(item.bbox_json) for item in active if bbox_2d(item.bbox_json)]
    datetimes = [item.datetime_value for item in active if item.datetime_value is not None]
    if bboxes:
        xs1 = [bbox[0] for bbox in bboxes]
        ys1 = [bbox[1] for bbox in bboxes]
        xs2 = [bbox[2] for bbox in bboxes]
        ys2 = [bbox[3] for bbox in bboxes]
        spatial = [[min(xs1), min(ys1), max(xs2), max(ys2)]]
    else:
        spatial = [[-180.0, -90.0, 180.0, 90.0]]
    if datetimes:
        temporal = [[dt_to_str(min(datetimes)), dt_to_str(max(datetimes))]]
    else:
        temporal = [[None, None]]
    return {'spatial': {'bbox': spatial}, 'temporal': {'interval': temporal}}


def serialize_collection(record: Any, items: list[Any], base_url: str) -> dict[str, Any]:
    base = normalize_base_url(base_url)
    doc = {
        'stac_version': STAC_VERSION,
        'type': 'Collection',
        'id': record.id,
        'title': record.title,
        'description': record.description,
        'license': record.license,
        'keywords': list(record.keywords_json or []),
        'extent': collection_extent(items),
        'links': [
            {'rel': 'self', 'href': f'{base}/collections/{record.id}', 'type': 'application/json'},
            {'rel': 'root', 'href': f'{base}/', 'type': 'application/json'},
            {'rel': 'parent', 'href': f'{base}/', 'type': 'application/json'},
            {'rel': 'items', 'href': f'{base}/collections/{record.id}/items', 'type': 'application/geo+json'},
            {'rel': 'search', 'href': f'{base}/search', 'type': 'application/geo+json'},
        ],
    }
    doc.update(copy.deepcopy(record.extra_json or {}))
    return doc


def serialize_root(collections: list[Any], base_url: str) -> dict[str, Any]:
    base = normalize_base_url(base_url)
    links = [
        {'rel': 'self', 'href': f'{base}/', 'type': 'application/json'},
        {'rel': 'root', 'href': f'{base}/', 'type': 'application/json'},
        {'rel': 'data', 'href': f'{base}/collections', 'type': 'application/json'},
        {'rel': 'search', 'href': f'{base}/search', 'type': 'application/geo+json'},
    ]
    links.extend({'rel': 'child', 'href': f'{base}/collections/{record.id}', 'title': record.title, 'type': 'application/json'} for record in collections)
    return {
        'stac_version': STAC_VERSION,
        'type': 'Catalog',
        'id': 'root',
        'title': 'Geospatial Catalog',
        'description': 'Immutable STAC catalog service',
        'links': links,
    }


def serialize_item_collection(items: list[dict[str, Any]], matched: int, limit: int, base_url: str) -> dict[str, Any]:
    base = normalize_base_url(base_url)
    return {
        'type': 'FeatureCollection',
        'features': items,
        'links': [
            {'rel': 'root', 'href': f'{base}/', 'type': 'application/json'},
            {'rel': 'search', 'href': f'{base}/search', 'type': 'application/geo+json'},
        ],
        'context': {'returned': len(items), 'matched': matched, 'limit': limit},
        'timeStamp': now_iso(),
    }
