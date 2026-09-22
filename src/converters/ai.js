/**
 * @fileoverview AI (PDF) → SVG converter.
 *
 * Adobe Illustrator files saved "PDF Compatible" are PDFs whose page content
 * stream is a tiny PostScript-like program of path operators. For the icon use
 * case (basic shapes only — no raster, gradients, text, or fonts) that stream
 * is all we need: we inflate it, walk the path/transform operators, and emit an
 * SVG whose `<path>`s carry the raw coordinates plus a `transform` matrix (the
 * content's CTM composed with the PDF→SVG y-flip), exactly the shape pdf2svg
 * produces.
 *
 * Scope guard: any operator that draws out-of-scope content (image `Do`,
 * shading/gradient `sh`, text `Tj`/`TJ`, inline image `BI`) throws, so a file
 * that isn't basic-shapes-only fails loudly instead of converting wrong.
 *
 * @module converters/ai
 */

import zlib from "zlib"

/** Operators that indicate unsupported (non-basic-shape) content. */
const UNSUPPORTED = new Set(["Do", "sh", "BI", "ID", "EI", "Tj", "TJ", "Tf", "'", '"'])

/** Round to 4dp and drop trailing zeros. */
const fmt = (n) => String(Number(n.toFixed(4)))

/** Clamp a 0..1 color channel to a 2-digit hex byte. */
const hexByte = (v) => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, "0")
/** PDF device-color operands → "#rrggbb". Gray fans one channel; CMYK folds to RGB. */
const rgbHex = (r, g, b) => `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`
const grayHex = (v) => rgbHex(v, v, v)
const cmykHex = (c, m, y, k) => rgbHex((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))

/**
 * Resolve a color from `scn`/`sc` operands by count — the device fallback for a
 * named colorspace (`/CS0 cs`, as Illustrator emits for RGB/CMYK/gray docs):
 * 1 → gray, 3 → RGB, 4 → CMYK. A pattern fill (`/P0 scn`) leaves no numeric
 * operands → null, so the caller keeps the current color.
 */
function colorFromOperands(nums) {
  if (nums.length === 1) return grayHex(nums[0])
  if (nums.length === 3) return rgbHex(nums[0], nums[1], nums[2])
  if (nums.length === 4) return cmykHex(nums[0], nums[1], nums[2], nums[3])
  return null
}

/** Compose two affine matrices [a,b,c,d,e,f]; result applies B then A (A·B). */
function compose(A, B) {
  return [
    A[0] * B[0] + A[2] * B[1],
    A[1] * B[0] + A[3] * B[1],
    A[0] * B[2] + A[2] * B[3],
    A[1] * B[2] + A[3] * B[3],
    A[0] * B[4] + A[2] * B[5] + A[4],
    A[1] * B[4] + A[3] * B[5] + A[5],
  ]
}

const IDENTITY = [1, 0, 0, 1, 0, 0]

/** `/MediaBox [x0 y0 x1 y1]` → { x0, y0, x1, y1 }. Throws if absent. */
function findMediaBox(buf) {
  const m = buf
    .toString("latin1")
    .match(/\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/)
  if (!m) throw new Error("no /MediaBox found — not a page-bearing PDF")
  return { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] }
}

/**
 * Inflate every FlateDecode stream and return the one that looks like the page
 * content (the most path operators). These AI files carry exactly one such
 * stream; the rest of the file is uncompressed Illustrator private data.
 */
function findContentStream(buf) {
  const s = buf.toString("latin1")
  const re = /stream\r?\n/g
  let m
  let best = null
  let bestScore = -1
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length
    const end = s.indexOf("endstream", start)
    if (end < 0) continue
    let text
    try {
      text = zlib.inflateSync(buf.slice(start, end)).toString("latin1")
    } catch {
      continue // not a flate stream
    }
    const score = (text.match(/(?:^|\s)(?:m|l|c|v|y|re)(?:\s)/g) || []).length
    if (score > bestScore) {
      bestScore = score
      best = text
    }
  }
  if (!best || bestScore <= 0) throw new Error("no drawable content stream found")
  return best
}

/** Split a content stream into numbers and operator tokens. */
function tokenize(s) {
  const out = []
  for (const raw of s.split(/\s+/)) {
    if (!raw) continue
    if (/^-?\d*\.?\d+$/.test(raw)) out.push(parseFloat(raw))
    else out.push(raw)
  }
  return out
}

/** Splice the last `n` operands off the stack (PDF operators are postfix). */
function take(stack, n) {
  return stack.splice(Math.max(0, stack.length - n), n)
}

/**
 * Walk the content stream, returning painted subpaths as { d, ctm } — `d` in
 * raw user-space coordinates, `ctm` the transform in effect. Clip-only paths
 * (ended by `n`) are dropped.
 */
function parsePaths(content) {
  const paths = []
  const stack = []
  // Graphics-state stack (q/Q) — saves the CTM together with the current fill/
  // stroke color and line width, so a restore rolls back color as well as transform.
  const gsStack = []
  let ctm = IDENTITY.slice()
  // Current paint state. PDF's initial color is black; line width defaults to 1.
  let fill = "#000000"
  let stroke = "#000000"
  let lineWidth = 1
  let d = ""
  let cx = 0
  let cy = 0
  let sx = 0
  let sy = 0

  const flush = (paint) => {
    if (paint && d.trim()) paths.push({ d: d.trim(), ctm: ctm.slice(), paint, fill, stroke, lineWidth })
    d = ""
  }

  for (const tok of tokenize(content)) {
    if (typeof tok === "number") {
      stack.push(tok)
      continue
    }
    if (UNSUPPORTED.has(tok)) {
      throw new Error(`unsupported operator "${tok}" — file is not basic-shapes-only`)
    }
    switch (tok) {
      case "m": { const [x, y] = take(stack, 2); d += `M ${fmt(x)} ${fmt(y)} `; cx = x; cy = y; sx = x; sy = y; break }
      case "l": { const [x, y] = take(stack, 2); d += `L ${fmt(x)} ${fmt(y)} `; cx = x; cy = y; break }
      case "c": { const [x1, y1, x2, y2, x3, y3] = take(stack, 6); d += `C ${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x3)} ${fmt(y3)} `; cx = x3; cy = y3; break }
      // v: first control point is the current point.
      case "v": { const [x2, y2, x3, y3] = take(stack, 4); d += `C ${fmt(cx)} ${fmt(cy)} ${fmt(x2)} ${fmt(y2)} ${fmt(x3)} ${fmt(y3)} `; cx = x3; cy = y3; break }
      // y: second control point is the endpoint.
      case "y": { const [x1, y1, x3, y3] = take(stack, 4); d += `C ${fmt(x1)} ${fmt(y1)} ${fmt(x3)} ${fmt(y3)} ${fmt(x3)} ${fmt(y3)} `; cx = x3; cy = y3; break }
      case "h": { d += "Z "; cx = sx; cy = sy; break }
      case "re": { const [x, y, w, h] = take(stack, 4); d += `M ${fmt(x)} ${fmt(y)} L ${fmt(x + w)} ${fmt(y)} L ${fmt(x + w)} ${fmt(y + h)} L ${fmt(x)} ${fmt(y + h)} Z `; cx = x; cy = y; sx = x; sy = y; break }
      case "cm": { const mtx = take(stack, 6); ctm = compose(ctm, mtx); break }
      case "q": { gsStack.push({ ctm: ctm.slice(), fill, stroke, lineWidth }); break }
      case "Q": {
        const gs = gsStack.pop()
        if (gs) { ctm = gs.ctm; fill = gs.fill; stroke = gs.stroke; lineWidth = gs.lineWidth }
        else ctm = IDENTITY.slice()
        break
      }
      // Line width (user space) — carried onto stroked paths in color mode.
      case "w": { const [lw] = take(stack, 1); lineWidth = lw; break }
      // Device color operators — lowercase sets the fill color, uppercase the
      // stroke. Recorded as graphics-state color and attached to each flushed
      // path; the geometry-only default emit ignores them. Named/spot color
      // spaces (cs/scn) are not device colors and fall through to `default`,
      // leaving the last device color in effect.
      case "rg": { const [r, g, b] = take(stack, 3); fill = rgbHex(r, g, b); break }
      case "RG": { const [r, g, b] = take(stack, 3); stroke = rgbHex(r, g, b); break }
      case "g": { const [v] = take(stack, 1); fill = grayHex(v); break }
      case "G": { const [v] = take(stack, 1); stroke = grayHex(v); break }
      case "k": { const [c, mag, yel, blk] = take(stack, 4); fill = cmykHex(c, mag, yel, blk); break }
      case "K": { const [c, mag, yel, blk] = take(stack, 4); stroke = cmykHex(c, mag, yel, blk); break }
      // Named-colorspace paint (`/CS0 cs` … `scn`) — resolve by operand count.
      // The colorspace decl (cs/CS) and any pattern name clear the stack via
      // `default`, so a pattern fill lands here with no numbers → color kept.
      case "scn": case "sc": { const col = colorFromOperands(stack); if (col) fill = col; stack.length = 0; break }
      case "SCN": case "SC": { const col = colorFromOperands(stack); if (col) stroke = col; stack.length = 0; break }
      // Painting operators — flush the current path, tagged by paint type so a
      // caller can keep only fills or only strokes (see convert's `keep` option).
      case "f": case "F": case "f*":
        flush("fill"); stack.length = 0; break
      case "S": case "s":
        flush("stroke"); stack.length = 0; break
      case "B": case "B*": case "b": case "b*":
        flush("both"); stack.length = 0; break
      // End path with no paint (clip boundary, no-op) — discard.
      case "n":
        flush(null); stack.length = 0; break
      // Clip operators — the following `n` discards the boundary path.
      case "W": case "W*":
        break
      // Any other operator (color/line-state: rg, w, J, j, M, d, cs, …) is
      // irrelevant to geometry; drop its operands and move on.
      default:
        stack.length = 0
    }
  }
  return paths
}

/** A near-duplicate's points must all sit within this fraction of the shape's
 *  bbox diagonal. History/leftover copies are nudged a few %; distinct shapes at
 *  other positions differ by far more, so they're never merged. */
const DUP_TOLERANCE = 0.08

/** Apply an affine matrix [a,b,c,d,e,f] to a point → [x', y']. */
function applyMatrix(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

/**
 * Parse a generated `d` string into its command-letter sequence and ordered
 * coordinate points. Our `d` only uses M/L/C/Z with space-separated numbers, so
 * every non-letter token pairs with the next as one (x, y).
 */
function parseD(d) {
  const cmds = []
  const pts = []
  const toks = d.split(/\s+/).filter(Boolean)
  for (let i = 0; i < toks.length; ) {
    if (/^[A-Za-z]$/.test(toks[i])) { cmds.push(toks[i]); i += 1 }
    else { pts.push([parseFloat(toks[i]), parseFloat(toks[i + 1])]); i += 2 }
  }
  return { cmds: cmds.join(""), pts }
}

/** Diagonal of the bounding box of a point list. */
function bboxDiag(pts) {
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity
  for (const [x, y] of pts) {
    if (x < minx) minx = x; if (x > maxx) maxx = x
    if (y < miny) miny = y; if (y > maxy) maxy = y
  }
  return Math.hypot(maxx - minx, maxy - miny)
}

/** True when two shapes are the same commands and every corresponding absolute
 *  point sits within DUP_TOLERANCE of the (larger) shape's diagonal. */
function sameShape(a, b) {
  if (a.cmds !== b.cmds || a.abs.length !== b.abs.length || a.abs.length === 0) return false
  const diag = Math.max(bboxDiag(a.abs), bboxDiag(b.abs))
  if (diag === 0) return false
  const tol = DUP_TOLERANCE * diag
  for (let i = 0; i < a.abs.length; i++) {
    if (Math.hypot(a.abs[i][0] - b.abs[i][0], a.abs[i][1] - b.abs[i][1]) > tol) return false
  }
  return true
}

/** Drop overlapping near-duplicate paths, keeping the first occurrence. Compares
 *  paths in absolute space (each `d` mapped by its composed transform). */
function dedupeOverlapping(paths, flip) {
  const kept = []
  const sigs = []
  for (const p of paths) {
    const { cmds, pts } = parseD(p.d)
    const t = compose(flip, p.ctm)
    const abs = pts.map(([x, y]) => applyMatrix(t, x, y))
    // Include paint in the signature so two same-shape paths in different colors
    // (a deliberate overlap in an illustration) are never merged — only true
    // history/leftover copies (identical shape AND paint) collapse.
    const sig = { cmds, abs, fill: p.fill, stroke: p.stroke }
    if (!sigs.some((s) => sameShape(s, sig) && s.fill === sig.fill && s.stroke === sig.stroke)) {
      kept.push(p)
      sigs.push(sig)
    }
  }
  return kept
}

/** SVG paint attributes for a path in color mode, from its captured graphics
 *  state. Fills carry their fill; strokes carry `fill="none"` plus the stroke
 *  color and width; `both` carries both. */
function paintAttrs(p) {
  const fills = p.paint === "fill" || p.paint === "both"
  const strokes = p.paint === "stroke" || p.paint === "both"
  let out = ` fill="${fills ? p.fill : "none"}"`
  if (strokes) out += ` stroke="${p.stroke}" stroke-width="${fmt(p.lineWidth)}"`
  return out
}

/**
 * Convert an AI (PDF) buffer to an SVG string.
 *
 * @param {Buffer} buffer - The `.ai` file contents.
 * @param {{ keep?: "fill" | "stroke", color?: boolean }} [options] - `keep`:
 *   keep only paths painted the matching way (fill/both for "fill", stroke/both
 *   for "stroke"); omitted → keep every painted path. `color`: when true, emit
 *   each path's captured fill/stroke color (for colored illustrations); default
 *   false → geometry only (monochrome icons recolored downstream via tokens).
 * @returns {string} SVG markup.
 */
export function convert(buffer, options = {}) {
  const { keep, color = false } = options
  const mb = findMediaBox(buffer)
  let paths = parsePaths(findContentStream(buffer))

  // Map device coords → SVG (y-down, mediabox origin at 0,0).
  const flip = [1, 0, 0, -1, -mb.x0, mb.y1]

  // Guard 1 — paint-type filter (opt-in). Some AI sources leave construction
  // geometry painted the "wrong" way for the variant (e.g. a stroked copy left
  // inside a fill icon). Drop paths that don't match the requested paint type.
  if (keep === "fill") paths = paths.filter((p) => p.paint === "fill" || p.paint === "both")
  else if (keep === "stroke") paths = paths.filter((p) => p.paint === "stroke" || p.paint === "both")

  // Guard 2 — drop overlapping near-duplicate paths (history/leftover copies the
  // PDF stream re-paints nudged a few %). Keep-first; distinct shapes are safe.
  paths = dedupeOverlapping(paths, flip)

  const width = mb.x1 - mb.x0
  const height = mb.y1 - mb.y0
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}">`]
  for (const p of paths) {
    const t = compose(flip, p.ctm).map(fmt).join(",")
    lines.push(`  <path d="${p.d}"${color ? paintAttrs(p) : ""} transform="matrix(${t})"/>`)
  }
  lines.push("</svg>", "")
  return lines.join("\n")
}

/** Input types this converter handles. */
export const types = ["ai"]
