import assert from 'node:assert'
import Automerge from './subject.js'
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

    it('generates operations for object literals breadth-first in UTF-8 key order', () => {
      let doc = Automerge.from({m: {zebra: 1, apple: {x: 1}, mango: 3}, b: 1}, {actor: ACTOR_A})
      const ops = Automerge.decodeChange(Automerge.getAllChanges(doc).pop()).ops
      assert.deepStrictEqual(ops.map(op => op.key), ['b', 'm', 'apple', 'mango', 'zebra', 'x'])
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

  describe('mark ranges', () => {
    function marked(text, callback) {
      let doc = Automerge.init(ACTOR_A)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.t = text })
      return Automerge.change(doc, {time: 0}, draft => callback(draft))
    }

    function markOps(doc) {
      return Automerge.decodeChange(Automerge.getLastLocalChange(doc)).ops.map(op => [op.action, op.elemId, op.expand])
    }

    it('rounds a start inside a surrogate pair up past the character', () => {
      const doc = marked('a😀b', draft => {
        Automerge.mark(draft, ['t'], {start: 1, end: 2, expand: 'none'}, 'link', true)
      })
      assert.deepStrictEqual(Automerge.marks(doc, ['t']), [{name: 'link', value: true, start: 1, end: 3}])
      assert.deepStrictEqual(Automerge.getHeads(doc), ['9593565aff66be007684b8b4f4520864655e3a538eb770386b97a9326df0342b'])
    })

    it('anchors the end on the begin when both round to the same character', () => {
      const doc = marked('a😀b', draft => {
        Automerge.mark(draft, ['t'], {start: 2, end: 3, expand: 'none'}, 'link', true)
      })
      assert.deepStrictEqual(Automerge.marks(doc, ['t']), [])
      assert.deepStrictEqual(markOps(doc), [['markBegin', `3@${ACTOR_A}`, false], ['markEnd', `5@${ACTOR_A}`, false]])
      assert.deepStrictEqual(Automerge.getHeads(doc), ['60c12fb6b02cc06d202e6f1fedffa587c9c3a8ba8b5cdb0cdcff371b1e338b69'])
    })

    it('anchors the end of an empty expanding mark on the begin', () => {
      const doc = marked('a😀b', draft => {
        Automerge.mark(draft, ['t'], {start: 2, end: 2, expand: 'after'}, 'link', true)
      })
      assert.deepStrictEqual(markOps(doc), [['markBegin', `3@${ACTOR_A}`, false], ['markEnd', `5@${ACTOR_A}`, true]])
      assert.deepStrictEqual(Automerge.getHeads(doc), ['aa4567aa0b3eb17a403983308db4362273a6538448ed99ec784ade859c7d460d'])
    })

    it('treats an end before the start as an empty mark at the start', () => {
      const doc = marked('abcd', draft => {
        Automerge.mark(draft, ['t'], {start: 3, end: 1, expand: 'after'}, 'bold', true)
      })
      assert.deepStrictEqual(Automerge.marks(doc, ['t']), [])
      assert.deepStrictEqual(markOps(doc), [['markBegin', `4@${ACTOR_A}`, false], ['markEnd', `6@${ACTOR_A}`, true]])
      assert.deepStrictEqual(Automerge.getHeads(doc), ['00e64dc16906cdcbe44b87a07e5adbf4daabe817568e4932cc8172cc92276809'])
    })

    it('ignores an empty non-expanding mark before checking bounds', () => {
      const doc = marked('abc', draft => {
        Automerge.mark(draft, ['t'], {start: 7, end: 7, expand: 'none'}, 'bold', true)
      })
      assert.deepStrictEqual(Automerge.getHeads(doc), ['e26008a15832af3ebc6e73dc364803401c1f93239569c911986a5ac7cef7bf9e'])
      assert.throws(() => marked('abc', draft => {
        Automerge.mark(draft, ['t'], {start: 4, end: 4, expand: 'both'}, 'bold', true)
      }))
    })

    it('ignores a deletion past the end of the text', () => {
      const doc = marked('abc', draft => { Automerge.splice(draft, ['t'], 5, 2) })
      assert.strictEqual(Automerge.toJS(doc).t, 'abc')
      assert.deepStrictEqual(Automerge.getHeads(doc), ['e26008a15832af3ebc6e73dc364803401c1f93239569c911986a5ac7cef7bf9e'])
      assert.throws(() => marked('abc', draft => { Automerge.splice(draft, ['t'], 5, 0, 'x') }))
    })

    it('indexes marksAt by text element, not UTF-16 offset', () => {
      const doc = marked('a😀b😀', draft => {
        Automerge.mark(draft, ['t'], {start: 3, end: 6, expand: 'none'}, 'bold', true)
      })
      assert.deepStrictEqual(Automerge.marks(doc, ['t']), [{name: 'bold', value: true, start: 3, end: 6}])
      assert.deepStrictEqual([0, 1, 2, 3, 4, 5, 6, 9].map(index => Automerge.marksAt(doc, ['t'], index)),
        [{}, {}, {bold: true}, {bold: true}, {}, {}, {}, {}])
    })

    it('orders marks by name, then start', () => {
      const doc = marked('abcd', draft => {
        Automerge.mark(draft, ['t'], {start: 2, end: 4}, 'bold', true)
        Automerge.mark(draft, ['t'], {start: 0, end: 3}, 'link', true)
        Automerge.mark(draft, ['t'], {start: 0, end: 1}, 'em', true)
      })
      assert.deepStrictEqual(Automerge.marks(doc, ['t']), [
        {name: 'bold', value: true, start: 2, end: 4},
        {name: 'em', value: true, start: 0, end: 1},
        {name: 'link', value: true, start: 0, end: 3}
      ])
      assert.deepStrictEqual(Automerge.getHeads(doc), ['f855e5c654685d8949c8392db4459753d05476a785909e5a6d70490267a03e69'])
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
