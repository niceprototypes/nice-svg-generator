# nice-svg-generator

Convert design source files to clean SVG. Zero runtime dependencies (Node's
built-in `zlib` only). The first — and currently only — input type is **`ai`**
(Adobe Illustrator, read via its PDF representation); the converter registry is
built so a second type can be added as one module.

## Usage

```bash
nice-svg-generator <folder> <type> [--deep]
```

- `<folder>` — folder to scan for `<type>` files
- `<type>` — input type (`ai`)
- `--deep` — recurse into subfolders (shallow by default)

Each converted file is written as a sibling `.svg` next to its source.

```bash
# Convert every .ai under a tree:
nice-svg-generator path/to/icons/.source ai --deep

# Shallow-convert a single icon folder:
nice-svg-generator path/to/icons/.source/github ai
```

Programmatic:

```js
import { convertFolder } from "nice-svg-generator"
const { converted, failed } = convertFolder("path/to/icons/.source/github", "ai")
```

## Scope (AI converter)

Handles **basic vector shapes only** — the path and transform operators of a
PDF content stream (`m l c v y h re`, `cm q Q`). It ignores paint/color state
(fill/stroke are the consumer's concern) and **throws** on out-of-scope content
(images `Do`, gradients `sh`, text `Tj`/`TJ`, inline images `BI`) so a file that
isn't basic-shapes-only fails loudly rather than converting wrong.

Output is minimal: `<svg viewBox>` with one `<path>` per drawn subpath, carrying
raw coordinates plus a `transform` matrix (the content CTM composed with the
PDF→SVG y-flip) — the same shape `pdf2svg` produces, with none of its `pt`/`rgb`
presentation artifacts.

## Adding an input type

Add `src/converters/{type}.js` exporting `types: ["{type}"]` and
`convert(buffer) → svgString`, then register it in `src/converters/index.js`.
