import assert from 'node:assert'
import Automerge from './subject.js'

function chain() {
  let doc = Automerge.init('aaaaaaaa')
  for (const [i, time] of [0, 0, 59, 0, 0, 107893, 115, 0].entries()) {
    doc = Automerge.change(doc, {time}, draft => { draft[`k${i}`] = i })
  }
  return doc
}

function branches() {
  const times = [0, 786, 0, 0, 194, 0, 362, 23645, 0, 0]
  function change(doc, callback) {
    return Automerge.change(doc, {time: times.shift()}, callback)
  }
  let a = change(Automerge.init('aaaaaaaa'), draft => { draft.x = 1 })
  let b = Automerge.merge(Automerge.init('bbbbbbbb'), a)
  a = change(a, draft => { draft.a = 2 })
  a = change(a, draft => { draft.a = 3 })
  b = change(b, draft => { draft.b = 1 })
  b = change(b, draft => { draft.b = 2 })
  a = Automerge.merge(a, b)
  a = change(a, draft => { draft.m = 1 })
  a = change(a, draft => { draft.m = 2 })
  b = change(b, draft => { draft.b = 3 })
  b = change(b, draft => { draft.b = 4 })
  a = Automerge.merge(a, b)
  return change(a, draft => { draft.m = 3 })
}

function hashes(doc) {
  return Automerge.getAllChanges(doc).map(change => Automerge.decodeChange(change).hash)
}

function fragment(head, level, boundary, checkpoints, members) {
  return {head, level, boundary, checkpoints, members}
}

function base64(bytes) {
  return Buffer.from(bytes).toString('base64')
}

function thrown(callback) {
  try {
    callback()
  } catch (error) {
    return error
  }
  assert.fail('expected an exception')
}

describe('fragments, matching @automerge/automerge 3.5.0', () => {
  it('groups history into fragments by leading zero bytes of the change hash', () => {
    const doc = chain(), h = hashes(doc)
    assert.deepStrictEqual(h.map(hash => hash.slice(0, 8)),
      ['c9b595d8', '495ad73d', '00eec439', '1b84aa2a', '253c20ea', '00008a1f', '0098d7e5', '5f83618c'])
    const level2 = fragment(h[5], 2, [], [h[2]], [h[5], h[4], h[3], h[2], h[1], h[0]])
    const level1 = fragment(h[6], 1, [h[5]], [], [h[6]])
    const loose = fragment(h[7], 0, [h[6]], [], [h[7]])
    assert.deepStrictEqual(Automerge.getFragmentMetadata(doc), [level2, level1, loose])
    assert.deepStrictEqual(Automerge.getFragmentMetadata(doc, null), [level2, level1, loose])
    assert.deepStrictEqual(Automerge.getFragmentMetadata(doc, {}), [level2, level1, loose])
    assert.deepStrictEqual(Automerge.getFragmentMetadata(doc, 0), [loose])
    assert.deepStrictEqual(Automerge.getFragmentMetadata(doc, 2), [level2])
    assert.deepStrictEqual(Automerge.getFragmentMetadata(doc, {start: 1}), [level2, level1])
    assert.deepStrictEqual(Automerge.getFragmentMetadata(doc, {end: 2}), [level1, loose])
    assert.deepStrictEqual(Automerge.getFragmentMetadata(doc, {start: 3, end: 1}), [])
    assert.deepStrictEqual(Automerge.getFragmentMetadata(doc, {start: '1'}), [level2, level1, loose])
    assert.deepStrictEqual(Automerge.next.getFragmentMetadata(Automerge.load(Automerge.save(doc)), 1), [level1])
  })

  it('supersedes lower fragments and keeps concurrent fragments in history order', () => {
    const doc = branches(), h = hashes(doc)
    assert.deepStrictEqual(h.map(hash => hash.slice(0, 8)),
      ['e8c5e71c', '0012cde3', '60c61da4', '331688b1', '00110403', '1fa6c3dc', '0041ffb2', '0000518a', '0afb12b8', '93fda600'])
    assert.deepStrictEqual(Automerge.getFragmentMetadata(doc), [
      fragment(h[1], 1, [], [], [h[1], h[0]]),
      fragment(h[6], 1, [h[4], h[1]], [], [h[6], h[5], h[2]]),
      fragment(h[7], 2, [], [h[4]], [h[7], h[4], h[3], h[0]]),
      fragment(h[8], 0, [h[7]], [], [h[8]]),
      fragment(h[9], 0, [h[6], h[8]], [], [h[9]])
    ])
    assert.deepStrictEqual(Automerge.getFragmentMeta(doc, h[4]), null)
    assert.deepStrictEqual(Automerge.getFragmentMeta(doc, h[6]), fragment(h[6], 1, [h[4], h[1]], [], [h[6], h[5], h[2]]))
    assert.deepStrictEqual(Automerge.getFragmentMeta(doc, h[5]), fragment(h[5], 0, [h[4], h[2]], [], [h[5]]))
    assert.deepStrictEqual(Automerge.getFragmentMeta(doc, h[3].toUpperCase()), fragment(h[3], 0, [h[0]], [], [h[3]]))
    assert.strictEqual(Automerge.getFragmentMeta(doc, '11'.repeat(32)), null)
  })

  it('rejects invalid level ranges and hashes like Rust', () => {
    const doc = chain()
    for (const levels of [-1, 1.5, NaN, Infinity]) {
      assert.throws(() => Automerge.getFragmentMetadata(doc, levels), {name: 'RangeError', message: 'fragment level must be a non-negative integer'})
    }
    assert.throws(() => Automerge.getFragmentMetadata(doc, {start: -1}), {name: 'RangeError', message: 'fragment level range start must be a non-negative integer'})
    assert.throws(() => Automerge.getFragmentMetadata(doc, {end: 0.5}), {name: 'RangeError', message: 'fragment level range end must be a non-negative integer'})
    const error = thrown(() => Automerge.getFragmentMetadata(doc, '1'))
    assert.ok(error instanceof RangeError)
    assert.ok(error.message.startsWith('bad fragment level range property: unable to get property JsValue("start"): JsValue(TypeError: Reflect.get called on non-object'))
    assert.strictEqual(thrown(() => Automerge.getFragmentMeta(doc, 1)), 'change hash was not a string')
    assert.strictEqual(thrown(() => Automerge.getFragmentMeta(doc, 'abc')), 'Odd number of digits')
    assert.strictEqual(thrown(() => Automerge.getFragmentMeta(doc, 'zz')), "Invalid character 'z' at position 0")
    assert.strictEqual(thrown(() => Automerge.getFragmentMeta(doc, 'é')), "Invalid character 'Ã' at position 0")
    assert.strictEqual(thrown(() => Automerge.getFragmentMeta(doc, '\n0')), "Invalid character '\\n' at position 0")
    assert.strictEqual(thrown(() => Automerge.getFragmentMeta(doc, '00')), 'incorrect length, change hash should be 32 bytes, got 1')
  })

  it('bundles fragments into the same bytes as Rust', () => {
    const doc = branches(), h = hashes(doc)
    assert.deepStrictEqual(Automerge.bundleFragmentMetadata(doc, Automerge.getFragmentMetadata(doc)).map(base64), [
      'hW9KgxVZ7UoDVAABBKqqqqoJAQIDAhMCIwIzBEUCUANTAmACAgACAQIBAgF+AJIGAAJ+AAF/AAIACBUFIQI0AUICVgJXAnACswEDfgFhAXgCAAICAQIUAgECAH4Bfw==',
      'hW9Kg4kOFNMDrAECABLN4yleX1x6/8uj7ELharbzDuIMyOYPMh5Fiq+NRlIAEQQDpOxHFpg0kctFoCrNulE8X6TijCWHaxyc2TQ0CQEEqqqqqgkBAgMEEwQjBDMFRQJQBFMFYAIDAH8DAgF/AwIBfwMCAQIAf+oCAAN9AQIBfAMBfAEDAAoVBiECNAFCAlYCVwNwBHECcwKzAQR/AWECAW0DAAMDAQMUAwECfQEAAQIAAgJ/AAIB',
      'hW9Kg67SyToDeQACBKqqqqoEu7u7uwkBBAMFEwIjAjMIRQJQBFMEYAJ/AAMBfgEAAgEEAQQBAgB+wgGbtwEABH8AAwF/AAIBBAAKFQYhBDQBQgJWAlcEcAZxAnMDswEFAwFifwF4AwF/AAQEAQQUAQIDAX8AAgF/AAIBfgIBfgN9AgE=',
      'hW9Kgwr7ErgBSwEAAFGKCxmWrQUWxKsbisLZyuOWiCSlGK0lUSoQXEi11QS7u7u7BAUAAAAIFQM0AUICVgJXAXACcQJzAn8BYgF/AX8UBH8BfwB/BA==',
      'hW9Kg5P9pgABawIAQf+yMiPXBsnFTJv6aYpDzYsm8neONVuQDCXs4AodAAr7EriV+xCvd0D01GM0y9MNNLqtL2RzljuOladh/BOpBKqqqqoGBgAAAAgVAzQBQgJWAlcBcAJxAnMCfwFtAX8BfxQDfwF/AH8F'
    ])
    const custom = [
      fragment(h[7], 2, [], [], []),
      fragment('11'.repeat(32), 0, [], [], ['11'.repeat(32)]),
      fragment(h[7], 7, ['AB'.repeat(32)], [], [h[9], h[3].toUpperCase()]),
      fragment(h[7], 2, [], [], [h[9], '11'.repeat(32)]),
      fragment(h[9], 0, [], [], [h[3]])
    ]
    assert.deepStrictEqual(Automerge.bundleFragmentMetadata(doc, custom).map(base64), [
      'hW9Kg9KmFhEDBAAAAAA=',
      'hW9Kg50Ruh0DxwED6MXnHJGBt0Oqvr2Na/d2OVcG0AyxHjZhgYJCGozbLiEAQf+yMiPXBsnFTJv6aYpDzYsm8neONVuQDCXs4AodAAr7EriV+xCvd0D01GM0y9MNNLqtL2RzljuOladh/BOpAgSqqqqqBLu7u7sJAQMDAxMDIwMzAkUCUANTBGACfgEAfgEFfgIEfgIEAgAAAn4BAn8CAgECAAoVBSEDNAFCAlYCVwJwA3ECcwKzAQN+AWIBbX4BAAICAQIUAQN+AAF/AH8FfgF/',
      'hW9Kg5P9pgABawIAQf+yMiPXBsnFTJv6aYpDzYsm8neONVuQDCXs4AodAAr7EriV+xCvd0D01GM0y9MNNLqtL2RzljuOladh/BOpBKqqqqoGBgAAAAgVAzQBQgJWAlcBcAJxAnMCfwFtAX8BfxQDfwF/AH8F'
    ])
    assert.deepStrictEqual(Automerge.saveBundle(doc, [h[9], h[3]]), Automerge.bundleFragmentMetadata(doc, [custom[2]])[0])
  })

  it('rejects malformed fragment metadata like Rust', () => {
    const doc = chain(), [meta] = Automerge.getFragmentMetadata(doc)
    const cases = [
      ['x', 'fragments must be an array'],
      [[{}], 'bad fragment at index 0: bad fragment head: change hash was not a string'],
      [[meta, {...meta, level: -1}], 'bad fragment at index 1: bad fragment level'],
      [[{...meta, level: '2'}], 'bad fragment at index 0: bad fragment level'],
      [[{...meta, boundary: undefined}], 'bad fragment at index 0: bad fragment boundary: the change hashes were not an array of strings'],
      [[{...meta, checkpoints: [5]}], 'bad fragment at index 0: bad fragment checkpoints: could not decode hash 0: change hash was not a string'],
      [[{...meta, members: [meta.head, 'abc']}], 'bad fragment at index 0: bad fragment members: could not decode hash 1: Odd number of digits']
    ]
    for (const [input, message] of cases) {
      assert.throws(() => Automerge.bundleFragmentMetadata(doc, input), {name: 'RangeError', message})
    }
    const error = thrown(() => Automerge.bundleFragmentMetadata(doc, [undefined, meta]))
    assert.ok(error.message.startsWith('bad fragment at index 0: bad fragment input property: unable to get property JsValue("head")'))
  })

  it('returns commits and fragments with their bytes', () => {
    const doc = chain(), h = hashes(doc)
    const commits = Automerge.getCommits(doc), fragments = Automerge.getFragments(doc)
    assert.deepStrictEqual(commits.map(commit => [commit.head, commit.parents]), [[h[7], [h[6]]]])
    assert.strictEqual(base64(commits[0].bytes),
      'hW9Kg1+DYYwBRAEAmNflguQHhxFmLKlp6zCvqXX8qj/yq+HTSRffF2yjTwSqqqqqCAgAAAAGFQQ0AUICVgJXAXACfwJrNwF/AX8UB38A')
    assert.deepStrictEqual(fragments.map(({head, level, boundary, checkpoints, members}) => ({head, level, boundary, checkpoints, members})),
      Automerge.getFragmentMetadata(doc, {start: 1}))
    assert.deepStrictEqual(fragments.map(fragment => base64(fragment.bytes)), [
      'hW9Kg5ONoLMDbwABBKqqqqoJAQIDAhMCIwIzCUUCUARTBGACBgAGAQYBBgECAHw7RQD1ygYABn8ABQF/AAQBBgAIFRMhAjQBQgJWAlcGcAKzAQR6AmswAmsxAmsyAmszAms0Ams1BgAGBgEGFAABAgMEBQYAfwAFAQ==',
      'hW9Kg4DU8zkDbwEAAIofy/dVxD4G2OkQ7ydTWIQS+XzPVORWoH7AnHXzTAEEqqqqqgkBAgMCEwIjAjMDRQJQAlMCYAJ/AH8Hfwd/B3/zAAABfwF/AX8ACBUEIQI0AUICVgJXAXACswECfwJrNn8AAX8BfxQGfwB/AA=='
    ])
    assert.deepStrictEqual(Automerge.getFragments(doc, 0).map(fragment => fragment.bytes), [commits[0].bytes])
  })

  it('adds commits and fragments from another document', () => {
    const doc = branches(), patches = []
    const options = {patchCallback: (patch, info) => patches.push(info.source)}
    let copy = Automerge.addFragments(Automerge.init(), Automerge.getFragments(doc), options)
    copy = Automerge.addCommits(copy, Automerge.getCommits(doc), options)
    assert.deepStrictEqual(Automerge.getHeads(copy), Automerge.getHeads(doc))
    assert.deepStrictEqual(Automerge.toJS(copy), Automerge.toJS(doc))
    assert.deepStrictEqual(patches, ['addFragments', 'addCommits'])

    const queued = Automerge.addCommits(Automerge.init(), Automerge.getCommits(doc))
    assert.deepStrictEqual(Automerge.getHeads(queued), [])
    assert.deepStrictEqual(Automerge.getMissingDeps(queued), [hashes(doc)[7], hashes(doc)[6]])
  })

  it('rejects commits whose metadata does not match their bytes', () => {
    const doc = chain(), h = hashes(doc), changes = Automerge.getAllChanges(doc)
    const commit = {head: h[1], parents: [h[0]], bytes: changes[1]}
    const cases = [
      [null, 'commit inputs must be an array'],
      [[{...commit, head: 'zz'}], 'bad commit input at index 0: bad commit head: Invalid character \'z\' at position 0'],
      [[commit, {...commit, parents: 'x'}], 'bad commit input at index 1: bad commit parents: the change hashes were not an array of strings'],
      [[{...commit, bytes: [1]}], 'bad commit input at index 0: bad commit bytes: not a Uint8Array'],
      [[{...commit, head: h[0]}], `commit input head mismatch: expected ${h[0]}, actual ${h[1]}`],
      [[{...commit, parents: []}], 'commit input parents do not match encoded change dependencies'],
      [[{...commit, bytes: new Uint8Array([1, 2, 3])}], 'bad commit bytes: unable to parse change: not enough data'],
      [[{...commit, bytes: Automerge.save(doc)}], 'bad commit bytes: wrong chunk type'],
      [[{...commit, bytes: new Uint8Array([...changes[1], 0])}], 'bad commit bytes: leftover data after parsing']
    ]
    for (const [input, message] of cases) {
      assert.throws(() => Automerge.addCommits(Automerge.init(), input), {name: 'RangeError', message})
    }
    const fragment = {...Automerge.getFragments(doc)[0]}
    assert.throws(() => Automerge.addFragments(Automerge.init(), [{...fragment, bytes: undefined}]),
      {name: 'RangeError', message: 'bad fragment input at index 0: bad fragment bytes: not a Uint8Array'})
    assert.throws(() => Automerge.addFragments(Automerge.init(), [{...fragment, bytes: new Uint8Array([1, 2, 3])}]),
      {name: 'RangeError', message: 'error loading fragment bundles: unable to parse chunk: not enough data'})
  })

  it('diffs one object and its children', () => {
    let doc = Automerge.from({a: {b: 1}, list: [{v: 1}, {v: 2}], text: 'hello', n: 1}, 'aaaa')
    const h0 = Automerge.getHeads(doc)
    doc = Automerge.change(doc, {time: 0}, draft => {
      draft.a.b = 2
      draft.list[1].v = 3
      draft.list.push({v: 9})
      Automerge.splice(draft, ['text'], 0, 1, 'J')
      draft.z = {q: 1}
    })
    const h1 = Automerge.getHeads(doc)
    doc = Automerge.change(doc, {time: 0}, draft => {
      delete draft.a
      draft.list.splice(0, 1)
    })
    const h2 = Automerge.getHeads(doc)
    assert.deepStrictEqual(Automerge.diffPath(doc, ['list'], h0, h1), [
      {action: 'insert', path: ['list', 2], values: [{}]},
      {action: 'put', path: ['list', 1, 'v'], value: 3},
      {action: 'put', path: ['list', 2, 'v'], value: 9}
    ])
    assert.deepStrictEqual(Automerge.diffPath(doc, ['list'], h0, h1, {recursive: false}), [{action: 'insert', path: ['list', 2], values: [{}]}])
    assert.deepStrictEqual(Automerge.diffPath(doc, ['list', 0], h0, h1), [{action: 'put', path: ['list', 1, 'v'], value: 3}])
    assert.deepStrictEqual(Automerge.diffPath(doc, ['list'], h1, h2), [{action: 'del', path: ['list', 0]}])
    assert.deepStrictEqual(Automerge.diffPath(doc, ['text'], h0, h1), [
      {action: 'splice', path: ['text', 0], value: 'J'},
      {action: 'del', path: ['text', 1]}
    ])
    assert.deepStrictEqual(Automerge.diffPath(doc, ['z'], h1, h0), [])
    assert.deepStrictEqual(Automerge.diffPath(doc, ['list'], ['00'.repeat(32)], h1), [
      {action: 'insert', path: ['list', 0], values: [{}, {}, {}]},
      {action: 'put', path: ['list', 0, 'v'], value: 1},
      {action: 'put', path: ['list', 1, 'v'], value: 3},
      {action: 'put', path: ['list', 2, 'v'], value: 9}
    ])
    assert.throws(() => Automerge.diffPath(doc, ['a'], h0, h1),
      {name: 'RangeError', message: 'invalid path _root/a: path component 0 (a) referenced a nonexistent object'})
    assert.throws(() => Automerge.diffPath(doc, ['n'], h0, h1), {name: 'RangeError', message: 'invalid path _root/n: path did not refer to an object'})
    assert.throws(() => Automerge.diffPath(doc, ['list', 'x'], h0, h1),
      {name: 'RangeError', message: 'invalid path _root/list/x: path component 1 (x) should be an integer to index a sequence'})
    assert.throws(() => Automerge.diffPath(doc, ['list'], 'x', h1), {name: 'Error', message: 'invalid before: must be an array'})
    assert.throws(() => Automerge.diffPath(doc, ['list'], h0, [5]),
      {name: 'RangeError', message: 'invalid before heads: could not decode hash 0: change hash was not a string'})
  })

  it('applies a batch of changes in the order Rust does', () => {
    let a = Automerge.change(Automerge.init('aaaaaaaa'), {time: 0}, draft => { draft.x = 0 })
    let b = Automerge.clone(a, 'bbbbbbbb')
    for (let i = 1; i < 4; i++) {
      a = Automerge.change(a, {time: 0}, draft => { draft.x = i })
      b = Automerge.change(b, {time: 0}, draft => { draft.y = i })
    }
    const changes = [...Automerge.getAllChanges(a), ...Automerge.getAllChanges(b).slice(1)]
    const names = new Map(changes.map((change, i) => [Automerge.decodeChange(change).hash, ['a1', 'a2', 'a3', 'a4', 'b2', 'b3', 'b4'][i]]))
    const [doc] = Automerge.applyChanges(Automerge.init(), [0, 2, 1, 4, 3, 5, 6].map(i => changes[i]))
    assert.deepStrictEqual(hashes(doc).map(hash => names.get(hash)), ['a1', 'a2', 'b2', 'a3', 'b3', 'a4', 'b4'])
    assert.deepStrictEqual(Automerge.getChangesSince(doc, [hashes(doc)[0]]).map(change => names.get(Automerge.decodeChange(change).hash)),
      ['a2', 'b2', 'a3', 'b3', 'a4', 'b4'])
  })
})
