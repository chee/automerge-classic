const assert = require('assert')
const Automerge = require('../src/automerge')

describe('history fragments', () => {
  it('uses ordered backend metadata and hash indexes', () => {
    let doc = Automerge.from({value: 1}, {actor: 'aa'})
    doc = Automerge.change(doc, {time: 0}, draft => { draft.value = 2 })
    doc = Automerge.change(doc, {time: 0}, draft => { draft.value = 3 })
    doc = Automerge.load(Automerge.save(doc), {actor: 'cc'})

    const state = Automerge.Frontend.getBackendState(doc)
    const metadata = Automerge.Backend.getHistoryMeta(state)
    const hashes = metadata.map(change => change.hash)
    assert.deepStrictEqual(metadata.map(change => change.index), [0, 1, 2])
    assert.deepStrictEqual(metadata.map(change => change.deps), [[], [hashes[0]], [hashes[1]]])
    assert.strictEqual(Automerge.Backend.getHistoryMeta(state), metadata)

    const selected = Automerge.Backend.getChangesByHash(state, [hashes[2], hashes[0]])
    assert.deepStrictEqual(selected.map(change => Automerge.decodeChange(change).hash), [hashes[0], hashes[2]])
    const bundled = Automerge.Backend.saveBundleByHash(state, [hashes[2], hashes[0]])
    assert.deepStrictEqual(Automerge.readBundle(bundled).changes.map(change => change.hash), [hashes[0], hashes[2]])

    const cloned = Automerge.clone(doc, {actor: 'bb'})
    const clonedState = Automerge.Frontend.getBackendState(cloned)
    assert.strictEqual(Automerge.Backend.getHistoryMeta(clonedState), metadata)
    const changed = Automerge.change(cloned, {time: 0}, draft => { draft.value = 4 })
    assert.notStrictEqual(Automerge.Backend.getHistoryMeta(Automerge.Frontend.getBackendState(changed)), metadata)
    assert.strictEqual(Automerge.Backend.getHistoryMeta(state), metadata)
  })

  it('builds and bundles fragments without scanning encoded history', () => {
    let doc = Automerge.from({value: 1}, {actor: 'aa'})
    for (let index = 0; index < 20; index++) {
      doc = Automerge.change(doc, {time: 0}, draft => { draft.value = index })
    }
    const state = Automerge.Frontend.getBackendState(doc)
    const hashes = Automerge.Backend.getHistoryMeta(state).map(change => change.hash)
    const getAllChanges = Automerge.Backend.getAllChanges
    Automerge.Backend.getAllChanges = () => { throw new Error('history scan') }
    try {
      const metadata = Automerge.getFragmentMetadata(doc)
      assert(metadata.length > 0)
      assert.deepStrictEqual(Automerge.getFragmentMetadata(doc), metadata)
      const bundled = Automerge.readBundle(Automerge.saveBundle(doc, [hashes[19], hashes[3]]))
      assert.deepStrictEqual(bundled.changes.map(change => change.hash), [hashes[3], hashes[19]])
      assert.strictEqual(Automerge.bundleFragmentMetadata(doc, metadata).length, metadata.length)
    } finally {
      Automerge.Backend.getAllChanges = getAllChanges
    }
  })

  it('matches the content-addressed fragment hierarchy', () => {
    let doc = Automerge.init({actor: '00000000000000000000000000000002'})
    for (let index = 0; index < 700; index++) {
      doc = Automerge.change(doc, {time: 0}, draft => { draft.n = index })
    }

    const changes = Automerge.getAllChanges(doc).map(Automerge.decodeChange)
    const indexByHash = new Map(changes.map((change, index) => [change.hash, index]))
    const metadata = Automerge.getFragmentMetadata(doc)
    const fragments = metadata.filter(fragment => fragment.level > 0)
    const commits = metadata.filter(fragment => fragment.level === 0)

    assert.deepStrictEqual(fragments.map(fragment => indexByHash.get(fragment.head)), [555, 642])
    assert.deepStrictEqual(fragments.map(fragment => fragment.level), [2, 1])
    assert.deepStrictEqual(fragments[0].boundary, [])
    assert.deepStrictEqual(fragments[0].checkpoints.map(hash => indexByHash.get(hash)), [555, 486, 485])
    assert.deepStrictEqual(fragments[0].members.map(hash => indexByHash.get(hash)),
      Array.from({length: 556}, (_, index) => 555 - index))
    assert.deepStrictEqual(fragments[1].boundary.map(hash => indexByHash.get(hash)), [555])
    assert.deepStrictEqual(fragments[1].checkpoints.map(hash => indexByHash.get(hash)), [642])
    assert.deepStrictEqual(fragments[1].members.map(hash => indexByHash.get(hash)),
      Array.from({length: 87}, (_, index) => 642 - index))
    assert.deepStrictEqual(commits.map(commit => indexByHash.get(commit.head)),
      Array.from({length: 57}, (_, index) => 643 + index))
    assert.strictEqual(Automerge.getFragmentMeta(doc, changes[485].hash), null)
    assert.deepStrictEqual(Automerge.getFragmentMeta(doc, changes[484].hash), {
      head: changes[484].hash,
      level: 0,
      boundary: changes[484].deps,
      checkpoints: [],
      members: [changes[484].hash]
    })
  })
})
