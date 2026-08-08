import assert from 'node:assert'
import Automerge from './subject.js'

// Rich-text patch fuzzing. Every peer keeps a shadow copy that is built only
// from the patches it is handed: local changes, changes received over the
// network, sync messages and incremental loads. The shadow tracks marks and
// block markers as well as values, so the invariants cover span generation:
//
//   1. the shadow equals toJS(doc) and spans(doc, path) for every text;
//   2. a shadow rebuilt from diff(doc, [], heads) equals the same thing, so
//      the incremental patch stream and the diff from the root agree;
//   3. reloading a saved document reproduces both.
//
// Generated edits deliberately include empty marks, marks whose range is
// concurrently deleted, insertions into a mark received from another peer,
// block markers spliced over, and partially delivered changes.

const IMMUTABLE = Automerge.ImmutableString

function newText() { return {kind: 'text', elems: []} }
function isText(value) { return isPlain(value) && value.kind === 'text' && Array.isArray(value.elems) }
function isCounter(value) { return isPlain(value) && value.kind === 'counter' }
function isPlain(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function shadowValue(value) {
  if (typeof value === 'string') return newText()
  if (Array.isArray(value)) return []
  if (value instanceof Automerge.Counter) return {kind: 'counter', value: value.value}
  if (Automerge.isImmutableString(value)) return new IMMUTABLE(value.val)
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof Uint8Array) return value.slice()
  if (isPlain(value)) {
    const copy = {}
    for (const key of Object.keys(value)) copy[key] = shadowValue(value[key])
    return copy
  }
  return value
}

function elementWidth(element) { return element.block ? 1 : element.value.length }

function elementIndex(text, offset) {
  let index = 0, at = 0
  while (index < text.elems.length && at < offset) {
    at += elementWidth(text.elems[index])
    index++
  }
  if (at !== offset) throw new RangeError(`offset ${offset} falls inside an element`)
  return index
}

function child(node, key) {
  if (isText(node)) return node.elems[elementIndex(node, key)].block
  return node[key]
}

function resolve(root, path) {
  let node = root
  for (let index = 0; index < path.length - 1; index++) node = child(node, path[index])
  return {parent: node, key: path[path.length - 1]}
}

function deleteText(text, offset, length) {
  const start = elementIndex(text, offset)
  let count = 0, deleted = 0
  while (start + count < text.elems.length && deleted < length) {
    deleted += elementWidth(text.elems[start + count])
    count++
  }
  text.elems.splice(start, count)
}

function markRange(text, start, end, apply) {
  let at = 0
  for (const element of text.elems) {
    const width = elementWidth(element)
    if (at >= start && at + width <= end) apply(element)
    at += width
  }
}

function applyShadowPatch(root, patch) {
  const {parent, key} = resolve(root, patch.path)
  if (patch.action === 'put') {
    if (isText(parent)) parent.elems[elementIndex(parent, key)].block = shadowValue(patch.value)
    else parent[key] = shadowValue(patch.value)
  } else if (patch.action === 'insert') {
    if (isText(parent)) {
      const elements = patch.values.map(() => ({block: {}, marks: {}}))
      parent.elems.splice(elementIndex(parent, key), 0, ...elements)
    } else {
      parent.splice(key, 0, ...patch.values.map(shadowValue))
    }
  } else if (patch.action === 'splice') {
    const marks = patch.marks ? Object.assign({}, patch.marks) : {}
    const elements = [...patch.value].map(value => ({value, marks: Object.assign({}, marks)}))
    parent.elems.splice(elementIndex(parent, key), 0, ...elements)
  } else if (patch.action === 'del') {
    if (isText(parent)) deleteText(parent, key, patch.length || 1)
    else if (Array.isArray(parent)) parent.splice(key, patch.length || 1)
    else delete parent[key]
  } else if (patch.action === 'inc') {
    parent[key].value += patch.value
  } else if (patch.action === 'mark') {
    const text = child(parent, key)
    for (const value of patch.marks) {
      markRange(text, value.start, value.end, element => {
        if (value.value === null) delete element.marks[value.name]
        else element.marks[value.name] = value.value
      })
    }
  } else if (patch.action === 'unmark') {
    markRange(child(parent, key), patch.start, patch.end, element => { delete element.marks[patch.name] })
  } else if (patch.action !== 'conflict') {
    throw new RangeError(`unsupported patch action: ${patch.action}`)
  }
}

function applyShadowPatches(root, patches) {
  for (const patch of patches) applyShadowPatch(root, patch)
}

function canonical(value) {
  if (isText(value)) {
    return value.elems.map(element => (element.block ? '￼' : element.value)).join('')
  }
  if (isCounter(value)) return {counter: value.value}
  if (value instanceof Automerge.Counter) return {counter: value.value}
  if (Automerge.isImmutableString(value)) return {immutable: value.val}
  if (value instanceof Date) return {date: value.getTime()}
  if (value instanceof Uint8Array) return {bytes: [...value]}
  if (Array.isArray(value)) return value.map(canonical)
  if (isPlain(value)) {
    const copy = {}
    for (const key of Object.keys(value).sort()) copy[key] = canonical(value[key])
    return copy
  }
  return value
}

function sameMarks(left, right) {
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  return leftKeys.every((key, index) => key === rightKeys[index] &&
    JSON.stringify(canonical(left[key])) === JSON.stringify(canonical(right[key])))
}

function shadowSpans(text) {
  const result = []
  let value = '', active = null
  for (const element of text.elems) {
    if (element.block) {
      if (value.length > 0) result.push(textSpan(value, active))
      result.push({type: 'block', value: canonical(element.block)})
      value = ''
      active = null
      continue
    }
    if (active !== null && !sameMarks(active, element.marks)) {
      result.push(textSpan(value, active))
      value = ''
    }
    value += element.value
    active = element.marks
  }
  if (value.length > 0) result.push(textSpan(value, active))
  return result
}

function textSpan(value, marks) {
  const active = {}
  for (const key of Object.keys(marks).sort()) active[key] = canonical(marks[key])
  return Object.keys(active).length > 0 ? {type: 'text', value, marks: active} : {type: 'text', value}
}

function textPaths(node, path = []) {
  const found = []
  if (isText(node)) return [path]
  if (Array.isArray(node)) {
    node.forEach((value, index) => found.push(...textPaths(value, path.concat(index))))
  } else if (isPlain(node) && !isCounter(node) && !(node instanceof Date) &&
             !(node instanceof Uint8Array) && !Automerge.isImmutableString(node)) {
    for (const key of Object.keys(node)) found.push(...textPaths(node[key], path.concat(key)))
  }
  return found
}

function json(value) { return JSON.stringify(canonical(value)) }

function checkDocument(doc, shadow, label) {
  assert.strictEqual(json(shadow), json(Automerge.toJS(doc)), `${label}: value diverged`)
  for (const path of textPaths(shadow)) {
    const text = path.reduce((node, key) => child(node, key), shadow)
    assert.strictEqual(json(shadowSpans(text)), json(Automerge.spans(doc, path)),
      `${label}: spans diverged at ${path.join('.')}`)
  }
}

function rebuildFromRoot(doc) {
  const root = {}
  applyShadowPatches(root, Automerge.diff(doc, [], Automerge.getHeads(doc)))
  return root
}

function prng(seed) {
  let state = (seed >>> 0) || 1
  return function () {
    state = (state * 1103515245 + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

const MARK_NAMES = ['bold', 'em', 'link']
const MARK_VALUES = [true, 1, 'x']
const EXPANDS = ['before', 'after', 'both', 'none']
const BLOCK_TYPES = ['paragraph', 'heading', 'list-item']

function makeFuzz(seed) {
  const rand = prng(seed)
  const chars = 'abcde 😀é\n'
  function int(bound) { return Math.floor(rand() * bound) }
  function pick(list) { return list[int(list.length)] }
  function randText(length) { return Array.from({length}, () => chars[int(chars.length)]).join('') }

  const peers = [0, 1, 2].map(index => ({
    doc: Automerge.init(String(index + 1).repeat(32)),
    shadow: {},
    sync: [Automerge.initSyncState(), Automerge.initSyncState(), Automerge.initSyncState()]
  }))

  function absorb(peer, patches) { applyShadowPatches(peer.shadow, patches) }

  function withPatches(peer, run) {
    const patches = []
    const result = run(p => patches.push(...p))
    absorb(peer, patches)
    return result
  }

  function textDoc(doc, path) {
    const value = path.reduce((node, key) => (node === undefined ? undefined : node[key]), Automerge.toJS(doc))
    return typeof value === 'string' ? value : undefined
  }

  function draftText(draft, path) {
    const value = path.reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), draft)
    return typeof value === 'string' ? value : undefined
  }

  function editText(draft, doc, path) {
    const current = draftText(draft, path)
    const length = current === undefined ? -1 : current.length
    if (length < 0) {
      if (path.length === 1) draft[path[0]] = randText(1 + int(4))
      else {
        if (!draft[path[0]]) draft[path[0]] = {}
        draft[path[0]][path[1]] = randText(1 + int(4))
      }
      return
    }
    const choice = int(10)
    if (choice < 4) {
      Automerge.splice(draft, path, int(length + 1), 0, randText(1 + int(3)))
    } else if (choice < 6 && length > 0) {
      const at = int(length)
      Automerge.splice(draft, path, at, 1 + int(length - at))
    } else if (choice < 7) {
      Automerge.updateText(draft, path, randText(int(3)) + current.slice(int(current.length + 1)))
    } else if (choice < 9) {
      const start = int(length + 1)
      const end = int(2) === 0 ? start : start + int(length - start + 1)
      Automerge.mark(draft, path, {start, end, expand: pick(EXPANDS)}, pick(MARK_NAMES), pick(MARK_VALUES))
    } else {
      const start = int(length + 1)
      const end = start + int(length - start + 1)
      Automerge.unmark(draft, path, {start, end, expand: pick(EXPANDS)}, pick(MARK_NAMES))
    }
  }

  function editBlocks(draft, doc, path) {
    const current = draftText(draft, path)
    if (current === undefined) return
    const at = int(current.length + 1)
    const isBlock = current[at] === '￼'
    const choice = int(4)
    if (choice === 0) {
      Automerge.splitBlock(draft, path, at, {type: pick(BLOCK_TYPES), parents: [], attrs: {}})
    } else if (choice === 1 && isBlock) {
      Automerge.joinBlock(draft, path, at)
    } else if (choice === 2 && isBlock) {
      Automerge.updateBlock(draft, path, at, {type: pick(BLOCK_TYPES), parents: [], attrs: {level: int(3)}})
    } else if (current === textDoc(doc, path)) {
      const spans = Automerge.spans(doc, path).map(span => {
        if (span.type === 'block') return {type: 'block', value: Object.assign({}, span.value, {type: pick(BLOCK_TYPES)})}
        if (int(3) === 0) return {type: 'text', value: span.value + randText(1), marks: span.marks}
        return span
      })
      if (spans.length > 0) Automerge.updateSpans(draft, path, spans)
    }
  }

  function editValues(draft) {
    const key = 'k' + int(5)
    const choice = int(8)
    if (choice === 0) draft[key] = {inner: randText(2)}
    else if (choice === 1) draft[key] = [int(9), randText(2)]
    else if (choice === 2) delete draft[key]
    else if (choice === 3) draft[key] = new Automerge.Counter(int(10))
    else if (choice === 4 && draft[key] instanceof Automerge.Counter) draft[key].increment(1 + int(5))
    else if (choice === 5) draft[key] = new IMMUTABLE(randText(2))
    else if (choice === 6) {
      if (!Array.isArray(draft.list)) draft.list = []
      const length = draft.list.length
      if (length === 0 || int(3) === 0) Automerge.insertAt(draft.list, int(length + 1), int(50))
      else if (int(2) === 0) Automerge.deleteAt(draft.list, int(length))
      else draft.list[int(length)] = randText(2)
    } else draft[key] = int(100)
  }

  function change(peer) {
    const doc = peer.doc
    peer.doc = withPatches(peer, push => Automerge.change(doc, {time: 0, patchCallback: push}, draft => {
      const count = 1 + int(3)
      for (let index = 0; index < count; index++) {
        const kind = int(10)
        if (kind < 4) editText(draft, doc, ['text'])
        else if (kind < 6) editText(draft, doc, ['nested', 'text'])
        else if (kind < 8) editBlocks(draft, doc, ['text'])
        else editValues(draft)
      }
    }))
  }

  function changeAtOldHeads(peer) {
    const history = Automerge.getHistory(peer.doc)
    if (history.length < 2) return
    const heads = [history[int(history.length - 1)].change.hash]
    const doc = peer.doc
    peer.doc = withPatches(peer, push => Automerge.changeAt(doc, heads, {time: 0, patchCallback: push}, draft => {
      editValues(draft)
    }).newDoc)
  }

  function sendChanges(from, to, partial) {
    let changes
    try { changes = Automerge.getChanges(to.doc, from.doc) } catch { return }
    if (changes.length === 0) return
    const count = partial ? 1 + int(changes.length) : changes.length
    const doc = to.doc
    to.doc = withPatches(to, push =>
      Automerge.applyChanges(doc, changes.slice(0, count), {patchCallback: push})[0])
  }

  function syncOnce(from, to) {
    const fromIndex = peers.indexOf(from), toIndex = peers.indexOf(to)
    const [state, message] = Automerge.generateSyncMessage(from.doc, from.sync[toIndex])
    from.sync[toIndex] = state
    if (!message) return
    const doc = to.doc
    to.doc = withPatches(to, push => {
      const [next, syncState] = Automerge.receiveSyncMessage(doc, to.sync[fromIndex], message, {patchCallback: push})
      to.sync[fromIndex] = syncState
      return next
    })
  }

  function sendIncremental(from, to) {
    if (from === to) return
    const doc = to.doc
    to.doc = withPatches(to, push =>
      Automerge.loadIncremental(doc, Automerge.save(from.doc), {patchCallback: push}))
  }

  return {peers, rand, int, pick, change, changeAtOldHeads, sendChanges, syncOnce, sendIncremental}
}

function fuzzRun(seed, steps) {
  const fuzz = makeFuzz(seed)
  const {peers, rand, int, pick} = fuzz

  for (let step = 0; step < steps; step++) {
    const label = `seed ${seed} step ${step}`
    const roll = rand()
    if (roll < 0.5) fuzz.change(pick(peers))
    else if (roll < 0.55) fuzz.changeAtOldHeads(pick(peers))
    else if (roll < 0.8) fuzz.sendChanges(pick(peers), pick(peers), int(2) === 0)
    else if (roll < 0.95) fuzz.syncOnce(pick(peers), pick(peers))
    else fuzz.sendIncremental(pick(peers), pick(peers))

    for (const peer of peers) {
      checkDocument(peer.doc, peer.shadow, label)
      checkDocument(peer.doc, rebuildFromRoot(peer.doc), `${label} (diff from root)`)
    }
  }

  for (let round = 0; round < 3; round++) {
    for (const from of peers) for (const to of peers) if (from !== to) fuzz.sendChanges(from, to, false)
  }

  const heads = JSON.stringify(Automerge.getHeads(peers[0].doc))
  for (const peer of peers) {
    const label = `seed ${seed} converged`
    assert.strictEqual(JSON.stringify(Automerge.getHeads(peer.doc)), heads, `${label}: heads diverged`)
    checkDocument(peer.doc, peer.shadow, label)
    checkDocument(peer.doc, rebuildFromRoot(peer.doc), `${label} (diff from root)`)
    const reloaded = Automerge.load(Automerge.save(peer.doc))
    checkDocument(reloaded, peer.shadow, `${label} (reloaded)`)
    checkDocument(reloaded, rebuildFromRoot(reloaded), `${label} (reloaded, diff from root)`)
  }
}

describe('rich text patch fuzzing', () => {
  it('keeps patch streams, diffs from the root, and reloads in agreement', () => {
    const seeds = process.env.FUZZ_SEEDS
      ? process.env.FUZZ_SEEDS.split(',').map(Number)
      : Array.from({length: 25}, (unused, index) => index + 1)
    for (const seed of seeds) fuzzRun(seed, Number(process.env.FUZZ_STEPS) || 60)
  }, 240000)

  it('applies an insertion into a mark that is concurrently deleted', () => {
    let base = Automerge.from({text: 'abcdef'}, '1'.repeat(32))
    let marker = Automerge.merge(Automerge.init('2'.repeat(32)), base)
    marker = Automerge.change(marker, {time: 0}, draft => {
      Automerge.mark(draft, ['text'], {start: 3, end: 3, expand: 'both'}, 'bold', true)
    })
    let inserter = Automerge.merge(Automerge.init('3'.repeat(32)), marker)
    inserter = Automerge.change(inserter, {time: 0}, draft => {
      Automerge.splice(draft, ['text'], 3, 0, 'XY')
    })
    let deleter = Automerge.merge(Automerge.init('4'.repeat(32)), marker)
    deleter = Automerge.change(deleter, {time: 0}, draft => {
      Automerge.splice(draft, ['text'], 2, 2)
    })

    const shadow = {}
    let doc = Automerge.init()
    const patches = []
    ;[doc] = Automerge.applyChanges(doc, [
      ...Automerge.getAllChanges(base),
      Automerge.getLastLocalChange(marker),
      Automerge.getLastLocalChange(inserter),
      Automerge.getLastLocalChange(deleter)
    ], {patchCallback: p => patches.push(...p)})
    applyShadowPatches(shadow, patches)

    checkDocument(doc, shadow, 'empty mark')
    checkDocument(doc, rebuildFromRoot(doc), 'empty mark (diff from root)')
    checkDocument(Automerge.load(Automerge.save(doc)), shadow, 'empty mark (reloaded)')
  })

  it('applies an empty mark delivered before the text it will contain', () => {
    let author = Automerge.from({text: 'hello'}, '1'.repeat(32))
    const first = Automerge.getLastLocalChange(author)
    author = Automerge.change(author, {time: 0}, draft => {
      Automerge.mark(draft, ['text'], {start: 2, end: 2, expand: 'both'}, 'em', 1)
    })
    const second = Automerge.getLastLocalChange(author)
    author = Automerge.change(author, {time: 0}, draft => {
      Automerge.splice(draft, ['text'], 2, 0, 'Z')
    })
    const third = Automerge.getLastLocalChange(author)

    for (const batches of [[[first], [second], [third]], [[first], [second, third]], [[first, second, third]]]) {
      const shadow = {}
      let doc = Automerge.init()
      for (const batch of batches) {
        const patches = []
        ;[doc] = Automerge.applyChanges(doc, batch, {patchCallback: p => patches.push(...p)})
        applyShadowPatches(shadow, patches)
      }
      checkDocument(doc, shadow, 'staged empty mark')
      checkDocument(doc, rebuildFromRoot(doc), 'staged empty mark (diff from root)')
    }
  })
})
