import assert from 'node:assert'
import Automerge from './subject.js'

describe('patches', () => {
  describe('the patchCallback', () => {
    it('gives access to the before and after states', () => {
      const doc = Automerge.init()
      const headsBefore = Automerge.getHeads(doc)
      let headsAfter
      const newDoc = Automerge.change(doc, {
        patchCallback: (patches, info) => {
          assert.deepStrictEqual(Automerge.getHeads(info.before), headsBefore)
          headsAfter = Automerge.getHeads(info.after)
        }
      }, d => { d.count = 1 })
      assert.deepStrictEqual(headsAfter, Automerge.getHeads(newDoc))
    })

    it('gives correct states when a list value is deleted', () => {
      const doc = Automerge.from({list: ['a', 'b', 'c']})
      const newDoc = Automerge.change(doc, {
        patchCallback: (patches, info) => {
          assert.deepStrictEqual(Automerge.toJS(info.before).list, ['a', 'b', 'c'])
          assert.deepStrictEqual(Automerge.toJS(info.after).list, ['a', 'c'])
        }
      }, d => { Automerge.deleteAt(d.list, 1) })
      assert.deepStrictEqual(Automerge.toJS(newDoc), {list: ['a', 'c']})
    })

    it('gives correct states when a map property is removed', () => {
      const doc = Automerge.from({obj: {a: 'a', b: 'b'}})
      const newDoc = Automerge.change(doc, {
        patchCallback: (patches, info) => {
          assert.deepStrictEqual(Automerge.toJS(info.before).obj, {a: 'a', b: 'b'})
          assert.deepStrictEqual(Automerge.toJS(info.after).obj, {a: 'a'})
        }
      }, d => { delete d.obj.b })
      assert.deepStrictEqual(Automerge.toJS(newDoc), {obj: {a: 'a'}})
    })
  })

  describe('diff()', () => {
    it('returns a set of patches', () => {
      const doc = Automerge.from({birds: ['goldfinch']})
      const before = Automerge.getHeads(doc)
      const newDoc = Automerge.change(doc, d => {
        d.birds.push('greenfinch')
        d.fish = ['cod']
      })
      const after = Automerge.getHeads(newDoc)
      assert.deepStrictEqual(Automerge.diff(newDoc, before, after), [
        {action: 'put', path: ['fish'], value: []},
        {action: 'insert', path: ['birds', 1], values: ['']},
        {action: 'splice', path: ['birds', 1, 0], value: 'greenfinch'},
        {action: 'insert', path: ['fish', 0], values: ['']},
        {action: 'splice', path: ['fish', 0, 0], value: 'cod'}
      ])
    })

    it('rejects heads that are not arrays', () => {
      let doc = Automerge.from({text: 'hello world'})
      const goodBefore = Automerge.getHeads(doc)
      doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], 0, 0, 'hello ') })
      const goodAfter = Automerge.getHeads(doc)
      assert.throws(() => Automerge.diff(doc, null, goodAfter), /before must be an array/)
      assert.throws(() => Automerge.diff(doc, goodBefore, null), /after must be an array/)
    })

    it('diffs the reverse of deleting a string value', () => {
      const doc = Automerge.from({list: ['a', 'b', 'c']})
      Automerge.change(doc, {
        patchCallback: (patches, info) => {
          const reverse = Automerge.diff(info.after,
            Automerge.getHeads(info.after), Automerge.getHeads(info.before))
          assert.deepStrictEqual(reverse, [
            {action: 'insert', path: ['list', 1], values: ['']},
            {action: 'splice', path: ['list', 1, 0], value: 'b'}
          ])
        }
      }, d => { Automerge.deleteAt(d.list, 1) })
    })
  })

  it('produces correct patches during changeAt', () => {
    // Regression test for automerge#951: changeAt emitted patches for objects
    // that are not visible in the final state, garbling the content.
    let doc = Automerge.init()
    const beginning = Automerge.getHeads(doc)
    doc = Automerge.change(doc, d => { d.name = 'a'.repeat(100) })
    doc = Automerge.changeAt(doc, beginning, d => { d.color = 'red' }).newDoc
    doc = Automerge.changeAt(doc, beginning, d => { d.color = 'unset' }).newDoc
    assert.strictEqual(Automerge.toJS(doc).color, 'unset')
  })

  describe('applyPatches() on an Automerge document', () => {
    function applied(initial, patch) {
      const doc = Automerge.from(initial)
      return Automerge.toJS(Automerge.change(doc, d => Automerge.applyPatches(d, [patch])))
    }

    it('applies a map update', () => {
      assert.strictEqual(applied({foo: {bar: 'baz'}},
        {action: 'put', path: ['foo', 'bar'], value: 'qux'}).foo.bar, 'qux')
    })

    it('applies a list update', () => {
      assert.strictEqual(applied({foo: ['bar']},
        {action: 'put', path: ['foo', 0], value: 'baz'}).foo[0], 'baz')
    })

    it('applies a list insertion', () => {
      assert.deepStrictEqual(applied({foo: ['bar']},
        {action: 'insert', path: ['foo', 1], values: ['baz', 'qux']}).foo, ['bar', 'baz', 'qux'])
    })

    it('applies a list deletion without a length', () => {
      assert.deepStrictEqual(applied({foo: ['bar', 'baz', 'qux']},
        {action: 'del', path: ['foo', 1]}).foo, ['bar', 'qux'])
    })

    it('applies a list deletion with a length', () => {
      assert.deepStrictEqual(applied({foo: ['bar', 'baz', 'qux']},
        {action: 'del', path: ['foo', 0], length: 2}).foo, ['qux'])
    })

    it('applies a text splice', () => {
      assert.strictEqual(applied({foo: 'bar'},
        {action: 'splice', path: ['foo', 3], value: 'baz'}).foo, 'barbaz')
    })

    it('applies a text deletion without a length', () => {
      assert.strictEqual(applied({foo: 'bar'}, {action: 'del', path: ['foo', 0]}).foo, 'ar')
    })

    it('applies a text deletion with a length', () => {
      assert.strictEqual(applied({foo: 'bar'}, {action: 'del', path: ['foo', 0], length: 2}).foo, 'r')
    })

    it('applies an increment', () => {
      assert.strictEqual(applied({foo: new Automerge.Counter(1)},
        {action: 'inc', path: ['foo'], value: 2}).foo.value, 3)
    })

    it('applies a mark patch', () => {
      let doc = Automerge.from({foo: 'bar'})
      doc = Automerge.change(doc, d => Automerge.applyPatches(d, [
        {action: 'mark', path: ['foo'], marks: [{name: 'bold', value: true, start: 0, end: 2}]}
      ]))
      assert.deepStrictEqual(Automerge.marks(doc, ['foo']),
        [{name: 'bold', value: true, start: 0, end: 2}])
    })

    it('applies an unmark patch', () => {
      let doc = Automerge.from({foo: 'bar'})
      doc = Automerge.change(doc, d => {
        Automerge.mark(d, ['foo'], {start: 0, end: 2, expand: 'none'}, 'bold', true)
      })
      doc = Automerge.change(doc, d => Automerge.applyPatches(d, [
        {action: 'unmark', path: ['foo'], name: 'bold', start: 0, end: 2}
      ]))
      assert.deepStrictEqual(Automerge.marks(doc, ['foo']), [])
    })

    it('applies a map update deep inside lists and maps', () => {
      const doc = Automerge.from({foo: [{bar: [{foo: 'hehe'}]}]})
      const updated = Automerge.change(doc, d => Automerge.applyPatches(d, [
        {action: 'put', path: ['foo', 0, 'bar', 0, 'foo'], value: 'qux'}
      ]))
      assert.strictEqual(Automerge.toJS(updated).foo[0].bar[0].foo, 'qux')
    })
  })

  describe('applyPatches() on a plain JavaScript value', () => {
    function applied(value, patch) {
      Automerge.applyPatches(value, [patch])
      return value
    }

    it('applies a map update to a nested map', () => {
      assert.strictEqual(applied({foo: {bar: 'baz'}},
        {action: 'put', path: ['foo', 'bar'], value: 'qux'}).foo.bar, 'qux')
    })

    it('applies a list update', () => {
      assert.strictEqual(applied({foo: ['bar']},
        {action: 'put', path: ['foo', 0], value: 'baz'}).foo[0], 'baz')
    })

    it('applies a list insertion', () => {
      assert.deepStrictEqual(applied({foo: ['bar']},
        {action: 'insert', path: ['foo', 1], values: ['baz', 'qux']}).foo, ['bar', 'baz', 'qux'])
    })

    it('applies a list deletion without a length', () => {
      assert.deepStrictEqual(applied({foo: ['bar', 'baz', 'qux']},
        {action: 'del', path: ['foo', 1]}).foo, ['bar', 'qux'])
    })

    it('applies a list deletion with a length', () => {
      assert.deepStrictEqual(applied({foo: ['bar', 'baz', 'qux']},
        {action: 'del', path: ['foo', 0], length: 2}).foo, ['qux'])
    })

    it('applies a text splice', () => {
      assert.strictEqual(applied({foo: 'bar'},
        {action: 'splice', path: ['foo', 3], value: 'baz'}).foo, 'barbaz')
    })

    it('applies a text deletion without a length', () => {
      assert.strictEqual(applied({foo: 'bar'}, {action: 'del', path: ['foo', 0]}).foo, 'ar')
    })

    it('applies an increment', () => {
      assert.strictEqual(applied({foo: 1}, {action: 'inc', path: ['foo'], value: 2}).foo, 3)
    })

    it('ignores mark and unmark patches', () => {
      const value = {foo: 'bar'}
      Automerge.applyPatches(value, [
        {action: 'mark', path: ['foo'], marks: [{name: 'bold', value: true, start: 0, end: 2}]},
        {action: 'unmark', path: ['foo'], name: 'bold', start: 0, end: 2}
      ])
      assert.deepStrictEqual(value, {foo: 'bar'})
    })
  })
})

describe('changeAt', () => {
  it('changes a document at a prior state', () => {
    let doc = Automerge.init()
    doc = Automerge.change(doc, d => { d.text = 'aaabbbccc' })
    const heads = Automerge.getHeads(doc)
    doc = Automerge.change(doc, d => { Automerge.splice(d, ['text'], 3, 3, 'BBB') })
    assert.strictEqual(doc.text, 'aaaBBBccc')
    doc = Automerge.changeAt(doc, heads, d => {
      assert.strictEqual(d.text, 'aaabbbccc')
      Automerge.splice(d, ['text'], 2, 3, 'XXX')
      assert.strictEqual(d.text, 'aaXXXbccc')
    }).newDoc
    assert.strictEqual(doc.text, 'aaXXXBBBccc')
  })

  it('leaves multiple heads intact on an empty change', () => {
    let doc1 = Automerge.init()
    doc1 = Automerge.change(doc1, d => { d.text = 'aaabbbccc' })
    const headsBeforeFork = Automerge.getHeads(doc1)
    let doc2 = Automerge.clone(doc1)
    doc2 = Automerge.change(doc2, d => { d.doc2 = 'doc2' })
    doc1 = Automerge.change(doc1, d => { d.doc1 = 'doc1' })
    doc1 = Automerge.merge(doc1, doc2)
    assert.strictEqual(Automerge.getHeads(doc1).length, 2)
    doc1 = Automerge.changeAt(doc1, headsBeforeFork, () => {}).newDoc
    assert.strictEqual(Automerge.getHeads(doc1).length, 2)
  })

  it('returns the heads of the change it made', () => {
    let doc1 = Automerge.init()
    doc1 = Automerge.change(doc1, d => { d.text = 'aaabbbccc' })
    let doc2 = Automerge.clone(doc1)
    doc2 = Automerge.change(doc2, d => { d.doc2 = 'doc2' })
    const headsOnFork = Automerge.getHeads(doc2)
    doc1 = Automerge.change(doc1, d => { d.doc1 = 'doc1' })
    const doc1Heads = Automerge.getHeads(doc1)
    doc1 = Automerge.merge(doc1, doc2)
    const {newDoc, newHeads} = Automerge.changeAt(doc1, doc1Heads, d => { d.text = 'changed' })
    assert.deepStrictEqual(new Set(Automerge.getHeads(newDoc)), new Set([...headsOnFork, ...newHeads]))
  })
})

describe('change timestamps', () => {
  function lastTime(doc) {
    return Automerge.decodeChange(Automerge.getLastLocalChange(doc)).time
  }

  it('defaults to the current timestamp', () => {
    const time = Math.floor(Date.now() / 1000)
    const doc = Automerge.change(Automerge.init(), d => { d.answer = 42 })
    assert.ok(Math.abs(lastTime(doc) - time) <= 1)
  })

  it('allows a user provided timestamp', () => {
    const doc = Automerge.change(Automerge.init(), {time: 12345}, d => { d.answer = 42 })
    assert.strictEqual(lastTime(doc), 12345)
  })

  it('allows no timestamp', () => {
    const doc = Automerge.change(Automerge.init(), {time: undefined}, d => { d.answer = 42 })
    assert.strictEqual(lastTime(doc), 0)
  })

  it('stamps empty changes too', () => {
    assert.strictEqual(lastTime(Automerge.emptyChange(Automerge.init(), {time: 12345})), 12345)
    assert.strictEqual(lastTime(Automerge.emptyChange(Automerge.init(), {time: undefined})), 0)
    const time = Math.floor(Date.now() / 1000)
    assert.ok(Math.abs(lastTime(Automerge.emptyChange(Automerge.init())) - time) <= 1)
  })
})

describe('conflicts', () => {
  it('does not return writable proxies outside of a change callback', () => {
    let doc = Automerge.from({user: {name: 'alice'}})
    let doc2 = Automerge.clone(doc)
    doc = Automerge.change(doc, d => { d.user = {name: 'bob'} })
    doc2 = Automerge.change(doc2, d => { d.user = {name: 'charlie'} })
    doc = Automerge.merge(doc, doc2)

    for (const value of Object.values(Automerge.getConflicts(doc, 'user'))) {
      if (Reflect.get(value, 'name') === 'bob') {
        try { Reflect.set(value, 'name', 'Attila') } catch { /* expected */ }
      }
    }

    const names = Object.values(Automerge.getConflicts(doc, 'user')).map(value => Reflect.get(value, 'name'))
    assert.deepStrictEqual(new Set(names), new Set(['charlie', 'bob']))
  })

  it('updates values inside a conflicted map', () => {
    let doc = Automerge.from({user: {}})
    let doc2 = Automerge.clone(doc)
    let doc3 = Automerge.clone(doc)
    doc2 = Automerge.change(doc2, d => { d.user = {name: 'alice'} })
    doc3 = Automerge.change(doc3, d => { d.user = {name: 'charlie'} })
    doc = Automerge.change(doc, d => { d.user = {name: 'bob'} })
    doc = Automerge.merge(doc, doc2)
    doc = Automerge.merge(doc, doc3)

    assert.deepStrictEqual(Automerge.getConflicts(doc, 'user'), {
      [`2@${Automerge.getActorId(doc)}`]: {name: 'bob'},
      [`2@${Automerge.getActorId(doc2)}`]: {name: 'alice'},
      [`2@${Automerge.getActorId(doc3)}`]: {name: 'charlie'}
    })

    doc = Automerge.change(doc, d => {
      for (const conflict of Object.values(Automerge.getConflicts(d, 'user'))) conflict.name = 'Attila'
    })

    assert.deepStrictEqual(Automerge.getConflicts(doc, 'user'), {
      [`2@${Automerge.getActorId(doc)}`]: {name: 'Attila'},
      [`2@${Automerge.getActorId(doc2)}`]: {name: 'Attila'},
      [`2@${Automerge.getActorId(doc3)}`]: {name: 'Attila'}
    })
  })

  it('updates values inside a conflicted list element', () => {
    let doc = Automerge.from({users: [{name: 'ignored'}]})
    let doc2 = Automerge.clone(doc)
    let doc3 = Automerge.clone(doc)
    doc2 = Automerge.change(doc2, d => { d.users[0] = {name: 'alice'} })
    doc3 = Automerge.change(doc3, d => { d.users[0] = {name: 'charlie'} })
    doc = Automerge.change(doc, d => { d.users[0] = {name: 'bob'} })
    doc = Automerge.merge(doc, doc2)
    doc = Automerge.merge(doc, doc3)

    const names = Object.values(Automerge.getConflicts(doc.users, 0)).map(value => value.name)
    assert.deepStrictEqual(new Set(names), new Set(['bob', 'alice', 'charlie']))

    doc = Automerge.change(doc, d => {
      for (const conflict of Object.values(Automerge.getConflicts(d.users, 0))) conflict.name = 'Attila'
    })

    assert.deepStrictEqual(new Set(Object.values(Automerge.getConflicts(doc.users, 0)).map(value => value.name)),
      new Set(['Attila']))
  })
})
