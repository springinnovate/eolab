"""Test deployment settings for remote object-storage scanning."""

import json
from pathlib import Path

import pytest

from eolab_app.settings import load_settings


def test_remote_s3_settings_keep_connection_details_server_side(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
) -> None:
    """Expose only the independent user-facing source description.

    Args:
        configured_environment: Complete baseline environment fixture.
        monkeypatch: Environment mutation fixture.
        version_file_path: Baked application version fixture.
    """
    monkeypatch.setenv(
        "SCAN_REMOTE_S3_SOURCES",
        json.dumps([{
            "id": "research-archive",
            "bucket": "private-bucket",
            "prefix": "published/",
            "displayName": "Research archive / published",
        }]),
    )
    monkeypatch.setenv("S3_ENDPOINT_URL", "https://objects.internal.example")
    monkeypatch.setenv("S3_REGION", "us-west-2")
    monkeypatch.setenv("S3_ACCESS_KEY_ID", "server-access")
    monkeypatch.setenv("S3_SECRET_ACCESS_KEY", "server-secret")
    monkeypatch.setenv("S3_SESSION_TOKEN", "server-session")
    monkeypatch.setenv("S3_LIST_PAGE_SIZE", "37")
    monkeypatch.setenv("S3_METADATA_CONCURRENCY", "3")

    settings = load_settings(version_file_path)
    public_settings = settings.as_public_dict()

    assert settings.remote_s3_roots[0].source_id == "research-archive"
    assert settings.s3_connection.list_page_size == 37
    assert settings.s3_connection.metadata_concurrency == 3
    assert public_settings["scanDisplayPaths"][-1] == (
        "Research archive / published"
    )
    serialized_public_settings = json.dumps(public_settings)
    settings_representation = repr(settings)
    for private_value in (
        "private-bucket",
        "objects.internal.example",
        "server-access",
        "server-secret",
        "server-session",
    ):
        assert private_value not in serialized_public_settings
    for private_value in (
        "objects.internal.example",
        "server-access",
        "server-secret",
        "server-session",
    ):
        assert private_value not in settings_representation


@pytest.mark.parametrize(
    "sources",
    [
        {},
        [{"id": "missing-fields"}],
        [{
            "id": "unsafe",
            "bucket": "bucket",
            "prefix": "../private",
            "displayName": "Unsafe",
        }],
        [
            {
                "id": "one",
                "bucket": "bucket",
                "prefix": "published/",
                "displayName": "One",
            },
            {
                "id": "two",
                "bucket": "bucket",
                "prefix": "published/nested/",
                "displayName": "Two",
            },
        ],
        [
            {
                "id": "duplicate",
                "bucket": "one",
                "prefix": "",
                "displayName": "One",
            },
            {
                "id": "duplicate",
                "bucket": "two",
                "prefix": "",
                "displayName": "Two",
            },
        ],
    ],
)
def test_remote_s3_settings_reject_malformed_roots(
    configured_environment: None,
    monkeypatch: pytest.MonkeyPatch,
    version_file_path: Path,
    sources: object,
) -> None:
    """Reject ambiguous source roots before application composition.

    Args:
        configured_environment: Complete baseline environment fixture.
        monkeypatch: Environment mutation fixture.
        version_file_path: Baked application version fixture.
        sources: Invalid JSON-compatible source configuration.
    """
    monkeypatch.setenv("SCAN_REMOTE_S3_SOURCES", json.dumps(sources))

    with pytest.raises(ValueError):
        load_settings(version_file_path)
