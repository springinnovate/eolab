/** Neutral ordinal chart rendering for vector-analysis components. */

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const CHART_WIDTH = 680;
const CHART_HEIGHT = 360;
const CHART_MARGIN = Object.freeze({ top: 20, right: 24, bottom: 92, left: 72 });

/**
 * Return compact finite-number text for axes and accessible details.
 *
 * @param {number} value Finite number.
 * @return {string} Compact localized value.
 */
export function formatSeriesNumber(value) {
    return new Intl.NumberFormat("en", {
        maximumSignificantDigits: 6,
    }).format(value);
}

/**
 * Keep dense ordinal tick labels readable while full values remain available.
 *
 * @param {string} label Full X label.
 * @param {number} [maximum=28] Maximum visible characters.
 * @return {string} Bounded tick label.
 */
function formatTickLabel(label, maximum = 28) {
    return label.length <= maximum
        ? label
        : `${label.slice(0, maximum - 1)}…`;
}

/**
 * Choose bounded ordinal tick indexes including both endpoints.
 *
 * @param {number} count Point count.
 * @param {number} [maximum=7] Maximum labels.
 * @return {number[]} Unique point indexes.
 */
function ordinalTickIndexes(count, maximum = 7) {
    if (count <= maximum) {
        return Array.from({ length: count }, (_, index) => index);
    }
    return [...new Set(Array.from(
        { length: maximum },
        (_, index) => Math.round(index * (count - 1) / (maximum - 1))
    ))];
}

/**
 * Create one namespaced SVG element with string attributes.
 *
 * @param {Document} documentContext Owning document.
 * @param {string} name SVG element name.
 * @param {Record<string,string|number>} attributes SVG attributes.
 * @param {string|null} [text=null] Optional text content.
 * @return {SVGElement} New SVG element.
 */
function svgElement(documentContext, name, attributes, text = null) {
    const element = documentContext.createElementNS(SVG_NAMESPACE, name);
    for (const [attribute, value] of Object.entries(attributes)) {
        element.setAttribute(attribute, String(value));
    }
    if (text !== null) element.textContent = text;
    return element;
}

/**
 * Draw a line or scatter plot over an ordinal sequence.
 *
 * Null Y values retain their X position and break line segments, so callers can
 * communicate missing observations without inventing numeric values.
 *
 * @param {Object} configuration Closed rendering contract.
 * @param {Document} configuration.documentContext Owning document.
 * @param {SVGElement} configuration.chart Empty target SVG element.
 * @param {{xLabel:string,yValue:number|null}[]} configuration.points Ordered points.
 * @param {"line"|"scatter"} configuration.chartType Plot geometry.
 * @param {"ordinal"|"numeric"} [configuration.xScale="ordinal"] X spacing.
 * @param {string} configuration.xAxisLabel Horizontal-axis title.
 * @param {string} configuration.yAxisLabel Vertical-axis title.
 * @param {string} configuration.ariaLabel Chart-level accessible description.
 * @param {(point:Object)=>string} configuration.pointAccessibleLabel Accessible point label.
 * @param {(point:Object)=>string} configuration.pointTooltip Pointer tooltip text.
 * @param {((point:Object)=>void)|null} [configuration.onPointSelect=null]
 * Optional selection intent callback.
 * @return {{pointElements:{circle:SVGElement,point:Object}[]}} Rendered point handles.
 */
export function renderOrdinalSeriesChart({
    documentContext,
    chart,
    points,
    chartType,
    xScale = "ordinal",
    xAxisLabel,
    yAxisLabel,
    ariaLabel,
    pointAccessibleLabel,
    pointTooltip,
    onPointSelect = null,
}) {
    if (
        !Array.isArray(points) || points.length === 0 ||
        !["line", "scatter"].includes(chartType) ||
        !["ordinal", "numeric"].includes(xScale) ||
        typeof xAxisLabel !== "string" || typeof yAxisLabel !== "string" ||
        typeof ariaLabel !== "string" ||
        typeof pointAccessibleLabel !== "function" ||
        typeof pointTooltip !== "function" ||
        !(onPointSelect === null || typeof onPointSelect === "function")
    ) {
        throw new TypeError("Invalid ordinal series chart contract.");
    }
    const finitePoints = points.filter((point) =>
        typeof point.yValue === "number" && Number.isFinite(point.yValue)
    );
    if (finitePoints.length === 0) {
        throw new TypeError("An ordinal series chart requires a finite Y value.");
    }
    const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
    const plotHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
    const values = finitePoints.map((point) => point.yValue);
    let minimum = Math.min(...values);
    let maximum = Math.max(...values);
    if (minimum === maximum) {
        const padding = Math.abs(minimum) * 0.1 || 1;
        minimum -= padding;
        maximum += padding;
    }
    const numericX = xScale === "numeric"
        ? points.map((point) => point.xValue)
        : [];
    if (
        xScale === "numeric" &&
        !numericX.every((value) => typeof value === "number" && Number.isFinite(value))
    ) {
        throw new TypeError("Numeric series chart X values must be finite.");
    }
    const minimumX = numericX.length > 0 ? Math.min(...numericX) : null;
    const maximumX = numericX.length > 0 ? Math.max(...numericX) : null;
    const x = (index) => {
        if (points.length === 1 || minimumX === maximumX) {
            return CHART_MARGIN.left + plotWidth / 2;
        }
        if (xScale === "numeric") {
            return CHART_MARGIN.left +
                (points[index].xValue - minimumX) * plotWidth /
                (maximumX - minimumX);
        }
        return CHART_MARGIN.left + index * plotWidth / (points.length - 1);
    };
    const y = (value) => CHART_MARGIN.top +
        (maximum - value) * plotHeight / (maximum - minimum);
    const xAxisY = CHART_MARGIN.top + plotHeight;
    chart.setAttribute("viewBox", `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`);
    chart.setAttribute("aria-label", ariaLabel);
    chart.append(
        svgElement(documentContext, "line", {
            class: "series-chart-axis",
            x1: CHART_MARGIN.left,
            y1: xAxisY,
            x2: CHART_MARGIN.left + plotWidth,
            y2: xAxisY,
        }),
        svgElement(documentContext, "line", {
            class: "series-chart-axis",
            x1: CHART_MARGIN.left,
            y1: CHART_MARGIN.top,
            x2: CHART_MARGIN.left,
            y2: xAxisY,
        })
    );
    for (let index = 0; index < 5; index += 1) {
        const value = minimum + (maximum - minimum) * index / 4;
        const tickY = y(value);
        chart.append(
            svgElement(documentContext, "line", {
                class: "series-chart-grid",
                x1: CHART_MARGIN.left,
                y1: tickY,
                x2: CHART_MARGIN.left + plotWidth,
                y2: tickY,
            }),
            svgElement(documentContext, "text", {
                class: "series-chart-tick",
                x: CHART_MARGIN.left - 10,
                y: tickY + 4,
                "text-anchor": "end",
            }, formatSeriesNumber(value))
        );
    }
    for (const index of ordinalTickIndexes(points.length)) {
        const tickX = x(index);
        chart.append(
            svgElement(documentContext, "line", {
                class: "series-chart-axis",
                x1: tickX,
                y1: xAxisY,
                x2: tickX,
                y2: xAxisY + 5,
            }),
            svgElement(documentContext, "text", {
                class: "series-chart-x-tick",
                x: tickX,
                y: xAxisY + 16,
                transform: `rotate(-35 ${tickX} ${xAxisY + 16})`,
                "text-anchor": "end",
            }, formatTickLabel(points[index].xLabel))
        );
    }
    if (chartType === "line") {
        let segmentOpen = false;
        const path = points.map((point, index) => {
            if (!(typeof point.yValue === "number" && Number.isFinite(point.yValue))) {
                segmentOpen = false;
                return "";
            }
            const command = segmentOpen ? "L" : "M";
            segmentOpen = true;
            return `${command}${x(index)},${y(point.yValue)}`;
        }).filter(Boolean).join(" ");
        chart.append(svgElement(documentContext, "path", {
            class: "series-chart-line",
            d: path,
        }));
    }
    const pointElements = [];
    points.forEach((point, index) => {
        if (!(typeof point.yValue === "number" && Number.isFinite(point.yValue))) {
            return;
        }
        const selectable = onPointSelect !== null;
        const circle = svgElement(documentContext, "circle", {
            class: "series-chart-point",
            cx: x(index),
            cy: y(point.yValue),
            r: 4.5,
            tabindex: 0,
            role: selectable ? "button" : "img",
            ...(selectable ? { "aria-pressed": "false" } : {}),
            "aria-label": pointAccessibleLabel(point),
        });
        if (selectable) {
            circle.addEventListener("click", () => onPointSelect(point));
            circle.addEventListener("keydown", (event) => {
                if (!["Enter", " "].includes(event.key)) return;
                event.preventDefault();
                onPointSelect(point);
            });
        }
        circle.append(svgElement(
            documentContext,
            "title",
            {},
            pointTooltip(point)
        ));
        pointElements.push({ circle, point });
        chart.append(circle);
    });
    chart.append(
        svgElement(documentContext, "text", {
            class: "series-chart-axis-title",
            x: CHART_MARGIN.left + plotWidth / 2,
            y: CHART_HEIGHT - 8,
            "text-anchor": "middle",
        }, xAxisLabel),
        svgElement(documentContext, "text", {
            class: "series-chart-axis-title",
            x: 16,
            y: CHART_MARGIN.top + plotHeight / 2,
            transform: `rotate(-90 16 ${CHART_MARGIN.top + plotHeight / 2})`,
            "text-anchor": "middle",
        }, yAxisLabel)
    );
    chart.removeAttribute("hidden");
    return { pointElements };
}
