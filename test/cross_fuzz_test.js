import assert from 'node:assert'
import Classic from './subject.js'
import Modern, { describeLive } from './modern.js'
import { CHANGE_COLUMNS, decodeChangeColumns, decodeChangeMeta, decodeColumnInfo, decodeColumns, decodeContainerHeader, decodeOps, encodeChange, inflateColumn } from '../backend/columnar.js'
import { Decoder } from '../backend/encoding.js'
import { BUNDLE_OPS_COLUMNS } from '../backend/bundle.js'

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
      out.push({path, kind: 'list', length: node.length})
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
      if (target.length > 0 && rand() < 0.3) {
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

  return {value, edit, objects}
}

function levelOneTime(doc, fn) {
  const trial = Classic.change(Classic.clone(doc, Classic.getActorId(doc)), {time: 0}, draft => fn(Classic, draft))
  if (Classic.getHeads(trial).join() === Classic.getHeads(doc).join()) return 0
  const {columns, actorIds, ...change} = decodeChangeColumns(Classic.getLastLocalChange(trial))
  change.ops = decodeOps(decodeColumns(columns, actorIds, CHANGE_COLUMNS), false)
  delete change.hash
  for (let time = 1; ; time++) {
    change.time = time
    if (decodeChangeMeta(encodeChange(change), true).hash.startsWith('00')) return time
  }
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

function history(A, doc) {
  return A.getChangesMetaSince(doc, []).map(meta => meta.hash)
}

function deletesOrderUnstable(bundle) {
  const targets = Classic.readBundle(bundle).changes.flatMap(change => change.ops)
    .filter(op => op.action === 'del').map(op => `${op.obj} ${op.key || op.elemId}`)
  return new Set(targets).size < targets.length
}

function inflated(bundle) {
  const decoder = new Decoder(decodeContainerHeader(new Decoder(bundle), false).chunkData), parts = []
  for (let i = decoder.readUint53(); i > 0; i--) parts.push(decoder.readRawBytes(32))
  for (let i = decoder.readUint53(); i > 0; i--) parts.push(decoder.readHexString())
  for (let section = 0; section < 2; section++) {
    for (const column of decodeColumnInfo(decoder)) {
      column.buffer = decoder.readRawBytes(column.bufferLen)
      inflateColumn(column)
      parts.push(column.columnId, column.buffer)
    }
  }
  return parts
}

function canonicalBundle(bundle) {
  const decoder = new Decoder(decodeContainerHeader(new Decoder(bundle), false).chunkData), deps = [], actors = [], sections = []
  for (let i = decoder.readUint53(); i > 0; i--) deps.push(decoder.readRawBytes(32))
  for (let i = decoder.readUint53(); i > 0; i--) actors.push(decoder.readHexString())
  for (let section = 0; section < 2; section++) {
    const columns = decodeColumnInfo(decoder)
    for (const column of columns) {
      column.buffer = decoder.readRawBytes(column.bufferLen)
      inflateColumn(column)
    }
    sections.push(columns)
  }
  const ops = decodeColumns(sections[1], actors, BUNDLE_OPS_COLUMNS).map(op => JSON.stringify(Object.assign({}, op, {idCtrInverse: undefined})))
  function target(op) {
    const {action, objActor, objCtr, keyActor, keyCtr, keyStr} = JSON.parse(op)
    return action === 3 ? JSON.stringify([objActor, objCtr, keyActor, keyCtr, keyStr]) : null
  }
  for (let i = 0, j; i < ops.length; i = j) {
    for (j = i + 1; target(ops[i]) !== null && j < ops.length && target(ops[j]) === target(ops[i]); j++);
    ops.splice(i, j - i, ...ops.slice(i, j).sort())
  }
  return {deps, actors, changes: sections[0].map(({columnId, buffer}) => [columnId, buffer]), ops}
}

function assertBundles(metas, classic, modern, context) {
  assert.strictEqual(classic.length, modern.length, `bundle count ${context}`)
  for (let i = 0; i < classic.length; i++) {
    if (Buffer.compare(classic[i], modern[i]) === 0) continue
    if (metas[i].level === 0) {
      assert.strictEqual(modern[i][8], 2, `change bytes ${context}`)
      assert.deepStrictEqual(Classic.decodeChange(classic[i]), Classic.decodeChange(modern[i]), `change ${context}`)
    } else if (deletesOrderUnstable(modern[i])) {
      assert.deepStrictEqual(canonicalBundle(classic[i]), canonicalBundle(modern[i]), `bundle ${context}`)
    } else {
      assert.deepStrictEqual(inflated(classic[i]), inflated(modern[i]), `bundle bytes ${context}`)
    }
  }
}

function assertFragments(peer, context) {
  let {classic, modern} = peer, checked = peer.checked || new Set()
  if (history(Classic, classic).join() !== history(Modern, modern).join()) {
    const changes = Classic.getAllChanges(classic)
    ;[classic] = Classic.applyChanges(Classic.init(), changes)
    ;[modern] = Modern.applyChanges(Modern.init(), changes)
    checked = new Set()
  }
  for (const levels of [0, {start: 1}]) {
    const metas = Classic.getFragmentMetadata(classic, levels)
    assert.deepStrictEqual(metas, Modern.getFragmentMetadata(modern, levels), `fragments ${JSON.stringify(levels)} ${context}`)
    const fresh = metas.filter(meta => !checked.has(meta.head))
    assertBundles(fresh, Classic.bundleFragmentMetadata(classic, fresh), Modern.bundleFragmentMetadata(modern, fresh), `${JSON.stringify(levels)} ${context}`)
    for (const meta of fresh) checked.add(meta.head)
  }
}

function assertAddedAcross(peer, context) {
  const fromClassic = Modern.addCommits(Modern.addFragments(Modern.init(), Classic.getFragments(peer.classic)), Classic.getCommits(peer.classic))
  const fromModern = Classic.addCommits(Classic.addFragments(Classic.init(), Modern.getFragments(peer.modern)), Modern.getCommits(peer.modern))
  assertPair({classic: fromModern, modern: fromClassic}, `added ${context}`)
  assertPair({classic: peer.classic, modern: fromClassic}, `added from classic ${context}`)
}

function assertDiffPath(peer, objects, before, after, context) {
  const modern = Modern.load(Modern.save(peer.modern))
  if (JSON.stringify(plain(Classic.diff(peer.classic, before, after))) !== JSON.stringify(plain(Modern.diff(modern, before, after)))) return
  for (const {path} of objects(peer.classic, [], [])) {
    for (const opts of [undefined, {recursive: false}]) {
      assert.deepStrictEqual(plain(Classic.diffPath(peer.classic, path, before, after, opts)),
        plain(Modern.diffPath(modern, path, before, after, opts)), `diffPath ${JSON.stringify(path)} ${context}`)
    }
  }
}

function run(seed) {
  const rand = random(seed), mining = random(-seed)
  const {edit, objects} = generator(rand)
  const peers = ACTORS.map(actor => ({classic: Classic.init(actor), modern: Modern.init(actor), checked: new Set()}))

  for (let step = 0; step < STEPS; step++) {
    const index = Math.floor(rand() * peers.length)
    const peer = peers[index], other = peers[(index + 1 + Math.floor(rand() * (peers.length - 1))) % peers.length]
    const action = rand()
    const context = `seed ${seed} step ${step}`
    const touched = action >= 0.8 && action < 0.9 ? [peer, other] : [peer]

    if (action < 0.7) {
      const fn = edit(peer.classic), before = Classic.getHeads(peer.classic)
      const time = mining() < 0.1 ? levelOneTime(peer.classic, fn) : 0
      peer.classic = Classic.change(peer.classic, {time}, draft => fn(Classic, draft))
      peer.modern = Modern.change(peer.modern, {time}, draft => fn(Modern, draft))
      if (mining() < 0.1) assertDiffPath(peer, objects, before, Classic.getHeads(peer.classic), context)
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
      if (mining() < 0.3) assertAddedAcross(peer, context)
    }
    for (const [index, p] of peers.entries()) {
      assertPair(p, `${context} peer ${index}`)
      if (touched.includes(p)) assertFragments(p, `${context} peer ${index}`)
    }
  }

  let [a, b] = [peers[0].classic, peers[1].modern]
  for (const p of peers.slice(1)) a = Classic.merge(a, p.classic)
  for (const p of [peers[0], peers[2]]) b = Modern.merge(b, p.modern)
  assert.deepStrictEqual(Classic.getHeads(a), Modern.getHeads(b), `final heads seed ${seed}`)
  assert.deepStrictEqual(plain(Classic.toJS(a)), plain(Modern.toJS(b)), `final value seed ${seed}`)
  assertPair({classic: Classic.load(Modern.save(b)), modern: Modern.load(Classic.save(a))}, `final load seed ${seed}`)
  assertFragments({classic: a, modern: b}, `final seed ${seed}`)
  assertAddedAcross({classic: a, modern: Modern.applyChanges(Modern.init(), Classic.getAllChanges(a))[0]}, `final seed ${seed}`)
}

describeLive('cross-implementation fuzz', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`agrees with Rust/WASM for seed ${seed}`, () => run(seed))
  }
})
