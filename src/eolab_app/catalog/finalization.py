"""Composition helpers for scanner Item finalization boundaries."""

from typing import Any

from eolab_app.catalog.ports import DatasetItemFinalizer


class CompositeDatasetItemFinalizer:
    """Apply focused Item finalizers in one deterministic scanner boundary."""

    def __init__(self, finalizers: tuple[DatasetItemFinalizer, ...]) -> None:
        """Create a non-empty ordered finalizer composition.

        Args:
            finalizers: Focused finalizers applied in supplied order.

        Raises:
            ValueError: If no finalizer is supplied.
        """
        if not finalizers:
            raise ValueError("At least one dataset Item finalizer is required")
        self._finalizers = finalizers

    async def finalize(self, item: dict[str, Any]) -> dict[str, Any]:
        """Apply every focused finalizer to one extracted scanner Item.

        Args:
            item: Fresh format-handler STAC Item.

        Returns:
            Finalized Item after every owned assessment boundary.

        Raises:
            Exception: Propagates failures from a focused finalizer so the scan
                records the source-dataset error through its existing contract.
        """
        finalized_item = item
        for finalizer in self._finalizers:
            finalized_item = await finalizer.finalize(finalized_item)
        return finalized_item
