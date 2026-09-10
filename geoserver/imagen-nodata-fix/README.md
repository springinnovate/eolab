# ImageN unsigned NoData scaling patch

ImageN 0.9.2's `RangeUshort.getMin()` returns a Java `Short`. The scaling
factories promote that signed representation directly to `double` when no
explicit output background is supplied. For a UInt16 NoData value of 65535,
the output raster still contains 65535, but its `GC_NODATA` metadata says -1.
GeoTools then applies the color ramp to the formerly missing pixel.

This module changes the four affected minimum conversions in `ScaleCRIF`,
`ScaleBilinearOpImage`, `Scale2CRIF` and `Scale2BilinearOpImage`. A USHORT range
uses `Short.toUnsignedInt` before numeric promotion. Other range types retain
their existing interpretation, including signed negative NoData. Explicit
background values retain precedence. No raster or style rewrite is involved.

The audit of both scaling source artifacts found these four `getMin()` calls
and no `getMax()` calls. This patch does not change the public `Range` API or
attempt a general rewrite of range arithmetic elsewhere in ImageN.

## Build and verify

Use Java 17 and Maven 3.9.11, as in `Dockerfile.geoserver`:

```sh
mvn --batch-mode --no-transfer-progress clean verify
```

To prove the regression tests detect the original defect:

```sh
mvn --batch-mode --no-transfer-progress clean verify -Dpatch.skip=true
```

The second command is expected to fail. Always rebuild normally afterwards.
Tests cover nearest, bilinear and bicubic interpolation in both registered
scaling operations, UInt16 values 32767/32768/65535, signed negative controls,
explicit output backgrounds, and the real GeoTools scale-to-color-map boundary.
They check both metadata endpoints, output samples, NoData alpha and opaque
valid zero/50 colors. Failsafe reruns the suite against the packaged jars with
the original scaling dependencies and loose replacement classes excluded.

Source SHA-256 checks and original-image jar SHA-256 checks fail closed when
the pinned artifacts change. The build compiles only the four changed classes against the released
dependencies. It inserts them into copies of the original `scale` and `scale2`
jars, preserving the remaining classes, registry resources, licenses and
manifests. The Dockerfile replaces those jars in place, so there are no duplicate
class definitions in an extra patch jar. The module's own ordinary Maven jar
is not deployed.

## Ownership and lifecycle

- **Owner:** ImageN raster scaling, packaged by the GeoServer image.
- **Used by:** GeoTools coverage rendering and GeoServer WMS.
- **Depends on:** the existing ImageN range and interpolation implementations.
- **Coordinates with:** downstream color mapping via the existing `GC_NODATA`
  metadata contract.

There are no new runtime dependencies, subsystem relationships, sibling
knowledge or public APIs. Maven's dependency, Ant and Failsafe plugins support
source patching, jar assembly and verification using the existing Maven/JDK
build toolchain. The maintenance compromise is a version-specific downstream
patch. Remove it when a tested upstream release provides the same correction;
re-audit it when upgrading ImageN or GeoServer.

After rollout, verify an uncached WMS request at a known NoData coordinate.
Existing persisted GeoWebCache tiles may still contain old colors and must be
truncated for affected layers; a new image alone does not invalidate them.
Application process-local composite caches clear on application redeployment.
