import assert from 'node:assert'
import { BooleanEncoder, DeltaEncoder, RLEEncoder } from '../backend/encoding.js'
import { append, clone, createColumn, decoder, get, loadColumn, range, save, splice, toBuffer } from '../backend/column_data.js'
function encode(type, values) {
  if (type === 'raw') return Uint8Array.from(values)
  let encoder
  if (type === 'int') encoder = new RLEEncoder('int')
  if (type === 'uint') encoder = new RLEEncoder('uint')
  if (type === 'string') encoder = new RLEEncoder('utf8')
  if (type === 'boolean') encoder = new BooleanEncoder()
  if (type === 'delta') encoder = new DeltaEncoder()
  for (let value of values) encoder.appendValue(value)
  return encoder.buffer
}

function bytes(buffer) {
  return Array.from(buffer)
}

function random(seed) {
  let state = seed >>> 0
  return function next(limit) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return limit === undefined ? state : state % limit
  }
}

function randomValue(type, next) {
  const choice = next(8)
  if (type !== 'boolean' && type !== 'raw' && choice === 0) return null
  if (type === 'boolean') return choice % 2 === 0
  if (type === 'raw') return next(256)
  if (type === 'string') return ['', 'a', 'b', 'λ', '🐟', `v${next(11)}`][choice % 6]
  if (type === 'uint') return next(20)
  return next(41) - 20
}

describe('Segmented compressed columns', () => {
  const examples = [
    ['int', [null, -5, -5, 0, 12, null, 99]],
    ['uint', [null, 0, 1, 1, 7, null, 100]],
    ['string', [null, '', 'alpha', 'alpha', 'λ', null, '🐟']],
    ['boolean', [false, false, true, false, true, true, false]],
    ['delta', [null, -3, -1, 0, 10, 10, null, 30]],
    ['raw', [0, 1, 127, 128, 254, 255, 0]]
  ]

  it('reads exact slab and range boundaries', () => {
    const input = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    const column = createColumn('uint', input, {slabRows: 4, slabBytes: 1000})
    assert.deepStrictEqual(column.slabs.map(slab => [slab.start, slab.rows]), [[0, 4], [4, 4], [8, 4]])
    assert.strictEqual(get(column, 0), 0)
    assert.strictEqual(get(column, 3), 3)
    assert.strictEqual(get(column, 4), 4)
    assert.strictEqual(get(column, 7), 7)
    assert.strictEqual(get(column, 8), 8)
    assert.strictEqual(get(column, 11), 11)
    assert.deepStrictEqual(Array.from(range(column, 0, 4)), [0, 1, 2, 3])
    assert.deepStrictEqual(Array.from(range(column, 4, 8)), [4, 5, 6, 7])
    assert.deepStrictEqual(Array.from(range(column, 3, 9)), [3, 4, 5, 6, 7, 8])
    assert.deepStrictEqual(Array.from(range(column, 12, 12)), [])
  })

  it('splices at and across exact boundaries', () => {
    const input = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    const column = createColumn('uint', input, {slabRows: 4, slabBytes: 1000})
    const inserted = splice(column, 4, 0, [20, 21])
    const replaced = splice(column, 4, 4, [30, 31])
    const crossed = splice(column, 2, 8, [40])
    assert.deepStrictEqual(Array.from(range(inserted)), [0, 1, 2, 3, 20, 21, 4, 5, 6, 7, 8, 9, 10, 11])
    assert.deepStrictEqual(Array.from(range(replaced)), [0, 1, 2, 3, 30, 31, 8, 9, 10, 11])
    assert.deepStrictEqual(Array.from(range(crossed)), [0, 1, 40, 10, 11])
    assert.strictEqual(inserted.slabs[0].data, column.slabs[0].data)
    assert.strictEqual(inserted.slabs[2].data, column.slabs[1].data)
    assert.strictEqual(inserted.slabs[3].data, column.slabs[2].data)
    assert.strictEqual(replaced.slabs[0].data, column.slabs[0].data)
    assert.strictEqual(replaced.slabs[2].data, column.slabs[2].data)
    assert.strictEqual(crossed.slabs[0].data === column.slabs[0].data, false)
    assert.strictEqual(crossed.slabs[crossed.slabs.length - 1].data === column.slabs[2].data, false)
  })

  it('uses coarse row and byte slab limits', () => {
    const rows = createColumn('uint', [0, 1, 2, 3, 4, 5, 6], {slabRows: 3, slabBytes: 1000})
    const strings = createColumn('string', ['abcdefghij', 'klmnopqrst', 'uvwxyz0123', '456789ABCD'], {
      slabRows: 10,
      slabBytes: 8
    })
    assert.deepStrictEqual(rows.slabs.map(slab => slab.rows), [3, 3, 1])
    assert.deepStrictEqual(strings.slabs.map(slab => slab.rows), [1, 1, 1, 1])
    assert.deepStrictEqual(Array.from(range(strings)), ['abcdefghij', 'klmnopqrst', 'uvwxyz0123', '456789ABCD'])
  })

  it('round-trips every codec through one canonical buffer', () => {
    for (let [type, input] of examples) {
      const column = createColumn(type, input, {slabRows: 2, slabBytes: 7})
      const encoded = toBuffer(column)
      const loaded = loadColumn(type, encoded, input.length, {slabRows: 3, slabBytes: 20})
      const decoded = decoder(column), output = []
      for (let index = 0; index < input.length; index++) output.push(decoded.readValue())
      assert.deepStrictEqual(bytes(encoded), bytes(encode(type, input)), type)
      assert.deepStrictEqual(Array.from(range(loaded)), input, type)
      assert.deepStrictEqual(output, input, type)
      assert.strictEqual(decoded.done, true, type)
      assert.strictEqual(toBuffer(loaded), encoded, type)
    }
  })

  it('loads an existing buffer with an explicit logical null length', () => {
    const encoded = new Uint8Array(0)
    const column = loadColumn('uint', encoded, 5)
    assert.strictEqual(column.length, 5)
    assert.strictEqual(column.slabs[0].data, encoded)
    assert.strictEqual(toBuffer(column), encoded)
    assert.deepStrictEqual(Array.from(range(column)), [null, null, null, null, null])
    assert.strictEqual(get(column, 4), null)
  })

  it('shares encoded slabs across clones, edits, saves, and loads', () => {
    const column = createColumn('int', [0, 1, 2, 3, 4, 5], {slabRows: 2, slabBytes: 1000})
    const copied = clone(column)
    const unchanged = splice(column, 1, 0, [])
    const extended = append(copied, [6, 7])
    const saved = save(extended)
    const loaded = loadColumn(saved)
    assert.notStrictEqual(copied, column)
    assert.deepStrictEqual(Array.from(range(column)), [0, 1, 2, 3, 4, 5])
    for (let index = 0; index < column.slabs.length; index++) {
      assert.strictEqual(copied.slabs[index].data, column.slabs[index].data)
      assert.strictEqual(unchanged.slabs[index].data, column.slabs[index].data)
      assert.strictEqual(extended.slabs[index].data, column.slabs[index].data)
      assert.strictEqual(saved.slabs[index].data, column.slabs[index].data)
      assert.strictEqual(loaded.slabs[index].data, column.slabs[index].data)
    }
    assert.deepStrictEqual(Array.from(range(loaded)), [0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('matches array splice under randomized edits', () => {
    for (let typeIndex = 0; typeIndex < examples.length; typeIndex++) {
      const type = examples[typeIndex][0]
      const next = random(0x51a9 + typeIndex)
      const expected = []
      let column = createColumn(type, [], {slabRows: 7, slabBytes: 19})
      for (let iteration = 0; iteration < 300; iteration++) {
        const index = next(expected.length + 1)
        const deleteCount = next(Math.min(expected.length - index, 5) + 1)
        const inserted = []
        const insertCount = next(5)
        for (let valueIndex = 0; valueIndex < insertCount; valueIndex++) inserted.push(randomValue(type, next))
        expected.splice(index, deleteCount, ...inserted)
        column = splice(column, index, deleteCount, inserted)
        assert.strictEqual(column.length, expected.length, `${type} iteration ${iteration}`)
        assert.deepStrictEqual(Array.from(range(column)), expected, `${type} iteration ${iteration}`)
        if (expected.length > 0) {
          const selected = next(expected.length)
          const start = next(expected.length + 1)
          const end = start + next(expected.length - start + 1)
          assert.strictEqual(get(column, selected), expected[selected], `${type} iteration ${iteration}`)
          assert.deepStrictEqual(Array.from(range(column, start, end)), expected.slice(start, end), `${type} iteration ${iteration}`)
        }
      }
      assert.deepStrictEqual(bytes(toBuffer(column)), bytes(encode(type, expected)), type)
    }
  })

  it('rejects invalid values, bounds, options, and encodings', () => {
    const column = createColumn('uint', [1, 2, 3])
    const encoded = encode('uint', [1, 2])
    assert.throws(() => createColumn('bytes', []), /unsupported column type/)
    assert.throws(() => createColumn('uint', [-1]), /nonnegative/)
    assert.throws(() => createColumn('int', [1.5]), /safe integers/)
    assert.throws(() => createColumn('boolean', [null]), /booleans/)
    assert.throws(() => createColumn('string', [1]), /strings/)
    assert.throws(() => createColumn('raw', [null]), /bytes/)
    assert.throws(() => createColumn('raw', [256]), /bytes/)
    assert.throws(() => createColumn('uint', [], {slabRows: 0}), /positive safe integer/)
    assert.throws(() => createColumn('uint', [], {rows: 10}), /unsupported column option/)
    assert.throws(() => get(column, 3), /out of bounds/)
    assert.throws(() => Array.from(range(column, 2, 1)), /precedes/)
    assert.throws(() => splice(column, 1, 3), /out of bounds/)
    assert.throws(() => splice(column, 1, 0, [-1]), /nonnegative/)
    assert.throws(() => loadColumn('uint', encoded, 1), /logical length/)
    assert.throws(() => loadColumn('uint', new Uint8Array([0]), 1), /incomplete number/)
    assert.throws(() => loadColumn('boolean', new Uint8Array([0x81, 0]), 1), /canonically encoded/)
    assert.throws(() => loadColumn({
      type: 'uint', length: 2, slabRows: 10, slabBytes: 10,
      slabs: [{rows: 1, data: encode('uint', [1])}]
    }), /do not match/)
  })
})
