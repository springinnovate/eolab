# Bivariate raster comparison

Bivariate mode compares the two most recently selected distinct, continuous
one-band catalog rasters. The most recent selection starts as X and the prior
selection starts as Y. Catalog identities—not WMS publications, layer
visibility, or renderer state—authorize the paired analysis. The browser
composition root coordinates catalog selection, optional raster rendering,
styling, paired analysis, and controls. Those sibling components do not import
or use one another's implementation state.

In the collapsible workspace layout, the mode selector, raster role controls,
and two-dimensional palette legend are presented in **Map layers**. The paired
density histogram is presented in **Histograms**. Entering bivariate mode asks
the existing browser composition callback to reveal the Histograms workspace;
neither workspace component imports or controls the other.

**Swap X/Y** reverses both roles and requests a new result because X owns the
reference grid. Both role labels and the two-dimensional legend name the
raster basenames and ranges. Selecting a third catalog raster updates the
available pair. Hiding a map layer, losing WMS tiles, removing a publication,
or using detail-only rendering changes only the optional map presentation; the
catalog pair and its pixel/statistics analysis remain available. Exiting
restores every retained WMS layer's ordinary style and opacity without another
publication request.

## ESOS-C color and rendering contract

The palette definitions and color math come from the proven
[ESOS-C data viewer](https://github.com/springinnovate/esos-c-dataviewer), while
eolab keeps them in focused domain and presentation modules instead of copying
the ESOS-C application structure. Both projects distribute this work under the
[Apache License 2.0](https://github.com/springinnovate/esos-c-dataviewer/blob/main/LICENSE).
One shared palette definition produces the
X ramp, Y ramp, map tiles, two-dimensional legend, histogram colors, and probe
lookup. The available palettes are Orange / Blue, Gray / White, Teal /
Magenta, Green / Purple, Red / Cyan, Indigo / Gold, Brown / Sky, and Steel /
Rose.

When both catalog rasters have WMS presentations, each remains a separate
one-layer request. Both render at 100% opacity, and the top raster's browser
tile container uses CSS `mix-blend-mode: plus-lighter`, matching ESOS-C. If one
or both WMS presentations are unavailable, the paired histogram and probe keep
working without a substitute publication. Legend and probe calculations use
the equivalent deterministic operation: add the two RGB channel values and
clamp each result to 255. Addition is commutative before clipping, but drawing
order stays deterministic. The UI does not expose other blend equations.

Additive eight-bit RGB is not injective. Channel clipping and finite color
precision can make different value pairs display the same color, so the UI
describes a bivariate encoding rather than a globally unique identifier. The
dual pixel probe reports the actual independent samples.

The paired histogram also retains the ESOS-C visual encoding. Populated-bin
density uses `log1p`, smoothstep, and a 1.2 gamma. Density changes cell inset,
saturation, and lightness around the paired map color; the adjacent explanation
states that additional encoding explicitly. X and Y marginals use their own
axis-ramp colors. Every populated cell is keyboard focusable and selectable by
pointer, touch, Enter, or Space. Its accessible text names both ranges, count,
and percentage. The chart summary names both rasters, both axis ranges, paired
sample count, approximation provenance, and highest-density region.

## Paired analysis contract

`POST /api/raster-analysis/paired-statistics` accepts two ordered catalog
identities and, optionally, one canonical non-wrapping WGS 84
`selectedBounds` rectangle. It never accepts filesystem paths, GeoServer layer
names, publication identities, histogram dimensions, resampling choices, or
work limits. Both sources are independently authorized through the catalog
source boundary and their filesystem signatures are checked before and after
the read. Pixel and paired-statistics calls remain usable when GeoServer or the
map viewer is unavailable.

For the whole request, the service intersects the WGS 84 source envelopes. A
selected window is intersected with that overlap. X cell centers define the
paired grid; each center is transformed to Y and reads the containing Y cell,
which is the documented nearest-neighbor rule. Positions outside the exact
overlap, masked or nodata values in either source, and non-finite values are
excluded. Swapping roles can therefore change positions and counts when the
source grids differ.

The X envelope keeps at most 127 cells on its longest edge and one source
position per grid cell. Each source separately satisfies the neutral native
block limit of 16,129 reads, the 9 GiB cumulative decoded-work limit, supported
scalar and one-band contracts, and the 1,024-pixel maximum native block edge.
The response is fixed at 32 by 32 bins and contains strictly increasing X/Y
edges, a documented Y-row/X-column count matrix, both marginals, paired count,
X-envelope and sample dimensions, reference-grid and resampling identities,
and exact/approximate provenance.

Paired and ordinary statistics share the configured read-concurrency admission
limit and one combined completed-result cache budget. Paired cache and
coalescing identity includes both ordered Collection and Item IDs, both source
signatures, selected bounds, algorithm version, and all fixed policy
parameters. Browser cancellation and sequence identity cover the complete
pair, so swapping roles, changing the window, or leaving the mode cannot
display an obsolete response.

Temporary AOI lifecycle storage remains independent. Bivariate mode currently
supports whole overlap and a shared rectangular sample window only, so the
temporary-AOI action is disabled rather than translated into another
subsystem's state.
