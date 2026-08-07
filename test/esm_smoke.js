const assert = require('assert')
const {execFileSync} = require('child_process')
const {readFileSync} = require('fs')
const path = require('path')
const {SourceTextModule} = require('vm')

function loadBundle(filename) {
  const source = readFileSync(path.join(__dirname, '..', 'dist', filename), 'utf8')
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

const nodeScript = "Promise.all([import('@automerge/automerge-classic'), import('@automerge/automerge-classic/slim'), import('@automerge/automerge-classic/classic')]).then(apis => { for (const api of apis) { let doc = api.from({value: 1}, {actor: 'aabb'}); doc = api.change(doc, draft => { draft.value = 2 }); if (api.load(api.save(doc), {actor: 'ccdd'}).value !== 2) process.exitCode = 1 } })"
execFileSync(process.execPath, ['--input-type=module', '-e', nodeScript])

loadBundle('automerge.mjs').then(root => loadBundle('classic.mjs').then(classic => {
  verify(root)
  verify(classic)
  assert.notStrictEqual(root.init, classic.init)
})).catch(error => {
  setImmediate(() => { throw error })
})
