"""Choose initial contributor colors and preserve colors for older memberships."""

from collections import Counter
from collections.abc import Iterable
from uuid import UUID

DEFAULT_CONTRIBUTOR_COLORS: tuple[str, ...] = (
    "#FFBE0B",
    "#FB5607",
    "#FF006E",
    "#8338EC",
    "#3A86FF",
    "#F63E02",
    "#F3DE2C",
    "#7CB518",
    "#7AE582",
    "#9FFFCB",
    "#AFFC41",
    "#FFAFCC",
    "#FCA311",
    "#3D348B",
    "#4CC9F0",
    "#DB00B6",
    "#FE5D26",
    "#FFFF82",
    "#7CFFCB",
    "#2D00F7",
    "#DC2F02",
    "#00A896",
    "#C77DFF",
    "#FF9F68",
    "#118AB2",
)


def get_contributor_color(contributor_id: UUID, saved_color: str | None) -> str:
    """Return a saved color, or a stable palette color for an older membership.

    Args:
        contributor_id: Persistent membership identifier, distinct for each session.
        saved_color: Validated custom or assigned color; older rows contain null.

    Returns:
        A six-digit hexadecimal color that remains stable across reloads.
    """
    return (
        saved_color
        or DEFAULT_CONTRIBUTOR_COLORS[
            contributor_id.int % len(DEFAULT_CONTRIBUTOR_COLORS)
        ]
    )


def choose_contributor_color(existing_colors: Iterable[str]) -> str:
    """Choose the least-used palette color, breaking ties in palette order.

    Args:
        existing_colors: Current colors of contributors in this shared layer.

    Returns:
        An unused palette color when possible; otherwise the least-used one.
    """
    counts = Counter(color.upper() for color in existing_colors)
    return min(DEFAULT_CONTRIBUTOR_COLORS, key=lambda color: counts[color])
