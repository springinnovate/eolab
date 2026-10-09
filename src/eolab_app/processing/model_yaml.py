"""Read, write and checksum Model YAML recipes and Run YAML records.

Documents use JSON-compatible values so their meaning survives conversion
between YAML, API requests and database records. The reader rejects ambiguous
or executable YAML features and checks size, nesting and token limits before
constructing Python objects.
"""

import hashlib
import json
from typing import Any

import yaml

from eolab_app.processing.models import ProcessingError

MAX_MODEL_YAML_BYTES = 64 * 1024
MAX_RUN_YAML_BYTES = 256 * 1024


def encode_canonical_json(value: Any) -> bytes:
    """Encode data as consistently ordered JSON for checksums and comparisons.

    Args:
        value: JSON-compatible data to encode.

    Returns:
        UTF-8 JSON bytes with sorted keys and no optional whitespace.

    Raises:
        ValueError: If a number is NaN or infinite.
        TypeError: If a value cannot be represented in JSON.
    """
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def compute_document_checksum(value: Any) -> str:
    """Compute a SHA-256 checksum of data, independent of YAML formatting.

    Args:
        value: JSON-compatible data, such as a model definition or source signature.

    Returns:
        A lowercase SHA-256 hexadecimal checksum of its consistently ordered JSON.

    Raises:
        ValueError: If a number is NaN or infinite.
        TypeError: If a value cannot be represented in JSON.
    """
    return hashlib.sha256(encode_canonical_json(value)).hexdigest()


def _yaml_node_to_json_value(node: yaml.Node) -> Any:
    """Convert parsed YAML nodes into JSON-compatible Python values.

    Args:
        node: A YAML node after the document's size, nesting and token checks.

    Returns:
        A dictionary, list, string, number, boolean or None.

    Raises:
        ValueError: If a mapping repeats keys, uses non-string keys, or a value
            has an unsupported type or is NaN or infinite.
    """
    if isinstance(node, yaml.MappingNode):
        result = {}
        for key, value in node.value:
            if key.tag != "tag:yaml.org,2002:str" or key.value == "<<":
                raise ValueError("Mapping keys must be strings; merges are unsupported")
            if key.value in result:
                raise ValueError("Duplicate mapping key")
            result[key.value] = _yaml_node_to_json_value(value)
        return result
    if isinstance(node, yaml.SequenceNode):
        return [_yaml_node_to_json_value(value) for value in node.value]
    tag = node.tag.removeprefix("tag:yaml.org,2002:")
    if tag == "str":
        return node.value
    if tag not in {"null", "bool", "int", "float"}:
        raise ValueError("Only JSON-compatible YAML scalars are supported")
    loader = yaml.SafeLoader("")
    try:
        result = loader.construct_object(node)
        encode_canonical_json(result)
        return result
    finally:
        loader.dispose()


def parse_yaml(data: bytes, *, run: bool = False) -> dict[str, Any]:
    """Read one Model YAML or Run YAML document into a dictionary.

    Model documents allow 64 KiB, 16 nesting levels and 2,048 counted nodes/tokens;
    run documents allow 256 KiB, 32 levels and 8,192 counted nodes/tokens. Duplicate
    keys, aliases, anchors, tags, directives and non-JSON values are rejected.
    Recipe and run schemas validate the returned dictionary separately.

    Args:
        data: The document's UTF-8 bytes.
        run: True to use the larger limits for a Run YAML document.

    Returns:
        A dictionary containing the document's JSON-compatible values.

    Raises:
        ProcessingError: If the document is malformed, oversized or uses unsupported YAML.
    """
    limit, depth_limit, node_limit = (
        (MAX_RUN_YAML_BYTES, 32, 8192) if run else (MAX_MODEL_YAML_BYTES, 16, 2048)
    )
    try:
        if len(data) > limit:
            raise ValueError("Document byte limit exceeded")
        text = data.decode("utf-8")
        depth = nodes = 0
        for token in yaml.scan(text):
            if isinstance(
                token,
                (yaml.AliasToken, yaml.AnchorToken, yaml.TagToken, yaml.DirectiveToken),
            ):
                raise ValueError(
                    "Aliases, anchors, tags and directives are unsupported"
                )
            if isinstance(
                token,
                (
                    yaml.BlockMappingStartToken,
                    yaml.BlockSequenceStartToken,
                    yaml.FlowMappingStartToken,
                    yaml.FlowSequenceStartToken,
                ),
            ):
                depth += 1
                nodes += 1
            elif isinstance(
                token,
                (
                    yaml.BlockEndToken,
                    yaml.FlowMappingEndToken,
                    yaml.FlowSequenceEndToken,
                ),
            ):
                depth -= 1
            elif isinstance(token, yaml.ScalarToken):
                nodes += 1
            if depth > depth_limit or nodes > node_limit:
                raise ValueError("Document structure limit exceeded")
        documents = list(yaml.compose_all(text, Loader=yaml.SafeLoader))
        if len(documents) != 1 or not isinstance(documents[0], yaml.MappingNode):
            raise ValueError("Expected one mapping document")
        return _yaml_node_to_json_value(documents[0])
    except (
        ValueError,
        TypeError,
        UnicodeError,
        yaml.YAMLError,
        RecursionError,
    ) as error:
        raise ProcessingError(
            "invalid_model_yaml",
            "The YAML document is invalid or exceeds model limits.",
        ) from error


def export_yaml(value: dict[str, Any], *, run: bool = False) -> bytes:
    """Write Model YAML or Run YAML and verify it reads back with the same values.

    Args:
        value: A validated model definition or run record.
        run: True to use the size and nesting limits for Run YAML.

    Returns:
        UTF-8 YAML bytes preserving the supplied values and types.

    Raises:
        ProcessingError: If the output exceeds document limits or changes on re-reading.
        ValueError: If a number is NaN or infinite.
        TypeError: If a supplied value cannot be represented in JSON.
    """
    # JSON normalization removes shared object references, so the exporter never
    # introduces YAML aliases that the input contract deliberately rejects.
    normalized = json.loads(encode_canonical_json(value))
    data = yaml.safe_dump(normalized, allow_unicode=True, sort_keys=False).encode(
        "utf-8"
    )
    if encode_canonical_json(parse_yaml(data, run=run)) != encode_canonical_json(value):
        raise ProcessingError(
            "invalid_model_yaml", "The model document cannot be exported faithfully."
        )
    return data
