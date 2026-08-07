const assert = require('assert')
const Automerge = process.env.TEST_DIST === '1' ? require('../dist/automerge') : require('../src/automerge')

const ACTOR_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const ACTOR_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

// Behavior pinned against the Rust implementation (../automerge, branch
// fragment, and released @automerge/automerge 3.4). Expected values in this
// file were captured from that implementation.
describe('Rust implementation parity', () => {
  describe('map key ordering', () => {
    it('applies the keys of each change in UTF-8 order', () => {
      let doc = Automerge.init()
      doc = Automerge.change(doc, draft => { draft.zebra = 1; draft.apple = 2 })
      assert.deepStrictEqual(Object.keys(doc), ['apple', 'zebra'])
      doc = Automerge.change(doc, draft => { draft.mango = 3 })
      doc = Automerge.change(doc, draft => { draft.aaa = 4 })
      assert.deepStrictEqual(Object.keys(doc), ['apple', 'zebra', 'mango', 'aaa'])
    })

    it('appends merged keys after existing keys', () => {
      let doc1 = Automerge.init(ACTOR_A), doc2 = Automerge.init(ACTOR_B)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.x = 'one'; draft.shared = {k: 1} })
      doc2 = Automerge.change(doc2, {time: 0}, draft => { draft.x = 'two'; draft.list = [3, 1] })
      const merged = Automerge.merge(doc1, doc2)
      assert.deepStrictEqual(Object.keys(merged), ['shared', 'x', 'list'])
    })

    it('sorts keys on load and in toJS', () => {
      let doc = Automerge.init()
      doc = Automerge.change(doc, draft => { draft.zebra = 1 })
      doc = Automerge.change(doc, draft => { draft.apple = {y: 2, b: 3} })
      const loaded = Automerge.load(Automerge.save(doc))
      assert.deepStrictEqual(Object.keys(loaded), ['apple', 'zebra'])
      assert.deepStrictEqual(Object.keys(Automerge.toJS(doc)), ['apple', 'zebra'])
      assert.deepStrictEqual(Object.keys(Automerge.toJS(doc).apple), ['b', 'y'])
    })

    it('orders astral and replacement-character keys by UTF-8 encoding', () => {
      let doc = Automerge.init()
      doc = Automerge.change(doc, draft => { draft['z\u{1F600}'] = 1; draft['z�'] = 2; draft.za = 3 })
      assert.deepStrictEqual(Object.keys(doc), ['za', 'z�', 'z\u{1F600}'])
    })

    it('preserves object-literal insertion order in generated operations', () => {
      let doc = Automerge.from({m: {zebra: 1, apple: 2, mango: 3}}, {actor: ACTOR_A})
      const ops = Automerge.decodeChange(Automerge.getAllChanges(doc).pop()).ops
      assert.deepStrictEqual(ops.map(op => op.key), ['m', 'zebra', 'apple', 'mango'])
    })
  })

  describe('conflicts', () => {
    it('returns conflicting values in ascending opId order', () => {
      let doc1 = Automerge.init(ACTOR_A), doc2 = Automerge.init(ACTOR_B)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.x = 'one' })
      doc2 = Automerge.change(doc2, {time: 0}, draft => { draft.x = 'two' })
      const merged = Automerge.merge(doc1, doc2)
      assert.strictEqual(merged.x, 'two')
      assert.deepStrictEqual(Automerge.getConflicts(merged, 'x'),
        {[`1@${ACTOR_A}`]: 'one', [`1@${ACTOR_B}`]: 'two'})
    })

    it('marks conflicted puts in load patches', () => {
      let doc1 = Automerge.init(ACTOR_A), doc2 = Automerge.init(ACTOR_B)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.v = 'one' })
      doc2 = Automerge.change(doc2, {time: 0}, draft => { draft.v = 'two' })
      const merged = Automerge.merge(doc1, doc2)
      const patches = []
      Automerge.load(Automerge.save(merged), {patchCallback: p => patches.push(...p)})
      assert.deepStrictEqual(patches, [
        {action: 'put', path: ['v'], value: '', conflict: true},
        {action: 'splice', path: ['v', 0], value: 'two'}
      ])
    })

    it('annotates conflicted list elements on insert patches', () => {
      let doc1 = Automerge.init(ACTOR_A)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.l = [1, 2, 3] })
      let doc2 = Automerge.merge(Automerge.init(ACTOR_B), doc1)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.l[1] = 'x' })
      doc2 = Automerge.change(doc2, {time: 0}, draft => { draft.l[1] = 'y' })
      doc1 = Automerge.merge(doc1, doc2)
      const patches = []
      Automerge.load(Automerge.save(doc1), {patchCallback: p => patches.push(...p)})
      assert.deepStrictEqual(patches, [
        {action: 'put', path: ['l'], value: []},
        {action: 'insert', path: ['l', 0], values: [1, '', 3], conflicts: [false, true, false]},
        {action: 'splice', path: ['l', 1, 0], value: 'y'}
      ])
    })

    it('emits a conflict patch when a losing value arrives', () => {
      let doc1 = Automerge.init(ACTOR_B)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.v = 1 })
      let doc2 = Automerge.merge(Automerge.init(ACTOR_A), doc1)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.v = 'winner' })
      doc2 = Automerge.change(doc2, {time: 0}, draft => { draft.v = 'loser' })
      const patches = []
      ;[doc1] = Automerge.applyChanges(doc1, Automerge.getChanges(doc1, doc2),
        {patchCallback: p => patches.push(...p)})
      assert.deepStrictEqual(patches, [{action: 'conflict', path: ['v']}])
      assert.strictEqual(doc1.v, 'winner')
    })
  })

  describe('patch emission order', () => {
    it('orders new-object content patches by object creation', () => {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.mmm = 'text here'; draft.zzz = {inner: [1, 2]} })
      doc = Automerge.change(doc, {time: 0}, draft => { draft.bbb = ['x']; draft.aaa = 'later text' })
      const patches = []
      Automerge.load(Automerge.save(doc), {patchCallback: p => patches.push(...p)})
      assert.deepStrictEqual(patches, [
        {action: 'put', path: ['aaa'], value: ''},
        {action: 'put', path: ['bbb'], value: []},
        {action: 'put', path: ['mmm'], value: ''},
        {action: 'put', path: ['zzz'], value: {}},
        {action: 'splice', path: ['mmm', 0], value: 'text here'},
        {action: 'put', path: ['zzz', 'inner'], value: []},
        {action: 'insert', path: ['zzz', 'inner', 0], values: [1, 2]},
        {action: 'insert', path: ['bbb', 0], values: ['']},
        {action: 'splice', path: ['bbb', 0, 0], value: 'x'},
        {action: 'splice', path: ['aaa', 0], value: 'later text'}
      ])
    })

    it('orders diff patches by object creation', () => {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.text = 'hello'; draft.tags = ['a'] })
      const before = Automerge.getHeads(doc)
      doc = Automerge.change(doc, {time: 0}, draft => {
        Automerge.splice(draft, ['text'], 5, 0, ' world')
        draft.tags.push('b')
        draft.meta = {v: 2}
      })
      assert.deepStrictEqual(Automerge.diff(doc, before, Automerge.getHeads(doc)), [
        {action: 'put', path: ['meta'], value: {}},
        {action: 'splice', path: ['text', 5], value: ' world'},
        {action: 'insert', path: ['tags', 1], values: ['']},
        {action: 'splice', path: ['tags', 1, 0], value: 'b'},
        {action: 'put', path: ['meta', 'v'], value: 2}
      ])
    })
  })

  describe('updateText', () => {
    function heads(from, to) {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.t = from })
      doc = Automerge.change(doc, {time: 0}, draft => { Automerge.updateText(draft, ['t'], to) })
      return [Automerge.getHeads(doc)[0], Automerge.toJS(doc).t]
    }

    it('generates separate Myers edits rather than one contiguous splice', () => {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.t = 'hello world' })
      doc = Automerge.change(doc, {time: 0}, draft => { Automerge.updateText(draft, ['t'], 'hxllo wyrld') })
      const ops = Automerge.decodeChange(Automerge.getAllChanges(doc).pop()).ops
      // 'e' -> 'x' and 'o' -> 'y' are two separate insert+delete pairs
      assert.deepStrictEqual(ops.map(op => (op.value === undefined ? op.action : `${op.action}:${op.value}`)),
        ['set:x', 'del', 'set:y', 'del'])
    })

    it('handles replacements that are not a single contiguous splice', () => {
      const cases = [
        ['hello world', 'hxllo wyrld'],
        ['the quick brown fox', 'the quick red fox jumps'],
        ['abc def', 'def abc'],
        ['ABCABBA', 'CBABAC'],
        ['', 'anything'],
        ['something', '']
      ]
      for (const [from, to] of cases) {
        assert.strictEqual(heads(from, to)[1], to)
      }
    })

    it('deletes block markers that fall inside a replaced range', () => {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.t = 'hello world' })
      doc = Automerge.change(doc, {time: 0}, draft => {
        Automerge.splitBlock(draft, ['t'], 5, {type: 'li'})
      })
      doc = Automerge.change(doc, {time: 0}, draft => {
        Automerge.updateText(draft, ['t'], 'hello brave world')
      })
      assert.deepStrictEqual(Automerge.spans(doc, ['t']), [{type: 'text', value: 'hello brave world'}])
    })
  })

  describe('mark boundary expansion', () => {
    function marksAfterSplice(expand, at) {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.text = 'hello world' })
      doc = Automerge.change(doc, {time: 0}, draft => {
        Automerge.mark(draft, ['text'], {start: 2, end: 5, expand}, 'bold', true)
      })
      doc = Automerge.change(doc, {time: 0}, draft => { Automerge.splice(draft, ['text'], at, 0, 'XX') })
      return Automerge.marks(doc, ['text'])
    }

    it('extends expanding end boundaries over text inserted at the boundary', () => {
      assert.deepStrictEqual(marksAfterSplice('after', 5), [{name: 'bold', value: true, start: 2, end: 7}])
      assert.deepStrictEqual(marksAfterSplice('both', 5), [{name: 'bold', value: true, start: 2, end: 7}])
      assert.deepStrictEqual(marksAfterSplice('none', 5), [{name: 'bold', value: true, start: 2, end: 5}])
      assert.deepStrictEqual(marksAfterSplice('before', 5), [{name: 'bold', value: true, start: 2, end: 5}])
    })

    it('extends expanding start boundaries over text inserted at the boundary', () => {
      assert.deepStrictEqual(marksAfterSplice('before', 2), [{name: 'bold', value: true, start: 2, end: 7}])
      assert.deepStrictEqual(marksAfterSplice('both', 2), [{name: 'bold', value: true, start: 2, end: 7}])
      assert.deepStrictEqual(marksAfterSplice('after', 2), [{name: 'bold', value: true, start: 4, end: 7}])
      assert.deepStrictEqual(marksAfterSplice('none', 2), [{name: 'bold', value: true, start: 4, end: 7}])
    })
  })

  describe('updateSpans', () => {
    it('defaults new marks to expand: after', () => {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.text = 'hello world' })
      doc = Automerge.change(doc, {time: 0}, draft => {
        Automerge.updateSpans(draft, ['text'], [{type: 'text', value: 'hello world', marks: {bold: true}}])
      })
      const ops = Automerge.decodeChange(Automerge.getAllChanges(doc).pop()).ops
      assert.strictEqual(ops[0].action, 'markBegin')
      assert.strictEqual(ops[0].expand, false)
      assert.strictEqual(ops[1].action, 'markEnd')
      assert.strictEqual(ops[1].expand, true)
    })

    it('applies a Myers diff over graphemes and block markers', () => {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.text = 'hello world' })
      doc = Automerge.change(doc, {time: 0}, draft => {
        Automerge.updateSpans(draft, ['text'], [
          {type: 'block', value: {type: 'p'}},
          {type: 'text', value: 'hello'},
          {type: 'block', value: {type: 'p'}},
          {type: 'text', value: 'world'}
        ])
      })
      assert.deepStrictEqual(Automerge.spans(doc, ['text']), [
        {type: 'block', value: {type: 'p'}},
        {type: 'text', value: 'hello'},
        {type: 'block', value: {type: 'p'}},
        {type: 'text', value: 'world'}
      ])
    })

    it('updates a changed block marker in place', () => {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.text = 'ab' })
      doc = Automerge.change(doc, {time: 0}, draft => {
        Automerge.updateSpans(draft, ['text'], [{type: 'block', value: {type: 'p'}}, {type: 'text', value: 'ab'}])
      })
      doc = Automerge.change(doc, {time: 0}, draft => {
        Automerge.updateSpans(draft, ['text'], [{type: 'block', value: {type: 'h1'}}, {type: 'text', value: 'ab'}])
      })
      assert.deepStrictEqual(Automerge.spans(doc, ['text']),
        [{type: 'block', value: {type: 'h1'}}, {type: 'text', value: 'ab'}])
    })
  })

  describe('strings with unpaired surrogates', () => {
    it('stores the replacement character, matching the saved document', () => {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.t = 'a\ud83dz' })
      assert.strictEqual(Automerge.toJS(doc).t, 'a�z')
      assert.strictEqual(Automerge.toJS(Automerge.load(Automerge.save(doc))).t, 'a�z')
    })

    it('sanitizes splice input', () => {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.t = 'az' })
      doc = Automerge.change(doc, {time: 0}, draft => { Automerge.splice(draft, ['t'], 1, 0, '\ude00!') })
      assert.strictEqual(Automerge.toJS(doc).t, 'a�!z')
    })
  })

  describe('getChanges', () => {
    it('ignores heads that are unknown to the new document', () => {
      let doc1 = Automerge.init(ACTOR_B)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.v = 1 })
      let doc2 = Automerge.merge(Automerge.init(ACTOR_A), doc1)
      doc1 = Automerge.change(doc1, {time: 0}, draft => { draft.v = 'winner' })
      doc2 = Automerge.change(doc2, {time: 0}, draft => { draft.v = 'loser' })
      // The unknown head means doc1's clock is discarded entirely, so all of
      // doc2's changes are returned, matching the Rust implementation
      const changes = Automerge.getChanges(doc1, doc2)
      assert.deepStrictEqual(changes.map(change => Automerge.decodeChange(change).actor),
        [ACTOR_B, ACTOR_A])
    })
  })

  describe('from()', () => {
    it('does not set an initialization message', () => {
      const doc = Automerge.from({value: 1}, {actor: ACTOR_A})
      const change = Automerge.decodeChange(Automerge.getAllChanges(doc)[0])
      assert.strictEqual(change.message, null)
    })
  })
})
