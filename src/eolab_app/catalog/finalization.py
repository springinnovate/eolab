"""Apply additional metadata and source assessments before catalog Items are stored."""

from typing import Any

from eolab_app.catalog.ports import DatasetItemFinalizer


class CompositeDatasetItemFinalizer:
    """Run a sequence of metadata finalizers on each catalog Item."""

    def __init__(self, finalizers: tuple[DatasetItemFinalizer, ...]) -> None:
        """Configure the order in which Item finalizers run.

        Args:
            finalizers: Focused finalizers applied in supplied order.

        Raises:
            ValueError: If no finalizer is supplied.
        """
        if not finalizers:
            raise ValueError("At least one dataset Item finalizer is required")
        self._finalizers = finalizers

    async def finalize(self, item: dict[str, Any]) -> dict[str, Any]:
        """Pass a catalog Item through each finalizer in order.

        Args:
            item: Fresh format-handler STAC Item.

        Returns:
            The Item returned by the last finalizer.

        Raises:
            Exception: Propagates a finalizer failure so the scanner can record
                which dataset could not be cataloged.
        """
        finalized_item = item
        for finalizer in self._finalizers:
            finalized_item = await finalizer.finalize(finalized_item)
        return finalized_item
