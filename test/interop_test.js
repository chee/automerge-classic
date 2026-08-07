const assert = require('assert')
const path = require('path')
const Automerge = process.env.TEST_DIST === '1' ? require('../dist/automerge') : require('../src/automerge')
const { splitContainers } = require('../backend/columnar')
const fixtures = require('./interop_fixtures')

function decode(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'))
}

function encode(value) {
  return Buffer.from(value).toString('base64')
}

function raw(value) {
  return new Automerge.RawString(value)
}

function assertDocument(doc) {
  assert.deepStrictEqual(Automerge.toJS(doc), {
    bytes: new Uint8Array([255, 128, 127, 1, 0]),
    label: raw('scalar café'),
    list: [raw('first'), raw('middle'), {emoji: raw('🦄')}, new Uint8Array([9, 8])],
    nested: {'e\u0301': raw('decomposed'), 'ключ': raw('обновлено')},
    title: 'Aé👩‍💻Z',
    '\ue000': 3,
    '😀': 4
  })
  assert.strictEqual(typeof doc.title, 'string')
  assert.deepStrictEqual([...doc.title], ['A', 'é', '👩', '‍', '💻', 'Z'])
  assert.strictEqual(Automerge.isRawString(doc.label), true)
  assert.strictEqual(doc.label.toString(), 'scalar café')
  assert.strictEqual(doc.bytes instanceof Uint8Array, true)
  assert.strictEqual(doc.list[3] instanceof Uint8Array, true)
  assert.deepStrictEqual(Object.keys(doc).slice(-2), ['\ue000', '😀'])
  assert.strictEqual(doc.nested['é'], undefined)
}

function assertIncrementalDocument(doc) {
  assert.deepStrictEqual(Automerge.toJS(doc), {
    one: 1,
    title: 'A🐦',
    two: 2,
    '\ue000': 3,
    '😀': 4,
    bytes: new Uint8Array([3, 4, 255]),
    list: [raw('tail')]
  })
  assert.strictEqual(typeof doc.title, 'string')
  assert.strictEqual(doc.bytes instanceof Uint8Array, true)
  assert.deepStrictEqual(Automerge.getHeads(doc), [fixtures.incremental.hashes[2]])
}

describe('modern Rust/WASM interoperability', () => {
  it('loads modern documents with text, bytes, Unicode keys, maps, and lists', () => {
    const doc = Automerge.load(decode(fixtures.document.bytes))
    assertDocument(doc)
    assert.deepStrictEqual(Automerge.getHeads(doc), [fixtures.document.hashes[1]])
    assert.deepStrictEqual(Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change).hash),
      fixtures.document.hashes)
  })

  it('applies modern changes with out-of-order dependency delivery', () => {
    const changes = fixtures.document.changes.map(decode)
    const metadata = changes.map(Automerge.decodeChange)
    assert.deepStrictEqual(metadata.map(change => change.actor), ['a1', 'a1'])
    assert.deepStrictEqual(metadata.map(change => change.seq), [1, 2])
    assert.deepStrictEqual(metadata.map(change => change.message), ['modern seed', 'modern mutation'])
    assert.deepStrictEqual(metadata.map(change => change.hash), fixtures.document.hashes)

    let doc = Automerge.init('c1')
    ;[doc] = Automerge.applyChanges(doc, changes.slice().reverse())
    assertDocument(doc)
    assert.deepStrictEqual(Automerge.getMissingDeps(doc), [])
    assert.deepStrictEqual(Automerge.getHeads(doc), [fixtures.document.hashes[1]])
  })

  it('loads concatenated modern incremental chunks atomically and sequentially', () => {
    const chunks = fixtures.incremental.chunks.map(decode)
    assert.deepStrictEqual(chunks.map(chunk => splitContainers(chunk).map(container => container[8])), [[1], [1], [1]])
    assert.deepStrictEqual(chunks.map(chunk => Automerge.decodeChange(chunk).hash), fixtures.incremental.hashes)
    assert.deepStrictEqual(chunks.map(chunk => Automerge.decodeChange(chunk).message), [
      'incremental one', 'incremental two', 'incremental three'
    ])

    const combined = Uint8Array.from(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))))
    const atomic = Automerge.loadIncremental(Automerge.init('c2'), combined)
    assertIncrementalDocument(atomic)
    assert.strictEqual(Automerge.getAllChanges(atomic).length, 3)

    let sequential = Automerge.init('c3')
    sequential = Automerge.loadIncremental(sequential, chunks[0])
    assert.deepStrictEqual(Automerge.toJS(sequential), {one: 1, title: 'A'})
    sequential = Automerge.loadIncremental(sequential, chunks[1])
    assert.deepStrictEqual(Automerge.toJS(sequential), {
      one: 1, title: 'A🐦', two: 2, '\ue000': 3, '😀': 4
    })
    sequential = Automerge.loadIncremental(sequential, chunks[2])
    assertIncrementalDocument(sequential)
    assert.deepStrictEqual(Automerge.getAllChanges(sequential).map(encode), fixtures.incremental.chunks)
  })

  it('preserves modern conflicts for scalars, bytes, and Unicode keys', () => {
    const doc = Automerge.load(decode(fixtures.conflicts.bytes))
    const choices = Automerge.getConflicts(doc, 'choice')
    const byteValues = Automerge.getConflicts(doc, 'bytes')
    const labels = Automerge.getConflicts(doc, 'key 🐦')

    assert.strictEqual(doc.choice, 2)
    assert.deepStrictEqual([...doc.bytes], [3, 4])
    assert.deepStrictEqual(doc['key 🐦'], raw('right'))
    assert.strictEqual(choices['4@bb'], 1)
    assert.strictEqual(choices['4@cc'], 2)
    assert.deepStrictEqual([...byteValues['5@bb']], [1, 2])
    assert.deepStrictEqual([...byteValues['5@cc']], [3, 4])
    assert.deepStrictEqual(labels['6@bb'], raw('left'))
    assert.deepStrictEqual(labels['6@cc'], raw('right'))
    assert.deepStrictEqual(Automerge.getHeads(doc), fixtures.conflicts.heads)
  })

  it('loads legacy tables from a document re-saved by modern', () => {
    const bytes = decode(fixtures.table.bytes)
    const doc = Automerge.load(bytes)
    const row = doc.books.byId(fixtures.table.rowId)

    assert.strictEqual(doc.books instanceof Automerge.Table, true)
    assert.strictEqual(doc.books.count, 1)
    assert.deepStrictEqual(doc.books.ids, [fixtures.table.rowId])
    assert.deepStrictEqual(row, {title: raw('Dune'), year: 1965, id: fixtures.table.rowId})
    assert.strictEqual(encode(Automerge.save(doc)), fixtures.table.bytes)
  })

  it('preserves modern mark changes and documents byte for byte', () => {
    const change = decode(fixtures.marks.change)
    const decoded = Automerge.decodeChange(change)
    assert.strictEqual(decoded.hash, fixtures.marks.hash)
    assert.deepStrictEqual(decoded.ops.slice(-2), [
      {obj: '1@aaaaaa', elemId: '2@aaaaaa', action: 'markBegin', insert: true,
        value: true, name: 'bold', expand: false, pred: []},
      {obj: '1@aaaaaa', elemId: '4@aaaaaa', action: 'markEnd', insert: true,
        expand: true, pred: []}
    ])
    assert.strictEqual(encode(Automerge.encodeChange(decoded)), fixtures.marks.change)

    let applied = Automerge.init('bbbbbb')
    ;[applied] = Automerge.applyChanges(applied, [change])
    assert.strictEqual(String(applied.text), 'abc')
    assert.deepStrictEqual(Automerge.getHeads(applied), [fixtures.marks.hash])

    const loaded = Automerge.load(decode(fixtures.marks.document))
    assert.strictEqual(String(loaded.text), 'abc')
    assert.deepStrictEqual(Automerge.getHeads(loaded), [fixtures.marks.hash])
    assert.strictEqual(encode(Automerge.getAllChanges(loaded)[0]), fixtures.marks.change)
    assert.strictEqual(encode(Automerge.save(loaded)), fixtures.marks.document)
  })

  it('loads modern rich text blocks and marks', () => {
    const loaded = Automerge.load(decode(fixtures.richText.bytes))
    assert.deepStrictEqual(Automerge.spans(loaded, ['text']), [
      {type: 'text', value: 'a', marks: {bold: true}},
      {type: 'block', value: {level: 1, type: 'paragraph'}},
      {type: 'text', value: 'bc'}
    ])
    assert.deepStrictEqual(Automerge.getAllChanges(loaded).map(change => Automerge.decodeChange(change).hash),
      fixtures.richText.hashes)
    assert.strictEqual(encode(Automerge.save(loaded)), fixtures.richText.bytes)
  })

  it('decodes modern v1 sync offers and answers with a compatible request', () => {
    const offer = Automerge.decodeSyncMessage(decode(fixtures.syncOffer))
    assert.deepStrictEqual(offer.heads, [fixtures.document.hashes[1]])
    assert.deepStrictEqual(offer.need, [])
    assert.deepStrictEqual(offer.have[0].lastSync, [])
    assert.deepStrictEqual([...offer.have[0].bloom], [2, 10, 7, 136, 204, 140])
    assert.deepStrictEqual(offer.changes, [])

    let doc = Automerge.init('c4'), state = Automerge.initSyncState(), request
    ;[doc, state] = Automerge.receiveSyncMessage(doc, state, decode(fixtures.syncOffer))
    ;[state, request] = Automerge.generateSyncMessage(doc, state)
    const decodedRequest = Automerge.decodeSyncMessage(request)
    assert.deepStrictEqual(decodedRequest.heads, [])
    assert.deepStrictEqual(decodedRequest.need, [fixtures.document.hashes[1]])
    assert.deepStrictEqual(decodedRequest.have[0].lastSync, [])
    assert.strictEqual(decodedRequest.have[0].bloom.byteLength, 0)
    assert.deepStrictEqual(decodedRequest.changes, [])
  })

  it('receives modern v2 sync messages containing compressed documents', () => {
    const document = decode(fixtures.document.bytes)
    const message = Automerge.encodeSyncMessage({
      heads: [fixtures.document.hashes[1]],
      need: [],
      have: [],
      changes: [document]
    }).slice()
    message[0] = 0x43

    const decoded = Automerge.decodeSyncMessage(message)
    assert.strictEqual(decoded.changes.length, 1)
    assert.deepStrictEqual([...decoded.changes[0]], [...document])

    let doc = Automerge.init('c5'), state = Automerge.initSyncState()
    ;[doc, state] = Automerge.receiveSyncMessage(doc, state, message)
    assertDocument(doc)
    assert.deepStrictEqual(state.sharedHeads, [fixtures.document.hashes[1]])
  })

  const liveIt = process.env.AUTOMERGE_MODERN_PATH ? it : it.skip
  liveIt('round-trips fixtures through an installed modern package', () => {
    const Modern = require(path.resolve(process.env.AUTOMERGE_MODERN_PATH))
    let modernDoc = Modern.load(decode(fixtures.document.bytes), {actor: 'd1'})
    const modernValue = Modern.toJS(modernDoc)
    assert.strictEqual(modernValue.title, 'Aé👩‍💻Z')
    assert.strictEqual(Modern.isRawString(modernValue.label), true)
    assert.strictEqual(modernValue.label.toString(), 'scalar café')
    assert.deepStrictEqual([...modernValue.bytes], [255, 128, 127, 1, 0])
    assert.deepStrictEqual(Modern.getAllChanges(modernDoc).map(change => Modern.decodeChange(change).hash),
      fixtures.document.hashes)

    let classicDoc = Automerge.load(decode(fixtures.document.bytes), 'd2')
    classicDoc = Automerge.change(classicDoc, {message: 'classic extension', time: 0}, draft => {
      draft.classicText = new Automerge.Text('from classic')
      draft.bytes = new Uint8Array([8, 6, 7, 5, 3, 0, 9])
    })
    const roundTripped = Modern.toJS(Modern.load(Automerge.save(classicDoc), {actor: 'd3'}))
    assert.strictEqual(roundTripped.classicText, 'from classic')
    assert.deepStrictEqual([...roundTripped.bytes], [8, 6, 7, 5, 3, 0, 9])

    const modernTable = Modern.load(decode(fixtures.table.bytes), {actor: 'd4'})
    const books = Modern.toJS(modernTable).books
    assert.strictEqual(books.length, 1)
    assert.strictEqual(books[0].title.toString(), 'Dune')
    assert.strictEqual(books[0].year, 1965)
    assert.strictEqual(encode(Modern.save(modernTable)), fixtures.table.bytes)

    let modernState = Modern.initSyncState(), message
    ;[modernState, message] = Modern.generateSyncMessage(modernDoc, modernState)
    let classicState = Automerge.initSyncState(), classic = Automerge.init('d5')
    ;[classic, classicState] = Automerge.receiveSyncMessage(classic, classicState, message)
    ;[classicState, message] = Automerge.generateSyncMessage(classic, classicState)
    ;[modernDoc, modernState] = Modern.receiveSyncMessage(modernDoc, modernState, message)
    ;[modernState, message] = Modern.generateSyncMessage(modernDoc, modernState)
    assert.strictEqual(message instanceof Uint8Array, true)
    ;[classic, classicState] = Automerge.receiveSyncMessage(classic, classicState, message)
    assertDocument(classic)
  })
})
