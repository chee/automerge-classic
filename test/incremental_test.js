import assert from 'node:assert'
import Automerge from '../src/automerge.js'
import * as Backend from '../backend/index.js'
import * as Frontend from '../frontend/index.js'
import { splitContainers } from '../backend/columnar.js'
describe('incremental persistence', () => {
  it('saves only changes since the previous cursor', () => {
    let doc = Automerge.init('aa')
    let state = Frontend.getBackendState(doc)
    assert.strictEqual(Backend.saveIncremental(state).byteLength, 0)

    doc = Automerge.change(doc, draft => { draft.one = 1 })
    state = Frontend.getBackendState(doc)
    const first = Backend.saveIncremental(state)
    assert.strictEqual(splitContainers(first).length, 1)
    assert.strictEqual(Backend.saveIncremental(state).byteLength, 0)

    doc = Automerge.change(doc, draft => { draft.two = 2 })
    state = Frontend.getBackendState(doc)
    const second = Backend.saveIncremental(state)
    assert.strictEqual(splitContainers(second).length, 1)
    assert.strictEqual(Automerge.decodeChange(second).message, null)
  })

  it('loads full documents and trailing changes incrementally', () => {
    let source = Automerge.from({one: 1}, 'aa')
    const full = Automerge.save(source)
    Backend.saveIncremental(Frontend.getBackendState(source))
    source = Automerge.change(source, draft => { draft.two = 2 })
    const tail = Backend.saveIncremental(Frontend.getBackendState(source))
    const bytes = new Uint8Array(full.byteLength + tail.byteLength)
    bytes.set(full)
    bytes.set(tail, full.byteLength)

    const initial = Backend.init()
    const [state, patch] = Backend.loadIncremental(initial, bytes)
    const target = Frontend.applyPatch(
      Frontend.init({backend: Backend, actorId: 'bb'}),
      patch,
      state
    )
    assert.deepStrictEqual({one: target.one, two: target.two}, {one: 1, two: 2})
    assert.deepStrictEqual(Backend.getHeads(state), Backend.getHeads(
      Frontend.getBackendState(source)
    ))
  })

  it('saves changes after specified heads', () => {
    let doc = Automerge.from({one: 1}, 'aa')
    const heads = Backend.getHeads(Frontend.getBackendState(doc))
    doc = Automerge.change(doc, draft => { draft.two = 2 })
    const state = Frontend.getBackendState(doc)
    const bytes = Backend.saveSince(state, heads)
    assert.strictEqual(splitContainers(bytes).length, 1)
    assert.strictEqual(Automerge.decodeChange(bytes).ops[0].key, 'two')
  })

  it('preserves encoded history when clones continue changing', () => {
    let original = Automerge.from({one: 1}, 'aa')
    original = Automerge.change(original, draft => { draft.two = 2 })
    Automerge.save(original)

    let copy = Automerge.clone(original, {actor: 'bb'})
    copy = Automerge.change(copy, draft => { draft.three = 3 })
    const loaded = Automerge.load(Automerge.save(copy))

    assert.deepStrictEqual(Automerge.toJS(loaded), {one: 1, two: 2, three: 3})
    assert.strictEqual(Automerge.getAllChanges(loaded).length, 3)
    assert.deepStrictEqual(Automerge.toJS(original), {one: 1, two: 2})
  })

  it('exposes compact history metadata', () => {
    let doc = Automerge.from({one: 1}, 'aa')
    doc = Automerge.change(doc, draft => { draft.two = 2 })
    const state = Frontend.getBackendState(doc)
    const heads = Backend.getHeads(state)
    const traversal = Backend.topoHistoryTraversal(state)
    const metadata = Backend.getChangesMeta(state)
    assert.deepStrictEqual(traversal, metadata.map(change => change.hash))
    assert.strictEqual(Backend.hasHeads(state, heads), true)
    assert.deepStrictEqual(Backend.stats(state), {
      numChanges: 2,
      numOps: 2,
      numActors: 1
    })
  })

  it('orders non-BMP map keys by UTF-8 bytes', () => {
    let doc = Automerge.init('aa')
    doc = Automerge.change(doc, draft => {
      draft['😀'] = 1
      draft['\ue000'] = 2
    })
    doc = Automerge.change(doc, draft => {
      draft['😀'] = 3
      draft['\ue000'] = 4
    })
    const loaded = Automerge.load(Automerge.save(doc))
    assert.strictEqual(loaded['😀'], 3)
    assert.strictEqual(loaded['\ue000'], 4)
  })
})
