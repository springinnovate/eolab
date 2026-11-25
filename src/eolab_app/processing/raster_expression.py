"""Parse raster formulas and evaluate pixel values or streaming reductions."""

from collections.abc import Iterator, Mapping
from dataclasses import dataclass
import math
import re
from typing import Any, cast

import numpy as np
from numpy.typing import NDArray

from eolab_app.processing.models import ProcessingError
from eolab_app.processing.raster_sample_statistics import RasterSampleStatistics

FUNCTIONS = frozenset(
    {"count", "sum", "mean", "stdev", "min", "max", "areaha", "pixelValue"}
)
MAX_NODES = 256
MAX_DEPTH = 20
TOKEN = re.compile(
    r"\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|([A-Za-z][A-Za-z0-9_]*)|(>=|<=|==|!=|&&|\|\||[+*/^!<>()=,\-]))"
)
PRECEDENCE = {
    "||": 1,
    "&&": 2,
    "==": 3,
    "!=": 3,
    ">": 4,
    "<": 4,
    ">=": 4,
    "<=": 4,
    "+": 5,
    "-": 5,
    "*": 6,
    "/": 6,
}
PIXEL_FUNCTIONS = frozenset({"min", "max"})
AREA_FUNCTIONS = {
    f"area_{name}": name for name in ("min", "max", "mean", "stdev", "sum", "count")
}


@dataclass(frozen=True)
class Node:
    """A parsed raster-formula value, operator or function call.

    Attributes:
        op: Source, literal, operator or statistic name.
        args: Child expressions supplying this node's operands or arguments.
        value: Numeric literal for "number", or the raster variable for "source"
            and selected-area functions in a pixel formula.
        boolean: Whether the expression produces a true/false condition.
        scalar: Whether the expression produces one value rather than pixel values.
        depth: Number of levels from this node to its deepest child.
    """

    op: str
    args: tuple["Node", ...] = ()
    value: float | str | None = None
    boolean: bool = False
    scalar: bool = False
    depth: int = 1


class Parser:
    """Parse only the documented calculation grammar with bounded recursion."""

    precedence: Mapping[str, int] = PRECEDENCE

    def __init__(self, text: str, alias: str) -> None:
        """Tokenize bounded text against one bound source name.

        Args:
            text: User expression, limited before parsing.
            alias: Validated catalog source alias.
        """
        if len(text.encode("utf-8")) > 4096:
            raise ProcessingError(
                "invalid_expression", "Expressions must fit within 4 KiB."
            )
        self.tokens: list[tuple[str, int]] = []
        self.index = self.nodes = self.nesting = 0
        self.alias = alias
        position = 0
        while position < len(text):
            if not text[position:].strip():
                break
            match = TOKEN.match(text, position)
            if match is None:
                raise ProcessingError(
                    "invalid_expression",
                    f"Unexpected character at column {position + 1}.",
                )
            self.tokens.append(
                (
                    next(value for value in match.groups() if value is not None),
                    match.start() + 1,
                )
            )
            position = match.end()
        self.tokens.append(("", len(text) + 1))

    def error(self, message: str) -> ProcessingError:
        """Return a location-bearing grammar error.

        Args:
            message: Public description of the invalid syntax/type.

        Returns:
            Sanitized validation error for the current token.
        """
        return ProcessingError(
            "invalid_expression", f"{message} At column {self.tokens[self.index][1]}."
        )

    def take(self, expected: str | None = None) -> str:
        """Consume one token, optionally requiring an exact spelling.

        Args:
            expected: Required token or None.

        Returns:
            Consumed token text.
        """
        token = self.tokens[self.index][0]
        if expected is not None and token != expected:
            raise self.error(f"Expected '{expected}'")
        if not token:
            raise self.error("Incomplete expression")
        self.index += 1
        return token

    def node(self, op: str, args: tuple[Node, ...] = (), **values: Any) -> Node:
        """Create one node while bounding tree size and evaluation depth.

        Args:
            op: Allowlisted operation.
            args: Already-checked child nodes.
            values: Literal value and inferred type fields.

        Returns:
            Immutable typed node.
        """
        self.nodes += 1
        depth = 1 + max((arg.depth for arg in args), default=0)
        if self.nodes > MAX_NODES or depth > MAX_DEPTH:
            raise self.error("Expression is too complex")
        return Node(op, args, depth=depth, **values)

    def expression(self, minimum: int = 0) -> Node:
        """Parse a precedence-delimited expression.

        Args:
            minimum: Minimum binary-operator precedence admitted here.

        Returns:
            Checked scalar or pixel expression.
        """
        self.nesting += 1
        if self.nesting > MAX_DEPTH:
            raise self.error("Expression is nested too deeply")
        token = self.take()
        if token in {"-", "+", "!"}:
            child = self.expression(7)
            if (token == "!") != child.boolean:
                raise self.error(
                    "Logical NOT requires a condition; signs require numbers"
                )
            left = self.node(
                "unary" + token, (child,), boolean=child.boolean, scalar=child.scalar
            )
        elif token == "(":
            left = self.expression()
            self.take(")")
        else:
            left = self.read_operand(token)
        while self.precedence.get(self.tokens[self.index][0], -1) >= minimum:
            op = self.take()
            right = self.expression(self.precedence[op] + (op != "^"))
            left = self.read_binary_operator(op, left, right)
        self.nesting -= 1
        return left

    def read_operand(self, token: str) -> Node:
        """Parse a raster, aggregate call or constant after its first token.

        Args:
            token: First token of the operand.
        Returns:
            Parsed operand with its scalar or pixel type.
        Raises:
            ProcessingError: If the operand is unknown or invalid.
        """
        if token == self.alias:
            return self.node("source")
        if token in FUNCTIONS:
            self.take("(")
            argument = self.expression()
            args = (argument,)
            if self.tokens[self.index][0] == ",":
                self.take(",")
                self.take("where")
                self.take("=")
                condition = self.expression()
                if not condition.boolean or any(
                    node.op in FUNCTIONS for node in walk(condition)
                ):
                    raise self.error("where requires a pixel condition")
                args += (condition,)
            self.take(")")
            if any(node.op in FUNCTIONS for arg in args for node in walk(arg)):
                raise self.error("Aggregates cannot be nested")
            if token == "pixelValue" and (argument.op != "source" or len(args) != 1):
                raise self.error(
                    "pixelValue requires only the raster, for example pixelValue(a)"
                )
            if token == "areaha" and (not argument.boolean or len(args) != 1):
                raise self.error(
                    "areaha requires one condition, for example areaha(a == 4)"
                )
            if token not in {"count", "sum", "areaha"} and argument.boolean:
                raise self.error(f"{token} requires numeric values")
            return self.node(token, args, scalar=True)
        return self.read_number(token)

    def read_number(self, token: str) -> Node:
        """Return a finite numerical literal from one operand token.

        Args:
            token: Candidate number token.
        Returns:
            Scalar number node.
        Raises:
            ProcessingError: If the token is unknown or represents a nonfinite value.
        """
        try:
            value = float(token)
        except ValueError as error:
            raise self.error(f"Unknown source or function '{token}'") from error
        if not math.isfinite(value):
            raise self.error("Use finite numeric constants")
        return self.node("number", value=value, scalar=True)

    def read_binary_operator(self, op: str, left: Node, right: Node) -> Node:
        """Return a typed operator for two operands of an aggregate expression.

        Args:
            op: Operator selected by the grammar.
            left: First operand.
            right: Second operand.
        Returns:
            Operator with its result type and operands.
        Raises:
            ProcessingError: If operand types or literal division are invalid.
        """
        boolean = op in {"&&", "||", "==", "!=", ">", "<", ">=", "<="}
        if op in {"&&", "||"}:
            if not left.boolean or not right.boolean:
                raise self.error("Logical operators require conditions")
        elif left.boolean or right.boolean:
            raise self.error("Arithmetic and comparisons require numeric values")
        if op == "/" and right.op == "number" and right.value == 0:
            raise self.error("Cannot divide by zero")
        return self.node(
            op, (left, right), boolean=boolean, scalar=left.scalar and right.scalar
        )


class PixelExpressionParser(Parser):
    """Parse cell arithmetic and selected-area statistics over named rasters."""

    precedence: Mapping[str, int] = {"+": 5, "-": 5, "*": 6, "/": 6, "^": 7}

    def __init__(self, text: str, aliases: frozenset[str]) -> None:
        """Set the raster names available to a pixel formula.

        Args:
            text: User formula using the calculator's arithmetic grammar.
            aliases: Validated, distinct raster names.
        """
        super().__init__(text, "")
        self.aliases = aliases

    def read_operand(self, token: str) -> Node:
        """Return a raster variable, calculator function call or number.

        Args:
            token: First token of the operand.
        Returns:
            Parsed numerical operand.
        Raises:
            ProcessingError: If a variable, function or argument list is invalid.
        """
        if token in AREA_FUNCTIONS and self.tokens[self.index][0] == "(":
            self.take("(")
            alias = self.take()
            if alias not in self.aliases:
                raise self.error(
                    f"{token} requires one raster variable, for example {token}(a)"
                )
            self.take(")")
            return self.node(token, value=alias)
        if token in self.aliases:
            return self.node("source", value=token)
        if token in PIXEL_FUNCTIONS:
            self.take("(")
            first = self.expression()
            self.take(",")
            second = self.expression()
            self.take(")")
            return self.node(
                token, (first, second), scalar=first.scalar and second.scalar
            )
        return self.read_number(token)

    def read_binary_operator(self, op: str, left: Node, right: Node) -> Node:
        """Construct arithmetic whose undefined values become missing at evaluation.

        Args:
            op: Arithmetic operator selected by the calculator grammar.
            left: First numerical operand.
            right: Second numerical operand.
        Returns:
            Operator and its operands.
        """
        return self.node(op, (left, right), scalar=left.scalar and right.scalar)


def walk(node: Node) -> Iterator[Node]:
    """Yield syntax nodes in bounded tree order.

    Args:
        node: Validated expression root.

    Yields:
        Each node, including repeated syntactic occurrences.
    """
    yield node
    for child in node.args:
        yield from walk(child)


def compile_expression(text: str, alias: str) -> Node:
    """Validate source bindings and require one scalar numerical result.

    Args:
        text: Bounded expression text.
        alias: The single source bound by the operation.

    Returns:
        Typed, bounded expression tree.
    """
    parser = Parser(text, alias)
    root = parser.expression()
    if parser.tokens[parser.index][0]:
        raise parser.error("Unexpected trailing input")
    nodes = tuple(walk(root))
    if (
        not root.scalar
        or root.boolean
        or not any(node.op in FUNCTIONS for node in nodes)
    ):
        raise parser.error("A calculation must produce a scalar aggregate result")
    if not any(node.op == "source" for node in nodes):
        raise parser.error("A calculation must reference its raster")
    return root


def compile_pixel_expression(text: str, aliases: frozenset[str]) -> Node:
    """Check a formula that produces one numerical value per output cell.

    Args:
        text: Bounded user formula containing at least one raster name.
        aliases: Names of the rasters bound to the formula.
    Returns:
        Parsed raster formula with the binding names retained in source nodes.
    Raises:
        ProcessingError: If the formula has invalid syntax or names no raster.
    """
    parser = PixelExpressionParser(text, aliases)
    root = parser.expression()
    if parser.tokens[parser.index][0]:
        raise parser.error("Unexpected trailing input")
    if root.scalar:
        raise parser.error("Use at least one raster variable")
    return root


def apply_operator(node: Node, values: list[Any]) -> Any:
    """Evaluate an allowlisted arithmetic/logical operator on values.

    Args:
        node: Validated operator node.
        values: Scalar or equally shaped array operands.

    Returns:
        Operator result; caller applies validity and finite-value checks.
    """
    op = node.op
    if op == "unary-":
        return -values[0]
    if op == "unary+":
        return values[0]
    if op == "unary!":
        return np.logical_not(values[0])
    a, b = values
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b
    if op == "^":
        return np.power(a, b)
    if op == "min":
        return np.minimum(a, b)
    if op == "max":
        return np.maximum(a, b)
    if op == ">":
        return a > b
    if op == "<":
        return a < b
    if op == ">=":
        return a >= b
    if op == "<=":
        return a <= b
    if op == "==":
        return a == b
    if op == "!=":
        return a != b
    if op == "&&":
        return np.logical_and(a, b)
    if op == "||":
        return np.logical_or(a, b)
    raise ValueError("Unrecognized validated operator")


def evaluate_pixel_expression(
    root: Node,
    samples: Mapping[str, NDArray[np.float64]],
    area_statistics: Mapping[str, Mapping[str, int | float]],
) -> NDArray[np.float64]:
    """Calculate a tile, preserving missing samples and undefined arithmetic.

    Args:
        root: Parsed pixel formula referencing one or more rasters.
        samples: Equally shaped tiles keyed by raster name, with NaN for NoData.
        area_statistics: Completed statistics keyed by raster name and statistic,
            for example area_statistics["a"]["mean"] for area_mean(a).
    Returns:
        Float64 tile with NaN wherever an input or intermediate value is invalid.
    """

    def evaluate(node: Node) -> NDArray[np.float64] | np.float64:
        """Evaluate one formula node against the supplied tile samples."""
        if node.op == "source":
            return samples[cast(str, node.value)]
        if node.op in AREA_FUNCTIONS:
            return np.float64(
                area_statistics[cast(str, node.value)][AREA_FUNCTIONS[node.op]]
            )
        if node.op == "number":
            return np.float64(cast(float, node.value))
        operands = [evaluate(child) for child in node.args]
        value = apply_operator(node, operands)
        valid = np.isfinite(value)
        for operand in operands:
            valid = valid & np.isfinite(operand)
        return np.where(valid, value, np.nan)

    with np.errstate(divide="ignore", invalid="ignore", over="ignore"):
        result = evaluate(root)
        # Area calls can supply scalars throughout the formula. Apply their
        # rasters' cell coverage once, including when the entire result is scalar.
        for alias in area_statistics:
            result = np.where(np.isfinite(samples[alias]), result, np.nan)
        return cast(NDArray[np.float64], result)


class Reduction:
    """Accumulate one raster statistic across successive pixel tiles.

    Counts distinguish valid source pixels, pixels matching the expression's
    conditions, and source pixels whose expressions produce invalid arithmetic.
    """

    def __init__(self, node: Node, pixel_value: float | None = None) -> None:
        """Set up one summary over the cells matching a parsed aggregate.

        Args:
            node: Validated aggregate node.
            pixel_value: Stored value at the selected point for pixelValue;
                missing or nonfinite values produce no_valid_data.
        """
        self.node = node
        self.valid_pixel_count = 0
        self.invalid_arithmetic_pixel_count = 0
        self.statistic = node.op
        if node.op == "areaha":
            self.statistic = "sum"
        elif node.args[0].boolean or node.op == "pixelValue":
            self.statistic = "count"
        self.samples = RasterSampleStatistics(frozenset({self.statistic}))
        self.point_value: float | None = None
        if (
            node.op == "pixelValue"
            and pixel_value is not None
            and math.isfinite(pixel_value)
        ):
            self.valid_pixel_count = self.samples.count = 1
            self.point_value = float(pixel_value)

    def update(
        self,
        data: NDArray[np.float64],
        valid_source_pixels: NDArray[np.bool_],
        hectares: NDArray[np.float64] | None = None,
    ) -> None:
        """Accumulate one tile's values that pass source validity and expression filters.

        stdev merges centered population moments across tiles. Empty tiles do
        not change those moments; a single matching pixel has deviation zero.

        Args:
            data: Float64 stored values in one tile.
            valid_source_pixels: In-area valid source mask.
            hectares: Fractional cell hectares, required for an areaha reduction.
        """
        cache: dict[Node, tuple[Any, Any]] = {}

        def evaluate(node: Node) -> tuple[Any, Any]:
            """Evaluate one pixel subtree, retaining its validity.

            Args:
                node: Pixel expression or finite literal.

            Returns:
                Values and a boolean validity mask.
            """
            if node in cache:
                return cache[node]
            if node.op == "source":
                result = (data, valid_source_pixels)
            elif node.op == "number":
                result = (np.float64(node.value), True)
            else:
                children = [evaluate(child) for child in node.args]
                valid: Any = True
                for _, mask in children:
                    valid = valid & mask
                with np.errstate(all="ignore"):
                    value = apply_operator(node, [child[0] for child in children])
                result = (value, valid & np.isfinite(value))
            cache[node] = result
            return result

        values, valid = evaluate(self.node.args[0])
        eligible = valid_source_pixels & valid
        if len(self.node.args) == 2:
            condition, condition_valid = evaluate(self.node.args[1])
            valid = valid & condition_valid
            eligible = eligible & condition_valid & condition
        self.valid_pixel_count += int(np.count_nonzero(valid_source_pixels))
        self.invalid_arithmetic_pixel_count += int(
            np.count_nonzero(valid_source_pixels & ~np.asarray(valid, dtype=bool))
        )
        if self.node.args[0].boolean:
            eligible = eligible & values
        samples = (
            cast(NDArray[np.float64], hectares)
            if self.node.op == "areaha"
            else np.broadcast_to(values, data.shape)
        )
        self.samples.add_block(samples, eligible)

    def result(self) -> tuple[int | float | None, str]:
        """Return the aggregate value and explicit empty/error classification.

        Returns:
            Native numeric result (counts remain Python integers) and status.
            stdev is population standard deviation, zero for one matched pixel
            and null for no valid data, no matches or invalid arithmetic.
        """
        if self.valid_pixel_count == 0:
            return None, "no_valid_data"
        if self.invalid_arithmetic_pixel_count == self.valid_pixel_count:
            return None, "invalid_arithmetic"
        if self.node.op == "pixelValue":
            return self.point_value, "ok"
        if self.statistic == "count":
            return self.samples.count, "ok" if self.samples.count else "no_matches"
        if self.samples.count == 0:
            return (
                0.0
                if self.node.op == "areaha"
                else 0 if self.node.op == "sum" else None
            ), "no_matches"
        value = self.samples.value(self.statistic)
        return (value, "ok") if math.isfinite(value) else (None, "overflow")


class Calculation:
    """Evaluate a raster formula, such as mean(a) + stdev(a), across pixel tiles."""

    def __init__(self, root: Node, pixel_value: float | None = None) -> None:
        """Create accumulators for unique aggregate subexpressions.

        Args:
            root: Compiled scalar result expression.
            pixel_value: Stored value at the selected point for pixelValue;
                missing or nonfinite values produce no_valid_data.
        """
        self.root = root
        self.reductions = {
            node: Reduction(node, pixel_value)
            for node in walk(root)
            if node.op in FUNCTIONS
        }

    def process_tile(
        self,
        data: np.ndarray,
        valid: np.ndarray,
        hectares: np.ndarray | None = None,
        area_valid: np.ndarray | None = None,
    ) -> None:
        """Process one raster tile and accumulate its contribution to the result.

        Call result() after all tiles have been processed. The selected point's
        pixelValue is supplied at construction and is unaffected by area tiles.

        Args:
            data: Raster pixel values for this tile.
            valid: Boolean mask selecting valid pixels inside the requested area.
            hectares: Selected area within each pixel, in hectares, for areaha.
            area_valid: Boolean mask selecting valid pixels with positive area.

        Raises:
            ValueError: If an area calculation has no hectare weights or area mask.
        """
        for reduction in self.reductions.values():
            if reduction.node.op == "pixelValue":
                continue
            if reduction.node.op == "areaha":
                if hectares is None or area_valid is None:
                    raise ValueError(
                        "Area reductions require fractional hectares and an area-validity mask"
                    )
                reduction.update(data, area_valid, hectares)
            else:
                reduction.update(data, valid)

    def result(self) -> dict[str, Any]:
        """Finalize a JSON-safe result without losing integer counts.

        Returns:
            Decimal-string value/type, state, and per-aggregate coverage counts.
        """
        reduced = {node: value.result() for node, value in self.reductions.items()}

        def scalar(node: Node) -> int | float:
            """Evaluate the remaining scalar expression.

            Args:
                node: Scalar operator, literal, or completed reduction.

            Returns:
                Finite scalar; division/domain failures are caught by the caller.
            """
            if node in reduced:
                return reduced[node][0]
            if node.op == "number":
                return node.value
            return apply_operator(node, [scalar(arg) for arg in node.args])

        state = next(
            (state for value, state in reduced.values() if value is None), "ok"
        )
        value = None
        if state == "ok":
            try:
                value = scalar(self.root)
                if not math.isfinite(value):
                    value, state = None, "overflow"
            except OverflowError:
                value, state = None, "overflow"
            except (ArithmeticError, TypeError, ValueError):
                value, state = None, "invalid_arithmetic"
            if state == "ok" and all(
                status == "no_matches" for _, status in reduced.values()
            ):
                state = "no_matches"
        return {
            "value": None if value is None else str(value),
            "unit": "ha" if self.root.op == "areaha" else None,
            "valueType": (
                None
                if value is None
                else ("integer" if isinstance(value, int) else "float")
            ),
            "state": state,
            "aggregates": [
                {
                    "function": node.op,
                    "validPixels": item.valid_pixel_count,
                    "matchedPixels": item.samples.count,
                    "invalidArithmeticPixels": item.invalid_arithmetic_pixel_count,
                    **({"unit": "ha"} if node.op == "areaha" else {}),
                }
                for node, item in self.reductions.items()
            ],
        }
