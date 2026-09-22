#!/usr/bin/env node
/**
 * @fileoverview CLI: `nice-svg-generator <folder> <type> [--deep]`.
 *
 * Positional, non-explicit syntax — folder then type, `--deep` to recurse.
 *
 * @module cli
 */

import { convertFolder } from "./run.js"
import { supportedTypes } from "./converters/index.js"

const argv = process.argv.slice(2)
const deep = argv.includes("--deep")
const [folder, type] = argv.filter((a) => !a.startsWith("--"))

if (!folder || !type) {
  console.error(`nice-svg-generator — convert design source files to SVG

Usage:
  nice-svg-generator <folder> <type> [--deep]

  <folder>   folder to scan for <type> files
  <type>     input type: ${supportedTypes().join(", ")}
  --deep     recurse into subfolders (shallow by default)

Examples:
  nice-svg-generator ~/nice/icons/.source ai --deep
  nice-svg-generator ~/nice/icons/.source/github ai`)
  process.exit(1)
}

try {
  const { files, converted, failed } = convertFolder(folder, type, { deep })
  for (const p of converted) console.log(`✓ ${p}`)
  for (const f of failed) console.error(`✗ ${f.file}: ${f.message}`)
  if (!files.length) {
    console.log(`(no .${type} files in ${folder}${deep ? " — deep" : ""})`)
  } else {
    console.log(`\n${converted.length} converted, ${failed.length} failed`)
  }
  process.exit(failed.length ? 1 : 0)
} catch (err) {
  console.error(`Error: ${err.message}`)
  process.exit(1)
}
