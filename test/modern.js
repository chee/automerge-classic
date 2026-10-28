import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The Rust/WASM implementation to compare against: AUTOMERGE_MODERN_PATH, a
// built ../automerge/javascript, or the installed @automerge/automerge
const resolve = createRequire(import.meta.url).resolve
const here = path.dirname(fileURLToPath(import.meta.url))
const candidates = [
  process.env.AUTOMERGE_MODERN_PATH,
  path.resolve(here, '..', '..', 'automerge', 'javascript'),
  '@automerge/automerge'
]

function resolveModern() {
  for (const candidate of candidates.filter(Boolean)) {
    try { return resolve(candidate) } catch (e) { /* try the next one */ }
  }
  return null
}

const modernPath = resolveModern()
export const describeLive = modernPath ? describe : describe.skip
export default modernPath ? await import(pathToFileURL(modernPath).href) : null
