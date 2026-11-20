import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, extname, resolve } from 'node:path'

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']

function isFile(filePath) {
  return existsSync(filePath) && statSync(filePath).isFile()
}

export function resolveRelativeModule(fromFile, specifier) {
  const base = resolve(dirname(resolve(fromFile)), specifier)
  if (isFile(base)) return base
  if (!extname(base)) {
    for (const ext of EXTENSIONS) {
      if (isFile(`${base}${ext}`)) return `${base}${ext}`
    }
    for (const ext of EXTENSIONS) {
      const indexPath = resolve(base, `index${ext}`)
      if (isFile(indexPath)) return indexPath
    }
  }
  return base
}

export function createFileRequire(fromFile, fallbackRequire) {
  const localRequire = createRequire(resolve(fromFile))
  return specifier => {
    if (specifier.endsWith('.css')) return {}
    if (specifier.endsWith('.svg')) return { default: specifier }
    if (specifier.startsWith('.')) return localRequire(resolveRelativeModule(fromFile, specifier))
    return fallbackRequire ? fallbackRequire(specifier) : localRequire(specifier)
  }
}
