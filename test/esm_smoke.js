import assert from 'node:assert'
import {execFileSync} from 'node:child_process'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {SourceTextModule} from 'node:vm'

const here = path.dirname(fileURLToPath(import.meta.url))

function loadBundle(filename) {
  const source = readFileSync(path.join(here, '..', 'dist', filename), 'utf8')
  const module = new SourceTextModule(source, {identifier: filename})
  return module.link(specifier => {
    throw new Error(`Unexpected import: ${specifier}`)
  }).then(() => module.evaluate()).then(() => module.namespace)
}

function verify(api) {
  assert.strictEqual(typeof api.init, 'function')
  assert.strictEqual(typeof api.change, 'function')
  assert.strictEqual(typeof api.default, 'object')
  let doc = api.from({value: 1}, {actor: 'aabb'})
  doc = api.change(doc, draft => { draft.value = 2 })
  assert.strictEqual(api.load(api.save(doc), {actor: 'ccdd'}).value, 2)
}

const nodeScript = "Promise.all([import('@automerge/automerge-classic'), import('@automerge/automerge-classic/slim')]).then(apis => { for (const api of apis) { let doc = api.from({value: 1}, {actor: 'aabb'}); doc = api.change(doc, draft => { draft.value = 2 }); if (api.load(api.save(doc), {actor: 'ccdd'}).value !== 2) process.exitCode = 1 } })"
execFileSync(process.execPath, ['--input-type=module', '-e', nodeScript])

const root = await loadBundle('automerge.js')
verify(root)
