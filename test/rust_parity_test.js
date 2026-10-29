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

describe('@automerge/automerge 3.5.0 parity', () => {
  function big(key, value) {
    return typeof value === 'bigint' ? `${value}n` : value
  }

  function thrown(fn) {
    try {
      fn()
    } catch (error) {
      return `${error.constructor.name}: ${error.message}`
    }
  }

  describe('path resolution', () => {
    const doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => {
      draft.m = {'': 'x', t: 'ab'}; draft['a/b'] = 'q'; draft.a = {b: 'zz'}
    })
    function edit(fn) {
      return Automerge.change(Automerge.clone(doc, ACTOR_A), {time: 0}, fn)
    }

    it('stops at an empty path component', () => {
      assert.strictEqual(thrown(() => edit(draft => Automerge.splice(draft, ['m', '', 't'], 0, 0, 'y'))),
        'RangeError: Cannot splice: RangeError: invalid op for object of type `map`')
      assert.deepStrictEqual(Automerge.getHeads(edit(draft => Automerge.splice(draft, ['m', ''], 0, 2, ''))), Automerge.getHeads(doc))
    })

    it('splits path components on slashes', () => {
      assert.strictEqual(Automerge.toJS(edit(draft => Automerge.splice(draft, ['a/b'], 0, 0, 'y'))).a.b, 'yzz')
    })

    it('reports unresolvable paths with the wasm messages', () => {
      assert.strictEqual(thrown(() => edit(draft => Automerge.mark(draft, ['nope'], {start: 0, end: 1}, 'b', true))),
        'RangeError: Cannot mark: RangeError: invalid object id: invalid path _root/nope: path component 0 (nope) referenced a nonexistent object')
      assert.strictEqual(thrown(() => edit(draft => Automerge.splice(draft, ['m', 't', 'x'], 0, 0, 'y'))),
        'RangeError: Cannot splice: RangeError: invalid object ID: invalid path _root/m/t/x: path component 2 (x) should be an integer to index a sequence')
    })

    it('returns spans of maps the way the wasm package does', () => {
      const d = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => {
        draft.m = {s: new Automerge.ImmutableString('s'), n: 1, k: {q: 1}, t: 'abc'}
      })
      assert.deepStrictEqual(Automerge.spans(d, ['m']), [{type: 'block', value: {q: 1}}, {type: 'text', value: '￼s￼'}])
    })
  })

  describe('updateSpans', () => {
    it('recomputes marks after inserting past a non-expanding mark end', () => {
      let doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.t = 'x' })
      doc = Automerge.change(doc, {time: 0}, draft => Automerge.mark(draft, ['t'], {start: 0, end: 1, expand: 'before'}, 'em', 'u'))
      doc = Automerge.change(doc, {time: 0}, draft => Automerge.updateSpans(draft, ['t'], [{type: 'text', value: 'xx', marks: {em: 'u'}}]))
      assert.deepStrictEqual(Automerge.getHeads(doc), ['e14269c9d3f720a1aba76e2d6580d6c19d9f103ce0b02605dc699cf122e17c04'])
      assert.deepStrictEqual(Automerge.marks(doc, ['t']), [{name: 'em', value: 'u', start: 0, end: 2}])
    })

    it('deletes one code point per replaced grapheme', () => {
      let doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.t = '\u{1F468}‍\u{1F469}' })
      doc = Automerge.change(doc, {time: 0}, draft => Automerge.updateSpans(draft, ['t'], [{type: 'text', value: '\udc68‍\u{1F469}'}]))
      assert.deepStrictEqual(Automerge.getHeads(doc), ['8a9784b7aeb252f4a6d782e1a7238c6edaea0bfce5b5a247412c8150aa700881'])
      assert.strictEqual(Automerge.toJS(doc).t, '�‍\u{1F469}‍\u{1F469}')
    })

    it('splits the current graphemes at mark boundaries', () => {
      let doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.t = '\u{1F468}‍\u{1F469}' })
      doc = Automerge.change(doc, {time: 0}, draft => Automerge.mark(draft, ['t'], {start: 0, end: 2, expand: 'none'}, 'b', true))
      doc = Automerge.change(doc, {time: 0}, draft => Automerge.updateSpans(draft, ['t'],
        [{type: 'text', value: '\u{1F468}'}, {type: 'text', value: '\u{1F600}‍\u{1F469}', marks: {link: false}}]))
      assert.deepStrictEqual(Automerge.getHeads(doc), ['f8aa808ed8464e26126bd5497361dfc39be77cf720359d025cc4cc0e7fdb2ba4'])
    })

    it('updates nested block lists by deleting from the front', () => {
      let doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => {
        draft.t = 'ab'; Automerge.splitBlock(draft, ['t'], 1, {type: 'p', l: [3, 4, 5]})
      })
      doc = Automerge.change(doc, {time: 0}, draft => Automerge.updateSpans(draft, ['t'],
        [{type: 'text', value: 'a'}, {type: 'block', value: {type: 'p', l: [9]}}, {type: 'text', value: 'b'}]))
      assert.deepStrictEqual(Automerge.getHeads(doc), ['f6b0dfa1c242ccef1e9df5a201e8b8f3cb67d4c966e3e2c65bfd62a932091128'])
      assert.deepStrictEqual(Automerge.block(doc, ['t'], 1).l, [5])
    })
  })

  describe('block markers', () => {
    it('creates nested block values depth-first in key order', () => {
      const doc = Automerge.change(Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.t = 'ab' }), {time: 0}, draft => {
        Automerge.splitBlock(draft, ['t'], 1, {type: 'p', parents: ['a', 'b'], attrs: {z: 1, k: 'v', n: 0}, l: [1, {b: 1, a: 2}, 'tx']})
      })
      assert.deepStrictEqual(Automerge.getHeads(doc), ['1a760dbf32bd60030d8169bfe04b68547662c1dfa998e98a5b290bd3ee6bbd9f'])
    })

    it('reports out-of-range indexes with the wasm messages', () => {
      const doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.t = 'abc' })
      function edit(fn) {
        return thrown(() => Automerge.change(Automerge.clone(doc), {time: 0}, fn))
      }
      assert.strictEqual(edit(draft => Automerge.splitBlock(draft, ['t'], 9, {type: 'p'})), 'RangeError: Cannot splice: RangeError: index 9 is out of bounds')
      assert.strictEqual(edit(draft => Automerge.joinBlock(draft, ['t'], 3)), 'RangeError: Cannot joinBlock: index 3 is out of bounds')
      assert.strictEqual(edit(draft => Automerge.updateBlock(draft, ['t'], 3, {type: 'p'})), 'RangeError: Cannot updateBlock: RangeError: index 3 is out of bounds')
      assert.strictEqual(Automerge.block(doc, ['t'], 9), null)
      assert.strictEqual(thrown(() => Automerge.getCursorPosition(doc, ['t'], 'zz')), 'RangeError: Cannot getCursorPosition: RangeError: cursor format is invalid')
    })
  })

  describe('numbers', () => {
    it('stores Uint, Int and Float64 wrappers inside new objects as maps', () => {
      const doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => {
        draft.k = {u: new Automerge.Uint(7), i: new Automerge.Int(-1), f: new Automerge.Float64(2), n: 0}
        draft.l = [new Automerge.Uint(1)]
        draft.l.push(new Automerge.Uint(2))
        draft.top = new Automerge.Uint(3)
      })
      assert.deepStrictEqual(Automerge.getHeads(doc), ['5e237ec9ca3be14c7a37eb7c32975153904e558a4e8e4b44268d4c1d37f0babe'])
      assert.deepStrictEqual(Automerge.toJS(doc), {k: {f: {value: 2}, i: {value: -1}, n: 0, u: {value: 7}}, l: [{value: 1}, {value: 2}], top: 3n})
    })

    it('reads uint values as bigints and compares assignments by datatype', () => {
      const doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.u = new Automerge.Uint(18) })
      assert.strictEqual(doc.u, 18n)
      const same = Automerge.change(Automerge.clone(doc, ACTOR_B), {time: 0}, draft => { draft.u = new Automerge.Uint(18) })
      assert.deepStrictEqual(Automerge.getHeads(same), Automerge.getHeads(doc))
      const int = Automerge.change(Automerge.clone(doc, ACTOR_B), {time: 0}, draft => { draft.u = 18 })
      assert.deepStrictEqual(Automerge.decodeChange(Automerge.getLastLocalChange(int)).ops,
        [{obj: '_root', key: 'u', action: 'set', value: 18, datatype: 'int', pred: [`1@${ACTOR_A}`]}])
    })
  })

  describe('getConflicts', () => {
    it('returns strings as plain strings, including inside objects', () => {
      const a = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => {
        draft.k = new Automerge.ImmutableString('s'); draft.n = {s: new Automerge.ImmutableString('in'), t: 'tt'}
      })
      const b = Automerge.change(Automerge.init(ACTOR_B), {time: 0}, draft => { draft.k = new Automerge.ImmutableString('o'); draft.n = 1 })
      const merged = Automerge.merge(a, b)
      assert.deepStrictEqual(Automerge.getConflicts(merged, 'k'), {[`1@${ACTOR_A}`]: 's', [`1@${ACTOR_B}`]: 'o'})
      assert.deepStrictEqual(JSON.parse(JSON.stringify(Automerge.getConflicts(merged, 'n'))), {[`2@${ACTOR_A}`]: {s: 'in', t: 'tt'}, [`2@${ACTOR_B}`]: 1})
      assert.strictEqual(Automerge.getConflicts(merged, 'n')[`2@${ACTOR_A}`].s, 'in')
    })
  })

  describe('save and load', () => {
    it('keeps changes with missing dependencies', () => {
      let a = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.x = 1 })
      a = Automerge.change(a, {time: 0}, draft => { draft.y = 2 })
      a = Automerge.change(a, {time: 0}, draft => { draft.z = 3 })
      const changes = Automerge.getAllChanges(a)
      const [b] = Automerge.applyChanges(Automerge.init(ACTOR_B), [changes[0], changes[2]])
      const loaded = Automerge.load(Automerge.save(b))
      assert.strictEqual(Automerge.getMissingDeps(loaded).length, 1)
      assert.deepStrictEqual(Automerge.toJS(Automerge.merge(loaded, a)), {x: 1, y: 2, z: 3})
    })

    it('returns the last change of the local actor after loading', () => {
      let doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.a = 1 })
      doc = Automerge.change(doc, {time: 0}, draft => { draft.b = 2 })
      const loaded = Automerge.load(Automerge.save(doc), {actor: ACTOR_A})
      assert.strictEqual(Automerge.decodeChange(Automerge.getLastLocalChange(loaded)).seq, 2)
    })
  })

  describe('changeAt', () => {
    it('isolates changes on derived actors numbered above every operation', () => {
      let doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.x = 1; draft.l = ['a'] })
      const first = Automerge.getHeads(doc)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.z = 3 })
      const r1 = Automerge.changeAt(doc, first, {time: 0}, draft => { draft.w = 4; draft.l.push('q') })
      const r2 = Automerge.changeAt(r1.newDoc, first, {time: 0}, draft => { draft.w = 5 })
      assert.deepStrictEqual(r1.newHeads, ['816f8c8587c540d1a40242816e4673fc5ba0ee231f5505a38faef1c3b454c6da'])
      assert.deepStrictEqual(r2.newHeads, ['38c5918c1bd30ec7d5781bccf38cb3e163aaadf73289b5220fddfafa8bfc1a17'])
      const changes = Automerge.getAllChanges(r2.newDoc).slice(-2).map(change => Automerge.decodeChange(change))
      assert.deepStrictEqual(changes.map(c => [c.actor, c.seq, c.startOp, c.deps]), [
        ['13b2230901' + ACTOR_A, 1, 6, ['44cd4608aa504489806ed7776b03a8594bc8a13e31a8c3c30b7c3ec8b713d192']],
        ['13b2230902' + ACTOR_A, 1, 9, ['44cd4608aa504489806ed7776b03a8594bc8a13e31a8c3c30b7c3ec8b713d192']]])
    })

    it('reports the isolation, the change and the reintegration as one patch', () => {
      const patches = []
      let doc = Automerge.change(Automerge.init({actor: ACTOR_A, patchCallback: p => patches.push(p)}), {time: 0}, draft => {
        draft.x = 1; draft.t = 'abc'; draft.l = [1, 2]
      })
      const heads = Automerge.getHeads(doc)
      doc = Automerge.change(doc, {time: 0}, draft => { draft.y = 2; Automerge.splice(draft, ['t'], 1, 1, 'ZZ'); draft.l.push(3); draft.x = 5 })
      patches.length = 0
      Automerge.changeAt(doc, heads, {time: 0}, draft => { draft.w = 4; Automerge.splice(draft, ['t'], 3, 0, 'q'); draft.l[0] = 9 })
      assert.deepStrictEqual(patches, [[
        {action: 'put', path: ['x'], value: 1}, {action: 'del', path: ['y']}, {action: 'put', path: ['w'], value: 4},
        {action: 'del', path: ['t', 1], length: 2}, {action: 'splice', path: ['t', 1], value: 'b'}, {action: 'splice', path: ['t', 3], value: 'q'},
        {action: 'del', path: ['l', 2]}, {action: 'put', path: ['l', 0], value: 9}, {action: 'put', path: ['x'], value: 5},
        {action: 'put', path: ['y'], value: 2}, {action: 'splice', path: ['t', 1], value: 'ZZ'}, {action: 'del', path: ['t', 3]},
        {action: 'insert', path: ['l', 2], values: [3]}]])
    })

    it('anchors insertions on mark boundaries created after the isolated heads', () => {
      let doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.t = 'x' })
      const heads = Automerge.getHeads(doc)
      doc = Automerge.change(doc, {time: 0}, draft => Automerge.mark(draft, ['t'], {start: 0, end: 1, expand: 'both'}, 'b', true))
      const result = Automerge.changeAt(doc, heads, {time: 0}, draft => Automerge.splice(draft, ['t'], 0, 0, 'y'))
      assert.deepStrictEqual(result.newHeads, ['d5dc20971629222fe3d1070dde0e936f1b6f5e6a90e1cc57327b41abd958dc85'])
      assert.strictEqual(Automerge.toJS(result.newDoc).t, 'yx')
    })
  })

  describe('invalid arguments', () => {
    it('normalizes splice arguments and reports errors like the wasm package', () => {
      const doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.t = 'abc'; draft.l = [1, 2] })
      function edit(fn) {
        return thrown(() => Automerge.change(Automerge.clone(doc), {time: 0}, fn)) ||
          JSON.stringify(Automerge.toJS(Automerge.change(Automerge.clone(doc), {time: 0}, fn)), big)
      }
      assert.deepStrictEqual([
        draft => Automerge.splice(draft, ['t'], 9, 0, 'x'), draft => Automerge.splice(draft, ['t'], 0, -1, 'q'),
        draft => Automerge.splice(draft, ['t'], -1, 1, 'z'), draft => Automerge.splice(draft, ['t'], 1.5, 0, 'z'),
        draft => Automerge.splice(draft, ['t'], 'x', 0, 'q'), draft => Automerge.splice(draft, ['l'], 1, 0, [1, 'a', null]),
        draft => Automerge.splice(draft, ['l'], 0, 0, [new Automerge.Uint(3)]), draft => Automerge.splice(draft, ['t'], 1, 1, 5)
      ].map(edit), [
        'RangeError: Cannot splice: RangeError: index 9 is out of bounds', 'RangeError: Cannot splice: RangeError: index 0 is out of bounds',
        '{"l":[1,2],"t":"zbc"}', '{"l":[1,2],"t":"azbc"}', 'RangeError: index must be a number or cursor', '{"l":[1,1,"a",null,2],"t":"abc"}',
        'RangeError: Cannot splice: RangeError: invalid import: JsValue(Object({"value":3}))', '{"l":[1,2],"t":"ac"}'])
    })

    it('validates mark arguments like the wasm package', () => {
      const doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.t = 'abc' })
      function mark(range, name, value) {
        return thrown(() => Automerge.change(Automerge.clone(doc), {time: 0}, draft => Automerge.mark(draft, ['t'], range, name, value)))
      }
      assert.deepStrictEqual([
        mark({start: 0, end: 9}, 'b', true), mark({start: '1', end: 2}, 'b', true), mark({start: 0, end: 2, expand: 'left'}, 'b', true),
        mark({start: 0, end: 2}, 5, true), mark({start: 0, end: 2}, 'b', {}), mark(null, 'b', true), mark({start: -1, end: 2}, 'b', true)
      ], [
        'RangeError: Cannot mark: RangeError: index 9 is out of bounds', 'RangeError: Cannot mark: RangeError: start must be a number',
        "RangeError: Cannot mark: RangeError: expand must be 'left', 'right', 'both', or 'none' - is 'right' by default",
        'RangeError: Cannot mark: RangeError: Invalid mark name', 'RangeError: Cannot mark: RangeError: Invalid mark value: invalid import: JsValue(Object({}))',
        'RangeError: Cannot mark: RangeError: range must be an object', undefined])
    })

    it('edits lists like the wasm proxies', () => {
      const doc = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.l = ['p', 'q', 'r'] })
      function edit(fn) {
        return thrown(() => Automerge.change(Automerge.clone(doc), {time: 0}, fn)) ||
          JSON.stringify(Automerge.toJS(Automerge.change(Automerge.clone(doc), {time: 0}, fn)).l, big)
      }
      assert.deepStrictEqual([
        draft => Automerge.insertAt(draft.l, 9, 1), draft => Automerge.deleteAt(draft.l, 9, 1), draft => Automerge.deleteAt(draft.l, 1, 9),
        draft => Automerge.deleteAt(draft.l, 1, 0), draft => { draft.l[5] = 1 }, draft => { draft.l.x = 1 }, draft => { delete draft.l[3] },
        draft => Automerge.deleteAt(draft.l, 2, -1), draft => draft.l.splice(9, 0, 1), draft => { draft.l[3] = new Automerge.Uint(4) },
        draft => { draft.l.length = 1 }
      ].map(edit), [
        'RangeError: index 9 is out of bounds', '["p","q","r"]', '["p"]', '["p","q","r"]', 'RangeError: index 5 is out of bounds',
        'RangeError: list index must be a number', 'RangeError: index 3 is out of bounds', '["p","r"]', 'RangeError: index 9 is out of bounds',
        '["p","q","r","4n"]', 'RangeError: list index must be a number'])
    })

    it('numbers inserted list elements before the deletions of the same splice', () => {
      const doc = Automerge.change(Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.l = [1, 2, 3] }), {time: 0}, draft => {
        draft.l.splice(1, 1, 7, 8)
      })
      assert.deepStrictEqual(Automerge.getHeads(doc), ['824542df544106a74b3cd7e93540c8b284461fff7db77288c833f8422785f7e2'])
    })
  })

  describe('batch patches', () => {
    it('reproduces the insertion index after an invisible update of the last element', () => {
      const base = Automerge.change(Automerge.init(ACTOR_A), {time: 0}, draft => { draft.l = [1] })
      const a = Automerge.change(Automerge.clone(base, ACTOR_B), {time: 0}, draft => { draft.l[0] = new Automerge.Counter(2) })
      let b = Automerge.change(Automerge.clone(base, 'cccc'), {time: 0}, draft => { draft.l.insertAt(1, 'x') })
      b = Automerge.change(b, {time: 0}, draft => { draft.l.deleteAt(0) })
      const patches = []
      Automerge.applyChanges(Automerge.clone(a), Automerge.getChanges(base, b), {patchCallback: p => patches.push(...p)})
      assert.deepStrictEqual(patches, [{action: 'insert', path: ['l', 0], values: ['']}, {action: 'splice', path: ['l', 1, 0], value: 'x'}])
    })
  })
})
