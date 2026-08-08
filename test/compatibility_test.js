import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as Automerge from '@automerge/automerge-classic'
import * as Slim from '@automerge/automerge-classic/slim'
import { automergeWasmBase64 } from '@automerge/automerge-classic/automerge.wasm.base64'

describe('modern API compatibility', () => {
  it('loads the root and slim exports through the package entry points', () => {
    assert.strictEqual(Slim.init, Automerge.init)
    assert.strictEqual(Automerge.next.change, Automerge.change)
    const script = "Promise.all([import('@automerge/automerge-classic'), import('@automerge/automerge-classic/slim')]).then(([root, slim]) => process.stdout.write(typeof root.init + ':' + typeof root.next.diff + ':' + typeof slim.applyPatches))"
    assert.strictEqual(execFileSync(process.execPath, ['--input-type=module', '-e', script], {encoding: 'utf8'}), 'function:function:function')
    assert.deepStrictEqual(['dump', 'isCounter', 'use'].filter(name => !(name in Automerge)), [])
    assert.strictEqual(automergeWasmBase64, '')
    assert.strictEqual(statSync(fileURLToPath(import.meta.resolve('@automerge/automerge-classic/automerge.wasm'))).size, 0)
  })

  it('normalizes modern actor options', () => {
    const doc = Automerge.init({actor: 'aabb'})
    assert.strictEqual(Automerge.getActorId(doc), 'aabb')
    assert.strictEqual(Automerge.getActorId(Automerge.clone(doc, {actor: 'ccdd'})), 'ccdd')
  })

  it('exposes document change graph helpers', () => {
    let doc = Automerge.from({value: 1}, {actor: 'aabb'})
    const firstHeads = Automerge.getHeads(doc)
    doc = Automerge.change(doc, draft => { draft.value = 2 })
    const secondHeads = Automerge.getHeads(doc)
    assert.strictEqual(firstHeads.length, 1)
    assert.strictEqual(secondHeads.length, 1)
    assert.strictEqual(Automerge.hasHeads(doc, firstHeads), true)
    assert.strictEqual(Automerge.hasHeads(doc, ['00'.repeat(32)]), false)
    assert.deepStrictEqual(Automerge.getMissingDeps(doc, secondHeads), [])
    assert.strictEqual(Automerge.getChangesSince(doc, firstHeads).length, 1)
    assert.deepStrictEqual(Automerge.getChangesMetaSince(doc, firstHeads).map(change => change.hash), secondHeads)
  })

  it('materializes historical views and makes concurrent changes at heads', () => {
    let doc = Automerge.from({one: 1}, {actor: 'aabb'})
    const oldHeads = Automerge.getHeads(doc)
    doc = Automerge.change(doc, draft => { draft.two = 2 })
    const view = Automerge.view(doc, oldHeads)
    assert.deepStrictEqual(view, {one: 1})
    assert.throws(() => Automerge.change(view, draft => { draft.bad = true }), /clone it first/)

    const result = Automerge.changeAt(doc, oldHeads, 'branch', draft => { draft.three = 3 })
    assert.deepStrictEqual(result.newDoc, {one: 1, two: 2, three: 3})
    assert.strictEqual(result.newHeads.length, 1)
    assert.strictEqual(Automerge.getHeads(result.newDoc).length, 2)
  })

  it('converts documents to detached JavaScript values', () => {
    const doc = Automerge.from({nested: {value: 1}, text: 'abc'})
    const copy = Automerge.toJS(doc)
    assert.strictEqual(Automerge.isAutomerge(doc), true)
    assert.strictEqual(Automerge.isAutomerge(copy), false)
    assert.deepStrictEqual(copy, {nested: {value: 1}, text: 'abc'})
    assert.notStrictEqual(copy.nested, doc.nested)
  })

  it('provides scalar, list, and classic text mutation helpers', () => {
    let doc = Automerge.from({list: ['a'], text: 'hello', title: 'a🙂b', values: ['🙂x']})
    doc = Automerge.change(doc, draft => {
      Automerge.insertAt(draft.list, 1, 'b', 'c')
      Automerge.deleteAt(draft.list, 0)
      Automerge.splice(draft, ['text'], 1, 3, 'i')
      Automerge.updateText(draft, ['text'], 'hiya')
      Automerge.splice(draft, ['title'], 1, 1, '🚀')
      Automerge.updateText(draft, ['values', 0], 'updated')
    })
    assert.deepStrictEqual(doc.list, ['b', 'c'])
    assert.strictEqual(doc.text.toString(), 'hiya')
    assert.strictEqual(doc.title, 'a🚀b')
    assert.deepStrictEqual(doc.values, ['updated'])
  })

  it('diffs historical states and applies structural patches', () => {
    let doc = Automerge.from({count: new Automerge.Counter(1), list: ['a'], nested: {keep: 1, remove: true}, title: 'hello'})
    const beforeHeads = Automerge.getHeads(doc)
    doc = Automerge.change(doc, draft => {
      draft.count.increment(2)
      draft.list[0] = 'b'
      draft.list.push('c')
      draft.nested.keep = 2
      draft.nested.added = {value: 3}
      delete draft.nested.remove
      Automerge.updateText(draft, ['title'], 'hiya')
    })
    const afterHeads = Automerge.getHeads(doc)
    const patches = Automerge.next.diff(doc, beforeHeads, afterHeads)
    const plain = Automerge.toJS(Automerge.view(doc, beforeHeads))
    Automerge.applyPatches(plain, patches)
    assert.deepStrictEqual(plain, Automerge.toJS(doc))
    assert(patches.every(patch => Array.isArray(patch.path)))

    let replay = Automerge.clone(Automerge.view(doc, beforeHeads))
    replay = Automerge.change(replay, draft => Automerge.applyPatches(draft, patches))
    assert.deepStrictEqual(Automerge.toJS(replay), Automerge.toJS(doc))
  })

  it('diffs front insertions, conflicts, and mark-only changes semantically', () => {
    let list = Automerge.from({values: ['a', 'b']})
    let before = Automerge.getHeads(list)
    list = Automerge.change(list, draft => { draft.values.insertAt(0, 'x') })
    assert.deepStrictEqual(Automerge.diff(list, before, Automerge.getHeads(list)), [
      {action: 'insert', path: ['values', 0], values: ['']},
      {action: 'splice', path: ['values', 0, 0], value: 'x'}
    ])

    const base = Automerge.from({value: 0}, {actor: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})
    let low = Automerge.clone(base, {actor: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'})
    let high = Automerge.clone(base, {actor: 'cccccccccccccccccccccccccccccccc'})
    low = Automerge.change(low, draft => { draft.value = 1 })
    high = Automerge.change(high, draft => { draft.value = 2 })
    before = Automerge.getHeads(high)
    const merged = Automerge.merge(high, low)
    assert.deepStrictEqual(Automerge.diff(merged, before, Automerge.getHeads(merged)), [
      {action: 'conflict', path: ['value']}
    ])

    let text = Automerge.from({text: 'abc'})
    before = Automerge.getHeads(text)
    text = Automerge.change(text, draft => {
      Automerge.mark(draft, ['text'], {start: 0, end: 1}, 'bold', true)
    })
    assert.deepStrictEqual(Automerge.diff(text, before, Automerge.getHeads(text)), [
      {action: 'mark', path: ['text'], marks: [{name: 'bold', value: true, start: 0, end: 1}]}
    ])
  })

  it('preserves list and object identity in semantic diffs', () => {
    let doc = Automerge.from({values: [{x: 1}, {x: 1}]}, {actor: '11111111111111111111111111111111'})
    let before = Automerge.getHeads(doc)
    doc = Automerge.change(doc, draft => draft.values.insertAt(0, {x: 1}))
    assert.deepStrictEqual(Automerge.diff(doc, before, Automerge.getHeads(doc)), [
      {action: 'insert', path: ['values', 0], values: [{}]},
      {action: 'put', path: ['values', 0, 'x'], value: 1}
    ])

    doc = Automerge.from({values: [{x: 1}, {x: 1}]}, {actor: '11111111111111111111111111111111'})
    before = Automerge.getHeads(doc)
    doc = Automerge.change(doc, draft => draft.values.deleteAt(0))
    assert.deepStrictEqual(Automerge.diff(doc, before, Automerge.getHeads(doc)), [
      {action: 'del', path: ['values', 0]}
    ])

    doc = Automerge.from({value: {x: 1}}, {actor: '11111111111111111111111111111111'})
    before = Automerge.getHeads(doc)
    doc = Automerge.change(doc, draft => { draft.value = {x: 1} })
    assert.deepStrictEqual(Automerge.diff(doc, before, Automerge.getHeads(doc)), [
      {action: 'put', path: ['value'], value: {}},
      {action: 'put', path: ['value', 'x'], value: 1}
    ])
  })

  it('updates spans without replacing unchanged text', () => {
    let doc = Automerge.from({text: 'abc'}, {actor: '11111111111111111111111111111111'})
    const cursor = Automerge.getCursor(doc, ['text'], 1)
    const before = Automerge.getHeads(doc)
    doc = Automerge.change(doc, draft => {
      Automerge.updateSpans(draft, ['text'], [{type: 'text', value: 'abc'}])
    })
    assert.deepStrictEqual(Automerge.getHeads(doc), before)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], cursor), 1)
    doc = Automerge.change(doc, draft => {
      Automerge.updateSpans(draft, ['text'], [{type: 'text', value: 'aXbc'}])
    })
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], cursor), 2)
    assert.deepStrictEqual(Automerge.diff(doc, before, Automerge.getHeads(doc)), [
      {action: 'splice', path: ['text', 1], value: 'X'}
    ])
  })

  it('accepts cursors as splice indexes', () => {
    let doc = Automerge.from({text: 'abc'}, {actor: '11111111111111111111111111111111'})
    const cursor = Automerge.getCursor(doc, ['text'], 1)
    doc = Automerge.change(doc, draft => Automerge.splice(draft, ['text'], cursor, 0, 'X'))
    assert.strictEqual(doc.text.toString(), 'aXbc')
  })

  it('calls modern patch callbacks with patch arrays and source metadata', () => {
    const calls = []
    function callback(patches, info) { calls.push({patches, info}) }
    let doc = Automerge.from({value: 1}, {patchCallback: callback})
    const firstHeads = Automerge.getHeads(doc)
    doc = Automerge.change(doc, draft => { draft.value = 2 })
    doc = Automerge.emptyChange(doc)
    const result = Automerge.changeAt(doc, firstHeads, draft => { draft.branch = true })
    assert.deepStrictEqual(calls.map(call => call.info.source), ['from', 'change', 'changeAt'])
    assert(calls.every(call => Array.isArray(call.patches)))
    assert.deepStrictEqual(calls[1].patches, [{action: 'put', path: ['value'], value: 2}])
    assert.strictEqual(calls[2].info.after, result.newDoc)
  })

  it('calls one-argument patch callbacks with patch arrays', () => {
    const calls = []
    const doc = Automerge.init({patchCallback: patches => calls.push(patches)})
    Automerge.change(doc, draft => { draft.value = 1 })
    assert.deepStrictEqual(calls, [[{action: 'put', path: ['value'], value: 1}]])
  })

  it('includes inherited marks on text splice patches', () => {
    const calls = []
    let doc = Automerge.from({text: 'abc'})
    doc = Automerge.change(doc, draft => {
      Automerge.mark(draft, ['text'], {start: 0, end: 3, expand: 'both'}, 'bold', true)
    })
    doc = Automerge.change(doc, {patchCallback: patches => calls.push(patches)}, draft => {
      Automerge.splice(draft, ['text'], 1, 0, 'X')
    })
    assert.deepStrictEqual(calls, [[{
      action: 'splice', path: ['text', 1], value: 'X', marks: {bold: true}
    }]])
    assert.deepStrictEqual(Automerge.marks(doc, ['text']), [
      {name: 'bold', value: true, start: 0, end: 4}
    ])
  })

  it('emits exact scalar, list, and text callback patches', () => {
    const actor = '11111111111111111111111111111111'
    function capture(initial, callback) {
      const calls = []
      let doc = Automerge.from(initial, {actor, time: 0})
    Automerge.change(doc, {time: 0, patchCallback: (patches, info) => calls.push({patches, source: info.source})}, callback)
      return calls
    }
    assert.deepStrictEqual(capture({value: 1}, doc => { doc.value = 2 }), [
      {patches: [{action: 'put', path: ['value'], value: 2}], source: 'change'}
    ])
    assert.deepStrictEqual(capture({value: 1}, doc => { delete doc.value }), [
      {patches: [{action: 'del', path: ['value']}], source: 'change'}
    ])
    assert.deepStrictEqual(capture({value: new Automerge.Counter(1)}, doc => doc.value.increment(2)), [
      {patches: [{action: 'inc', path: ['value'], value: 2}], source: 'change'}
    ])
    assert.deepStrictEqual(capture({list: [1, 2]}, doc => doc.list.insertAt(1, 3, 4)), [
      {patches: [{action: 'insert', path: ['list', 1], values: [3, 4]}], source: 'change'}
    ])
    assert.deepStrictEqual(capture({list: [1, 2, 3]}, doc => doc.list.deleteAt(1, 2)), [
      {patches: [{action: 'del', path: ['list', 1], length: 2}], source: 'change'}
    ])
    assert.deepStrictEqual(capture({text: 'abc'}, doc => Automerge.splice(doc, ['text'], 1, 1, 'X')), [
      {patches: [
        {action: 'splice', path: ['text', 1], value: 'X'},
        {action: 'del', path: ['text', 2]}
      ], source: 'change'}
    ])
  })

  it('emits exact mark and block callback patches', () => {
    const actor = '11111111111111111111111111111111'
    const calls = []
    function callback(patches, info) { calls.push({patches, source: info.source}) }
    let doc = Automerge.from({text: 'abc'}, {actor, time: 0})
    doc = Automerge.change(doc, {time: 0, patchCallback: callback}, draft => {
      Automerge.mark(draft, ['text'], {start: 0, end: 3, expand: 'both'}, 'bold', true)
    })
    assert.deepStrictEqual(calls.pop(), {patches: [{
      action: 'mark', path: ['text'], marks: [{name: 'bold', value: true, start: 0, end: 3}]
    }], source: 'change'})
    doc = Automerge.change(doc, {time: 0, patchCallback: callback}, draft => {
      Automerge.unmark(draft, ['text'], {start: 1, end: 3}, 'bold')
    })
    assert.deepStrictEqual(calls.pop(), {patches: [{
      action: 'mark', path: ['text'], marks: [{name: 'bold', value: null, start: 1, end: 3}]
    }], source: 'change'})

    let blockDoc = Automerge.from({text: 'abc'}, {actor, time: 0})
    blockDoc = Automerge.change(blockDoc, {time: 0}, draft => {
      Automerge.splitBlock(draft, ['text'], 1, {type: 'paragraph', level: 1})
    })
    Automerge.change(blockDoc, {time: 0, patchCallback: callback}, draft => {
      Automerge.updateBlock(draft, ['text'], 1, {type: 'heading', level: 2})
    })
    assert.deepStrictEqual(calls.pop(), {patches: [
      {action: 'del', path: ['text', 1]},
      {action: 'insert', path: ['text', 1], values: [{}]},
      {action: 'put', path: ['text', 1, 'type'], value: ''},
      {action: 'put', path: ['text', 1, 'level'], value: 2},
      {action: 'splice', path: ['text', 1, 'type', 0], value: 'heading'}
    ], source: 'change'})

    const loaded = []
    Automerge.load(Automerge.save(doc), {patchCallback: (patches, info) => loaded.push({patches, source: info.source})})
    assert.deepStrictEqual(loaded, [{patches: [
      {action: 'put', path: ['text'], value: ''},
      {action: 'splice', path: ['text', 0], value: 'a', marks: {bold: true}},
      {action: 'splice', path: ['text', 1], value: 'bc'}
    ], source: 'loadIncremental'}])
  })

  it('uses exact transport callback patches and sources', () => {
    const actor = '11111111111111111111111111111111'
    const peer = '22222222222222222222222222222222'
    const expected = [
      {action: 'put', path: ['list'], value: []},
      {action: 'put', path: ['value'], value: 1},
      {action: 'insert', path: ['list', 0], values: [2]}
    ]
    function seed() { return Automerge.from({value: 1, list: [2]}, {actor, time: 0}) }
    function callback(calls) {
      return (patches, info) => calls.push({patches, source: info.source})
    }

    let calls = [], source = seed()
    Automerge.load(Automerge.save(source), {patchCallback: callback(calls)})
    assert.deepStrictEqual(calls, [{patches: expected, source: 'loadIncremental'}])

    calls = []
    source = seed()
    Automerge.applyChanges(Automerge.init({actor: peer}), Automerge.getAllChanges(source), {patchCallback: callback(calls)})
    assert.deepStrictEqual(calls, [{patches: expected, source: 'applyChanges'}])

    calls = []
    source = seed()
    Automerge.merge(Automerge.init({actor: peer, patchCallback: callback(calls)}), source)
    assert.deepStrictEqual(calls, [{patches: expected, source: 'merge'}])

    calls = []
    source = seed()
    let target = Automerge.init({actor: peer})
    let sourceState = Automerge.initSyncState(), targetState = Automerge.initSyncState(), message
    for (let round = 0; round < 5 && Automerge.getHeads(target).join() !== Automerge.getHeads(source).join(); round++) {
      let generated = Automerge.generateSyncMessage(source, sourceState)
      sourceState = generated[0]
      message = generated[1]
      if (message) [target, targetState] = Automerge.receiveSyncMessage(target, targetState, message, {patchCallback: callback(calls)})
      generated = Automerge.generateSyncMessage(target, targetState)
      targetState = generated[0]
      message = generated[1]
      if (message) [source, sourceState] = Automerge.receiveSyncMessage(source, sourceState, message)
    }
    assert.deepStrictEqual(calls, [{patches: expected, source: 'receiveSyncMessage'}])

    const base = Automerge.from({value: 0}, {actor, time: 0})
    calls = []
    let low = Automerge.clone(base, {actor: peer, patchCallback: callback(calls)})
    let high = Automerge.clone(base, {actor: '33333333333333333333333333333333'})
    low = Automerge.change(low, {time: 0}, draft => { draft.value = 1 })
    high = Automerge.change(high, {time: 0}, draft => { draft.value = 2 })
    calls.length = 0
    Automerge.merge(low, high)
    assert.deepStrictEqual(calls, [{patches: [
      {action: 'put', path: ['value'], value: 2, conflict: true}
    ], source: 'merge'}])
  })

  it('normalizes encoded changes like 3.2', () => {
    const decoded = Automerge.decodeChange(Automerge.encodeChange({
      actor: 'aaaa', seq: 1, startOp: 1, time: 0, deps: [],
      ops: [{action: 'set', obj: '_root', key: 'x', insert: false, value: 3, pred: []}]
    }))
    assert.deepStrictEqual(decoded, {
      actor: 'aaaa',
      hash: 'd581e3b402ec3dfc14aafdece9de797976737f17ec18add749fe17c3cde6bc3e',
      seq: 1,
      startOp: 1,
      time: 0,
      message: null,
      deps: [],
      ops: [{action: 'set', obj: '_root', key: 'x', datatype: 'uint', value: 3, pred: []}]
    })

    const increment = Automerge.decodeChange(Automerge.encodeChange({
      actor: 'aaaa', seq: 1, startOp: 1, time: 0, message: null, deps: [],
      ops: [{action: 'inc', obj: '_root', key: 'x', datatype: 'uint', value: 3, pred: ['1@aaaa']}]
    }))
    assert.deepStrictEqual(increment.ops, [
      {action: 'inc', obj: '_root', key: 'x', value: 3, pred: ['1@aaaa']}
    ])
    assert.strictEqual(increment.hash, '8c38c58a85ee128866f89785f89138288249db16b24baec42a7b27b25f3712fc')
  })

  it('rejects classic multi-op shorthands like 3.2', () => {
    const change = {actor: 'aaaa', seq: 1, startOp: 1, time: 0, message: null, deps: []}
    const cases = [
      ['values', {action: 'set', obj: '_root', elemId: '_head', insert: true, values: ['a', 'b'], pred: []}],
      ['multiOp', {action: 'del', obj: '_root', elemId: '1@aaaa', multiOp: 2, pred: ['1@aaaa']}]
    ]
    for (const [field, op] of cases) {
      assert.throws(() => { Automerge.encodeChange(Object.assign({}, change, {ops: [op]})) }, error => {
        assert(error instanceof RangeError)
        assert.strictEqual(error.message, `Unable to read JS change: unknown field \`${field}\`, expected one of ` +
          '`ops`, `deps`, `message`, `seq`, `actor`, `requestType`')
        return true
      })
    }
    assert.doesNotThrow(() => {
      Automerge.encodeChange(Object.assign({}, change, {ops: [{
        action: 'set', obj: '_root', key: 'x', value: 1, values: undefined, multiOp: undefined, pred: []
      }]}))
    })
  })

  it('decodes bytes like 3.2 without changing byte-valued marks', () => {
    const bytes = Automerge.decodeChange(Automerge.encodeChange({
      actor: 'aaaa', seq: 1, startOp: 1, time: 0, deps: [],
      ops: [{action: 'set', obj: '_root', key: 'x', value: new Uint8Array([1, 2, 255]), pred: []}]
    }))
    assert.deepStrictEqual(bytes, {
      actor: 'aaaa',
      hash: '8bc48bb7b9201cbe31e03cd7db01c4f3c3d317cbc956c1f76854ac122e83e7ea',
      seq: 1,
      startOp: 1,
      time: 0,
      message: null,
      deps: [],
      ops: [{action: 'set', obj: '_root', key: 'x', value: [1, 2, 255], pred: []}]
    })

    let doc = Automerge.from({text: 'a'})
    doc = Automerge.change(doc, draft => {
      Automerge.mark(draft, ['text'], {start: 0, end: 1}, 'data', new Uint8Array([1, 2]))
    })
    assert.deepStrictEqual(Automerge.decodeChange(Automerge.getLastLocalChange(doc)).ops.slice(-2), [
      {action: 'markBegin', obj: Automerge.getObjectId(doc, 'text'), elemId: '_head', insert: true,
        name: 'data', value: [1, 2], expand: false, pred: []},
      {action: 'markEnd', obj: Automerge.getObjectId(doc, 'text'),
        elemId: Automerge.getCursor(doc, ['text'], 0), insert: true, expand: true, pred: []}
    ])
    assert.deepStrictEqual(Array.from(Automerge.marks(doc, ['text'])[0].value), [1, 2])
  })

  it('exposes modern diagnostics and predicates', () => {
    const doc = Automerge.from({count: new Automerge.Counter(1)})
    assert.strictEqual(Automerge.isCounter(doc.count), true)
    assert.strictEqual(Automerge.isCounter(1), false)
    assert.strictEqual(Automerge.dump(doc), undefined)
    assert.strictEqual(Automerge.use({}), undefined)
  })

  it('round-trips positional string cursors', () => {
    const doc = Automerge.from({title: 'a🙂b'})
    const cursor = Automerge.getCursor(doc, ['title'], 2, 'before')
    assert.strictEqual(Automerge.getCursorPosition(doc, ['title'], cursor), 1)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['title'], Automerge.getCursor(doc, ['title'], 'start')), 0)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['title'], Automerge.getCursor(doc, ['title'], 'end')), 4)
  })

  it('keeps cursors anchored across preceding edits', () => {
    let doc = Automerge.from({title: 'Hello'})
    const start = Automerge.getCursor(doc, ['title'], 0)
    const end = Automerge.getCursor(doc, ['title'], 5)
    doc = Automerge.change(doc, draft => { Automerge.splice(draft, ['title'], 0, 0, '>> ') })
    const from = Automerge.getCursorPosition(doc, ['title'], start)
    const to = Automerge.getCursorPosition(doc, ['title'], end)
    assert.strictEqual(doc.title.slice(from, to), 'Hello')
  })

  it('updates indexed deleted cursors after further changes and loads', () => {
    let doc = Automerge.from({text: 'abc'}, {actor: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})
    const before = Automerge.getCursor(doc, ['text'], 1, 'before')
    const after = Automerge.getCursor(doc, ['text'], 1, 'after')
    doc = Automerge.change(doc, draft => { Automerge.splice(draft, ['text'], 1, 1) })
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], before), 0)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], after), 1)

    doc = Automerge.change(doc, draft => { Automerge.splice(draft, ['text'], 0, 0, 'X') })
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], before), 1)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], after), 2)

    doc = Automerge.load(Automerge.save(doc))
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], before), 1)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], after), 2)
  })

  it('indexes deleted cursors around concurrent insertions', () => {
    const base = Automerge.from({text: 'abc'}, {actor: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})
    const before = Automerge.getCursor(base, ['text'], 1, 'before')
    const after = Automerge.getCursor(base, ['text'], 1, 'after')
    let left = Automerge.clone(base, {actor: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'})
    let right = Automerge.clone(base, {actor: 'cccccccccccccccccccccccccccccccc'})
    left = Automerge.change(left, draft => { Automerge.splice(draft, ['text'], 1, 1) })
    right = Automerge.change(right, draft => { Automerge.splice(draft, ['text'], 1, 0, 'X') })
    const docs = [
      Automerge.merge(Automerge.clone(left, {actor: 'dddddddddddddddddddddddddddddddd'}), right),
      Automerge.merge(Automerge.clone(right, {actor: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'}), left)
    ]
    for (const doc of docs) {
      assert.strictEqual(doc.text, 'aXc')
      assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], before), 0)
      assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], after), 2)
    }
  })

  it('indexes marked text cursors with surrogate-pair offsets', () => {
    let doc = Automerge.from({text: '🙂ab'}, {actor: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})
    const before = Automerge.getCursor(doc, ['text'], 2, 'before')
    const after = Automerge.getCursor(doc, ['text'], 2, 'after')
    doc = Automerge.change(doc, draft => {
      Automerge.mark(draft, ['text'], {start: 0, end: 4, expand: 'both'}, 'bold', true)
    })
    doc = Automerge.change(doc, draft => { Automerge.splice(draft, ['text'], 2, 1) })
    assert.deepStrictEqual(Automerge.marks(doc, ['text']), [
      {name: 'bold', value: true, start: 0, end: 3}
    ])
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], before), 0)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], after), 2)
  })

  it('indexes cursors anchored to deleted block markers', () => {
    let doc = Automerge.from({text: 'abc'},
      {actor: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'})
    doc = Automerge.change(doc, draft => {
      Automerge.splitBlock(draft, ['text'], 1, {type: 'paragraph'})
    })
    const before = Automerge.getCursor(doc, ['text'], 1, 'before')
    const after = Automerge.getCursor(doc, ['text'], 1, 'after')
    doc = Automerge.change(doc, draft => { Automerge.joinBlock(draft, ['text'], 1) })
    doc = Automerge.load(Automerge.save(doc))
    assert.deepStrictEqual(Automerge.spans(doc, ['text']), [{type: 'text', value: 'abc'}])
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], before), 0)
    assert.strictEqual(Automerge.getCursorPosition(doc, ['text'], after), 1)
  })

  it('round-trips incremental data and sync data', () => {
    let source = Automerge.from({value: 1})
    const incremental = Automerge.saveIncremental(source)
    assert.strictEqual(Automerge.saveIncremental(source).byteLength, 0)
    let target = Automerge.init()
    target = Automerge.loadIncremental(target, incremental)
    assert.deepStrictEqual(target, {value: 1})

    let syncState = Automerge.initSyncState()
    const encodedState = Automerge.encodeSyncState(syncState)
    syncState = Automerge.decodeSyncState(encodedState)
    let message
    ;[syncState, message] = Automerge.generateSyncMessage(source, syncState)
    assert(message instanceof Uint8Array)
    const decodedMessage = Automerge.decodeSyncMessage(message)
    assert.deepStrictEqual(Automerge.decodeSyncMessage(Automerge.encodeSyncMessage(decodedMessage)), decodedMessage)
  })

  it('keeps read-only sync states from applying incoming changes', () => {
    let source = Automerge.from({value: 1})
    let sourceState = Automerge.initSyncState(), message
    ;[sourceState, message] = Automerge.generateSyncMessage(source, sourceState)
    let target = Automerge.init(), targetState = Automerge.initSyncState({readOnly: true})
    ;[target, targetState] = Automerge.receiveSyncMessage(target, targetState, message)
    ;[targetState, message] = Automerge.generateSyncMessage(target, targetState)
    ;[source, sourceState] = Automerge.receiveSyncMessage(source, sourceState, message)
    ;[sourceState, message] = Automerge.generateSyncMessage(source, sourceState)
    assert.strictEqual(message, null)
    assert.deepStrictEqual(target, {})
    assert.strictEqual(targetState.readOnly, true)
    assert.strictEqual(sourceState.peerReadOnly, true)
  })

  it('encodes modern sync capabilities', () => {
    const doc = Automerge.init('11111111111111111111111111111111')
    let state = Automerge.initSyncState(), message
    ;[state, message] = Automerge.generateSyncMessage(doc, state)
    assert.strictEqual(Array.from(message, byte => byte.toString(16).padStart(2, '0')).join(''),
      '42000001000000020284')
    assert.deepStrictEqual(Automerge.decodeSyncMessage(message).supportedCapabilities,
      ['supports-sync-reset'])

    state = Automerge.initSyncState({readOnly: true})
    ;[state, message] = Automerge.generateSyncMessage(doc, state)
    assert.strictEqual(Array.from(message, byte => byte.toString(16).padStart(2, '0')).join(''),
      '42000001000000020286')
    assert.deepStrictEqual(Automerge.decodeSyncMessage(message).supportedCapabilities,
      ['read-only', 'supports-sync-reset'])
  })

  it('exposes history inspection and statistics', () => {
    const doc = Automerge.from({value: 1}, {actor: 'aabb'})
    const traversal = Automerge.topoHistoryTraversal(doc)
    const inspected = Automerge.inspectChange(doc, traversal[0])
    const statistics = Automerge.stats(doc)
    assert.strictEqual(inspected.hash, traversal[0])
    assert.strictEqual(statistics.numChanges, 1)
    assert.strictEqual(statistics.numActors, 1)
    assert.strictEqual(Automerge.inspectChange(doc, '00'.repeat(32)), null)
  })

  it('saves and reads bundles', () => {
    let doc = Automerge.from({value: 1}, {actor: 'aabb'})
    doc = Automerge.change(doc, draft => { draft.value = 2 })
    const hashes = Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change).hash)

    const bundle = Automerge.saveBundle(doc, [hashes[1]])
    const decodedBundle = Automerge.readBundle(bundle)
    assert.deepStrictEqual(decodedBundle.changes.map(change => change.hash), [hashes[1]])
    assert.deepStrictEqual(decodedBundle.deps, [hashes[0]])
    assert(Automerge.getBackend(doc))
    assert.strictEqual(Automerge.hasOurChanges(doc, {sharedHeads: Automerge.getHeads(doc)}), true)
  })

  it('exposes immutable string predicates and initialized wasm state', () => {
    const value = new Automerge.ImmutableString('value')
    assert.strictEqual(Automerge.isImmutableString(value), true)
    assert.strictEqual(Automerge.isRawString(new Automerge.RawString('raw')), true)
    assert.strictEqual(value.toString(), 'value')
    let doc = Automerge.from({list: []})
    doc = Automerge.change(doc, draft => {
      draft.root = value
      draft.list.insertAt(0, new Automerge.RawString('listed'))
    })
    assert.deepStrictEqual(doc, {
      list: [new Automerge.ImmutableString('listed')],
      root: new Automerge.ImmutableString('value')
    })
    assert.strictEqual(Automerge.isWasmInitialized(), true)
    return Automerge.initializeWasm()
      .then(() => Automerge.initializeBase64Wasm())
      .then(() => Automerge.wasmInitialized())
  })

  it('reads and changes rich text blocks and spans', () => {
    let doc = Automerge.from({text: 'abc'})
    doc = Automerge.change(doc, draft => {
      Automerge.splitBlock(draft, ['text'], 1, {type: 'paragraph', level: 1})
    })
    assert.deepStrictEqual(Automerge.block(doc, ['text'], 1), {level: 1, type: 'paragraph'})
    assert.deepStrictEqual(Automerge.spans(doc, ['text']), [
      {type: 'text', value: 'a'},
      {type: 'block', value: {level: 1, type: 'paragraph'}},
      {type: 'text', value: 'bc'}
    ])
    doc = Automerge.change(doc, draft => {
      Automerge.updateBlock(draft, ['text'], 1, {type: 'heading', level: 2})
    })
    assert.deepStrictEqual(Automerge.block(doc, ['text'], 1), {level: 2, type: 'heading'})
    doc = Automerge.change(doc, draft => {
      Automerge.joinBlock(draft, ['text'], 1)
      Automerge.updateSpans(draft, ['text'], [
        {type: 'text', value: 'hi', marks: {bold: true}},
        {type: 'block', value: {type: 'paragraph'}},
        {type: 'text', value: 'there'}
      ])
    })
    assert.deepStrictEqual(Automerge.spans(doc, ['text']), [
      {type: 'text', value: 'hi', marks: {bold: true}},
      {type: 'block', value: {type: 'paragraph'}},
      {type: 'text', value: 'there'}
    ])
  })
})
