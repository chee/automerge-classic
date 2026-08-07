const assert = require('assert')
const { checkEncoded } = require('./helpers')
const Automerge = process.env.TEST_DIST === '1' ? require('../dist/automerge') : require('../src/automerge')
const { encodeChange, decodeChange } = require('../backend/columnar')

describe('change encoding', () => {
  it('should encode text edits', () => {
    const change1 = {actor: 'aaaa', seq: 1, startOp: 1, time: 9, message: '', deps: [], ops: [
      {action: 'makeText', obj: '_root', key: 'text', insert: false, pred: []},
      {action: 'set', obj: '1@aaaa', elemId: '_head', insert: true, value: 'h', pred: []},
      {action: 'del', obj: '1@aaaa', elemId: '2@aaaa', insert: false, pred: ['2@aaaa']},
      {action: 'set', obj: '1@aaaa', elemId: '_head', insert: true, value: 'H', pred: []},
      {action: 'set', obj: '1@aaaa', elemId: '4@aaaa', insert: true, value: 'i', pred: []}
    ]}
    checkEncoded(encodeChange(change1), [
      0x85, 0x6f, 0x4a, 0x83, // magic bytes
      0xe2, 0xbd, 0xfb, 0xf5, // checksum
      1, 94, 0, 2, 0xaa, 0xaa, // chunkType: change, length, deps, actor 'aaaa'
      1, 1, 9, 0, 0, // seq, startOp, time, message, actor list
      12, 0x01, 4, 0x02, 4, // column count, objActor, objCtr
      0x11, 8, 0x13, 7, 0x15, 8, // keyActor, keyCtr, keyStr
      0x34, 4, 0x42, 6, // insert, action
      0x56, 6, 0x57, 3, // valLen, valRaw
      0x70, 6, 0x71, 2, 0x73, 2, // predNum, predActor, predCtr
      0, 1, 4, 0, // objActor column: null, 0, 0, 0, 0
      0, 1, 4, 1, // objCtr column: null, 1, 1, 1, 1
      0, 2, 0x7f, 0, 0, 1, 0x7f, 0, // keyActor column: null, null, 0, null, 0
      0, 1, 0x7c, 0, 2, 0x7e, 4, // keyCtr column: null, 0, 2, 0, 4
      0x7f, 4, 0x74, 0x65, 0x78, 0x74, 0, 4, // keyStr column: 'text', null, null, null, null
      1, 1, 1, 2, // insert column: false, true, false, true, true
      0x7d, 4, 1, 3, 2, 1, // action column: makeText, set, del, set, set
      0x7d, 0, 0x16, 0, 2, 0x16, // valLen column: 0, 0x16, 0, 0x16, 0x16
      0x68, 0x48, 0x69, // valRaw column: 'h', 'H', 'i'
      2, 0, 0x7f, 1, 2, 0, // predNum column: 0, 0, 1, 0, 0
      0x7f, 0, // predActor column: 0
      0x7f, 2 // predCtr column: 2
    ])
    const decoded = decodeChange(encodeChange(change1))
    const expected = Object.assign({hash: decoded.hash}, change1, {
      message: null,
      ops: change1.ops.map(op => {
        const normalized = Object.assign({}, op)
        if (!normalized.insert) delete normalized.insert
        return normalized
      })
    })
    assert.deepStrictEqual(decoded, expected)
  })

  it('should require strict ordering of preds', () => {
    const change = new Uint8Array([
      133, 111, 74, 131, 31, 229, 112, 44, 1, 105, 1, 58, 30, 190, 100, 253, 180, 180, 66, 49, 126,
      81, 142, 10, 3, 35, 140, 189, 231, 34, 145, 57, 66, 23, 224, 149, 64, 97, 88, 140, 168, 194,
      229, 4, 244, 209, 58, 138, 67, 140, 1, 152, 236, 250, 2, 0, 1, 4, 55, 234, 66, 242, 8, 21, 11,
      52, 1, 66, 2, 86, 3, 87, 10, 112, 2, 113, 3, 115, 4, 127, 9, 99, 111, 109, 109, 111, 110, 86,
      97, 114, 1, 127, 1, 127, 166, 1, 52, 48, 57, 49, 52, 57, 52, 53, 56, 50, 127, 2, 126, 0, 1,
      126, 139, 1, 0
    ])
    assert.throws(() => { decodeChange(change) }, /operation IDs are not in ascending order/)
  })

  it('should decode unknown scalar types like 3.2', () => {
    const change = new Uint8Array([
      0x85, 0x6f, 0x4a, 0x83, 0xc4, 0x72, 0x47, 0xf0, 1, 51, 0, 2, 0x12, 0x34, 1, 1, 0, 0, 0, 9,
      0x15, 3, 0x34, 1, 0x42, 2, 0x56, 2, 0x57, 4, 0x70, 2, 0xf0, 1, 2, 0xf1, 1, 2, 0xf3, 1, 2,
      0x7f, 1, 0x78, 1, 0x7f, 1, 0x7f, 0x4e, 1, 2, 3, 4, 0x7f, 0, 0x7f, 2, 2, 0, 2, 1
    ])
    assert.deepStrictEqual(decodeChange(change), {
      actor: '1234',
      seq: 1,
      startOp: 1,
      time: 0,
      message: null,
      deps: [],
      ops: [{action: 'set', obj: '_root', key: 'x', value: {type_code: 14, bytes: [1, 2, 3, 4]}, pred: []}],
      hash: 'c47247f01a9cc36830473660932f9d866f766efd73f6ebdf30d9c95755c4c705'
    })
    assert.deepStrictEqual(decodeChange(change, true).ops, [{
      action: 'set', obj: '_root', key: 'x', insert: false,
      value: new Uint8Array([1, 2, 3, 4]), datatype: 14, pred: []
    }])
  })

  it('should validate but not compare a supplied hash', () => {
    const change = {actor: 'aaaa', seq: 1, startOp: 1, time: 0, message: null, deps: [], ops: [
      {action: 'set', obj: '_root', key: 'x', value: 1, datatype: 'uint', pred: []}
    ]}
    const encoded = encodeChange(change)
    checkEncoded(encoded, encodeChange(Object.assign({}, change, {hash: '0'.repeat(64)})))
    checkEncoded(encoded, encodeChange(Object.assign({}, change, {hash: 'A'.repeat(64)})))
    checkEncoded(encoded, encodeChange(Object.assign({}, change, {hash: null})))
    assert.throws(() => { encodeChange(Object.assign({}, change, {hash: ''})) }, /32-byte hexadecimal string/)
    assert.throws(() => { encodeChange(Object.assign({}, change, {hash: '0'.repeat(63)})) }, /32-byte hexadecimal string/)
    assert.throws(() => { encodeChange(Object.assign({}, change, {hash: 0})) }, /32-byte hexadecimal string/)
  })

  describe('with trailing bytes', () => {
    let change = new Uint8Array([
      0x85, 0x6f, 0x4a, 0x83, // magic bytes
      0xb2, 0x98, 0x9e, 0xa9, // checksum
      1, 61, 0, 2, 0x12, 0x34, // chunkType: change, length, deps, actor '1234'
      1, 1, 252, 250, 220, 255, 5, // seq, startOp, time
      14, 73, 110, 105, 116, 105, 97, 108, 105, 122, 97, 116, 105, 111, 110, // message: 'Initialization'
      0, 6, // actor list, column count
      0x15, 3, 0x34, 1, 0x42, 2, // keyStr, insert, action
      0x56, 2, 0x57, 1, 0x70, 2, // valLen, valRaw, predNum
      0x7f, 1, 0x78, // keyStr: 'x'
      1, // insert: false
      0x7f, 1, // action: set
      0x7f, 19, // valLen: 1 byte of type uint
      1, // valRaw: 1
      0x7f, 0, // predNum: 0
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9 // 10 trailing bytes
    ])

    it('should allow decoding and re-encoding', () => {
      // NOTE: This calls the JavaScript encoding and decoding functions, even when the WebAssembly
      // backend is loaded. Should the wasm backend export its own functions for testing?
      const decoded = decodeChange(change)
      assert.deepStrictEqual(decoded.extra_bytes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
      assert.strictEqual(decoded.extraBytes, undefined)
      checkEncoded(change, encodeChange(decoded))

      const raw = decodeChange(change, true)
      assert(raw.extraBytes instanceof Uint8Array)
      assert.strictEqual(raw.extra_bytes, undefined)
      checkEncoded(change, encodeChange(raw))
    })

    it('should validate extra_bytes', () => {
      const decoded = decodeChange(change)
      assert.throws(() => { encodeChange(Object.assign({}, decoded, {extra_bytes: new Uint8Array([1])})) }, /array of bytes/)
      assert.throws(() => { encodeChange(Object.assign({}, decoded, {extra_bytes: [256]})) }, /array of bytes/)
    })

    it('should be preserved in document encoding', () => {
      const [doc] = Automerge.applyChanges(Automerge.init(), [change])
      const [reconstructed] = Automerge.getAllChanges(Automerge.load(Automerge.save(doc)))
      checkEncoded(change, reconstructed)
    })
  })
})
