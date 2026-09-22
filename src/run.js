/**
 * @fileoverview Folder → SVG conversion runner (programmatic API).
 *
 * Discovers files of a given input type in a folder (shallow by default, or
 * recursive with `deep`), converts each to a sibling `.svg`, and reports the
 * results. Used by the CLI and importable directly.
 *
 * @module run
 */

import fs from "fs"
import path from "path"
import { getConverter } from "./converters/index.js"

export { supportedTypes } from "./converters/index.js"

/**
 * Convert a single source-file buffer to an SVG string.
 *
 * @param {Buffer} buffer - File contents.
 * @param {string} type - Input type (e.g. "ai").
 * @param {object} [options] - Converter-specific options, forwarded as-is.
 * @returns {string} SVG markup.
 */
export function convert(buffer, type, options) {
  return getConverter(type).convert(buffer, options)
}

/** Files ending in `ext` under `dir` — shallow, or recursive when `deep`. */
function findFiles(dir, ext, deep) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (deep) out.push(...findFiles(full, ext, deep))
    } else if (entry.name.toLowerCase().endsWith(ext)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Convert every `type` file in `folder` to a sibling `.svg`.
 *
 * @param {string} folder - Folder to scan.
 * @param {string} type - Input type (e.g. "ai").
 * @param {{ deep?: boolean }} [options] - Recurse into subfolders when true.
 * @returns {{ files: string[], converted: string[], failed: {file:string,message:string}[] }}
 */
export function convertFolder(folder, type, { deep = false } = {}) {
  const converter = getConverter(type) // throws on unknown type
  const dir = path.resolve(folder)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`not a folder: ${folder}`)
  }

  const ext = `.${type.toLowerCase()}`
  const files = findFiles(dir, ext, deep)

  const converted = []
  const failed = []
  for (const file of files) {
    // Sibling .svg (case-insensitive extension already matched).
    const svgPath = `${file.slice(0, file.length - ext.length)}.svg`
    try {
      fs.writeFileSync(svgPath, converter.convert(fs.readFileSync(file)))
      converted.push(svgPath)
    } catch (err) {
      failed.push({ file, message: err.message })
    }
  }
  return { files, converted, failed }
}
