const assert = require('assert')
const Automerge = require('../src/automerge')
const { splitContainers } = require('../backend/columnar')

describe('incremental persistence', () => {
  it('saves only changes since the previous cursor', () => {
    let doc = Automerge.init('aa')
    let state = Automerge.Frontend.getBackendState(doc)
    assert.strictEqual(Automerge.Backend.saveIncremental(state).byteLength, 0)

    doc = Automerge.change(doc, draft => { draft.one = 1 })
    state = Automerge.Frontend.getBackendState(doc)
    const first = Automerge.Backend.saveIncremental(state)
    assert.strictEqual(splitContainers(first).length, 1)
    assert.strictEqual(Automerge.Backend.saveIncremental(state).byteLength, 0)

    doc = Automerge.change(doc, draft => { draft.two = 2 })
    state = Automerge.Frontend.getBackendState(doc)
    const second = Automerge.Backend.saveIncremental(state)
    assert.strictEqual(splitContainers(second).length, 1)
    assert.strictEqual(Automerge.decodeChange(second).message, null)
  })

  it('loads full documents and trailing changes incrementally', () => {
    let source = Automerge.from({one: 1}, 'aa')
    const full = Automerge.save(source)
    Automerge.Backend.saveIncremental(Automerge.Frontend.getBackendState(source))
    source = Automerge.change(source, draft => { draft.two = 2 })
    const tail = Automerge.Backend.saveIncremental(Automerge.Frontend.getBackendState(source))
    const bytes = new Uint8Array(full.byteLength + tail.byteLength)
    bytes.set(full)
    bytes.set(tail, full.byteLength)

    const initial = Automerge.Backend.init()
    const [state, patch] = Automerge.Backend.loadIncremental(initial, bytes)
    const target = Automerge.Frontend.applyPatch(
      Automerge.Frontend.init({backend: Automerge.Backend, actorId: 'bb'}),
      patch,
      state
    )
    assert.deepStrictEqual({one: target.one, two: target.two}, {one: 1, two: 2})
    assert.deepStrictEqual(Automerge.Backend.getHeads(state), Automerge.Backend.getHeads(
      Automerge.Frontend.getBackendState(source)
    ))
  })

  it('saves changes after specified heads', () => {
    let doc = Automerge.from({one: 1}, 'aa')
    const heads = Automerge.Backend.getHeads(Automerge.Frontend.getBackendState(doc))
    doc = Automerge.change(doc, draft => { draft.two = 2 })
    const state = Automerge.Frontend.getBackendState(doc)
    const bytes = Automerge.Backend.saveSince(state, heads)
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
    const state = Automerge.Frontend.getBackendState(doc)
    const heads = Automerge.Backend.getHeads(state)
    const traversal = Automerge.Backend.topoHistoryTraversal(state)
    const metadata = Automerge.Backend.getChangesMeta(state)
    assert.deepStrictEqual(traversal, metadata.map(change => change.hash))
    assert.strictEqual(Automerge.Backend.hasHeads(state, heads), true)
    assert.deepStrictEqual(Automerge.Backend.stats(state), {
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
