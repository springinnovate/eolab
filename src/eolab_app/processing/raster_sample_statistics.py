"""Combine statistics from masked blocks of raster samples."""

import math

import numpy as np
from numpy.typing import NDArray


class RasterSampleStatistics:
    """Reduce masked raster blocks, retaining only running numbers between blocks."""

    def __init__(self, functions: frozenset[str]) -> None:
        """Choose the statistics to compute from successive sample blocks.

        Args:
            functions: Requested names among min, max, mean, stdev, sum and count.
        """
        self.functions = functions
        self.count = 0
        self._minimum = math.inf
        self._maximum = -math.inf
        self._sum = self._compensation = 0.0
        self._needs_moments = bool(functions & {"mean", "stdev"})
        self._origin = 0.0
        self._shifted_mean = self._deviation = 0.0
        self._value_scale = 1.0

    def add_block(self, values: NDArray[np.float64], valid: NDArray[np.bool_]) -> None:
        """Include finite samples selected by the caller's mask.

        Args:
            values: Raster values on one block, in the same shape as valid.
            valid: True where a value belongs to this statistic's population.
        """
        count = int(np.count_nonzero(valid))
        prior_count = self.count
        self.count += count
        if not count or self.functions == {"count"}:
            return
        selected = values if count == values.size else values[valid]
        block_min = (
            float(np.min(selected))
            if self._needs_moments or "min" in self.functions
            else math.inf
        )
        block_max = (
            float(np.max(selected))
            if self._needs_moments or "max" in self.functions
            else -math.inf
        )
        self._minimum = min(self._minimum, block_min)
        self._maximum = max(self._maximum, block_max)
        if "sum" in self.functions:
            with np.errstate(over="ignore", invalid="ignore"):
                partial = float(np.sum(selected, dtype=np.float64))
            corrected = partial - self._compensation
            total = self._sum + corrected
            self._compensation = (total - self._sum) - corrected
            self._sum = total
        if self._needs_moments:
            self._merge_population_moments(selected, block_min, block_max, prior_count)

    def _merge_population_moments(
        self,
        selected: NDArray[np.float64],
        block_min: float,
        block_max: float,
        prior_count: int,
    ) -> None:
        """Merge a block's mean and optional population deviation by sample count.

        Accumulating offsets from the first sample retains small differences
        around a large baseline. For data spanning zero, a zero origin avoids
        subtracting that baseline to recover a small mean. Scaling and hypot
        keep extreme values representable when taking differences and squares.

        Args:
            selected: Nonempty block of finite samples.
            block_min: Lowest finite value in this block.
            block_max: Highest finite value in this block.
            prior_count: Number of samples accumulated before this block.
        """
        if (
            self._value_scale == 1.0
            and max(abs(block_min), abs(block_max)) > np.finfo(np.float64).max / 4
        ):
            self._value_scale = 2.0
            self._origin /= 2
            self._shifted_mean /= 2
            self._deviation /= 2
        if not prior_count:
            self._origin = float(selected.flat[0]) / self._value_scale
        if self._origin and self._minimum <= 0 <= self._maximum:
            self._shifted_mean += self._origin
            self._origin = 0.0

        low = block_min / self._value_scale - self._origin
        high = block_max / self._value_scale - self._origin
        block_mean = low
        block_deviation = 0.0
        if block_min != block_max:
            offsets = selected / self._value_scale
            offsets -= self._origin
            magnitude = max(abs(low), abs(high))
            if magnitude > np.finfo(np.float64).max / selected.size:
                block_mean = float(np.mean(offsets / magnitude)) * magnitude
            else:
                block_mean = float(np.mean(offsets))
            spread = max(abs(low - block_mean), abs(high - block_mean))
            if "stdev" in self.functions and spread:
                offsets -= block_mean
                offsets /= spread
                np.square(offsets, out=offsets)
                block_deviation = math.sqrt(float(np.mean(offsets))) * spread
        prior_weight = prior_count / self.count
        block_weight = selected.size / self.count
        delta = block_mean - self._shifted_mean
        if "stdev" in self.functions:
            self._deviation = math.hypot(
                self._deviation * math.sqrt(prior_weight),
                block_deviation * math.sqrt(block_weight),
                delta * math.sqrt(prior_weight * block_weight),
            )
        self._shifted_mean += delta * block_weight

    def value(self, function: str) -> int | float:
        """Return a requested statistic after all blocks have been added.

        Args:
            function: One of the names supplied at construction.
        Returns:
            Integer count or Float64 statistic. An empty sum or count is zero.
            Other empty statistics and unrepresentable results give NaN.
        """
        if function == "count":
            return self.count
        if not self.count and function != "sum":
            return math.nan
        result = {
            "sum": self._sum,
            "min": self._minimum,
            "max": self._maximum,
            "mean": (self._origin + self._shifted_mean) * self._value_scale,
            "stdev": self._deviation * self._value_scale,
        }[function]
        return result if math.isfinite(result) else math.nan
