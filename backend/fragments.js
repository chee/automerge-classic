import { encodeDocumentBundle } from './bundle.js'
import { DOC_OPS_COLUMNS, compressChange, decodeColumns, decodeDocumentHeader, decodeOps } from './columnar.js'
import { backendState } from './util.js'

const graphs = new WeakMap()

function fragmentLevel(hash) {
  let level = 0
  while (hash.startsWith('00', level * 2)) level++
  return level
}

function merge(clock, other) {
  for (const [actor, seq] of other) {
    if (!(clock.get(actor) >= seq)) clock.set(actor, seq)
  }
}

function covers(clock, other) {
  for (const [actor, seq] of other) {
    if (!(clock.get(actor) >= seq)) return false
  }
  return true
}

function bfs(graph, seeds, clock) {
  const queue = seeds.slice(), seen = new Set(queue)
  for (let i = 0; i < queue.length; i++) {
    for (const parent of graph.parents[queue[i]]) {
      if (!seen.has(parent) && !(clock.get(graph.actors[parent]) >= graph.seqs[parent])) {
        seen.add(parent)
        queue.push(parent)
      }
    }
  }
  return queue
}

function clockOf(graph, node) {
  const clock = new Map(), stack = [node], seen = new Set(stack)
  while (stack.length > 0) {
    const current = stack.pop()
    if (current !== node && graph.clocks.has(current)) {
      merge(clock, graph.clocks.get(current))
      continue
    }
    if (!(clock.get(graph.actors[current]) >= graph.seqs[current])) clock.set(graph.actors[current], graph.seqs[current])
    for (const parent of graph.parents[current]) {
      if (!seen.has(parent)) {
        seen.add(parent)
        stack.push(parent)
      }
    }
  }
  return clock
}

function addFragment(graph, node, level) {
  const clock = clockOf(graph, node), deps = [], kept = []
  for (let i = graph.fragments.length - 1; i >= 0; i--) {
    const fragment = graph.fragments[i]
    if (covers(clock, fragment.clock)) {
      if (fragment.level < level) continue
      deps.push(fragment.node)
    }
    kept.push(fragment)
  }
  kept.reverse()
  kept.push({node, level, deps, clock})
  graph.fragments = kept
  graph.clocks.set(node, clock)
  merge(graph.top, clock)
}

function historyGraph(state) {
  if (!state.haveHashGraph) state.computeHashGraph()
  if (!graphs.has(state)) {
    graphs.set(state, {
      actors: [], seqs: [], parents: [], positions: new Map(), counts: {}, clocks: new Map(), fragments: [], top: new Map(), exported: new Map()
    })
  }
  const graph = graphs.get(state)
  graph.hashes = state.historyHashes
  for (const actor of Object.keys(state.hashesByActor)) {
    const hashes = state.hashesByActor[actor]
    for (let seq = graph.counts[actor] || 0; seq < hashes.length; seq++) graph.positions.set(hashes[seq], [actor, seq + 1])
    graph.counts[actor] = hashes.length
  }
  for (let node = graph.actors.length; node < graph.hashes.length; node++) {
    const hash = graph.hashes[node], [actor, seq] = graph.positions.get(hash)
    graph.actors.push(actor)
    graph.seqs.push(seq)
    graph.parents.push(state.dependenciesByHash[hash].map(dep => state.changeIndexByHash[dep]))
    const level = fragmentLevel(hash)
    if (level > 0) addFragment(graph, node, level)
  }
  return graph
}

function looseCommit(graph, node) {
  const head = graph.hashes[node]
  return {head, level: 0, boundary: graph.parents[node].map(parent => graph.hashes[parent]), checkpoints: [], members: [head]}
}

function exportFragment(graph, fragment) {
  let exported = graph.exported.get(fragment.node)
  if (!exported) {
    const head = graph.hashes[fragment.node], clock = new Map()
    for (const dep of fragment.deps) merge(clock, graph.clocks.get(dep))
    const members = bfs(graph, [fragment.node], clock).map(node => graph.hashes[node])
    exported = {
      head,
      level: fragment.level,
      boundary: fragment.deps.map(dep => graph.hashes[dep]),
      checkpoints: members.filter(hash => hash !== head && fragmentLevel(hash) > 0),
      members
    }
    graph.exported.set(fragment.node, exported)
  }
  return {
    head: exported.head, level: exported.level, boundary: exported.boundary.slice(),
    checkpoints: exported.checkpoints.slice(), members: exported.members.slice()
  }
}

function getFragments(backend, start, end) {
  const state = backendState(backend, true), graph = historyGraph(state)
  const fragments = graph.fragments
    .filter(fragment => fragment.level >= start && fragment.level < end)
    .map(fragment => exportFragment(graph, fragment))
  if (start > 0 || end <= 0) return fragments
  const heads = state.heads.filter(head => fragmentLevel(head) === 0).map(head => state.changeIndexByHash[head])
  return fragments.concat(bfs(graph, heads, graph.top).reverse().map(node => looseCommit(graph, node)))
}

function getFragment(backend, hash) {
  const state = backendState(backend, true), graph = historyGraph(state)
  const node = state.changeIndexByHash[hash]
  if (node === undefined) return null
  if (fragmentLevel(hash) === 0) return looseCommit(graph, node)
  const fragment = graph.fragments.find(fragment => fragment.node === node)
  return fragment ? exportFragment(graph, fragment) : null
}

function documentOps(state) {
  const saveCursor = state.saveCursor
  const {opsColumns, actorIds} = decodeDocumentHeader(state.save())
  state.saveCursor = saveCursor
  return decodeOps(decodeColumns(opsColumns, actorIds, DOC_OPS_COLUMNS), true)
}

function bundleFragments(backend, fragments) {
  const state = backendState(backend, true)
  if (!state.haveHashGraph) state.computeHashGraph()
  const bundles = []
  let ops
  for (const fragment of fragments) {
    if (fragmentLevel(fragment.head) === 0 && fragment.members.length === 1) {
      const index = state.changeIndexByHash[fragment.head]
      if (index !== undefined) bundles.push(compressChange(state.changes[index]))
    } else if (fragment.members.every(hash => state.changeIndexByHash[hash] !== undefined)) {
      const indexes = fragment.members.map(hash => state.changeIndexByHash[hash]).sort((a, b) => a - b)
      ops = ops || documentOps(state)
      bundles.push(encodeDocumentBundle(indexes.map(index => state.changes[index]), ops))
    }
  }
  return bundles
}

export { bundleFragments, documentOps, getFragment, getFragments }
