import assert from 'node:assert'
import Classic from './subject.js'
import Modern, { describeLive } from './modern.js'

const SEEDS = Number(process.env.CROSS_FUZZ_SEEDS || 40)
const STEPS = Number(process.env.CROSS_FUZZ_STEPS || 60)
const ACTORS = ['aaaaaaaa', 'bbbbbbbb', 'cccccccc']
const KEYS = ['a', 'b', 'list', 'text', 'n', 'zz', '', 'é', '\u{1F600}']
const STRINGS = ['', 'x', 'hello', 'é', '\u{1F600}', 'a\u{1F600}b', 'two words']

function random(seed) {
  return () => {
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function plain(value) {
  if (value instanceof Date) return {date: value.getTime()}
  if (value instanceof Uint8Array) return {bytes: [...value]}
  if (value instanceof Classic.ImmutableString || value instanceof Modern.ImmutableString) return {immutable: value.val}
  if (value instanceof Classic.Counter || value instanceof Modern.Counter) return {counter: value.value}
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).map(key => [key, plain(value[key])]))
  return value
}

function generator(rand) {
  function int(n) { return Math.floor(rand() * n) }
  function pick(list) { return list[int(list.length)] }

  function scalar(A) {
    switch (int(9)) {
      case 0: return int(1000) - 500
      case 1: return rand() * 100
      case 2: return pick([true, false, null])
      case 3: return new Date(1700000000000 + int(1e6))
      case 4: return new Uint8Array([int(256), int(256)])
      case 5: return new A.Counter(int(10))
      case 6: return new A.ImmutableString(pick(STRINGS))
      default: return pick(STRINGS)
    }
  }

  function value(A, depth) {
    if (depth > 2 || rand() < 0.6) return scalar(A)
    if (rand() < 0.5) return Array.from({length: int(3)}, () => value(A, depth + 1))
    const object = {}
    for (let i = int(3); i > 0; i--) object[pick(KEYS)] = value(A, depth + 1)
    return object
  }

  function objects(node, path, out) {
    if (typeof node === 'string') {
      if (!path.includes('')) out.push({path, kind: 'text', text: node})
    } else if (Array.isArray(node)) {
      out.push({path, kind: 'list', length: node.length, counters: node.map(item => item instanceof Classic.Counter)})
      node.forEach((child, index) => objects(child, [...path, index], out))
    } else if (node !== null && Object.getPrototypeOf(node) === Object.prototype) {
      const conflicted = Object.keys(node).filter(key => Object.keys(Classic.getConflicts(node, key) || {}).length > 1)
      out.push({path, kind: 'map', keys: Object.keys(node), conflicted})
      for (const key of Object.keys(node)) objects(node[key], [...path, key], out)
    }
    return out
  }

  function edit(doc) {
    const target = pick(objects(doc, [], []))
    const path = target.path
    const valueSeed = Math.floor(rand() * 2 ** 32)
    function resolve(draft) { return path.reduce((node, key) => node[key], draft) }
    function fresh(A) { return generator(random(valueSeed)).value(A, path.length) }

    if (target.kind === 'map') {
      const key = target.keys.length > 0 && rand() < 0.4 ? pick(target.keys) : pick(KEYS)
      if (!target.keys.includes(key) || rand() < 0.4) return (A, draft) => { resolve(draft)[key] = fresh(A) }
      if (rand() < 0.5) return (A, draft) => { delete resolve(draft)[key] }
      return (A, draft) => {
        const object = resolve(draft)
        if (object[key] instanceof A.Counter && !target.conflicted.includes(key)) object[key].increment(3)
        else object[key] = fresh(A)
      }
    }
    if (target.kind === 'list') {
      const index = int(target.length), count = 1 + int(Math.min(2, target.length - index))
      if (target.length > 0 && rand() < 0.3 && !target.counters.slice(index, index + count).includes(true)) {
        return (A, draft) => { A.deleteAt(resolve(draft), index, count) }
      }
      const at = int(target.length + 1)
      return (A, draft) => { A.insertAt(resolve(draft), at, fresh(A), fresh(A)) }
    }
    const chars = [...target.text]
    const start = int(chars.length + 1), end = start + int(chars.length - start + 1)
    const offset = chars.slice(0, start).join('').length, width = chars.slice(start, end).join('').length
    switch (int(3)) {
      case 0: {
        const text = pick(STRINGS) + pick(STRINGS)
        return (A, draft) => { A.updateText(draft, path, text) }
      }
      case 1: {
        if (start === end) break
        const name = pick(['bold', 'italic']), value = rand() < 0.2 ? null : true
        const expand = pick(['before', 'after', 'both', 'none'])
        return (A, draft) => { A.mark(draft, path, {start: offset, end: offset + width, expand}, name, value) }
      }
    }
    const text = pick(STRINGS)
    return (A, draft) => { A.splice(draft, path, offset, width, text) }
  }

  return {value, edit}
}

function syncAll(docA, implA, docB, implB) {
  let stateA = implA.initSyncState(), stateB = implB.initSyncState()
  for (let round = 0; round < 50; round++) {
    let messageA, messageB
    ;[stateA, messageA] = implA.generateSyncMessage(docA, stateA)
    if (messageA) [docB, stateB] = implB.receiveSyncMessage(docB, stateB, messageA)
    ;[stateB, messageB] = implB.generateSyncMessage(docB, stateB)
    if (messageB) [docA, stateA] = implA.receiveSyncMessage(docA, stateA, messageB)
    if (!messageA && !messageB) return [docA, docB]
  }
  throw new Error('sync did not converge')
}

function assertPair(peer, context) {
  assert.deepStrictEqual(Classic.getHeads(peer.classic), Modern.getHeads(peer.modern), `heads ${context}`)
  assert.deepStrictEqual(plain(Classic.toJS(peer.classic)), plain(Modern.toJS(peer.modern)), `value ${context}`)
}

function run(seed) {
  const rand = random(seed)
  const {edit} = generator(rand)
  const peers = ACTORS.map(actor => ({classic: Classic.init(actor), modern: Modern.init(actor)}))

  for (let step = 0; step < STEPS; step++) {
    const index = Math.floor(rand() * peers.length)
    const peer = peers[index], other = peers[(index + 1 + Math.floor(rand() * (peers.length - 1))) % peers.length]
    const action = rand()
    const context = `seed ${seed} step ${step}`

    if (action < 0.7) {
      const fn = edit(peer.classic)
      peer.classic = Classic.change(peer.classic, {time: 0}, draft => fn(Classic, draft))
      peer.modern = Modern.change(peer.modern, {time: 0}, draft => fn(Modern, draft))
    } else if (action < 0.8) {
      peer.classic = Classic.merge(peer.classic, other.classic)
      peer.modern = Modern.merge(peer.modern, other.modern)
    } else if (action < 0.9) {
      [peer.classic, other.modern] = syncAll(peer.classic, Classic, other.modern, Modern)
      ;[other.classic, peer.modern] = syncAll(other.classic, Classic, peer.modern, Modern)
      assert.deepStrictEqual(Classic.getHeads(peer.classic), Modern.getHeads(other.modern), `sync ${context}`)
    } else {
      const fromClassic = Modern.load(Classic.save(peer.classic))
      const fromModern = Classic.load(Modern.save(peer.modern))
      assert.deepStrictEqual(plain(Modern.toJS(fromClassic)), plain(Classic.toJS(fromModern)), `load ${context}`)
      const changes = Modern.getAllChanges(peer.modern)
      const [applied] = Classic.applyChanges(Classic.init(), changes)
      assert.deepStrictEqual(plain(Classic.toJS(applied)), plain(Classic.toJS(peer.classic)), `applyChanges ${context}`)
    }
    for (const [index, p] of peers.entries()) assertPair(p, `${context} peer ${index}`)
  }

  let [a, b] = [peers[0].classic, peers[1].modern]
  for (const p of peers.slice(1)) a = Classic.merge(a, p.classic)
  for (const p of [peers[0], peers[2]]) b = Modern.merge(b, p.modern)
  assert.deepStrictEqual(Classic.getHeads(a), Modern.getHeads(b), `final heads seed ${seed}`)
  assert.deepStrictEqual(plain(Classic.toJS(a)), plain(Modern.toJS(b)), `final value seed ${seed}`)
  assertPair({classic: Classic.load(Modern.save(b)), modern: Modern.load(Classic.save(a))}, `final load seed ${seed}`)
}

describeLive('cross-implementation fuzz', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`agrees with Rust/WASM for seed ${seed}`, () => run(seed))
  }
})
