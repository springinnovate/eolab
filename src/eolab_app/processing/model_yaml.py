"""Bounded JSON-compatible YAML documents owned by Processing Models."""

import hashlib
import json
from typing import Any

import yaml

from eolab_app.processing.models import ProcessingError

MODEL_BYTES = 64 * 1024
RUN_BYTES = 256 * 1024


def canonical_json(value: Any) -> bytes:
    """Encode a normalized contract value with deterministic JSON ordering.

    Args:
        value: JSON-compatible validated contract value.

    Returns:
        UTF-8 canonical representation.

    Raises:
        ValueError: If a number is nonfinite.
        TypeError: If the value is not JSON-compatible.
    """
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def definition_digest(value: Any) -> str:
    """Hash a normalized definition, independently of YAML formatting.

    Args:
        value: Validated JSON-compatible definition.

    Returns:
        Lowercase SHA-256 hex digest.
    """
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _json_node(node: yaml.Node) -> Any:
    """Convert a bounded YAML tree, rejecting duplicate keys and non-JSON types.

    Args:
        node: Node already bounded by the token scan.

    Returns:
        A JSON-compatible value without aliases or custom construction.

    Raises:
        ValueError: If a key, tag or scalar violates the document contract.
    """
    if isinstance(node, yaml.MappingNode):
        result = {}
        for key, value in node.value:
            if key.tag != "tag:yaml.org,2002:str" or key.value == "<<":
                raise ValueError("Mapping keys must be strings; merges are unsupported")
            if key.value in result:
                raise ValueError("Duplicate mapping key")
            result[key.value] = _json_node(value)
        return result
    if isinstance(node, yaml.SequenceNode):
        return [_json_node(value) for value in node.value]
    tag = node.tag.removeprefix("tag:yaml.org,2002:")
    if tag == "str":
        return node.value
    if tag not in {"null", "bool", "int", "float"}:
        raise ValueError("Only JSON-compatible YAML scalars are supported")
    loader = yaml.SafeLoader("")
    try:
        result = loader.construct_object(node)
        canonical_json(result)
        return result
    finally:
        loader.dispose()


def parse_yaml(data: bytes, *, run: bool = False) -> dict[str, Any]:
    """Read one bounded YAML mapping before model-specific validation.

    Args:
        data: UTF-8 document, never a filename or execution target.
        run: Use the larger export envelope's limits.

    Returns:
        JSON-compatible mapping, with duplicate keys and aliases rejected.

    Raises:
        ProcessingError: For malformed, oversized or unsupported YAML.
    """
    limit, depth_limit, node_limit = (
        (RUN_BYTES, 32, 8192) if run else (MODEL_BYTES, 16, 2048)
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
        return _json_node(documents[0])
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
    """Export a bounded contract and prove semantic equality on reparse.

    Args:
        value: Validated normalized mapping.
        run: Whether this is a run export rather than a reusable definition.

    Returns:
        UTF-8 safe YAML preserving types, nulls and effective defaults.

    Raises:
        ProcessingError: If the output cannot fit or round-trip within its limits.
    """
    # JSON normalization removes shared object references, so the exporter never
    # introduces YAML aliases that the input contract deliberately rejects.
    normalized = json.loads(canonical_json(value))
    data = yaml.safe_dump(normalized, allow_unicode=True, sort_keys=False).encode(
        "utf-8"
    )
    if canonical_json(parse_yaml(data, run=run)) != canonical_json(value):
        raise ProcessingError(
            "invalid_model_yaml", "The model document cannot be exported faithfully."
        )
    return data
