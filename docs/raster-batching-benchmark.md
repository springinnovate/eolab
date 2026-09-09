# Raster batching benchmark

Measured locally on Windows on 2026-09-09 using this #360 implementation on
`5ca6b7b` (working tree), Python 3.12, synthetic DEFLATE TIFFs on D:. The script
`tests/benchmark_aggregate_batching.py` generates 2,000 × 1,000 uint16 native
pixels with values `column % 50`, WGS84 transform `(-82, 0, 0.01, -0.02)`, and
32 × 32 or 512 × 512 native blocks. No overviews or resampling are used.

Each run uses a fresh Python process. First-pass and warm-repeat refer to order;
OS/storage caches were not flushed. Reported kernel time excludes queueing,
process startup and publication. Peak memory is the fresh benchmark process's
Windows peak working set, including interpreter/setup, rather than the planner's
conservative admission estimate. Two runs are useful preliminary measurements,
not a statistical performance guarantee.

Numeric runs use `mean(a)`, `sum(a, where=a > 10)` and `count(a > 10)` over the
whole fixture. Polygon runs use `areaha(a > 10)` and `count(a > 10)` over the
country-shaped polygon and triangular hole encoded in the benchmark. Counts and
all eligibility diagnostics match exactly across admitted settings; float totals
match within `rtol=1e-8, atol=1e-8`. The numerical-only fixture has mean 24.5,
selected sum 46,800,000, and 1,560,000 matching pixels.

| Case / native blocks | Target pixels | Read size | Evaluation size | Read calls | Reducer updates | Kernel seconds first / repeat | Peak MiB first / repeat | Estimated MiB |
| --- | ---: | --- | --- | ---: | ---: | --- | --- | ---: |
| Numeric / 32² | Current | 32×32 | 32×32 | 2,016 | 6,048 | 0.5296 / 0.5304 | 91.5 / 91.4 | 147.0 |
| Numeric / 32² | 65,536 | 2,000×32 | 2,000×32 | 32 | 96 | 0.1511 / 0.1588 | 108.6 / 108.4 | 146.8 |
| Numeric / 32² | 262,144 | 2,000×128 | 2,000×128 | 8 | 24 | 0.1465 / 0.1478 | 119.8 / 119.8 | 203.2 |
| Numeric / 32² | 1,048,576 | 2,000×512 | 2,000×512 | 2 | 6 | 0.1513 / 0.1613 | 132.7 / 133.0 | 428.8 |
| Numeric / 512² | Current | 512×512 | 256×256 | 8 | 96 | 0.0438 / 0.0427 | 105.3 / 105.3 | 147.8 |
| Numeric / 512² | 65,536 | 512×512 | 512×128 | 8 | 96 | 0.0431 / 0.0436 | 104.7 / 105.2 | 148.0 |
| Numeric / 512² | 262,144 | 512×512 | 512×512 | 8 | 24 | 0.0405 / 0.0425 | 118.8 / 119.0 | 205.0 |
| Numeric / 512² | 1,048,576 | 2,000×512 | 2,000×512 | 2 | 6 | 0.0476 / 0.0474 | 129.8 / 130.3 | 428.8 |
| Polygon / 512² | Current | 512×512 | 256×256 | 8 | 64 | 0.6151 / 0.6227 | 116.2 / 116.3 | 272.8 |
| Polygon / 512² | 65,536 | 512×512 | 512×128 | 8 | 64 | 0.4261 / 0.4378 | 116.3 / 116.4 | 283.0 |
| Polygon / 512² | 262,144 | 512×512 | 512×512 | 8 | 16 | 0.4321 / 0.4248 | 129.6 / 129.3 | 361.0 |

For the 32² numeric fixture at 262,144 pixels, first/repeat read times were
0.1055/0.1070 s and calculation times 0.0327/0.0323 s, versus current behavior's
0.1779/0.1794 s and 0.3341/0.3322 s. The clearest gain is reduced per-block overhead
on small-block TIFFs. Larger native blocks already avoid much of that overhead;
the million-pixel setting was slightly slower in that numeric fixture.

Both 4,194,304-pixel numeric trials were refused before pixel I/O at an estimated
715.5 MiB. Polygon trials at 1,048,576 and 4,194,304 pixels were refused at
666.2 and 1,057.1 MiB respectively. The admission ceiling stayed 512 MiB.

The default remains current behavior. These measurements support exposing tuning
for review, not selecting a universal new default. Full JSON measurements,
including every phase, exact rows, effective dimensions and refusal messages,
can be reproduced with:

```sh
python tests/benchmark_aggregate_batching.py --scratch D:/eolab-benchmark-360 --repeats 2
```
