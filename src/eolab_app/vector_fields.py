"""Read selected vector attributes in geometry-free native batches."""

from collections.abc import Callable, Mapping
from datetime import date
from threading import Event
from typing import Any


class VectorFieldMissingError(ValueError):
    """A requested attribute is absent from the native layer schema."""


def visit_vector_fields(
    source_path: str,
    layer_name: str | None,
    fields: tuple[str, ...],
    feature_limit: int | None,
    cancel_event: Event,
    visit: Callable[[Mapping[str, Any]], None],
    *,
    open_options: tuple[str, ...] = (),
) -> bool:
    """Visit selected scalar properties without retaining features or geometry.

    Args:
        source_path: Authorized native dataset or GDAL archive-member path.
        layer_name: Exact native layer name, or None for the first layer.
        fields: Unique authoritative attribute names.
        feature_limit: Validated positive maximum rows, or None for the complete source.
        cancel_event: Cancellation checked before reads and callbacks.
        visit: Accumulator called once for each visited row.
        open_options: Format-owned GDAL options preserving the admitted schema.

    Returns:
        Whether the source was exhausted without cancellation. Limited reads
        probe one additional row; native batches contain at most 4,096 rows.

    Raises:
        ValueError: If the layer or selected fields are absent.
        RuntimeError: If GDAL cannot open or read the source.
        OSError: If the underlying source cannot be accessed.
        UnicodeDecodeError: If a native text field contains invalid UTF-8.
    """
    from osgeo import gdal, ogr

    with gdal.ExceptionMgr(), ogr.ExceptionMgr():
        with gdal.OpenEx(
            source_path,
            gdal.OF_VECTOR | gdal.OF_READONLY,
            open_options=list(open_options),
        ) as dataset:
            layer = (
                dataset.GetLayerByName(layer_name)
                if layer_name is not None
                else dataset.GetLayer(0)
            )
            if layer is None:
                raise ValueError("The exact source layer is missing")
            definition = layer.GetLayerDefn()
            field_types = {
                definition.GetFieldDefn(index)
                .GetName(): definition.GetFieldDefn(index)
                .GetTypeName()
                for index in range(definition.GetFieldCount())
            }
            if any(field not in field_types for field in fields):
                raise VectorFieldMissingError(
                    "The selected field is not present in the source layer"
                )
            layer.SetIgnoredFields(
                [
                    "OGR_GEOMETRY",
                    *(field for field in field_types if field not in fields),
                ]
            )
            batch_size = 4096 if feature_limit is None else min(4096, feature_limit + 1)
            options = [
                f"MAX_FEATURES_IN_BATCH={batch_size}",
                f"INCLUDE_FID={'NO' if fields else 'YES'}",
            ]
            visited = 0
            with layer.GetArrowStreamAsNumPy(options) as stream:
                while not cancel_event.is_set():
                    batch = stream.GetNextRecordBatch()
                    if batch is None:
                        return not cancel_event.is_set()
                    row_count = len(next(iter(batch.values())))
                    columns = {field: batch[field].tolist() for field in fields}
                    for index in range(row_count):
                        if cancel_event.is_set():
                            return False
                        if feature_limit is not None and visited == feature_limit:
                            return False
                        visit(
                            {
                                field: normalize_vector_field_value(
                                    columns[field][index], field_types[field]
                                )
                                for field in fields
                            }
                        )
                        visited += 1
                    del batch, columns
            return False


def normalize_vector_field_value(value: Any, field_type: str) -> Any:
    """Decode native text and dates while preserving other scalar values.

    Args:
        value: Python scalar from a native column, with masked values as None.
        field_type: OGR schema type distinguishing text from binary.

    Returns:
        Native Python scalar, decoded UTF-8 string, or ISO date string.

    Raises:
        UnicodeDecodeError: If a text column contains invalid UTF-8.
    """
    if field_type == "String" and isinstance(value, bytes):
        return value.decode("utf-8")
    if field_type == "Date" and isinstance(value, date):
        return value.isoformat()
    return value
