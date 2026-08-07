const assert = require('assert')
const path = require('path')
const Classic = process.env.TEST_DIST === '1' ? require('../dist/automerge') : require('../src/automerge')

// Cross-implementation integration tests: a classic (plain JavaScript) peer
// and a Rust/WASM peer perform the same operations, exchange documents, and
// synchronize. Set AUTOMERGE_MODERN_PATH to the modern package, or build
// ../automerge/javascript (branch fragment); the suite is skipped when no
// modern package is available.
function resolveModern() {
  if (process.env.AUTOMERGE_MODERN_PATH) return path.resolve(process.env.AUTOMERGE_MODERN_PATH)
  const sibling = path.resolve(__dirname, '..', '..', 'automerge', 'javascript')
  try {
    require(sibling)
    return sibling
  } catch (e) {
    return null
  }
}

const modernPath = resolveModern()
const describeLive = modernPath ? describe : describe.skip
const Modern = modernPath ? require(modernPath) : null

const ACTOR_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ACTOR_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

// JSON round trip so that Counter/Date/Uint8Array instances from the two
// packages compare by content rather than by prototype identity
function plain(value) { return JSON.parse(JSON.stringify(value)) }

function syncAll(docA, implA, docB, implB) {
  let stateA = implA.initSyncState(), stateB = implB.initSyncState()
  for (let round = 0; round < 30; round++) {
    let messageA, messageB
    ;[stateA, messageA] = implA.generateSyncMessage(docA, stateA)
    if (messageA) [docB, stateB] = implB.receiveSyncMessage(docB, stateB, messageA)
    ;[stateB, messageB] = implB.generateSyncMessage(docB, stateB)
    if (messageB) [docA, stateA] = implA.receiveSyncMessage(docA, stateA, messageB)
    if (!messageA && !messageB) return [docA, docB]
  }
  throw new Error('sync did not converge')
}

describeLive('live Rust/WASM interoperability', () => {
  it('produces identical change hashes for the same API calls', () => {
    function build(A) {
      let doc = A.init(ACTOR_A)
      doc = A.change(doc, {time: 0, message: 'one'}, draft => {
        draft.title = 'hello'
        draft.count = new A.Counter(3)
        draft.when = new Date(1700000000000)
        draft.bytes = new Uint8Array([1, 2, 3])
        draft.nested = {list: [1, 'two', {three: 3}], zzz: 1, aaa: 2}
      })
      doc = A.change(doc, {time: 0}, draft => {
        A.splice(draft, ['title'], 5, 0, ' world')
        draft.count.increment(2)
        A.insertAt(draft.nested.list, 1, 1.5)
        A.deleteAt(draft.nested.list, 3)
      })
      return doc
    }
    const classic = build(Classic), modern = build(Modern)
    assert.deepStrictEqual(Classic.getHeads(classic), Modern.getHeads(modern))
    assert.deepStrictEqual(plain(Classic.toJS(classic)), plain(Modern.toJS(modern)))
  })

  it('loads documents saved by the other implementation', () => {
    let classic = Classic.from({text: 'shared words', items: [1, 2], meta: {kind: 'note'}}, {actor: ACTOR_A})
    const modern = Modern.load(Classic.save(classic))
    assert.deepStrictEqual(plain(Modern.toJS(modern)), plain(Classic.toJS(classic)))
    assert.deepStrictEqual(Modern.getHeads(modern), Classic.getHeads(classic))

    let modern2 = Modern.from({text: 'other words', tags: ['x']}, {actor: ACTOR_B})
    const classic2 = Classic.load(Modern.save(modern2))
    assert.deepStrictEqual(plain(Classic.toJS(classic2)), plain(Modern.toJS(modern2)))
    assert.deepStrictEqual(Classic.getHeads(classic2), Modern.getHeads(modern2))
  })

  it('synchronizes a classic peer with a modern peer in both directions', () => {
    let classic = Classic.from({text: 'hello world', notes: []}, ACTOR_A)
    let modern = Modern.init(ACTOR_B)
    ;[classic, modern] = syncAll(classic, Classic, modern, Modern)
    assert.deepStrictEqual(plain(Classic.toJS(classic)), plain(Modern.toJS(modern)))

    classic = Classic.change(classic, {time: 0}, draft => {
      Classic.splice(draft, ['text'], 0, 0, 'oh, ')
      draft.notes.push('from classic')
    })
    modern = Modern.change(modern, {time: 0}, draft => {
      Modern.splice(draft, ['text'], 11, 0, '!')
      draft.notes.push('from modern')
    })
    ;[classic, modern] = syncAll(classic, Classic, modern, Modern)
    assert.strictEqual(Classic.toJS(classic).text, 'oh, hello world!')
    assert.deepStrictEqual(Classic.getHeads(classic), Modern.getHeads(modern))
    assert.deepStrictEqual(plain(Classic.toJS(classic)), plain(Modern.toJS(modern)))
  })

  it('exchanges rich text, marks, and blocks over sync', () => {
    let modern = Modern.from({text: 'hello world'}, {actor: ACTOR_B})
    modern = Modern.change(modern, {time: 0}, draft => {
      Modern.mark(draft, ['text'], {start: 0, end: 5, expand: 'both'}, 'bold', true)
    })
    modern = Modern.change(modern, {time: 0}, draft => {
      Modern.splitBlock(draft, ['text'], 5, {type: 'li'})
    })
    let classic = Classic.init(ACTOR_A)
    ;[modern, classic] = syncAll(modern, Modern, classic, Classic)
    assert.deepStrictEqual(plain(Classic.spans(classic, ['text'])), plain(Modern.spans(modern, ['text'])))
    assert.deepStrictEqual(Classic.marks(classic, ['text']), Modern.marks(modern, ['text']))

    // typing at the end of the bold range extends it on both peers
    classic = Classic.change(classic, {time: 0}, draft => {
      Classic.splice(draft, ['text'], 5, 0, '!!')
    })
    ;[modern, classic] = syncAll(modern, Modern, classic, Classic)
    assert.deepStrictEqual(Classic.marks(classic, ['text']), Modern.marks(modern, ['text']))
    assert.deepStrictEqual(plain(Classic.spans(classic, ['text'])), plain(Modern.spans(modern, ['text'])))
  })

  it('produces identical updateText operations', () => {
    const cases = [
      ['hello world', 'hxllo wyrld'],
      ['the quick brown fox', 'the quick red fox jumps'],
      ['abc def', 'def abc'],
      ['ABCABBA', 'CBABAC'],
      ['résumé 👩‍💻', 'résumé 👩‍💻!'],
      ['', 'anything'],
      ['something', '']
    ]
    function run(A, from, to) {
      let doc = A.init(ACTOR_A)
      doc = A.change(doc, {time: 0}, draft => { draft.t = from })
      doc = A.change(doc, {time: 0}, draft => { A.updateText(draft, ['t'], to) })
      return [A.getHeads(doc)[0], A.toJS(doc).t]
    }
    for (const [from, to] of cases) {
      assert.deepStrictEqual(run(Classic, from, to), run(Modern, from, to),
        `updateText(${JSON.stringify(from)} -> ${JSON.stringify(to)})`)
    }
  })

  it('produces identical patches for load, applyChanges, and sync', () => {
    function build(A) {
      let doc1 = A.init(ACTOR_A), doc2 = A.init(ACTOR_B)
      doc1 = A.change(doc1, {time: 0}, draft => { draft.x = 'one'; draft.shared = {k: 1} })
      doc2 = A.change(doc2, {time: 0}, draft => { draft.x = 'two'; draft.list = [3, 1] })
      return A.merge(doc1, doc2)
    }
    function loadPatches(A) {
      const patches = []
      A.load(A.save(build(A)), {patchCallback: p => patches.push(...p)})
      return patches
    }
    assert.deepStrictEqual(plain(loadPatches(Classic)), plain(loadPatches(Modern)))

    function applyPatches(A) {
      const changes = A.getAllChanges(build(A))
      const patches = []
      A.applyChanges(A.init(), changes, {patchCallback: p => patches.push(...p)})
      return patches
    }
    assert.deepStrictEqual(plain(applyPatches(Classic)), plain(applyPatches(Modern)))

    function syncPatches(A) {
      let remote = build(A), local = A.init()
      let localState = A.initSyncState(), remoteState = A.initSyncState()
      const patches = []
      for (let round = 0; round < 10; round++) {
        let message
        ;[remoteState, message] = A.generateSyncMessage(remote, remoteState)
        if (!message) break
        ;[local, localState] = A.receiveSyncMessage(local, localState, message, {patchCallback: p => patches.push(...p)})
        let reply
        ;[localState, reply] = A.generateSyncMessage(local, localState)
        if (reply) [remote, remoteState] = A.receiveSyncMessage(remote, remoteState, reply)
      }
      return patches
    }
    assert.deepStrictEqual(plain(syncPatches(Classic)), plain(syncPatches(Modern)))
  })

  it('produces identical diff output', () => {
    function run(A) {
      let doc = A.init(ACTOR_A)
      doc = A.change(doc, {time: 0}, draft => { draft.text = 'hello'; draft.tags = ['a'] })
      const before = A.getHeads(doc)
      doc = A.change(doc, {time: 0}, draft => {
        A.splice(draft, ['text'], 5, 0, ' world')
        draft.tags.push('b')
        draft.meta = {v: 2}
      })
      return A.diff(doc, before, A.getHeads(doc))
    }
    assert.deepStrictEqual(plain(run(Classic)), plain(run(Modern)))
  })

  it('agrees on key enumeration order and conflicts', () => {
    function build(A) {
      let doc1 = A.init(ACTOR_A), doc2 = A.init(ACTOR_B)
      doc1 = A.change(doc1, {time: 0}, draft => { draft.x = 'one'; draft.shared = {k: 1} })
      doc2 = A.change(doc2, {time: 0}, draft => { draft.x = 'two'; draft.list = [3, 1] })
      return A.merge(doc1, doc2)
    }
    const classic = build(Classic), modern = build(Modern)
    assert.deepStrictEqual(Object.keys(classic), Object.keys(modern))
    assert.deepStrictEqual(Object.keys(Classic.toJS(classic)), Object.keys(Modern.toJS(modern)))
    assert.deepStrictEqual(plain(Classic.getConflicts(classic, 'x')), plain(Modern.getConflicts(modern, 'x')))
  })

  it('exchanges incremental saves', () => {
    let classic = Classic.from({log: ['a']}, ACTOR_A)
    let modern = Modern.load(Classic.save(classic))
    const heads = Classic.getHeads(classic)
    classic = Classic.change(classic, {time: 0}, draft => { draft.log.push('b'); draft.extra = true })
    modern = Modern.loadIncremental(modern, Classic.saveSince(classic, heads))
    assert.deepStrictEqual(plain(Modern.toJS(modern)), plain(Classic.toJS(classic)))

    const heads2 = Modern.getHeads(modern)
    modern = Modern.change(modern, {time: 0}, draft => { draft.log.push('c') })
    classic = Classic.loadIncremental(classic, Modern.saveSince(modern, heads2))
    assert.deepStrictEqual(plain(Classic.toJS(classic)), plain(Modern.toJS(modern)))
  })

  it('resolves cursors created by the other implementation', () => {
    let modern = Modern.from({text: 'hello world'}, {actor: ACTOR_B})
    let classic = Classic.load(Modern.save(modern))
    const cursor = Modern.getCursor(modern, ['text'], 5)
    assert.strictEqual(Classic.getCursorPosition(classic, ['text'], cursor),
      Modern.getCursorPosition(modern, ['text'], cursor))
    classic = Classic.change(classic, {time: 0}, draft => { Classic.splice(draft, ['text'], 0, 0, '>> ') })
    modern = Modern.loadIncremental(modern, Classic.saveSince(classic, Modern.getHeads(modern)))
    assert.strictEqual(Classic.getCursorPosition(classic, ['text'], cursor), 8)
    assert.strictEqual(Modern.getCursorPosition(modern, ['text'], cursor), 8)
  })

  it('converges under interleaved concurrent editing', () => {
    let classic = Classic.from({doc: {title: 'untitled', body: 'lorem ipsum', tally: new Classic.Counter(0)}}, ACTOR_A)
    let modern = Modern.init(ACTOR_B)
    ;[classic, modern] = syncAll(classic, Classic, modern, Modern)
    for (let round = 0; round < 5; round++) {
      classic = Classic.change(classic, {time: 0}, draft => {
        Classic.updateText(draft.doc, ['title'], `title ${round} from classic`)
        draft.doc.tally.increment(1)
      })
      modern = Modern.change(modern, {time: 0}, draft => {
        Modern.splice(draft, ['doc', 'body'], 0, 0, `${round}: `)
        draft.doc.tally.increment(1)
      })
      ;[classic, modern] = syncAll(classic, Classic, modern, Modern)
      assert.deepStrictEqual(Classic.getHeads(classic), Modern.getHeads(modern))
      assert.deepStrictEqual(plain(Classic.toJS(classic)), plain(Modern.toJS(modern)))
    }
    assert.strictEqual(classic.doc.tally.value, 10)
  })

  it('behaves like the modern package in an automerge-repo style lifecycle', () => {
    // mirrors how automerge-repo drives the API: init with patchCallback,
    // change, incremental save accumulation, load on restart
    function run(A) {
      const notifications = []
      let doc = A.init({actor: ACTOR_A, patchCallback: (patches, info) => notifications.push([info.source, patches.length])})
      const chunks = []
      let lastHeads = A.getHeads(doc)
      function persist(after) {
        chunks.push(A.saveSince(after, lastHeads))
        lastHeads = A.getHeads(after)
      }
      doc = A.change(doc, {time: 0}, draft => { draft.cards = [] })
      persist(doc)
      doc = A.change(doc, {time: 0}, draft => { draft.cards.push({title: 'first card', done: false}) })
      persist(doc)
      doc = A.change(doc, {time: 0}, draft => { draft.cards[0].done = true })
      persist(doc)
      let restored = A.init()
      for (const chunk of chunks) restored = A.loadIncremental(restored, chunk)
      return {heads: A.getHeads(restored), value: plain(A.toJS(restored)), notifications}
    }
    assert.deepStrictEqual(run(Classic), run(Modern))
  })

  it('agrees on updateSpans output', () => {
    const cases = [
      [{type: 'text', value: 'hello world', marks: {bold: true}}],
      [{type: 'text', value: 'goodbye world'}],
      [{type: 'block', value: {type: 'p'}}, {type: 'text', value: 'hello'},
        {type: 'block', value: {type: 'p'}}, {type: 'text', value: 'world'}],
      [{type: 'text', value: 'hello'}, {type: 'block', value: {type: 'li'}},
        {type: 'text', value: ' world', marks: {em: 1}}]
    ]
    function run(A, spans) {
      let doc = A.init(ACTOR_A)
      doc = A.change(doc, {time: 0}, draft => { draft.text = 'hello world' })
      doc = A.change(doc, {time: 0}, draft => { A.updateSpans(draft, ['text'], spans) })
      return [A.getHeads(doc)[0], plain(A.spans(doc, ['text']))]
    }
    for (const spans of cases) {
      assert.deepStrictEqual(run(Classic, spans), run(Modern, spans), JSON.stringify(spans))
    }
  })

  it('sanitizes unpaired surrogates identically', () => {
    function run(A) {
      let doc = A.init(ACTOR_A)
      doc = A.change(doc, {time: 0}, draft => { draft.t = 'a\ud83dz' })
      doc = A.change(doc, {time: 0}, draft => { A.splice(draft, ['t'], 1, 0, '\ude00!') })
      return [A.getHeads(doc)[0], A.toJS(doc).t]
    }
    assert.deepStrictEqual(run(Classic), run(Modern))
  })

  it('agrees on history inspection', () => {
    function build(A) {
      let doc1 = A.init(ACTOR_A), doc2 = A.init(ACTOR_B)
      doc1 = A.change(doc1, {time: 0, message: 'first'}, draft => { draft.a = 1 })
      doc2 = A.merge(A.init(ACTOR_B), doc1)
      doc1 = A.change(doc1, {time: 0}, draft => { draft.b = 2 })
      doc2 = A.change(doc2, {time: 0}, draft => { draft.c = 3 })
      return A.merge(doc1, doc2)
    }
    const classic = build(Classic), modern = build(Modern)
    assert.deepStrictEqual(Classic.getHeads(classic), Modern.getHeads(modern))
    assert.deepStrictEqual(Classic.topoHistoryTraversal(classic), Modern.topoHistoryTraversal(modern))
    assert.strictEqual(Classic.getHistory(classic).length, Modern.getHistory(modern).length)
    const hash = Classic.topoHistoryTraversal(classic)[0]
    assert.strictEqual(Classic.inspectChange(classic, hash).hash, Modern.inspectChange(modern, hash).hash)
  })

  it('exposes every export of the modern package', () => {
    for (const key of Object.keys(Modern)) {
      assert.ok(key in Classic, `missing export: ${key}`)
    }
    for (const key of Object.keys(Modern.next)) {
      assert.ok(key in Classic.next, `missing next export: ${key}`)
    }
  })
})
