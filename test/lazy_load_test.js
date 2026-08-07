const assert = require('assert')
const Automerge = require('../src/automerge')
const { MAX_MAP_BLOCK_SIZE } = require('../backend/new')

function state(doc) {
  return Automerge.getBackend(doc).state
}

describe('lazy loaded state', () => {
  it('defers history materialization and block splitting through clone', () => {
    let source = Automerge.init('aaaaaaaa')
    for (let value = 0; value <= MAX_MAP_BLOCK_SIZE; value++) {
      source = Automerge.change(source, doc => { doc.value = value })
    }

    const loaded = Automerge.load(Automerge.save(source))
    const loadedState = state(loaded)
    assert.strictEqual(loadedState.haveHashGraph, false)
    assert.strictEqual(loadedState.changesEncoders, null)
    assert.strictEqual(loadedState.blocks.length, 1)
    assert.deepStrictEqual(Automerge.getMissingDeps(loaded), [])
    assert.strictEqual(loadedState.haveHashGraph, false)

    let copy = Automerge.clone(loaded, {actor: 'bbbbbbbb'})
    const copyState = state(copy)
    assert.strictEqual(copyState.haveHashGraph, false)
    assert.strictEqual(copyState.changesEncoders, null)
    assert.strictEqual(copyState.changesColumns, loadedState.changesColumns)

    copy = Automerge.change(copy, doc => { doc.value = MAX_MAP_BLOCK_SIZE + 1 })
    assert.strictEqual(state(copy).haveHashGraph, false)
    assert.strictEqual(Array.isArray(state(copy).changesEncoders), true)
    assert.strictEqual(state(copy).blocks.every(block => block.numOps <= MAX_MAP_BLOCK_SIZE), true)
    assert.strictEqual(Automerge.load(Automerge.save(copy)).value, MAX_MAP_BLOCK_SIZE + 1)
    assert.strictEqual(Automerge.getAllChanges(copy).length, MAX_MAP_BLOCK_SIZE + 2)
  })

  it('shares untouched compressed slabs across document snapshots', () => {
    let before = Automerge.init('aaaaaaaa')
    for (let index = 0; index < 80; index++) {
      before = Automerge.change(before, doc => { doc.value = index })
    }
    const snapshot = Automerge.clone(before, {actor: 'bbbbbbbb'})
    const beforeBytes = Automerge.save(snapshot)
    const snapshotState = state(snapshot)
    const beforeAction = snapshotState.blocks[0].columns.find(column => column.columnId === 66).columnData
    const after = Automerge.change(before, doc => { doc.value = 80 })
    const afterAction = state(after).blocks[0].columns.find(column => column.columnId === 66).columnData

    assert.ok(beforeAction.slabs.length > 1)
    assert.strictEqual(afterAction.slabs[0].data, beforeAction.slabs[0].data)
    assert.deepStrictEqual(Automerge.save(snapshot), beforeBytes)
    assert.strictEqual(after.value, 80)
    assert.strictEqual(Automerge.load(Automerge.save(after)).value, 80)
  })
})
