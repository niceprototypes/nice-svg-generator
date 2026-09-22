/**
 * @fileoverview Converter registry, keyed by input type.
 *
 * Each converter module exports `types` (the input types it handles) and
 * `convert(buffer) → svgString`. Register a new input type by importing its
 * module and adding it to CONVERTERS — nothing else changes.
 *
 * @module converters
 */

import * as ai from "./ai.js"

// Add future converter modules here (e.g. an `eps` or `sketch` converter).
const CONVERTERS = [ai]

const byType = new Map()
for (const mod of CONVERTERS) {
  for (const type of mod.types) byType.set(type, mod)
}

/** The converter module for an input type, or throw listing what's supported. */
export function getConverter(type) {
  const mod = byType.get(type.toLowerCase())
  if (!mod) {
    throw new Error(`unknown input type "${type}" — supported: ${supportedTypes().join(", ")}`)
  }
  return mod
}

/** All registered input types. */
export function supportedTypes() {
  return [...byType.keys()]
}
