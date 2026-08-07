const assert = require('assert')
const Automerge = require('../src/automerge')

describe('byte values', () => {
  it('stores byte views without including unrelated buffer bytes', () => {
    const source = new Uint8Array([0, 1, 2, 3])
    let doc = Automerge.init('aa')
    doc = Automerge.change(doc, draft => {
      draft.bytes = source.subarray(1, 3)
      draft.list = [source.subarray(2, 4)]
    })
    assert.deepStrictEqual([...doc.bytes], [1, 2])
    assert.deepStrictEqual([...doc.list[0]], [2, 3])

    doc = Automerge.change(doc, draft => {
      draft.bytes = new Uint8Array([...draft.bytes, 4])
    })
    const loaded = Automerge.load(Automerge.save(doc))
    assert.deepStrictEqual([...loaded.bytes], [1, 2, 4])
    assert.deepStrictEqual([...loaded.list[0]], [2, 3])
  })

  it('preserves conflicting byte values', () => {
    let left = Automerge.from({bytes: new Uint8Array([0])}, 'aa')
    let right = Automerge.clone(left, {actorId: 'bb'})
    left = Automerge.change(left, draft => { draft.bytes = new Uint8Array([1]) })
    right = Automerge.change(right, draft => { draft.bytes = new Uint8Array([2]) })
    const merged = Automerge.merge(left, right)
    const conflicts = Automerge.getConflicts(merged, 'bytes')
    assert.deepStrictEqual(Object.values(conflicts).map(value => [...value]).sort(), [[1], [2]])
  })
})
