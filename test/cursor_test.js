import assert from 'node:assert'
import Automerge from './subject.js'

describe('cursors', () => {
  it('uses cursors as splice indexes', () => {
    let doc = Automerge.from({value: 'The sly fox jumped over the lazy dog'})
    const cursor = Automerge.getCursor(doc, ['value'], 19)
    doc = Automerge.change(doc, d => { Automerge.splice(d, ['value'], 0, 3, 'Has the') })
    assert.strictEqual(doc.value, 'Has the sly fox jumped over the lazy dog')
    doc = Automerge.change(doc, d => { Automerge.splice(d, ['value'], cursor, 0, 'right ') })
    assert.strictEqual(doc.value, 'Has the sly fox jumped right over the lazy dog')
    assert.strictEqual(typeof Automerge.getCursorPosition(doc, ['value'], cursor), 'number')
  })

  it('uses cursors in common text operations', () => {
    let doc = Automerge.from({value: 'The sly fox jumped over the lazy dog'})
    let doc2 = Automerge.clone(doc)
    const cursor = Automerge.getCursor(doc, ['value'], 8)

    doc = Automerge.change(doc, d => {
      Automerge.splice(d, ['value'], cursor, 0, 'o')
      Automerge.splice(d, ['value'], cursor, 0, 'l')
      Automerge.splice(d, ['value'], cursor, 0, 'e')
    })
    doc2 = Automerge.change(doc2, d => { Automerge.splice(d, ['value'], 3, -3, 'A') })
    doc = Automerge.merge(doc, doc2)
    doc = Automerge.change(doc, d => {
      Automerge.splice(d, ['value'], cursor, -1, 'd')
      Automerge.splice(d, ['value'], cursor, 0, ' ')
    })
    assert.strictEqual(doc.value, 'A sly old fox jumped over the lazy dog')
  })

  it('uses JavaScript string indices', () => {
    let doc = Automerge.from({value: '🇬🇧🇩🇪'})
    const cursor = Automerge.getCursor(doc, ['value'], doc.value.indexOf('🇩🇪'))
    doc = Automerge.change(doc, d => {
      Automerge.splice(d, ['value'], cursor, -2, '')
      Automerge.splice(d, ['value'], cursor, -2, '')
      Automerge.splice(d, ['value'], cursor, 0, '🇫🇷')
    })
    assert.strictEqual(doc.value, '🇫🇷🇩🇪')
  })

  it('supports start and end cursors', () => {
    let doc = Automerge.from({text: 'abc'})
    const end = Automerge.getCursor(doc, ['text'], 'end')
    const start = Automerge.getCursor(doc, ['text'], 'start')
    doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], end, 0, 'def') })
    assert.strictEqual(doc.text, 'abcdef')
    doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], start, 0, 'hello') })
    assert.strictEqual(doc.text, 'helloabcdef')
  })

  it('supports move before and after', () => {
    let doc = Automerge.from({text: 'aaa@bbb'})
    const before = Automerge.getCursor(doc, ['text'], 3, 'before')
    const after = Automerge.getCursor(doc, ['text'], 3, 'after')
    doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], 3, 1, '~~~') })
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], before), 2)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], after), 6)
  })

  it('converts negative indices into a start cursor', () => {
    let doc = Automerge.from({text: 'is awesome'})
    const cursor = Automerge.getCursor(doc, ['text'], -1)
    doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], cursor, 0, 'Automerge ') })
    assert.strictEqual(doc.text, 'Automerge is awesome')
  })

  it('converts indices past the end into an end cursor', () => {
    const doc = Automerge.from({text: 'Alex'})
    const cursor1 = Automerge.getCursor(doc, ['text'], 1337)
    const cursor2 = Automerge.getCursor(doc, ['text'], 4)
    const fork = Automerge.clone(doc)
    const doc1 = Automerge.change(doc, d => { Automerge.splice(d, ['text'], cursor1, 0, ' Good') })
    const doc2 = Automerge.change(fork, d => { Automerge.splice(d, ['text'], cursor2, 0, ' Good') })
    assert.strictEqual(doc1.text, 'Alex Good')
    assert.strictEqual(doc2.text, 'Alex Good')
  })

  describe('views', () => {
    it('resolves cursor positions in a view', () => {
      let doc = Automerge.from({text: 'abc'})
      const cursor = Automerge.getCursor(doc, ['text'], 1)
      doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], 1, 0, 'x') })
      const heads = Automerge.getHeads(doc)
      doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], 1, 0, 'y') })
      assert.strictEqual(Automerge.getCursorPosition(Automerge.view(doc, heads), ['text'], cursor), 2)
    })

    it('creates cursors against a view', () => {
      let doc = Automerge.from({text: 'aaa@bbb'})
      const heads = Automerge.getHeads(doc)
      doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], 3, 1, '~~~') })
      const at = Automerge.view(doc, heads)
      const before = Automerge.getCursor(at, ['text'], 3, 'before')
      const after = Automerge.getCursor(at, ['text'], 3, 'after')
      const start = Automerge.getCursor(at, ['text'], 'start')
      const end = Automerge.getCursor(at, ['text'], 'end')
      assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], start), 0)
      assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], before), 2)
      assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], after), 6)
      assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], end), 9)
    })
  })

  it('reports where patches came from', () => {
    const callbacks = []
    function patchCallback(patches, info) { callbacks.push(info.source) }
    let doc1 = Automerge.from({hello: 'world'}, {patchCallback})
    const heads1 = Automerge.getHeads(doc1)
    let doc2 = Automerge.clone(doc1, {patchCallback})
    doc2 = Automerge.change(doc2, d => { d.a = 'b' })
    doc2 = Automerge.changeAt(doc2, heads1, d => { d.b = 'c' }).newDoc
    doc1 = Automerge.merge(doc1, doc2)
    doc2 = Automerge.change(doc2, d => { d.x = 'y' })
    doc1 = Automerge.loadIncremental(doc1, Automerge.saveIncremental(doc2))
    doc2 = Automerge.change(doc2, d => { d.n = 'm' })
    let state1 = Automerge.initSyncState(), state2 = Automerge.initSyncState()
    for (;;) {
      const forward = Automerge.generateSyncMessage(doc1, state2)
      state2 = forward[0]
      if (forward[1]) {
        const received = Automerge.receiveSyncMessage(doc2, state1, forward[1])
        doc2 = received[0]
        state1 = received[1]
      }
      const back = Automerge.generateSyncMessage(doc2, state1)
      state1 = back[0]
      if (!back[1]) break
      const received = Automerge.receiveSyncMessage(doc1, state2, back[1], {patchCallback})
      doc1 = received[0]
      state2 = received[1]
    }
    assert.deepStrictEqual(callbacks, [
      'from', 'change', 'changeAt', 'merge', 'change', 'loadIncremental', 'change', 'receiveSyncMessage'
    ])
  })

  it('makes a shallow copy when from() is given a document', () => {
    const state = {text: 'The sly fox jumped over the lazy dog', x: 5, y: new Date(), z: [1, 2, 3, {alpha: 'bravo'}]}
    const doc1 = Automerge.from(state)
    assert.deepStrictEqual(Automerge.toJS(doc1), state)
    const doc2 = Automerge.from(doc1)
    assert.deepStrictEqual(Automerge.toJS(doc2), Automerge.toJS(doc1))
  })

  it('reuses dates read from another document', () => {
    const original = Automerge.change(Automerge.init(), doc => {
      doc.date = new Date()
      doc.dates = [new Date()]
    })
    const updated = Automerge.change(original, doc => {
      doc.anotherDate = original.date
      doc.dates[0] = original.dates[0]
    })
    assert.deepStrictEqual(updated.anotherDate, original.date)
  })
})
