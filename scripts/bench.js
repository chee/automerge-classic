import {createRequire} from 'node:module'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const resolve = createRequire(import.meta.url).resolve

const IMPLS = {
  classic: () => import(pathToFileURL(path.resolve(here, '..', 'src', 'automerge.js')).href),
  modern: () => import(pathToFileURL(resolve(process.env.AUTOMERGE_MODERN_PATH ||
    path.resolve(here, '..', '..', 'automerge', 'javascript'))).href)
}

function bigDoc(A) {
  let doc = A.from({text: '', list: [], map: {}})
  doc = A.change(doc, d => {
    for (let i = 0; i < 2000; i++) A.splice(d, ['text'], d.text.length, 0, 'lorem ipsum ')
    for (let i = 0; i < 2000; i++) d.list.push(i)
    for (let i = 0; i < 2000; i++) d.map['key' + i] = i
  })
  return doc
}

function largeDoc(A) {
  let doc = A.from({text: '', list: [], map: {}}), mid, prev
  for (let i = 0; i < 5000; i++) {
    if (i === 2500) mid = A.getHeads(doc)
    if (i === 4999) prev = A.getHeads(doc)
    doc = A.change(doc, d => {
      A.splice(d, ['text'], (i * 7919) % (d.text.length + 1), 0, 'lorem ipsum dolor ')
      d.list.push({n: i, s: 'item' + i})
      d.map['key' + (i % 500)] = i
    })
  }
  return {doc, mid, prev}
}

let large

function largeContext(A) {
  if (!large) {
    large = largeDoc(A)
    large.bytes = A.save(large.doc)
  }
  return {...large, unsaved: A.change(A.clone(large.doc), d => { d.map.key0 = -1 }), fresh: A.clone(large.doc)}
}

function loadedContext(A) {
  const ctx = largeContext(A)
  return {...ctx, loaded: A.load(ctx.bytes)}
}

function markedContext(A) {
  let doc = A.from({text: ''})
  doc = A.change(doc, d => {
    for (let i = 0; i < 500; i++) A.splice(d, ['text'], d.text.length, 0, 'lorem ipsum ')
    for (let i = 0; i < 100; i++) A.mark(d, ['text'], {start: i * 50, end: i * 50 + 20, expand: 'both'}, 'bold', true)
  })
  return {doc}
}

function branchesContext(A) {
  const base = bigDoc(A)
  let left = A.clone(base), right = A.clone(base)
  for (let i = 0; i < 200; i++) {
    left = A.change(left, d => { d.list.push(i) })
    right = A.change(right, d => { A.splice(d, ['text'], i, 0, 'z'); d.map['k' + i] = i })
  }
  return {left, right}
}

function sequentialDiffs(A, doc, edit) {
  let heads = A.getHeads(doc)
  const out = []
  for (let i = 0; i < 20; i++) {
    const before = heads
    doc = A.change(doc, d => edit(d, i))
    heads = A.getHeads(doc)
    out.push(A.diff(doc, before, heads))
  }
  return out
}

const WORKLOADS = {
  'map: 6000 writes to one key': A => {
    let doc = A.from({counter: 0})
    for (let i = 0; i < 6000; i++) doc = A.change(doc, d => { d.counter = i })
    return doc
  },

  'map: 2000 distinct keys': A => {
    let doc = A.init()
    for (let i = 0; i < 2000; i++) doc = A.change(doc, d => { d['key' + i] = i })
    return doc
  },

  'list: 3000 appends': A => {
    let doc = A.from({list: []})
    for (let i = 0; i < 3000; i++) doc = A.change(doc, d => { d.list.push(i) })
    return doc
  },

  'list: 3000 object appends': A => {
    let doc = A.from({list: []})
    for (let i = 0; i < 3000; i++) doc = A.change(doc, d => { d.list.push({n: i}) })
    return doc
  },

  'list: 3000 appends in one change': A => {
    let doc = A.from({list: []})
    return A.change(doc, d => { for (let i = 0; i < 3000; i++) d.list.push(i) })
  },

  'text: 5000 char inserts at end': A => {
    let doc = A.from({text: ''})
    for (let i = 0; i < 5000; i++) doc = A.change(doc, d => { A.splice(d, ['text'], d.text.length, 0, 'x') })
    return doc
  },

  'text: 5000 char inserts at start': A => {
    let doc = A.from({text: ''})
    for (let i = 0; i < 5000; i++) doc = A.change(doc, d => { A.splice(d, ['text'], 0, 0, 'x') })
    return doc
  },

  'text: 20000 chars in one change': A => {
    let doc = A.from({text: ''})
    return A.change(doc, d => { for (let i = 0; i < 20000; i++) A.splice(d, ['text'], d.text.length, 0, 'x') })
  },

  'save: 6000-op doc': (A, ctx) => A.save(ctx.unsaved),

  'load: 6000-op doc': (A, ctx) => A.load(ctx.bytes),

  'save: 5000-change doc': [largeContext, (A, ctx) => A.save(ctx.unsaved)],

  'load: 5000-change doc': [largeContext, (A, ctx) => A.load(ctx.bytes)],

  'load + getAllChanges: 5000-change doc': [largeContext, (A, ctx) => A.getAllChanges(A.load(ctx.bytes))],

  'clone+change x1000': (A, ctx) => {
    let doc = ctx.doc
    for (let i = 0; i < 1000; i++) doc = A.change(doc, d => { d.map.key0 = i })
    return doc
  },

  'getChanges + applyChanges (2000 changes)': (A, ctx) => {
    const changes = A.getAllChanges(ctx.smallHistory)
    let doc = A.init()
    ;[doc] = A.applyChanges(doc, changes)
    return doc
  },

  'merge two 1000-change branches': A => {
    let base = A.from({a: [], b: []})
    let left = A.clone(base), right = A.clone(base)
    for (let i = 0; i < 1000; i++) {
      left = A.change(left, d => { d.a.push(i) })
      right = A.change(right, d => { d.b.push(i) })
    }
    return A.merge(left, right)
  },

  'sync: full doc to empty peer': (A, ctx) => {
    let a = ctx.doc, b = A.init()
    let sa = A.initSyncState(), sb = A.initSyncState()
    for (let round = 0; round < 200; round++) {
      let ma, mb
      ;[sa, ma] = A.generateSyncMessage(a, sa)
      if (ma) [b, sb] = A.receiveSyncMessage(b, sb, ma)
      ;[sb, mb] = A.generateSyncMessage(b, sb)
      if (mb) [a, sa] = A.receiveSyncMessage(a, sa, mb)
      if (!ma && !mb) break
    }
    return b
  },

  'sync: steady state, 100 rounds': (A, ctx) => {
    let a = ctx.doc, b = A.load(ctx.bytes)
    let sa = A.initSyncState(), sb = A.initSyncState()
    for (let i = 0; i < 100; i++) {
      a = A.change(a, d => { d.list.push(i) })
      let ma, mb
      ;[sa, ma] = A.generateSyncMessage(a, sa)
      if (ma) [b, sb] = A.receiveSyncMessage(b, sb, ma)
      ;[sb, mb] = A.generateSyncMessage(b, sb)
      if (mb) [a, sa] = A.receiveSyncMessage(a, sa, mb)
    }
    return b
  },

  'diff: 20 sequential list edits': (A, ctx) => {
    let doc = ctx.doc, heads = A.getHeads(doc), out = []
    for (let i = 0; i < 20; i++) {
      const before = heads
      doc = A.change(doc, d => { d.list.push(i) })
      heads = A.getHeads(doc)
      out.push(A.diff(doc, before, heads))
    }
    return out
  },

  'diff: 20 sequential text edits': (A, ctx) => {
    let doc = ctx.doc, heads = A.getHeads(doc), out = []
    for (let i = 0; i < 20; i++) {
      const before = heads
      doc = A.change(doc, d => { A.splice(d, ['text'], 5, 0, 'z') })
      heads = A.getHeads(doc)
      out.push(A.diff(doc, before, heads))
    }
    return out
  },

  'diff: heads to heads': (A, ctx) => {
    const before = A.getHeads(ctx.doc)
    let doc = A.change(ctx.doc, d => { for (let i = 0; i < 500; i++) d.list.push(i) })
    return A.diff(doc, before, A.getHeads(doc))
  },

  'diff: large doc, 20 sequential list edits': [largeContext, (A, ctx) =>
    sequentialDiffs(A, ctx.fresh, (d, i) => { d.list.push({n: i}) })],

  'diff: large doc, 20 sequential text edits': [largeContext, (A, ctx) =>
    sequentialDiffs(A, ctx.fresh, d => { A.splice(d, ['text'], 100, 0, 'z') })],

  'diff: large doc, midpoint to current': [largeContext, (A, ctx) =>
    A.diff(ctx.doc, ctx.mid, A.getHeads(ctx.doc))],

  'diff: large doc, current to midpoint': [largeContext, (A, ctx) =>
    A.diff(ctx.doc, A.getHeads(ctx.doc), ctx.mid)],

  'diff: loaded large doc, last change': [loadedContext, (A, ctx) =>
    A.diff(ctx.loaded, ctx.prev, A.getHeads(ctx.loaded))],

  'diff: marked text, 20 sequential edits': [markedContext, (A, ctx) =>
    sequentialDiffs(A, ctx.doc, (d, i) => { A.splice(d, ['text'], i * 50 + 10, 0, 'z') })],

  'diff: across merge of 200-change branches': [branchesContext, (A, ctx) => {
    const before = A.getHeads(ctx.left)
    const merged = A.merge(ctx.left, ctx.right)
    return A.diff(merged, before, A.getHeads(merged))
  }]

}

function context(A) {
  const doc = bigDoc(A)
  const bytes = A.save(doc)
  let smallHistory = A.from({list: []})
  for (let i = 0; i < 2000; i++) smallHistory = A.change(smallHistory, d => { d.list.push(i) })
  return {doc, bytes, smallHistory, unsaved: bigDoc(A)}
}

async function run() {
  const impl = process.argv[2]
  const only = process.argv[3]
  const A = await IMPLS[impl]()
  const results = {}
  for (const [name, workload] of Object.entries(WORKLOADS)) {
    if (only && name !== only) continue
    const [setup, fn] = Array.isArray(workload) ? workload : [context, workload]
    const ctx = setup(A)
    if (global.gc) global.gc()
    const start = process.hrtime.bigint()
    fn(A, ctx)
    results[name] = Number(process.hrtime.bigint() - start) / 1e6
  }
  process.stdout.write(JSON.stringify(results))
}

await run()
