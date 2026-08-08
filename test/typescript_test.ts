import * as assert from 'node:assert'
import * as Automerge from '..'
import { Counter, Doc } from '..'

const UUID_PATTERN = /^[0-9a-f]{32}$/

interface BirdList {
  birds: string[]
}

interface NumberBox {
  number: number
}

describe('TypeScript support', () => {
  describe('Automerge.init()', () => {
    it('should allow a document to be `any`', () => {
      let s1 = Automerge.init<any>()
      s1 = Automerge.change(s1, doc => (doc.key = 'value'))
      assert.strictEqual(s1.key, 'value')
      assert.strictEqual(s1.nonexistent, undefined)
      assert.deepStrictEqual(s1, { key: 'value' })
    })

    it('should allow a document type to be specified as a parameter to `init`', () => {
      let s1 = Automerge.init<BirdList>()

      // Note: Technically, `s1` is not really a `BirdList` yet but just an empty object.
      assert.equal(s1.hasOwnProperty('birds'), false)

      // Since we're pulling the wool over TypeScript's eyes, it can't give us compile-time protection
      // from something like this:
      // assert.equal(s1.birds.length, 0) // Runtime error: Cannot read property 'length' of undefined

      // Nevertheless this way seems more ergonomical (than having `init` return a type of `{}` or
      // `Partial<T>`, for example) because it allows us to have a single type for the object
      // throughout its life, rather than having to recast it once its required fields have
      // been populated.
      s1 = Automerge.change(s1, doc => (doc.birds = ['goldfinch']))
      assert.deepStrictEqual(s1.birds, ['goldfinch'])
    })

    it('should allow a document type to be specified on the result of `init`', () => {
      // This is equivalent to passing the type parameter to `init`; note that the result is a
      // `Doc`, which is frozen
      let s1: Doc<BirdList> = Automerge.init()
      let s2 = Automerge.change(s1, doc => (doc.birds = ['goldfinch']))
      assert.deepStrictEqual(s2.birds, ['goldfinch'])
    })

    it('should allow a document to be initialized with `from`', () => {
      const s1 = Automerge.from<BirdList>({ birds: [] })
      assert.strictEqual(s1.birds.length, 0)
      const s2 = Automerge.change(s1, doc => doc.birds.push('magpie'))
      assert.strictEqual(s2.birds[0], 'magpie')
    })

    it('should allow passing options when initializing with `from`', () => {
      const actorId = '1234'
      const s1 = Automerge.from<BirdList>({ birds: [] }, actorId)
      assert.strictEqual(Automerge.getActorId(s1), '1234')
      const s2 = Automerge.from<BirdList>({ birds: [] }, { actorId })
      assert.strictEqual(Automerge.getActorId(s2), '1234')
    })

    it('should allow the actorId to be configured', () => {
      let s1 = Automerge.init<BirdList>('111111')
      assert.strictEqual(Automerge.getActorId(s1), '111111')
      let s2 = Automerge.init<BirdList>()
      assert.strictEqual(UUID_PATTERN.test(Automerge.getActorId(s2)), true)
    })

    it('should allow the freeze option to be passed in', () => {
      let s1 = Automerge.init<BirdList>({ freeze: true })
      let s2 = Automerge.change(s1, doc => (doc.birds = []))
      assert.strictEqual(Object.isFrozen(s2), true)
      assert.strictEqual(Object.isFrozen(s2.birds), true)
    })

    it('should allow the length of the array to be increased', () => {
      let s1: Doc<BirdList> = Automerge.from({ birds: []})
      let s2 = Automerge.change(s1, doc => doc.birds.length = 1)
      assert.deepStrictEqual(s2.birds, [null])
    })

    it('should allow the length of the array to be decreased', () => {
      let s1: Doc<BirdList> = Automerge.from({ birds: ['1234']})
      let s2 = Automerge.change(s1, doc => doc.birds.length = 0)
      assert.deepStrictEqual(s2.birds, [])
    })

    it('should throw error if length is invalid', () => {
      let s1: Doc<BirdList> = Automerge.from({ birds: ['1234']})
      assert.throws(() => Automerge.change(s1, doc => {
        doc.birds.length = undefined
      }), "array length")
      assert.throws(() => Automerge.change(s1, doc => {
        doc.birds.length = NaN
      }), "array length")
    })
  })

  describe('saving and loading', () => {
    it('should allow an `any` type document to be loaded', () => {
      let s1 = Automerge.init<any>()
      s1 = Automerge.change(s1, doc => (doc.key = 'value'))
      let s2: any = Automerge.load(Automerge.save(s1))
      assert.strictEqual(s2.key, 'value')
      assert.deepStrictEqual(s2, { key: 'value' })
    })

    it('should allow a document of declared type to be loaded', () => {
      let s1 = Automerge.init<BirdList>()
      s1 = Automerge.change(s1, doc => (doc.birds = ['goldfinch']))
      let s2 = Automerge.load<BirdList>(Automerge.save(s1))
      assert.strictEqual(s2.birds[0], 'goldfinch')
      assert.deepStrictEqual(s2, { birds: ['goldfinch'] })
      assert.strictEqual(UUID_PATTERN.test(Automerge.getActorId(s2)), true)
    })

    it('should allow the actorId to be configured', () => {
      let s1 = Automerge.init<BirdList>()
      s1 = Automerge.change(s1, doc => (doc.birds = ['goldfinch']))
      let s2 = Automerge.load<BirdList>(Automerge.save(s1), '111111')
      assert.strictEqual(Automerge.getActorId(s2), '111111')
    })

    it('should allow the freeze option to be passed in', () => {
      let s1 = Automerge.init<BirdList>()
      s1 = Automerge.change(s1, doc => (doc.birds = ['goldfinch']))
      let s2 = Automerge.load<BirdList>(Automerge.save(s1), { freeze: true })
      assert.strictEqual(Object.isFrozen(s2), true)
      assert.strictEqual(Object.isFrozen(s2.birds), true)
    })
  })

  describe('making changes', () => {
    it('should accept an optional message', () => {
      let s1 = Automerge.init<BirdList>()
      s1 = Automerge.change(s1, 'hello', doc => (doc.birds = []))
      assert.strictEqual(Automerge.getHistory(s1)[0].change.message, 'hello')
    })

    it('should support list modifications', () => {
      let s1: Doc<BirdList> = Automerge.init<BirdList>()
      s1 = Automerge.change(s1, doc => (doc.birds = ['goldfinch']))
      s1 = Automerge.change(s1, doc => {
        Automerge.insertAt(doc.birds, 1, 'greenfinch', 'bullfinch', 'chaffinch')
        Automerge.deleteAt(doc.birds, 0)
        Automerge.deleteAt(doc.birds, 0, 2)
      })
      assert.deepStrictEqual(s1, { birds: ['chaffinch'] })
    })

    it('should allow empty changes', () => {
      let s1 = Automerge.init()
      s1 = Automerge.emptyChange(s1, 'my message')
      assert.strictEqual(Automerge.getHistory(s1)[0].change.message, 'my message')
    })

    it('should allow inspection of conflicts', () => {
      let s1 = Automerge.init<NumberBox>('111111')
      s1 = Automerge.change(s1, doc => (doc.number = 3))
      let s2 = Automerge.init<NumberBox>('222222')
      s2 = Automerge.change(s2, doc => (doc.number = 42))
      let s3 = Automerge.merge(s1, s2)
      assert.strictEqual(s3.number, 42)
      assert.deepStrictEqual(
        Automerge.getConflicts(s3, 'number'),
        { '1@111111': 3, '1@222222': 42 })
    })

  })

  describe('getting and applying changes', () => {
    it('should return an array of change objects', () => {
      let s1 = Automerge.init<BirdList>()
      s1 = Automerge.change(s1, doc => (doc.birds = ['goldfinch']))
      let s2 = Automerge.change(s1, 'add chaffinch', doc => doc.birds.push('chaffinch'))
      const changes = Automerge.getChanges(s1, s2)
      assert.strictEqual(changes.length, 1)
      const change = Automerge.decodeChange(changes[0])
      assert.strictEqual(change.message, 'add chaffinch')
      assert.strictEqual(change.actor, Automerge.getActorId(s2))
      assert.strictEqual(change.seq, 2)
    })

    it('should include operations in changes', () => {
      let s1 = Automerge.init<NumberBox>()
      s1 = Automerge.change(s1, doc => (doc.number = 3))
      const changes = Automerge.getAllChanges(s1)
      assert.strictEqual(changes.length, 1)
      const change = Automerge.decodeChange(changes[0])
      assert.strictEqual(change.ops.length, 1)
      assert.strictEqual(change.ops[0].action, 'set')
      assert.strictEqual(change.ops[0].obj, '_root')
      assert.strictEqual(change.ops[0].key, 'number')
      assert.strictEqual(change.ops[0].value, 3)
    })

    it('should allow changes to be re-applied', () => {
      let s1 = Automerge.init<BirdList>()
      s1 = Automerge.change(s1, doc => (doc.birds = []))
      let s2 = Automerge.change(s1, doc => doc.birds.push('goldfinch'))
      const changes = Automerge.getAllChanges(s2)
      let [s3] = Automerge.applyChanges(Automerge.init<BirdList>(), changes)
      assert.deepStrictEqual(s3.birds, ['goldfinch'])
    })

    it('should allow concurrent changes to be merged', () => {
      let s1 = Automerge.init<BirdList>()
      s1 = Automerge.change(s1, doc => (doc.birds = ['goldfinch']))
      let s2 = Automerge.merge(Automerge.init<BirdList>(), s1)
      s1 = Automerge.change(s1, doc => doc.birds.unshift('greenfinch'))
      s2 = Automerge.change(s2, doc => doc.birds.push('chaffinch'))
      let s3 = Automerge.merge(s1, s2)
      assert.deepStrictEqual(s3.birds, ['greenfinch', 'goldfinch', 'chaffinch'])
    })
  })

  describe('history inspection', () => {
    it('should inspect document history', () => {
      const s0 = Automerge.init<NumberBox>()
      const s1 = Automerge.change(s0, 'one', doc => (doc.number = 1))
      const s2 = Automerge.change(s1, 'two', doc => (doc.number = 2))
      const history = Automerge.getHistory(s2)
      assert.strictEqual(history.length, 2)
      assert.strictEqual(history[0].change.message, 'one')
      assert.strictEqual(history[1].change.message, 'two')
      assert.strictEqual(history[0].snapshot.number, 1)
      assert.strictEqual(history[1].snapshot.number, 2)
    })
  })

  describe('Automerge.Counter', () => {
    interface CounterMap {
      [name: string]: Counter
    }

    interface CounterList {
      counts: Counter[]
    }

    interface BirdCounterMap {
      birds: CounterMap
    }

    it('should handle counters inside maps', () => {
      const doc1 = Automerge.change(Automerge.init<CounterMap>(), doc => {
        doc.wrens = new Counter()
      })
      assert.equal(doc1.wrens, 0)

      const doc2 = Automerge.change(doc1, doc => {
        doc.wrens.increment()
      })
      assert.equal(doc2.wrens, 1)
    })

    it('should handle counters inside lists', () => {
      const doc1 = Automerge.change(Automerge.init<CounterList>(), doc => {
        doc.counts = [new Counter(1)]
      })
      assert.equal(doc1.counts[0], 1)

      const doc2 = Automerge.change(doc1, doc => {
        doc.counts[0].increment(2)
      })
      assert.equal(doc2.counts[0].value, 3)
    })

    describe('counter as numeric primitive', () => {
      let doc1: CounterMap
      beforeEach(() => {
        doc1 = Automerge.change(Automerge.init<CounterMap>(), doc => {
          doc.birds = new Counter(3)
        })
      })

      it('is equal (==) but not strictly equal (===) to its numeric value', () => {
        assert.equal(doc1.birds, 3)
        assert.notStrictEqual(doc1.birds, 3)
      })

      it('has to be explicitly cast to be used as a number', () => {
        let birdCount: number

        // This is valid javascript, but without the `ts-ignore` flag, it fails to compile:
        // @ts-ignore
        birdCount = doc1.birds // Type 'Counter' is not assignable to type 'number'.ts(2322)

        // This is because TypeScript doesn't know about the `.valueOf()` trick.
        // https://github.com/Microsoft/TypeScript/issues/2361

        // If we want to treat a counter value as a number, we have to explicitly cast it to keep
        // TypeScript happy.

        // We can cast by putting a `+` in front of it:
        birdCount = +doc1.birds
        assert.equal(birdCount < 4, true)
        assert.equal(birdCount >= 0, true)

        // Or we can be explicit (have to cast as unknown, then number):
        birdCount = (doc1.birds as unknown) as number
        assert.equal(birdCount <= 2, false)
        assert.equal(birdCount + 10, 13)
      })

      it('is converted to a string using its numeric value', () => {
        assert.equal(doc1.birds.toString(), '3')
        assert.equal(`I saw ${doc1.birds} birds`, 'I saw 3 birds')
        assert.equal(['I saw', doc1.birds, 'birds'].join(' '), 'I saw 3 birds')
      })
    })
  })

})
