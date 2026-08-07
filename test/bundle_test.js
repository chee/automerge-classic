const assert = require('assert')
const Automerge = process.env.TEST_DIST === '1' ? require('../dist/automerge') : require('../src/automerge')
const Backend = require('../backend')
const { decodeChange, decodeChanges } = require('../backend/columnar')

const bundleBase64 = 'hW9Kgzsn5nkDqgEBbzeSJvClUp4StAZSUsmtZNGiNH0seBQV4jh2TJ7VHnoBA6qqqgkBAgMDEwIjAzMCRQJQAlMDYAICAH4CAQICfgMCAgAAAgIBfgJ+AgANAQQDBBMEFRMhAiMENAJCBVYFVwhwBHECcwIAA38AAAN/BAADfwB9BGJhc2UFY291bnQEbGlzdAABBAB/AgMBAwECAX4CAXw2FABGdHdvAWJpcmR/AQMAfwB/AQ=='
const currentBundleBase64 = 'hW9Kgxg/9eMD0gIBAAAtu1ftqv6LMNMDSA3P9w05nWdkUrb6EBh9zq/2KiwBEAAAAAAAAAAAAAAAAAAAAAIJAQMDBhMGIwYzA0UCUANTCGAD1wAAf60E1gABf60E1gABf60E1gAB1wAAAFfXAAF+1wCpf9UAAdcAAAoVBCEDIwY0AUIDVgNXrgFwA3EDcwbXAAFu1wAAf60E1gABV9cAAdcAJKwErQSuBK8EsASxBLIEswS0BLUEtgS3BLgEuQS6BLsEvAS9BL4EvwTABMEEwgTDBMQExQTGBMcEyATJBMoEywTMBM0EzgTPBNAE0QTSBNME1ATVBNYE1wTYBNkE2gTbBNwE3QTeBN8E4AThBOIE4wTkBOUE5gTnBOgE6QTqBOsE7ATtBO4E7wTwBPEE8gTzBPQE9QT2BPcE+AT5BPoE+wT8BP0E/gT/BIAFgQWCBdcAAdcAAH+sBNYAAQ=='
const compressedBundleBase64 = 'hW9Kg0XHdJMDowcAARAAAAAAAAAAAAAAAAAAAAACCQEDAwMTAyMDMwNFA1AFUwVgA6wEAKwEAawEAawEAawEAACsBH8AqwQBfwCqBAGsBAAKFQQhAzQCQgNWBl+lBnAFcQNzA7MBBawEAW6sBACsBKwEAcAAFOwDJAVAg3YgWBS7Sd7atm1bv1bbtt2xp7Zt27axx0C5Rx597PEnnnzq6Weefe75F1586eVXXn3t9TfefOvtd9597/0PPvzo408+/ezzL7786utvvv3u+x9+/OnnX3797fc//vzr73/+/a/Kqq3Gaq3O6q3BGq3Jmq3FWq3N2q3DOq3Luq3Heq3P+m3ABm3Ihm3ERm3Mxm3CJm3Kpm3GZm3O5m3BFm3Jlm3FVm3N1m3DNm3Ltm3Hdm3P9u3ADu3Iju3ETu3Mzu3CLs0DnvCCN3zgCz/4IwCBCEIwQhCKMIQjApGIQjRiEIs4xCMBiUhCMlKQijSkIwOZyEI2cpCLPOSjAIUoQjGu4Cqu4Tpu4CZu4Tbu4C7u4T4e4CFKUIoylKMClahCNWpQizrUowGNaEIzWtCKNrSjA53oQjd60Is+9GMAgxjCMEYwijGMYwKTmMI0ZjCLOcxjAYtYwjJWsIo1rGMDm9jCNnawiz3s4wCHOMIxTnCKM5zjApfwoCe96E0f+tKP/gxgIIMYzBCGMozhjGAkoxjNGMYyjvFMYCKTmMwUpjKN6cxgJrOYzRzmMo/5LGAhi1jMK7zKa7zOG7zJW7zNO7zLe7zPB3zIEpayjOWsYCWrWM0a1rKO9WxgI5vYzBa2so3t7GAnu9jNHvayj/0c4CCHOMwRjnKM45zgJKc4zRnOco7zXOAil7jMFa5yjevc4Ca3uM0d7nKP+zzgIY94zBOe8oznvOAlPeQpL3nLR77yk78CFKggBStEoQpTuCIUqShFK0axilO8EpSoJCUrRalKU7oylKksZStHucpTvgpUqCIV64qu6pqu64Zu6pZu647u6p7u64EeqkSlKlO5KlSpKlWrRrWqU70a1KgmNatFrWpTuzrUqS51q0e96lO/BjSoIQ1rRKMa07gmNKkpTWtGs5rTvBa0qCUta0WrWtO6NrSpLW1rR7va074OdKgjHetEpzrTuS50KQ/n6byct/Nxvs7P+bsAF+iCXLALcaEuzIW7CBfpoly0i3GxLs7FuwSX6JJcsktxqS7NpbsMl+myXLbLcbkuz+W7Alfoilyx+x9/AKsEAasEAKsEAX8AqwQB'
const changeBase64 = [
  'hW9Kg8qluwQBWAFvN5Im8KVSnhK0BlJSya1k0aI0fSx4FBXiOHZMntUeegOqqqoCAgAAAAgVDDQBQgJWA1cEcANxAnMCfgRiYXNlBWNvdW50AgIBfjYUdHdvAX4BAH8AfwE=',
  'hW9KgzRocvoBXwHKpbsEQ+k7WEFoNHruNTFI46jlAfhyW/t44OMaS4rBVQOqqqoDBAAAAAkBBAIEEwQVCDQCQgNWA1cEcAIAAX8AAAF/BAABfwB/BGxpc3QAAQEBfgIBfgBGYmlyZAIA'
]
const hashes = [
  'caa5bb0443e93b584168347aee353148e3a8e501f8725bfb78e0e31a4b8ac155',
  '346872fa66a167f4a66ceed5a4028652d16c27dcb4025584269bfa2f186045af'
]
const baseHash = '6f379226f0a5529e12b4065252c9ad64d1a2347d2c781415e238764c9ed51e7a'

function bytes(base64) {
  return Uint8Array.from(Buffer.from(base64, 'base64'))
}

function baseDocument() {
  let doc = Automerge.init('aaaaaa')
  return Automerge.change(doc, {time: 0}, value => { value.base = new Automerge.ImmutableString('one') })
}

describe('bundle encoding', () => {
  it('decodes a legacy Rust bundle and preserves its changes', () => {
    const encoded = bytes(bundleBase64)
    const decoded = Backend.readBundle(encoded)

    assert.deepStrictEqual(decoded.deps, [baseHash])
    assert.deepStrictEqual(decoded.actors, ['aaaaaa'])
    assert.deepStrictEqual(decoded.changes.map(change => change.hash), hashes)
    assert.deepStrictEqual(decoded.changeBytes.map(change => Buffer.from(change).toString('base64')), changeBase64)
    assert.deepStrictEqual(Backend.readBundle(Backend.saveBundle(decoded.changeBytes)).changeBytes, decoded.changeBytes)
    assert.deepStrictEqual(decodeChanges([encoded]).map(change => change.hash), hashes)
  })

  it('decodes compressed current Rust bundles and re-encodes their changes', () => {
    const encoded = bytes(compressedBundleBase64)
    const decoded = Backend.readBundle(encoded)
    const roundTripped = Backend.readBundle(Backend.saveBundle(decoded.changeBytes))

    assert.strictEqual(encoded.byteLength, 942)
    assert.strictEqual(decoded.changeBytes.length, 556)
    assert.deepStrictEqual(decoded.deps, [])
    assert.deepStrictEqual(decoded.actors, ['00000000000000000000000000000002'])
    assert.strictEqual(decoded.changes[0].hash, '07b6204c340fe17953fbcc238179589d962bd3115c678d67b3539762a33f8804')
    assert.strictEqual(decoded.changes[555].hash, '00002dbb57edaafe8b30d303480dcff70d399d676452b6fa10187dceaff62a2c')
    assert.deepStrictEqual(decoded.changes, decoded.changeBytes.map(change => decodeChange(change, true)))
    assert.deepStrictEqual(roundTripped.changeBytes, decoded.changeBytes)
  })

  it('matches uncompressed current Rust bundle bytes', () => {
    const encoded = bytes(currentBundleBase64)
    const decoded = Backend.readBundle(encoded)

    assert.strictEqual(decoded.changeBytes.length, 87)
    assert.deepStrictEqual(decoded.deps, ['00002dbb57edaafe8b30d303480dcff70d399d676452b6fa10187dceaff62a2c'])
    assert.deepStrictEqual(Backend.saveBundle(decoded.changeBytes), encoded)
  })

  it('loads Rust bundles incrementally and from concatenated storage', () => {
    const encoded = bytes(bundleBase64)
    let doc = Automerge.loadIncremental(baseDocument(), encoded)

    assert.deepStrictEqual(Automerge.toJS(doc), {
      base: new Automerge.ImmutableString('two'), count: 1,
      list: [new Automerge.ImmutableString('bird')]
    })
    assert.deepStrictEqual(Automerge.getHeads(doc), [hashes[1]])

    const base = Automerge.getAllChanges(baseDocument())[0]
    doc = Automerge.load(Uint8Array.from(Buffer.concat([Buffer.from(base), Buffer.from(encoded)])))
    assert.deepStrictEqual(Automerge.toJS(doc), {
      base: new Automerge.ImmutableString('two'), count: 1,
      list: [new Automerge.ImmutableString('bird')]
    })
    assert.deepStrictEqual(Automerge.getHeads(doc), [hashes[1]])
  })

  it('queues bundle changes until external dependencies arrive', () => {
    const encoded = bytes(bundleBase64)
    let doc = Automerge.load(encoded, {allowMissingChanges: true})

    assert.deepStrictEqual(Automerge.toJS(doc), {})
    assert.deepStrictEqual(Automerge.getMissingDeps(doc), [baseHash])
    doc = Automerge.loadIncremental(doc, Automerge.getAllChanges(baseDocument())[0])
    assert.deepStrictEqual(Automerge.toJS(doc), {
      base: new Automerge.ImmutableString('two'), count: 1,
      list: [new Automerge.ImmutableString('bird')]
    })
  })

  it('round-trips selected JavaScript changes with external dependencies', () => {
    let doc = baseDocument()
    doc = Automerge.change(doc, {time: 1, message: 'nested'}, value => {
      value.bytes = new Uint8Array([0, 127, 255])
      value.nested = {title: 'café'}
      value.items = ['a', 'b']
    })
    doc = Automerge.change(doc, {time: 2}, value => {
      value.items.push('🐦')
      value.nested.title = 'done'
    })
    const raw = Automerge.getAllChanges(doc)
    const encoded = Backend.saveBundle(raw.slice(1))
    const decoded = Backend.readBundle(encoded)

    assert.strictEqual(encoded[8], 3)
    assert.deepStrictEqual(decoded.deps, [baseHash])
    assert.deepStrictEqual(decoded.changeBytes, raw.slice(1))

    let loaded = baseDocument()
    loaded = Automerge.loadIncremental(loaded, encoded)
    assert.deepStrictEqual(Automerge.toJS(loaded), Automerge.toJS(doc))
    assert.deepStrictEqual(Automerge.getHeads(loaded), Automerge.getHeads(doc))
  })

  it('preserves actor ordering in multi-actor changes', () => {
    const first = Automerge.encodeChange({
      actor: 'cccccc', seq: 1, startOp: 1, time: 0, message: '', deps: [],
      ops: [{action: 'set', obj: '_root', key: 'value', value: 1, pred: []}]
    })
    const second = Automerge.encodeChange({
      actor: 'aaaaaa', seq: 1, startOp: 1, time: 0, message: '', deps: [],
      ops: [{action: 'set', obj: '_root', key: 'value', value: 2, pred: []}]
    })
    const third = Automerge.encodeChange({
      actor: 'bbbbbb', seq: 1, startOp: 1, time: 0, message: '',
      deps: [Automerge.decodeChange(first).hash, Automerge.decodeChange(second).hash],
      ops: [{action: 'set', obj: '_root', key: 'value', value: 3,
        pred: ['1@aaaaaa', '1@cccccc']}]
    })
    const raw = [first, second, third]
    const decoded = Backend.readBundle(Backend.saveBundle(raw))

    assert.deepStrictEqual(decoded.changeBytes, raw)
    assert.deepStrictEqual(decoded.changes.map(change => change.hash), raw.map(change => Automerge.decodeChange(change).hash))
  })

  it('rejects non-topological bundle input', () => {
    let doc = baseDocument()
    doc = Automerge.change(doc, {time: 1}, value => { value.base = 'two' })
    const raw = Automerge.getAllChanges(doc)
    assert.throws(() => Backend.saveBundle(raw.slice().reverse()), /topological order/)
  })
})
