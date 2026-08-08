import assert from 'node:assert'
import fixtures from './interop_fixtures.js'
import Automerge from '../src/automerge.js'
import { decodeChangeColumns } from '../backend/columnar.js'
function markChange(doc, actor, begin, end) {
  const previous = Automerge.getAllChanges(doc).map(Automerge.decodeChange)
    .filter(change => change.actor === actor).sort((left, right) => left.seq - right.seq).pop()
  return Automerge.encodeChange({
    actor,
    seq: previous ? previous.seq + 1 : 1,
    startOp: previous ? previous.startOp + previous.ops.length : 1,
    time: 0,
    message: 'mark',
    deps: Automerge.getHeads(doc),
    ops: [begin, end]
  })
}

describe('modern mark encoding', () => {
  it('reads and writes mark ranges and spans', () => {
    const fixture = fixtures.marks
    const fixtureDoc = Automerge.load(Uint8Array.from(Buffer.from(fixture.document, 'base64')))
    assert.deepStrictEqual(Automerge.marks(fixtureDoc, ['text']), [
      {name: 'bold', value: true, start: 1, end: 3}
    ])
    assert.deepStrictEqual(Automerge.marksAt(fixtureDoc, ['text'], 1), {bold: true})
    assert.deepStrictEqual(Automerge.spans(fixtureDoc, ['text']), [
      {type: 'text', value: 'a'},
      {type: 'text', value: 'bc', marks: {bold: true}}
    ])
    assert.strictEqual(Automerge.getCursor(fixtureDoc, ['text'], 1, 'before'), '-3@aaaaaa')
    assert.strictEqual(Automerge.getCursor(fixtureDoc, ['text'], 1, 'after'), '3@aaaaaa')
    assert.strictEqual(Automerge.getCursorPosition(fixtureDoc, ['text'], '-3@aaaaaa'), 1)

    let doc = Automerge.from({text: 'abc'}, {actor: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})
    doc = Automerge.change(doc, {time: 0}, draft => {
      Automerge.mark(draft, ['text'], {start: 1, end: 3, expand: 'both'}, 'bold', true)
    })
    assert.deepStrictEqual(Automerge.marks(doc, ['text']), [
      {name: 'bold', value: true, start: 1, end: 3}
    ])
    assert.deepStrictEqual(Automerge.decodeChange(Automerge.getLastLocalChange(doc)).ops.slice(-2)
      .map(op => [op.action, op.expand]), [['markBegin', true], ['markEnd', true]])
    doc = Automerge.change(doc, {time: 0}, draft => {
      Automerge.unmark(draft, ['text'], {start: 2, end: 3}, 'bold')
    })
    assert.deepStrictEqual(Automerge.marks(doc, ['text']), [
      {name: 'bold', value: true, start: 1, end: 2}
    ])
  })

  it('keeps operation cursors stable when their character is deleted', () => {
    let doc = Automerge.from({text: 'abcd'}, {actor: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})
    const before = Automerge.getCursor(doc, ['text'], 1, 'before')
    const after = Automerge.getCursor(doc, ['text'], 1, 'after')
    doc = Automerge.change(doc, draft => { Automerge.splice(draft, ['text'], 1, 1) })
    assert.strictEqual(before, '-3@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    assert.strictEqual(after, '3@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], before), 0)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], after), 1)
  })

  it('roundtrips mark columns and endpoint expansion bits canonically', () => {
    const actor = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    for (const [before, after] of [[false, false], [true, false], [false, true], [true, true]]) {
      const encoded = Automerge.encodeChange({
        actor,
        seq: 1,
        startOp: 1,
        time: 0,
        message: '',
        deps: [],
        ops: [
          {action: 'markBegin', obj: '_root', elemId: '_head', insert: true, name: '', value: null, expand: before, pred: []},
          {action: 'markEnd', obj: '_root', elemId: `1@${actor}`, insert: true, expand: after, pred: []}
        ]
      })
      const decoded = Automerge.decodeChange(encoded)
      const columnIds = decodeChangeColumns(encoded).columns.map(column => column.columnId)

      assert.strictEqual(decoded.ops[0].action, 'markBegin')
      assert.strictEqual(decoded.ops[0].name, '')
      assert.strictEqual(decoded.ops[0].value, null)
      assert.strictEqual(decoded.ops[0].expand, before)
      assert.strictEqual(decoded.ops[1].action, 'markEnd')
      assert.strictEqual(decoded.ops[1].expand, after)
      assert.strictEqual(columnIds.includes(0x94), before || after)
      assert.strictEqual(columnIds.includes(0xa5), true)
      assert.deepStrictEqual(Automerge.encodeChange(decoded), encoded)
    }
  })

  it('preserves zero-width marks through edits, save, and load', () => {
    const actor = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    let doc = Automerge.from({text: 'abc'}, {actor})
    const objectId = Automerge.getObjectId(doc, 'text')
    const encoded = markChange(doc, actor,
      {action: 'markBegin', obj: objectId, elemId: Automerge.getCursor(doc, ['text'], 0), insert: true,
        name: 'bold', value: true, expand: false, pred: []},
      {action: 'markEnd', obj: objectId, elemId: Automerge.getCursor(doc, ['text'], 2), insert: true,
        expand: true, pred: []})
    const markHash = Automerge.decodeChange(encoded).hash

    ;[doc] = Automerge.applyChanges(doc, [encoded])
    assert.strictEqual(String(doc.text), 'abc')
    assert.deepStrictEqual(Automerge.getHeads(doc), [markHash])

    doc = Automerge.change(doc, draft => { Automerge.splice(draft, ['text'], 1, 0, 'X') })
    assert.strictEqual(String(doc.text), 'aXbc')

    const loaded = Automerge.load(Automerge.save(doc))
    assert.strictEqual(String(loaded.text), 'aXbc')
    assert.strictEqual(Automerge.getAllChanges(loaded).map(Automerge.decodeChange)[1].hash, markHash)
    assert.strictEqual(Automerge.getAllChanges(loaded).map(Automerge.decodeChange)[1].ops[0].name, 'bold')
  })

  it('keeps marks zero-width across operation block boundaries', () => {
    const actor = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    let doc = Automerge.from({text: 'x'.repeat(601)}, {actor})
    const objectId = Automerge.getObjectId(doc, 'text')
    const encoded = markChange(doc, actor,
      {action: 'markBegin', obj: objectId, elemId: '_head', insert: true, name: 'bold', value: null, expand: true, pred: []},
      {action: 'markEnd', obj: objectId, elemId: Automerge.getCursor(doc, ['text'], 600), insert: true,
        expand: true, pred: []})

    ;[doc] = Automerge.applyChanges(doc, [encoded])
    doc = Automerge.change(doc, draft => { Automerge.splice(draft, ['text'], 300, 0, 'Y') })
    const loaded = Automerge.load(Automerge.save(doc))

    assert.strictEqual(loaded.text.length, 602)
    assert.strictEqual(String(loaded.text).slice(298, 303), 'xxYxx')
    assert.strictEqual(Automerge.stats(loaded).numOps, 605)
  })
})
