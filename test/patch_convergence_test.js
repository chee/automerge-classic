const assert = require('assert')
const fs = require('fs')
const path = require('path')
const Automerge = process.env.TEST_DIST === '1' ? require('../dist/automerge') : require('../src/automerge')

// Patch-convergence fuzzing: several peers make concurrent changes (maps,
// lists, text, marks) and exchange them over partial, out-of-order syncs.
// Invariants, checked after every step:
//   1. applying every patchCallback patch to a plain value reproduces
//      toJS(doc) exactly (so a consumer following the patch stream never
//      diverges from the document);
//   2. after full synchronization all peers converge to the same heads and
//      value, spans agree, and diff(doc, [], heads) applied to an empty
//      value rebuilds toJS(doc).
// Failing seeds from this fuzz produced the fixtures in test/fixtures/.

const ACTOR_A = '11111111111111111111111111111111'
const ACTOR_B = '22222222222222222222222222222222'

function prng(seed) {
  let state = seed >>> 0
  return function () {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function plain(value) { return JSON.parse(JSON.stringify(value)) }

function fuzzRun(seed, steps, checkDiffFromRoot) {
  const rand = prng(seed)
  function pick(list) { return list[Math.floor(rand() * list.length)] }
  function int(bound) { return Math.floor(rand() * bound) }
  const chars = 'abcde 😀é'
  function randText(length) { return Array.from({length}, () => chars[int(chars.length)]).join('') }

  const peers = [0, 1, 2].map(index => ({
    doc: Automerge.init(String(index + 1).repeat(32)),
    shadow: {}
  }))

  function absorb(peer, patches) {
    const next = plain(peer.shadow)
    Automerge.applyPatches(next, plain(patches))
    peer.shadow = next
  }

  function randomChange(peer) {
    const patches = []
    peer.doc = Automerge.change(peer.doc, {time: 0, patchCallback: p => patches.push(...p)}, draft => {
      const opCount = 1 + int(3)
      for (let index = 0; index < opCount; index++) {
        const kind = int(9)
        if (kind < 3) {
          const key = 'k' + int(6)
          const choice = int(7)
          if (choice === 0) draft[key] = {inner: randText(3)}
          else if (choice === 1) draft[key] = [int(9), randText(2)]
          else if (choice === 2 && draft[key] !== undefined) delete draft[key]
          else if (choice === 3) draft[key] = new Automerge.Counter(int(10))
          else if (choice === 4 && draft[key] instanceof Automerge.Counter) draft[key].increment(1 + int(5))
          else draft[key] = int(100)
        } else if (kind < 5) {
          if (!Array.isArray(draft.list)) draft.list = []
          const length = draft.list.length
          const choice = int(3)
          if (choice === 0 || length === 0) Automerge.insertAt(draft.list, int(length + 1), int(50))
          else if (choice === 1) Automerge.deleteAt(draft.list, int(length))
          else draft.list[int(length)] = randText(2)
        } else if (kind < 8) {
          if (!draft.text) draft.text = randText(4)
          else {
            const current = draft.text
            if (int(2) === 0) {
              const at = int(current.length + 1), del = int(Math.max(1, current.length - at))
              Automerge.splice(draft, ['text'], at, del, randText(int(4)))
            } else {
              const at = int(current.length + 1)
              Automerge.updateText(draft, ['text'], current.slice(0, at) + randText(int(5)) + current.slice(at + int(3)))
            }
          }
        } else if (typeof draft.text === 'string' && draft.text.length > 1) {
          const length = draft.text.length
          const start = int(length), end = Math.min(length, start + int(Math.max(1, length - start)))
          const expand = pick(['before', 'after', 'both', 'none'])
          if (int(3) === 0) Automerge.unmark(draft, ['text'], {start, end: Math.max(end, start), expand}, pick(['bold', 'em']))
          else Automerge.mark(draft, ['text'], {start, end: Math.max(end, start), expand}, pick(['bold', 'em']), pick([true, 1, 'x']))
        } else {
          draft['b' + int(3)] = randText(2)
        }
      }
    })
    absorb(peer, patches)
  }

  function randomSync(from, to, partial) {
    let changes
    try { changes = Automerge.getChanges(to.doc, from.doc) } catch (error) { return }
    if (changes.length === 0) return
    const count = partial ? 1 + int(changes.length) : changes.length
    const patches = []
    ;[to.doc] = Automerge.applyChanges(to.doc, changes.slice(0, count), {patchCallback: p => patches.push(...p)})
    absorb(to, patches)
  }

  for (let step = 0; step < steps; step++) {
    if (rand() < 0.55) randomChange(pick(peers))
    else randomSync(pick(peers), pick(peers), int(2) === 0)

    for (const peer of peers) {
      assert.strictEqual(canonical(plain(peer.shadow)), canonical(plain(Automerge.toJS(peer.doc))),
        `seed ${seed} step ${step}: patch stream diverged from document`)
    }
  }

  for (const a of peers) for (const b of peers) randomSync(a, b, false)
  for (const a of peers) for (const b of peers) randomSync(a, b, false)
  const heads = JSON.stringify(Automerge.getHeads(peers[0].doc))
  for (const peer of peers) {
    assert.strictEqual(JSON.stringify(Automerge.getHeads(peer.doc)), heads, `seed ${seed}: peers did not converge`)
    const want = canonical(plain(Automerge.toJS(peer.doc)))
    assert.strictEqual(canonical(plain(peer.shadow)), want, `seed ${seed}: final patch stream diverged`)
    if (typeof Automerge.toJS(peer.doc).text === 'string') {
      assert.strictEqual(canonical(plain(Automerge.spans(peer.doc, ['text']))),
        canonical(plain(Automerge.spans(peers[0].doc, ['text']))), `seed ${seed}: spans diverged`)
    }
    if (checkDiffFromRoot) {
      const rebuilt = {}
      Automerge.applyPatches(rebuilt, plain(Automerge.diff(peer.doc, [], Automerge.getHeads(peer.doc))))
      assert.strictEqual(canonical(plain(rebuilt)), want, `seed ${seed}: diff from root diverged`)
    }
  }
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name)))
    .map(encoded => new Uint8Array(Buffer.from(encoded, 'base64')))
}

// diff() reuses document views and mark scans between calls. These check that
// the reuse never returns a result that a cold call would not have produced.
describe('diff reuse', () => {
  it('matches cold results across successive versions', () => {
    let doc = Automerge.from({text: 'hello', list: [1], map: {a: 1}}, ACTOR_A)
    let heads = Automerge.getHeads(doc)
    for (let step = 0; step < 5; step++) {
      const before = heads
      doc = Automerge.change(doc, {time: 0}, draft => {
        Automerge.splice(draft, ['text'], 0, 0, 'z')
        draft.list.push(step)
        draft.map['k' + step] = step
      })
      heads = Automerge.getHeads(doc)
      const cold = Automerge.diff(Automerge.load(Automerge.save(doc)), before, heads)
      assert.deepStrictEqual(Automerge.diff(doc, before, heads), cold)
    }
  })

  it('keeps independent documents apart', () => {
    let left = Automerge.from({text: 'abc'}, ACTOR_A)
    let right = Automerge.from({text: 'abc'}, ACTOR_B)
    const leftBefore = Automerge.getHeads(left), rightBefore = Automerge.getHeads(right)
    left = Automerge.change(left, {time: 0}, draft => { Automerge.splice(draft, ['text'], 3, 0, 'L') })
    right = Automerge.change(right, {time: 0}, draft => { Automerge.splice(draft, ['text'], 3, 0, 'R') })
    const leftHeads = Automerge.getHeads(left), rightHeads = Automerge.getHeads(right)
    assert.deepStrictEqual(Automerge.diff(left, leftBefore, leftHeads),
      [{action: 'splice', path: ['text', 3], value: 'L'}])
    assert.deepStrictEqual(Automerge.diff(right, rightBefore, rightHeads),
      [{action: 'splice', path: ['text', 3], value: 'R'}])
    assert.deepStrictEqual(Automerge.diff(left, leftBefore, leftHeads),
      [{action: 'splice', path: ['text', 3], value: 'L'}])
  })

  it('reports marks added by a change that leaves the text alone', () => {
    let doc = Automerge.from({text: 'hello', other: 1}, ACTOR_A)
    let heads = Automerge.getHeads(doc)
    doc = Automerge.change(doc, {time: 0}, draft => { draft.other = 2 })
    assert.deepStrictEqual(Automerge.diff(doc, heads, Automerge.getHeads(doc)),
      [{action: 'put', path: ['other'], value: 2}])
    heads = Automerge.getHeads(doc)
    doc = Automerge.change(doc, {time: 0}, draft => {
      Automerge.mark(draft, ['text'], {start: 0, end: 3, expand: 'none'}, 'bold', true)
    })
    assert.deepStrictEqual(Automerge.diff(doc, heads, Automerge.getHeads(doc)),
      [{action: 'mark', path: ['text'], marks: [{name: 'bold', value: true, start: 0, end: 3}]}])
    heads = Automerge.getHeads(doc)
    doc = Automerge.change(doc, {time: 0}, draft => {
      Automerge.unmark(draft, ['text'], {start: 0, end: 3}, 'bold')
    })
    assert.deepStrictEqual(Automerge.diff(doc, heads, Automerge.getHeads(doc)),
      [{action: 'unmark', path: ['text'], name: 'bold', start: 0, end: 3}])
  })
})

describe('patch convergence', () => {
  it('patch streams converge under concurrent fuzzing', () => {
    for (let seed = 1; seed <= 12; seed++) fuzzRun(seed, 50, false)
  }, 60000)

  it('diff from root rebuilds the fuzzed documents', () => {
    for (let seed = 1; seed <= 12; seed++) fuzzRun(seed, 50, true)
  }, 60000)

  it('keeps a concurrently surviving value when a delete arrives in a multi-key change', () => {
    // Minimized from fuzzing: a change that deletes a key whose only pred is
    // already overwritten, batched together with changes to other keys, used
    // to emit a patch that dropped the surviving concurrent value.
    const changes = loadFixture('concurrent_delete_patch.json')
    let doc = Automerge.init()
    ;[doc] = Automerge.applyChanges(doc, changes)
    const reloaded = Automerge.load(Automerge.save(doc))
    assert.deepStrictEqual(plain(Automerge.toJS(doc)), plain(Automerge.toJS(reloaded)))
    assert.ok(Automerge.toJS(doc).k2 !== undefined, 'concurrent value must survive the delete')
  })

  it('sorts the actor table when saving documents with out-of-order actors', () => {
    const changes = loadFixture('concurrent_delete_patch.json')
    let doc = Automerge.init()
    ;[doc] = Automerge.applyChanges(doc, changes)
    const {decodeDocumentHeader} = require('../backend/columnar')
    const {actorIds} = decodeDocumentHeader(Automerge.save(doc))
    const sorted = actorIds.slice().sort()
    assert.deepStrictEqual(actorIds, sorted)
  })

  it('emits text patches for edits after a mark in the same change', () => {
    let doc = Automerge.from({text: 'abcd'}, '11111111111111111111111111111111')
    const before = doc
    const patches = []
    doc = Automerge.change(doc, {time: 0, patchCallback: p => patches.push(...p)}, draft => {
      Automerge.mark(draft, ['text'], {start: 1, end: 1, expand: 'both'}, 'em', 1)
      Automerge.splice(draft, ['text'], 2, 0, 'XY')
    })
    assert.strictEqual(Automerge.toJS(doc).text, 'abXYcd')
    assert.strictEqual(Automerge.toJS(before).text, 'abcd', 'previous snapshot must not be mutated')
    const shadow = {text: 'abcd'}
    Automerge.applyPatches(shadow, plain(patches))
    assert.strictEqual(shadow.text, 'abXYcd')
  })

  // Found by the same fuzz: a batched patch can reference the same child
  // object several times through conflict re-listing; its shared patch must
  // be applied only once, or its contents get duplicated.
  it('materializes list-element overwrite chains like a reload', () => {
    const changes = loadFixture('list_conflict_materialization.json')
    let doc = Automerge.init()
    ;[doc] = Automerge.applyChanges(doc, changes)
    const reloaded = Automerge.load(Automerge.save(doc))
    assert.deepStrictEqual(plain(Automerge.toJS(doc)), plain(Automerge.toJS(reloaded)))
  })

  // Found by fuzzing: mark boundaries are elements of the text sequence and
  // must be resolved by scanning the sequence in order, like the Rust
  // implementation (an unclosed markBegin extends to the end of the text)
  it('resolves overlapping mark values like the Rust implementation', () => {
    const changes = loadFixture('mark_value_overlap.json')
    let doc = Automerge.init()
    ;[doc] = Automerge.applyChanges(doc, changes)
    assert.deepStrictEqual(plain(Automerge.spans(doc, ['text'])), [
      {type: 'text', value: '\ufffd', marks: {bold: true}},
      {type: 'text', value: 'éb', marks: {bold: 1}}
    ])
  })

  // Found by fuzzing: when several marks and block markers stack on the same
  // anchors, mark resolution must use plain RGA ordering for all sequence
  // elements including mark boundaries, matching the Rust implementation
  // (which handles boundary stickiness at authoring time instead, by
  // anchoring new insertions on the boundary elements themselves)
  it('orders inserts against stacked mark boundaries like the Rust implementation', () => {
    const changes = loadFixture('mark_block_stack.json')
    let doc = Automerge.init()
    ;[doc] = Automerge.applyChanges(doc, changes)
    const spans = plain(Automerge.spans(doc, ['text']))
    assert.deepStrictEqual(spans[4], {type: 'text', value: 'd ', marks: {bold: true, em: true}})
  })

  // Found by fuzzing: deleting two consecutive list elements where the first
  // survives through a concurrent overwrite must remove the second element,
  // not the survivor (the list index has to advance past the surviving
  // element before the removal patch is generated)
  it('removes the correct element when a deletion loses to a concurrent overwrite', () => {
    let base = Automerge.init(ACTOR_A)
    base = Automerge.change(base, {time: 0}, draft => { draft.list = [20, 6] })
    let overwriter = Automerge.merge(Automerge.init(ACTOR_B), base)
    overwriter = Automerge.change(overwriter, {time: 0}, draft => { draft.list[0] = {n: 8} })
    let deleter = Automerge.merge(Automerge.init('c'.repeat(32)), base)
    deleter = Automerge.change(deleter, {time: 0}, draft => {
      Automerge.deleteAt(draft.list, 0)
      Automerge.deleteAt(draft.list, 0)
    })
    const changes = [...Automerge.getAllChanges(base),
      Automerge.getLastLocalChange(overwriter), Automerge.getLastLocalChange(deleter)]
    let doc = Automerge.init()
    ;[doc] = Automerge.applyChanges(doc, changes)
    assert.deepStrictEqual(plain(Automerge.toJS(doc).list), [{n: 8}])
    assert.deepStrictEqual(plain(Automerge.toJS(Automerge.load(Automerge.save(doc))).list), [{n: 8}])
  })

  describe('counters', () => {
    it('preds successive increments on the counter operation', () => {
      let doc = Automerge.from({c: new Automerge.Counter(9)}, ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.c.increment(4) })
      doc = Automerge.change(doc, {time: 0}, draft => { draft.c.increment(4) })
      const incs = Automerge.getAllChanges(doc).flatMap(ch =>
        Automerge.decodeChange(ch).ops.filter(op => op.action === 'inc'))
      for (const op of incs) assert.deepStrictEqual(op.pred, [`1@${ACTOR_A}`])
      assert.strictEqual(Automerge.toJS(doc).c.value, 17)
      assert.strictEqual(Automerge.toJS(Automerge.load(Automerge.save(doc))).c.value, 17)
    })

    it('keeps concurrent conflict values when incrementing', () => {
      let doc1 = Automerge.init(ACTOR_A)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.k = 90 })
      let doc2 = Automerge.from({}, ACTOR_B)
      doc2 = Automerge.change(doc2, {time: 0}, draft => { draft.k = new Automerge.Counter(0) })
      doc1 = Automerge.merge(doc1, doc2)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.k.increment(4) })
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.k.increment(1) })
      assert.strictEqual(Automerge.toJS(doc1).k.value, 5)
      assert.strictEqual(Automerge.toJS(Automerge.load(Automerge.save(doc1))).k.value, 5)
      // the losing concurrent value survives as a conflict; this matches the
      // Rust implementation's replay behaviour (its local and reload views
      // hide the conflict, inconsistently with its own replay)
      const conflicts = Automerge.getConflicts(doc1, 'k')
      assert.strictEqual(conflicts[`1@${ACTOR_A}`], 90)
      assert.strictEqual(conflicts[`1@${ACTOR_B}`].value, 5)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { delete draft.k })
      assert.strictEqual(Automerge.toJS(doc1).k, undefined)
      assert.strictEqual(Automerge.toJS(Automerge.load(Automerge.save(doc1))).k, undefined)
    })

    it('does not hide values whose only successors are increments', () => {
      let doc1 = Automerge.from({k: 'zero'}, ACTOR_A)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.k = new Automerge.Counter(6) })
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.k.increment(2) })
      const reloaded = Automerge.load(Automerge.save(doc1))
      assert.strictEqual(Automerge.toJS(reloaded).k.value, 8)
      assert.strictEqual(Automerge.toJS(doc1).k.value, 8)
    })

    it('allows overwriting a counter with a plain value', () => {
      let doc = Automerge.from({c: new Automerge.Counter(3)}, ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.c = 99 })
      assert.strictEqual(Automerge.toJS(doc).c, 99)
      assert.strictEqual(Automerge.toJS(Automerge.load(Automerge.save(doc))).c, 99)
    })

    it('ignores increments to counters that are not visible', () => {
      let doc1 = Automerge.from({c: new Automerge.Counter(5)}, ACTOR_A)
      let doc2 = Automerge.merge(Automerge.init(ACTOR_B), doc1)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.c = 'gone' })
      doc2 = Automerge.change(doc2, {time: 0}, draft => { draft.c.increment(3) })
      const merged = Automerge.merge(doc1, doc2)
      assert.strictEqual(Automerge.toJS(merged).c, 'gone')
      assert.strictEqual(Automerge.toJS(Automerge.load(Automerge.save(merged))).c, 'gone')
    })
  })
})
