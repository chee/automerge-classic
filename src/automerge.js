const uuid = require('./uuid')
const Frontend = require('../frontend')
const { OPTIONS, OBJECT_ID, CONFLICTS } = require('../frontend/constants')
const { encodeChange: encodeChangeRaw, decodeChange, decodeChangeMeta, decodeChanges, splitContainers } = require('../backend/columnar')
const { isObject, parseOpId, compareUtf8, wellFormedString } = require('./common')
const { ImmutableString, isImmutableString } = require('./immutable_string')
const { myersDiff, graphemes, replaceHook } = require('./text_diff')
let backend = require('../backend') // mutable: can be overridden with setDefaultBackend()
const viewDocs = new WeakSet()
const fragmentMetadataCache = new WeakMap()

/**
 * Automerge.* API
 * The functions in this file constitute the publicly facing Automerge API which combines
 * the features of the Frontend (a document interface) and the backend (CRDT operations)
 */

function normalizeInitOptions(options) {
  if (typeof options === 'string' || typeof options === 'undefined') return options
  if (!isObject(options)) return options
  if (options.actorId !== undefined || !Object.prototype.hasOwnProperty.call(options, 'actor')) return options
  const normalized = Object.assign({}, options)
  if (options.actor !== null && options.actor !== undefined) normalized.actorId = options.actor
  delete normalized.actor
  return normalized
}

function encodeChange(change, actorOrder) {
  if (!change || !Array.isArray(change.ops)) return encodeChangeRaw(change, actorOrder)
  const ops = change.ops.map(op => {
    for (const field of Object.keys(op)) {
      if ((field === 'values' || field === 'multiOp') && op[field] !== undefined) {
        throw new RangeError(`Unable to read JS change: unknown field \`${field}\`, expected one of ` +
          '`ops`, `deps`, `message`, `seq`, `actor`, `requestType`')
      }
    }
    if (op.action === 'inc') return Object.assign({}, op, {datatype: 'int', value: Math.trunc(op.value)})
    if (op.datatype !== undefined || typeof op.value !== 'number' ||
        !Number.isInteger(op.value) || op.value < 0 || op.value > Number.MAX_SAFE_INTEGER) return op
    return Object.assign({}, op, {datatype: 'uint'})
  })
  return encodeChangeRaw(Object.assign({}, change, {ops}), actorOrder)
}

function assertWritable(doc) {
  if (viewDocs.has(doc)) {
    throw new RangeError('Cannot change an Automerge view; clone it first')
  }
}

function init(options) {
  options = normalizeInitOptions(options)
  if (typeof options === 'string') {
    options = {actorId: options}
  } else if (typeof options === 'undefined') {
    options = {}
  } else if (!isObject(options)) {
    throw new TypeError(`Unsupported options for init(): ${options}`)
  }
  return Frontend.init(Object.assign({backend, textV2: true}, options))
}

/**
 * Returns a new document object initialized with the given state.
 */
function from(initialState, options) {
  return changeWithSource(init(options), {}, doc => Object.assign(doc, copyPatchValue(initialState)), 'from')
}

function change(doc, options, callback) {
  return changeWithSource(doc, options, callback, 'change')
}

function changeWithSource(doc, options, callback, source) {
  assertWritable(doc)
  if (typeof options === 'function') {
    callback = options
    options = undefined
  }
  options = patchOptions(doc, options, source)
  const [newDoc] = Frontend.change(doc, options, callback)
  return newDoc
}

function emptyChange(doc, options) {
  assertWritable(doc)
  options = patchOptions(doc, options, 'emptyChange')
  const [newDoc] = Frontend.emptyChange(doc, options)
  return newDoc
}

function clone(doc, options = {}) {
  options = normalizeInitOptions(options)
  const state = backend.clone(Frontend.getBackendState(doc, 'clone'))
  return applyBackendPatch(init(options), backend.getPatch(state), state, [], options, null)
}

function free(doc) {
  backend.free(Frontend.getBackendState(doc, 'free'))
}

function load(data, options = {}) {
  options = normalizeInitOptions(options)
  const state = backend.load(data)
  if ((!isObject(options) || !options.allowMissingChanges) && backend.getMissingDeps(state).length > 0) {
    throw new RangeError("change's deps should already be in the document")
  }
  let doc = applyBackendPatch(init(options), backend.getPatch(state), state, [data], options, 'loadIncremental')
  if (isObject(options) && options.convertImmutableStringsToText) {
    doc = changeWithSource(doc, {time: 0}, migrateImmutableStrings, 'loadIncremental')
  }
  return doc
}

function migrateImmutableStrings(value) {
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (isImmutableString(child)) value[key] = child.val
    else if (isObject(child) && !(child instanceof Date) && !ArrayBuffer.isView(child)) migrateImmutableStrings(child)
  }
}

function save(doc) {
  return backend.save(Frontend.getBackendState(doc, 'save'))
}

function merge(localDoc, remoteDoc, options = {}) {
  assertWritable(localDoc)
  const localState = Frontend.getBackendState(localDoc, 'merge')
  const remoteState = Frontend.getBackendState(remoteDoc, 'merge', 'second')
  const changes = backend.getChangesAdded(localState, remoteState)
  const [updatedDoc] = applyChangesWithSource(localDoc, changes, options, 'merge')
  return updatedDoc
}

function getChanges(oldDoc, newDoc) {
  const oldState = Frontend.getBackendState(oldDoc, 'getChanges')
  const newState = Frontend.getBackendState(newDoc, 'getChanges', 'second')
  return backend.getChanges(newState, backend.getHeads(oldState))
}

function getAllChanges(doc) {
  return backend.getAllChanges(Frontend.getBackendState(doc, 'getAllChanges'))
}

function getHeads(doc) {
  return backend.getHeads(Frontend.getBackendState(doc, 'getHeads'))
}

function getBackend(doc) {
  return Frontend.getBackendState(doc, 'getBackend')
}

function getObjectId(object, prop) {
  if (object === null || object === undefined) return null
  return (arguments.length > 1 ? Frontend.getObjectId(object, prop) : Frontend.getObjectId(object)) || null
}

function getConflicts(object, key) {
  const values = Frontend.getConflicts(object, key)
  if (!values) return
  const projected = {}
  for (const opId of Object.keys(values)) {
    projected[opId] = values[opId] instanceof Frontend.Text ? values[opId].toJSON() : values[opId]
  }
  return projected
}

function getMissingDeps(doc, heads = []) {
  return backend.getMissingDeps(Frontend.getBackendState(doc, 'getMissingDeps'), heads)
}

function hasHeads(doc, heads) {
  if (!Array.isArray(heads)) throw new TypeError('Pass an array of hashes to hasHeads()')
  const state = Frontend.getBackendState(doc, 'hasHeads')
  if (backend.hasHeads) return backend.hasHeads(state, heads)
  return heads.every(hash => !!backend.getChangeByHash(state, hash))
}

function getChangesSince(doc, heads) {
  return backend.getChanges(Frontend.getBackendState(doc, 'getChangesSince'), heads)
}

function getChangesMetaSince(doc, heads) {
  const state = Frontend.getBackendState(doc, 'getChangesMetaSince')
  if (backend.getChangesMeta) return backend.getChangesMeta(state, heads)
  return backend.getChanges(state, heads).map(change => {
    const decoded = decodeChange(change)
    const metadata = Object.assign({}, decoded)
    delete metadata.ops
    return metadata
  })
}

function patchOptions(doc, options, source) {
  let normalized
  if (typeof options === 'string') normalized = {message: options}
  else normalized = Object.assign({}, options || {})
  const callback = normalized.patchCallback || doc[OPTIONS] && doc[OPTIONS].patchCallback
  if (callback) {
    normalized.patchCallback = (patch, before, after, local, changes) => {
      callPatchCallback(callback, patch, before, after, local, changes, source)
    }
  }
  return normalized
}

function callPatchCallback(callback, patch, before, after, local, changes, source) {
  if (callback.length > 2) {
    callback(patch, before, after, local, changes)
  } else if (source) {
    const patches = []
    appendRecordDiff(patches, before, after, [], after)
    appendConflictPatches(patches, before, after, [])
    appendChangeMarkPatches(patches, before, after, changes)
    if (patches.length > 0) callback(patches, {before, after, source})
  }
}

function applyBackendPatch(doc, patch, backendState, changes, options, source) {
  const newDoc = Frontend.applyPatch(doc, patch, backendState)
  const patchCallback = options.patchCallback || doc[OPTIONS].patchCallback
  if (patchCallback) {
    callPatchCallback(patchCallback, patch, doc, newDoc, false, changes, source)
  }
  return newDoc
}

function applyChanges(doc, changes, options = {}) {
  return applyChangesWithSource(doc, changes, options, 'applyChanges')
}

function applyChangesWithSource(doc, changes, options, source) {
  assertWritable(doc)
  const oldState = Frontend.getBackendState(doc, 'applyChanges')
  const [newState, patch] = backend.applyChanges(oldState, changes)
  return [applyBackendPatch(doc, patch, newState, changes, options, source)]
}

function loadIncremental(doc, data, options = {}) {
  assertWritable(doc)
  const oldState = Frontend.getBackendState(doc, 'loadIncremental')
  const [newState, patch] = backend.loadIncremental(oldState, data)
  if (!patch) return doc
  return applyBackendPatch(doc, patch, newState, [data], options, 'loadIncremental')
}

function saveIncremental(doc) {
  return backend.saveIncremental(Frontend.getBackendState(doc, 'saveIncremental'))
}

function saveSince(doc, heads) {
  return backend.saveSince(Frontend.getBackendState(doc, 'saveSince'), heads)
}

function concatBinary(buffers) {
  const byteLength = buffers.reduce((length, buffer) => length + buffer.byteLength, 0)
  const result = new Uint8Array(byteLength)
  let offset = 0
  for (const buffer of buffers) {
    result.set(buffer, offset)
    offset += buffer.byteLength
  }
  return result
}

function saveBundle(doc, hashes) {
  if (!Array.isArray(hashes)) throw new TypeError('saveBundle() hashes must be an array')
  const state = Frontend.getBackendState(doc, 'saveBundle')
  const selected = new Set(hashes)
  if (selected.size !== hashes.length) throw new RangeError('saveBundle() hashes must be unique')
  if (backend.saveBundleByHash) return backend.saveBundleByHash(state, hashes)
  const changes = backend.getAllChanges(state).filter(change => {
    const hash = decodeChangeMeta(change, true).hash
    if (selected.has(hash)) {
      selected.delete(hash)
      return true
    }
    return false
  })
  if (selected.size > 0) throw new RangeError(`Unknown change hash: ${selected.values().next().value}`)
  return backend.saveBundle ? backend.saveBundle(changes) : concatBinary(changes)
}

function readBundle(bundle) {
  if (backend.readBundle) {
    const decoded = backend.readBundle(bundle)
    return {changes: decoded.changes, deps: decoded.deps}
  }
  const changes = decodeChanges([bundle])
  const included = new Set(changes.map(change => change.hash))
  const deps = new Set()
  for (const change of changes) {
    for (const dep of change.deps) if (!included.has(dep)) deps.add(dep)
  }
  return {changes, deps: [...deps].sort()}
}

function applyImportedChanges(doc, changes, options, source) {
  assertWritable(doc)
  options = options || {}
  const oldState = Frontend.getBackendState(doc, source)
  const [newState, patch] = backend.applyChanges(oldState, changes)
  const newDoc = Frontend.applyPatch(doc, patch, newState)
  const patchCallback = options.patchCallback || doc[OPTIONS].patchCallback
  if (patchCallback && patch.diffs && Object.keys(patch.diffs.props).length > 0) {
    callPatchCallback(patchCallback, patch, doc, newDoc, false, changes, source)
  }
  return newDoc
}

function addCommits(doc, commits, options = {}) {
  if (!Array.isArray(commits)) throw new TypeError('addCommits() commits must be an array')
  const changes = commits.map(commit => {
    if (!commit || !(commit.bytes instanceof Uint8Array)) {
      throw new RangeError('bad commit bytes: not a Uint8Array')
    }
    let metadata
    try {
      metadata = decodeChangeMeta(commit.bytes, true)
    } catch (error) {
      throw new RangeError(`bad commit bytes: ${error.message}`)
    }
    if (commit.head !== metadata.hash) {
      throw new RangeError(`commit input head mismatch: expected ${commit.head}, actual ${metadata.hash}`)
    }
    if (!Array.isArray(commit.parents) || commit.parents.length !== metadata.deps.length ||
        commit.parents.some((parent, index) => parent !== metadata.deps[index])) {
      throw new RangeError('commit input parents do not match encoded change dependencies')
    }
    return commit.bytes
  })
  return applyImportedChanges(doc, changes, options, 'addCommits')
}

function addFragments(doc, fragments, options = {}) {
  if (!Array.isArray(fragments)) throw new TypeError('addFragments() fragments must be an array')
  const changes = []
  for (const fragment of fragments) {
    if (!fragment || !(fragment.bytes instanceof Uint8Array)) {
      throw new RangeError('bad fragment bytes: not a Uint8Array')
    }
    let decoded
    try {
      decoded = []
      for (const chunk of splitContainers(fragment.bytes)) {
        if (chunk[8] === 3 && backend.readBundle) {
          decoded.push(...backend.readBundle(chunk).changeBytes)
        } else if (chunk[8] === 1 || chunk[8] === 2) {
          decoded.push(chunk)
        } else {
          decoded.push(...decodeChanges([chunk]).map(encodeChangeRaw))
        }
      }
    } catch (error) {
      throw new RangeError(`error loading fragment bundles: ${error.message}`)
    }
    if (decoded.length === 0 && fragment.bytes.byteLength > 0) {
      throw new RangeError('error loading fragment bundles: no changes found')
    }
    changes.push(...decoded)
  }
  return applyImportedChanges(doc, changes, options, 'addFragments')
}

function equals(val1, val2) {
  if (!isObject(val1) || !isObject(val2)) return val1 === val2
  const keys1 = Object.keys(val1).sort(), keys2 = Object.keys(val2).sort()
  if (keys1.length !== keys2.length) return false
  for (let i = 0; i < keys1.length; i++) {
    if (keys1[i] !== keys2[i]) return false
    if (!equals(val1[keys1[i]], val2[keys2[i]])) return false
  }
  return true
}

function getHistory(doc) {
  const actor = Frontend.getActorId(doc)
  const history = getAllChanges(doc)
  return history.map((change, index) => ({
      get change () {
        return decodeChange(change)
      },
      get snapshot () {
        const state = backend.loadChanges(backend.init(), history.slice(0, index + 1))
        return Frontend.applyPatch(init(actor), backend.getPatch(state), state)
      }
    })
  )
}

function changesAtHeads(doc, heads) {
  if (!Array.isArray(heads)) throw new TypeError('Pass an array of hashes to view()')
  const changes = getAllChanges(doc)
  const decoded = changes.map(change => decodeChangeMeta(change, true))
  const byHash = {}
  for (const change of decoded) byHash[change.hash] = change
  const selected = {}
  const pending = heads.slice()

  while (pending.length > 0) {
    const hash = pending.pop()
    if (selected[hash]) continue
    const change = byHash[hash]
    if (!change) throw new RangeError(`Unknown change hash: ${hash}`)
    selected[hash] = true
    pending.push(...change.deps)
  }

  return changes.filter((change, index) => selected[decoded[index].hash])
}

function documentFromChanges(changes, options = {}) {
  const state = backend.loadChanges(backend.init(), changes)
  return applyBackendPatch(init(options), backend.getPatch(state), state, changes, options)
}

function view(doc, heads) {
  const snapshot = documentFromChanges(changesAtHeads(doc, heads), {
    actorId: Frontend.getActorId(doc), freeze: doc[OPTIONS].freeze
  })
  viewDocs.add(snapshot)
  return snapshot
}

function changeAt(doc, heads, options, callback) {
  assertWritable(doc)
  if (typeof options === 'function') {
    callback = options
    options = undefined
  }
  const snapshot = view(doc, heads)
  const branch = clone(snapshot)
  const branchOptions = isObject(options) ? Object.assign({}, options) : options
  if (isObject(branchOptions)) delete branchOptions.patchCallback
  const changed = changeWithSource(branch, branchOptions, callback, 'changeAt')
  if (changed === branch) return {newDoc: doc, newHeads: null}
  const newHeads = getHeads(changed)
  const oldState = Frontend.getBackendState(doc, 'changeAt')
  const changedState = Frontend.getBackendState(changed, 'changeAt', 'second')
  const changes = backend.getChangesAdded(oldState, changedState)
  return {newDoc: applyChangesWithSource(doc, changes, options || {}, 'changeAt')[0], newHeads}
}

function toJS(value) {
  if (value instanceof Frontend.Text) {
    let text = ''
    for (const item of value) text += typeof item === 'string' ? item : '\ufffc'
    return text
  }
  if (isImmutableString(value)) return new ImmutableString(value.val)
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof Uint8Array) return value.slice()
  if (value instanceof Frontend.Counter) return new Frontend.Counter(value.value)
  if (Array.isArray(value)) return value.map(toJS)
  if (!isObject(value)) return value
  // The Rust implementation materializes a fresh value, so keys come out in
  // sorted order regardless of the enumeration order of the document object.
  const copy = {}
  for (const key of Object.keys(value).sort(compareUtf8)) copy[key] = toJS(value[key])
  return copy
}

function isAutomerge(value) {
  return isObject(value) && Frontend.getObjectId(value) === '_root'
}

function isCounter(value) {
  return value instanceof Frontend.Counter
}

function getLastLocalChange(doc) {
  return Frontend.getLastLocalChange(doc) || undefined
}

function insertAt(list, index, ...values) {
  if (!list || typeof list.insertAt !== 'function') {
    throw new RangeError('object cannot be modified outside of a change block')
  }
  list.insertAt(index, ...values)
}

function deleteAt(list, index, numDelete) {
  if (!list || typeof list.deleteAt !== 'function') {
    throw new RangeError('object cannot be modified outside of a change block')
  }
  list.deleteAt(index, numDelete)
}

function valueAtPath(doc, path, name) {
  if (!Array.isArray(path)) throw new TypeError(`${name}() path must be an array`)
  if (path.length === 0) throw new RangeError(`${name}() path must not be empty`)
  let parent = doc
  for (let index = 0; index < path.length - 1; index++) {
    const prop = path[index]
    if (parent === null || parent === undefined || !['string', 'number'].includes(typeof prop)) {
      throw new RangeError(`${name}() path does not resolve to a string, Text, or list`)
    }
    parent = parent[prop]
  }
  const key = path[path.length - 1]
  if (parent === null || parent === undefined || !['string', 'number'].includes(typeof key)) {
    throw new RangeError(`${name}() path does not resolve to a string, Text, or list`)
  }
  return {parent, key, value: parent[key]}
}

function textAtTarget(target) {
  if (target.value instanceof Frontend.Text) return target.value
  return Frontend.getText(target.parent, target.key)
}

function textElementWidth(value) {
  return typeof value === 'string' ? value.length : 1
}

function textLength(text) {
  let length = 0
  for (const value of text) length += textElementWidth(value)
  return length
}

function textOffset(text, elementIndex) {
  let offset = 0
  for (let index = 0; index < elementIndex && index < text.length; index++) {
    offset += textElementWidth(text.get(index))
  }
  return offset
}

function textElementIndex(text, offset) {
  if (offset <= 0) return 0
  let current = 0
  for (let index = 0; index < text.length; index++) {
    current += textElementWidth(text.get(index))
    if (offset <= current) return index + 1
  }
  return text.length
}

function textCursorIndex(text, offset) {
  let current = 0
  for (let index = 0; index < text.length; index++) {
    current += textElementWidth(text.get(index))
    if (offset < current) return index
  }
  return text.length
}

function splice(doc, path, index, del, newText = '') {
  const target = valueAtPath(doc, path, 'splice')
  if (typeof index === 'string') index = getCursorPosition(doc, path, index)
  if (!Number.isInteger(index) || !Number.isInteger(del)) {
    throw new RangeError('splice() index and delete count must be integers')
  }
  if (typeof newText !== 'string') throw new TypeError('splice() text must be a string')
  newText = wellFormedString(newText)
  if (del < 0) {
    index += del
    del = -del
  }
  const text = textAtTarget(target) || target.value
  if (typeof text !== 'string' && !(text instanceof Frontend.Text) && !Array.isArray(text)) {
    throw new RangeError('splice() path does not resolve to a string, Text, or list')
  }
  const chars = [...newText]
  const length = text instanceof Frontend.Text ? textLength(text) : text.length
  if (index < 0 || index > length) throw new RangeError('splice() index is out of bounds')
  del = Math.min(del, length - index)
  if (text instanceof Frontend.Text) {
    const start = textElementIndex(text, index)
    let deleteCount = 0, deleted = 0
    while (start + deleteCount < text.length && deleted < del) {
      deleted += textElementWidth(text.get(start + deleteCount))
      deleteCount++
    }
    if (chars.length > 0) text.insertAt(start, ...chars)
    if (deleteCount > 0) text.deleteAt(start + chars.length, deleteCount)
  } else if (Array.isArray(text)) {
    text.splice(index, del, ...chars)
  } else {
    target.parent[target.key] = text.slice(0, index) + newText + text.slice(index + del)
  }
}

function updateText(doc, path, newText) {
  if (typeof newText !== 'string') throw new TypeError('updateText() text must be a string')
  newText = wellFormedString(newText)
  const target = valueAtPath(doc, path, 'updateText')
  const text = textAtTarget(target) || target.value
  if (!(text instanceof Frontend.Text) && !Array.isArray(text)) {
    throw new RangeError('updateText() path does not resolve to a string, Text, or list')
  }
  // The Rust implementation renders the current text with block markers as
  // U+FFFC, splits both strings into graphemes, and applies each Myers diff
  // edit as a splice. Replicating that exactly keeps the generated operations,
  // and therefore the change hashes, identical.
  const current = [...text].map(value => (typeof value === 'string' ? value : '￼')).join('')
  const old = graphemes(current), next = graphemes(newText)
  const edits = []
  let index = 0
  function width(items) { return items.reduce((total, item) => total + item.length, 0) }
  myersDiff({
    equal(oldIndex, newIndex, length) {
      index += width(old.slice(oldIndex, oldIndex + length))
    },
    delete(oldIndex, oldLength) {
      edits.push({index, del: width(old.slice(oldIndex, oldIndex + oldLength)), text: ''})
    },
    insert(oldIndex, newIndex, newLength) {
      const inserted = next.slice(newIndex, newIndex + newLength).join('')
      edits.push({index, del: 0, text: inserted})
      index += inserted.length
    }
  }, old, next)
  for (const edit of edits) splice(doc, path, edit.index, edit.del, edit.text)
}

function copyPatchValue(value) {
  if (value instanceof Frontend.Text) return new Frontend.Text([...value].map(copyPatchValue))
  if (isImmutableString(value)) return new ImmutableString(value.val)
  if (value instanceof Date) return new Date(value.getTime())
  if (value instanceof Uint8Array) return value.slice()
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
  }
  if (value instanceof Frontend.Counter) return new Frontend.Counter(value.value)
  if (Array.isArray(value)) return value.map(copyPatchValue)
  if (!isObject(value)) return value
  const copy = {}
  for (const key of Object.keys(value)) copy[key] = copyPatchValue(value[key])
  return copy
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true
  if (left instanceof Frontend.Text && right instanceof Frontend.Text) {
    const leftValues = [...left], rightValues = [...right]
    return sameValue(leftValues, rightValues)
  }
  if (left instanceof Frontend.Counter && right instanceof Frontend.Counter) {
    return left.value === right.value
  }
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.byteLength !== right.byteLength) return false
    for (let index = 0; index < left.byteLength; index++) {
      if (left[index] !== right[index]) return false
    }
    return true
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      if (!sameValue(left[index], right[index])) return false
    }
    return true
  }
  if (!isObject(left) || !isObject(right)) return false
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort()
  if (leftKeys.length !== rightKeys.length) return false
  for (let index = 0; index < leftKeys.length; index++) {
    if (leftKeys[index] !== rightKeys[index] || !sameValue(left[leftKeys[index]], right[rightKeys[index]])) {
      return false
    }
  }
  return true
}

function isRecord(value) {
  if (!isObject(value) || Array.isArray(value) || value instanceof Date ||
      value instanceof Frontend.Text || value instanceof Frontend.Counter ||
      ArrayBuffer.isView(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function appendRichTextDiff(patches, before, after, path, afterDoc) {
  before = [...before]
  after = [...after]
  let prefix = 0
  while (prefix < before.length && prefix < after.length && sameValue(before[prefix], after[prefix])) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
         sameValue(before[before.length - suffix - 1], after[after.length - suffix - 1])) suffix++
  const removed = before.length - prefix - suffix
  const offset = before.slice(0, prefix).reduce((total, value) => total + textElementWidth(value), 0)
  const deleteLength = before.slice(prefix, prefix + removed)
    .reduce((total, value) => total + textElementWidth(value), 0)
  const inserted = after.slice(prefix, after.length - suffix)
  const insertBeforeDelete = removed > 0 && inserted.length > 0 && inserted.every(value => typeof value === 'string')
  if (removed > 0 && !insertBeforeDelete) appendDelete(patches, path.concat(offset), deleteLength)
  const markState = afterDoc ? markRanges(afterDoc, path).values : []
  let index = offset, text = '', textMarks
  function flushText() {
    if (text.length === 0) return
    const patch = {action: 'splice', path: path.concat(index), value: text}
    if (textMarks && Object.keys(textMarks).length > 0) patch.marks = Object.assign({}, textMarks)
    patches.push(patch)
    index += text.length
    text = ''
    textMarks = undefined
  }
  for (let insertedIndex = 0; insertedIndex < inserted.length; insertedIndex++) {
    const value = inserted[insertedIndex]
    const valueMarks = markState[prefix + insertedIndex] || {}
    if (typeof value === 'string') {
      if (text.length > 0 && !sameValue(textMarks, valueMarks)) flushText()
      if (text.length === 0) textMarks = valueMarks
      text += value
      continue
    }
    flushText()
    patches.push({action: 'insert', path: path.concat(index), values: [{}]})
    const updatingBlock = removed === 1 && inserted.length === 1 && isRecord(before[prefix]) && isRecord(value)
    const keys = updatingBlock ? Object.keys(value).sort((left, right) => {
      if (left === 'type') return -1
      if (right === 'type') return 1
      return left.localeCompare(right)
    }) : undefined
    appendRecordDiff(patches, {}, value, path.concat(index), afterDoc, keys)
    index++
  }
  flushText()
  if (insertBeforeDelete) appendDelete(patches, path.concat(index), deleteLength)
}

function appendDelete(patches, path, length) {
  const patch = {action: 'del', path}
  if (length > 1) patch.length = length
  patches.push(patch)
}

function patchPlaceholder(value) {
  if (typeof value === 'string' || value instanceof Frontend.Text) return ''
  if (Array.isArray(value)) return []
  if (isRecord(value)) return {}
  return copyPatchValue(value)
}

function opIdOfObject(value) {
  const objectId = isObject(value) && value[OBJECT_ID]
  if (!objectId) return null
  if (objectId === '_root') return {counter: 0, actorId: ''}
  return parseOpId(objectId)
}

function keyConflict(object, key) {
  const conflicts = isObject(object) && object[CONFLICTS] && object[CONFLICTS][key]
  return conflicts ? Object.keys(conflicts).length > 1 : false
}

function insertConflicts(patch, list, index, count) {
  const conflicts = Array.from({length: count}, (_, offset) => keyConflict(list, index + offset))
  if (conflicts.some(Boolean)) patch.conflicts = conflicts
}

/**
 * Patches are grouped into one emission unit per document object, and the
 * units are emitted in ascending order of the objects\' creation operation
 * IDs, matching the patch order of the Rust implementation. Units without an
 * operation ID (plain strings) sort with the nearest preceding identified
 * unit, staying in collection order within a tie.
 */
function emitUnits(patches, units) {
  let lastOpId = {counter: 0, actorId: ''}
  for (const unit of units) {
    if (unit.opId) lastOpId = unit.opId; else unit.opId = lastOpId
  }
  units.sort((a, b) => a.opId.counter - b.opId.counter ||
    (a.opId.actorId < b.opId.actorId ? -1 : a.opId.actorId > b.opId.actorId ? 1 : 0))
  for (const unit of units) {
    for (const patch of unit.patches) patches.push(patch)
  }
}

function collectArrayDiff(units, before, after, path, afterDoc) {
  const unit = {opId: opIdOfObject(after), patches: []}
  units.push(unit)
  const beforeIds = Frontend.getElementIds(before), afterIds = Frontend.getElementIds(after)
  function beforeValue(index) { return Frontend.getText(before, index) || before[index] }
  function afterValue(index) { return Frontend.getText(after, index) || after[index] }
  const sameElement = beforeIds && afterIds
    ? (beforeIndex, afterIndex) => beforeIds[beforeIndex] === afterIds[afterIndex] &&
        sameValue(beforeValue(beforeIndex), afterValue(afterIndex))
    : (beforeIndex, afterIndex) => sameValue(beforeValue(beforeIndex), afterValue(afterIndex))
  let prefix = 0
  while (prefix < before.length && prefix < after.length && sameElement(prefix, prefix)) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
         sameElement(before.length - suffix - 1, after.length - suffix - 1)) suffix++
  const beforeMiddle = before.length - prefix - suffix
  const afterMiddle = after.length - prefix - suffix
  if (beforeMiddle === 0 && afterMiddle > 0) {
    const values = Array.from({length: afterMiddle}, (_, index) => afterValue(prefix + index))
    collectArrayInsert(units, unit.patches, after, path, prefix, values, afterDoc)
    return
  }
  if (afterMiddle === 0 && beforeMiddle > 0) {
    appendDelete(unit.patches, path.concat(prefix), beforeMiddle)
    return
  }
  const common = Math.min(beforeMiddle, afterMiddle)
  for (let index = 0; index < common; index++) {
    collectValueDiff(units, unit.patches, beforeValue(prefix + index), afterValue(prefix + index),
      path.concat(prefix + index), afterDoc, keyConflict(after, prefix + index))
  }
  if (beforeMiddle > afterMiddle) {
    appendDelete(unit.patches, path.concat(prefix + common), beforeMiddle - common)
  } else if (afterMiddle > beforeMiddle) {
    const values = Array.from({length: afterMiddle - common}, (_, index) => afterValue(prefix + common + index))
    collectArrayInsert(units, unit.patches, after, path, prefix + common, values, afterDoc)
  }
}

function collectArrayInsert(units, inline, after, path, index, values, afterDoc) {
  const patch = {action: 'insert', path: path.concat(index), values: values.map(patchPlaceholder)}
  insertConflicts(patch, after, index, values.length)
  inline.push(patch)
  collectInitializations(units, values.map((value, offset) => ({value, path: path.concat(index + offset)})), afterDoc)
}

function collectTextInitialization(units, queue, value, path, afterDoc) {
  const unit = {opId: opIdOfObject(value), patches: []}
  units.push(unit)
  const markState = afterDoc ? markRangesForText(afterDoc, value).values : []
  let index = 0, text = '', textMarks
  function flushText() {
    if (text.length === 0) return
    const patch = {action: 'splice', path: path.concat(index), value: text}
    if (textMarks && Object.keys(textMarks).length > 0) patch.marks = Object.assign({}, textMarks)
    unit.patches.push(patch)
    index += text.length
    text = ''
    textMarks = undefined
  }
  for (let itemIndex = 0; itemIndex < value.length; itemIndex++) {
    const item = value.get(itemIndex)
    const itemMarks = markState[itemIndex] || {}
    if (typeof item === 'string') {
      if (text.length > 0 && !sameValue(textMarks, itemMarks)) flushText()
      if (text.length === 0) textMarks = itemMarks
      text += item
      continue
    }
    flushText()
    unit.patches.push({action: 'insert', path: path.concat(index), values: [{}]})
    queue.push({value: item, path: path.concat(index)})
    index++
  }
  flushText()
}

function collectInitializations(units, initial, afterDoc) {
  const queue = initial.slice()
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex++) {
    const {value, path} = queue[queueIndex]
    if (typeof value === 'string') {
      if (value.length > 0) {
        units.push({opId: null, patches: [{action: 'splice', path: path.concat(0), value}]})
      }
    } else if (value instanceof Frontend.Text) {
      collectTextInitialization(units, queue, value, path, afterDoc)
    } else if (Array.isArray(value) && value.length > 0) {
      const patch = {action: 'insert', path: path.concat(0), values: value.map(patchPlaceholder)}
      insertConflicts(patch, value, 0, value.length)
      units.push({opId: opIdOfObject(value), patches: [patch]})
      for (let index = 0; index < value.length; index++) {
        queue.push({value: Frontend.getText(value, index) || value[index], path: path.concat(index)})
      }
    } else if (isRecord(value)) {
      const keys = Object.keys(value).sort(compareUtf8)
      const unit = {opId: opIdOfObject(value), patches: []}
      units.push(unit)
      for (const key of keys) {
        const patch = {action: 'put', path: path.concat(key), value: patchPlaceholder(value[key])}
        if (keyConflict(value, key)) patch.conflict = true
        unit.patches.push(patch)
      }
      for (const key of keys) {
        queue.push({value: Frontend.getText(value, key) || value[key], path: path.concat(key)})
      }
    }
  }
}

function collectPutValue(units, inline, value, path, afterDoc, conflict) {
  const patch = {action: 'put', path, value: patchPlaceholder(value)}
  if (conflict) patch.conflict = true
  inline.push(patch)
  collectInitializations(units, [{value, path}], afterDoc)
}

function collectRecordDiff(units, before, after, path, afterDoc, orderedKeys) {
  const unit = {opId: opIdOfObject(after), patches: []}
  units.push(unit)
  const beforeKeys = Object.keys(before).sort(compareUtf8)
  const afterKeys = orderedKeys || Object.keys(after).sort(compareUtf8)
  const beforeSet = new Set(beforeKeys), afterSet = new Set(afterKeys)
  for (const key of beforeKeys) {
    if (!afterSet.has(key)) unit.patches.push({action: 'del', path: path.concat(key)})
  }
  for (const key of afterKeys) {
    const afterValue = Frontend.getText(after, key) || after[key]
    const valuePath = path.concat(key)
    if (!beforeSet.has(key)) {
      const patch = {action: 'put', path: valuePath, value: patchPlaceholder(afterValue)}
      if (keyConflict(after, key)) patch.conflict = true
      unit.patches.push(patch)
      collectInitializations(units, [{value: afterValue, path: valuePath}], afterDoc)
    } else {
      const beforeValue = Frontend.getText(before, key) || before[key]
      collectValueDiff(units, unit.patches, beforeValue, afterValue, valuePath, afterDoc, keyConflict(after, key))
    }
  }
}

function collectValueDiff(units, inline, before, after, path, afterDoc, conflict) {
  const beforeId = isObject(before) && Frontend.getObjectId(before)
  const afterId = isObject(after) && Frontend.getObjectId(after)
  if (sameValue(before, after) && (!beforeId || beforeId === afterId)) return
  if (beforeId && afterId && beforeId !== afterId) {
    collectPutValue(units, inline, after, path, afterDoc, conflict)
    return
  }
  if (typeof before === 'string' && typeof after === 'string') {
    collectPutValue(units, inline, after, path, afterDoc, conflict)
  } else if ((typeof before === 'string' || before instanceof Frontend.Text) &&
             (typeof after === 'string' || after instanceof Frontend.Text)) {
    const unit = {opId: opIdOfObject(after), patches: []}
    units.push(unit)
    appendRichTextDiff(unit.patches, before, after, path, afterDoc)
  } else if (before instanceof Frontend.Counter && after instanceof Frontend.Counter) {
    inline.push({action: 'inc', path, value: after.value - before.value})
  } else if (Array.isArray(before) && Array.isArray(after)) {
    collectArrayDiff(units, before, after, path, afterDoc)
  } else if (isRecord(before) && isRecord(after)) {
    collectRecordDiff(units, before, after, path, afterDoc)
  } else {
    const patch = {action: 'put', path, value: copyPatchValue(after)}
    if (conflict) patch.conflict = true
    inline.push(patch)
  }
}

function appendRecordDiff(patches, before, after, path, afterDoc, orderedKeys) {
  const units = []
  collectRecordDiff(units, before, after, path, afterDoc, orderedKeys)
  emitUnits(patches, units)
}

function diff(doc, beforeHeads, afterHeads) {
  if (!Array.isArray(beforeHeads) || !Array.isArray(afterHeads)) {
    throw new TypeError('diff() heads must be arrays')
  }
  if (!hasHeads(doc, beforeHeads) || !hasHeads(doc, afterHeads)) return []
  const before = view(doc, beforeHeads), after = view(doc, afterHeads)
  const patches = []
  appendRecordDiff(patches, before, after, [], after)
  appendConflictPatches(patches, before, after, [])
  appendMarkPatches(patches, before, after, before, after, [])
  return patches
}

function conflictMap(object, key) {
  return Frontend.getConflicts(object, key) || {}
}

function appendConflictPatches(patches, before, after, path) {
  if (before instanceof Frontend.Text || after instanceof Frontend.Text) return
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.min(before.length, after.length)
    for (let index = 0; index < length; index++) {
      const beforeConflicts = conflictMap(before, index), afterConflicts = conflictMap(after, index)
      if (!sameValue(beforeConflicts, afterConflicts) && Object.keys(afterConflicts).length > 1) {
        const patchPath = path.concat(index)
        const put = patches.find(patch => patch.action === 'put' && sameValue(patch.path, patchPath))
        if (put) put.conflict = true
        else if (sameValue(before[index], after[index])) patches.push({action: 'conflict', path: patchPath})
      }
      appendConflictPatches(patches, Frontend.getText(before, index) || before[index],
        Frontend.getText(after, index) || after[index], path.concat(index))
    }
  } else if (isRecord(before) && isRecord(after)) {
    for (const key of Object.keys(after)) {
      if (!Object.prototype.hasOwnProperty.call(before, key)) continue
      const beforeConflicts = conflictMap(before, key), afterConflicts = conflictMap(after, key)
      if (!sameValue(beforeConflicts, afterConflicts) && Object.keys(afterConflicts).length > 1) {
        const patchPath = path.concat(key)
        const put = patches.find(patch => patch.action === 'put' && sameValue(patch.path, patchPath))
        if (put) put.conflict = true
        else if (sameValue(before[key], after[key])) patches.push({action: 'conflict', path: patchPath})
      }
      appendConflictPatches(patches, Frontend.getText(before, key) || before[key],
        Frontend.getText(after, key) || after[key], path.concat(key))
    }
  }
}

function markEqual(left, right) {
  return left.name === right.name && left.start === right.start && left.end === right.end &&
    sameValue(left.value, right.value)
}

function findTextObject(value, objectId, path = []) {
  if (!isObject(value)) return
  const keys = Array.isArray(value) ? value.map((_, index) => index) : Object.keys(value)
  for (const key of keys) {
    const text = Frontend.getText(value, key)
    if (text) {
      const textPath = path.concat(key)
      if (Frontend.getObjectId(text) === objectId) return {path: textPath, text}
      let offset = 0
      for (const item of text) {
        if (isObject(item)) {
          const found = findTextObject(item, objectId, textPath.concat(offset))
          if (found) return found
        }
        offset += textElementWidth(item)
      }
    } else {
      const child = value[key]
      if (Array.isArray(child) || isRecord(child)) {
        const found = findTextObject(child, objectId, path.concat(key))
        if (found) return found
      }
    }
  }
}

function markEndpoint(doc, target, elemId) {
  if (elemId === '_head') return 0
  let offset = 0
  for (const elem of target.text.elems) {
    offset += textElementWidth(elem.value)
    if (elem.elemId === elemId) return offset
  }
  const state = Frontend.getBackendState(doc, 'patchCallback')
  const index = backend.getCursorPosition(state, Frontend.getObjectId(target.text), elemId, 'after')
  return textOffset(target.text, index)
}

function appendChangeMarkPatches(patches, before, after, changes) {
  if (!Array.isArray(changes) || changes.length === 0) return
  const groups = [], pending = new Map()
  for (const change of decodeChanges(changes)) {
    for (const op of change.ops) {
      if (op.action === 'markBegin') {
        if (!pending.has(op.obj)) pending.set(op.obj, [])
        pending.get(op.obj).push(op)
      } else if (op.action === 'markEnd') {
        const stack = pending.get(op.obj)
        if (!stack || stack.length === 0) continue
        const begin = stack.pop()
        const target = findTextObject(after, op.obj)
        if (!target || !findTextObject(before, op.obj)) continue
        let group = groups.find(value => sameValue(value.path, target.path))
        if (!group) {
          group = {path: target.path, marks: []}
          groups.push(group)
        }
        group.marks.push({
          name: begin.name,
          value: copyPatchValue(begin.value),
          start: markEndpoint(after, target, begin.elemId),
          end: markEndpoint(after, target, op.elemId)
        })
      }
    }
  }
  for (const group of groups) patches.push({action: 'mark', path: group.path, marks: group.marks})
}

function appendMarkPatches(patches, beforeDoc, afterDoc, before, after, path) {
  if (before instanceof Frontend.Text && after instanceof Frontend.Text) {
    if (!sameValue([...before], [...after])) return
    const oldMarks = marks(beforeDoc, path), newMarks = marks(afterDoc, path)
    const removed = oldMarks.filter(oldMark => !newMarks.some(newMark => markEqual(oldMark, newMark)))
    const added = newMarks.filter(newMark => !oldMarks.some(oldMark => markEqual(oldMark, newMark)))
    for (const value of removed) {
      patches.push({action: 'unmark', path, name: value.name, start: value.start, end: value.end})
    }
    if (added.length > 0) patches.push({action: 'mark', path, marks: added})
    return
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    for (let index = 0; index < before.length; index++) {
      appendMarkPatches(patches, beforeDoc, afterDoc, Frontend.getText(before, index) || before[index],
        Frontend.getText(after, index) || after[index], path.concat(index))
    }
  } else if (isRecord(before) && isRecord(after)) {
    for (const key of Object.keys(after)) {
      if (Object.prototype.hasOwnProperty.call(before, key)) {
        appendMarkPatches(patches, beforeDoc, afterDoc, Frontend.getText(before, key) || before[key],
          Frontend.getText(after, key) || after[key], path.concat(key))
      }
    }
  }
}

function diffPath(doc, path, beforeHeads, afterHeads, options = {}) {
  if (!Array.isArray(path)) throw new TypeError('diffPath() path must be an array')
  const recursive = options.recursive !== false
  return diff(doc, beforeHeads, afterHeads).filter(patch => {
    if (patch.path.length < path.length) return false
    for (let index = 0; index < path.length; index++) {
      if (patch.path[index] !== path[index]) return false
    }
    return recursive || patch.path.length <= path.length + 1
  })
}

function applyPatch(doc, patch) {
  if (!patch || !Array.isArray(patch.path)) throw new TypeError('applyPatch() requires a patch with a path')
  if (patch.action === 'put') {
    const target = valueAtPath(doc, patch.path, 'applyPatch')
    target.parent[target.key] = copyPatchValue(patch.value)
  } else if (patch.action === 'insert') {
    const target = valueAtPath(doc, patch.path, 'applyPatch')
    if (!Array.isArray(target.parent) || typeof target.key !== 'number') {
      throw new RangeError('insert patch target is not a list index')
    }
    target.parent.splice(target.key, 0, ...patch.values.map(copyPatchValue))
  } else if (patch.action === 'del') {
    const target = valueAtPath(doc, patch.path, 'applyPatch')
    if (Array.isArray(target.parent) && typeof target.key === 'number') {
      target.parent.splice(target.key, patch.length || 1)
    } else if (target.parent instanceof Frontend.Text && typeof target.key === 'number') {
      target.parent.deleteAt(target.key, patch.length || 1)
    } else if (typeof target.parent === 'string' && typeof target.key === 'number') {
      splice(doc, patch.path.slice(0, -1), target.key, patch.length || 1)
    } else {
      delete target.parent[target.key]
    }
  } else if (patch.action === 'splice') {
    const index = patch.path[patch.path.length - 1]
    if (typeof index !== 'number') throw new RangeError('splice patch target is not a string index')
    splice(doc, patch.path.slice(0, -1), index, 0, patch.value)
  } else if (patch.action === 'inc') {
    const target = valueAtPath(doc, patch.path, 'applyPatch')
    if (target.value && typeof target.value.increment === 'function') {
      target.value.increment(patch.value)
    } else if (target.value instanceof Frontend.Counter) {
      target.parent[target.key] = new Frontend.Counter(target.value.value + patch.value)
    } else if (typeof target.value === 'number') {
      target.parent[target.key] += patch.value
    } else {
      throw new RangeError('inc patch target is not a counter or number')
    }
  } else if (patch.action === 'mark') {
    if (isAutomerge(doc)) {
      for (const value of patch.marks) {
        mark(doc, patch.path, {start: value.start, end: value.end, expand: 'none'}, value.name, value.value)
      }
    }
  } else if (patch.action === 'unmark') {
    if (isAutomerge(doc)) {
      unmark(doc, patch.path, {start: patch.start, end: patch.end, expand: 'none'}, patch.name)
    }
  } else if (patch.action !== 'conflict') {
    throw new RangeError(`Unsupported patch action: ${patch.action}`)
  }
}

function applyPatches(doc, patches) {
  if (!Array.isArray(patches)) throw new TypeError('applyPatches() requires an array')
  for (const patch of patches) applyPatch(doc, patch)
}

function getCursor(doc, path, position, move = 'after') {
  const target = valueAtPath(doc, path, 'getCursor')
  const value = textAtTarget(target) || target.value
  if (!(value instanceof Frontend.Text)) {
    throw new RangeError('getCursor() path does not resolve to a string or Text')
  }
  const length = textLength(value)
  if (!['before', 'after'].includes(move)) throw new RangeError('getCursor() move must be before or after')
  if (position === 'start' || (typeof position === 'number' && position < 0)) return 's'
  if (position === 'end' || (typeof position === 'number' && position >= length)) return 'e'
  if (!Number.isInteger(position)) throw new RangeError('getCursor() position must be a number, start, or end')
  const elementIndex = textCursorIndex(value, position)
  if (elementIndex === value.length) return 'e'
  const elemId = value.getElemId(elementIndex)
  return move === 'before' ? `-${elemId}` : elemId
}

function updateCursorPosition(before, after, position, move) {
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
         before[before.length - suffix - 1] === after[after.length - suffix - 1]) suffix++
  const beforeEnd = before.length - suffix, afterEnd = after.length - suffix
  if (position < prefix) return position
  if (position === prefix && beforeEnd === prefix) return move === 'after' ? afterEnd : prefix
  if (position >= beforeEnd) return afterEnd + position - beforeEnd
  return move === 'after' ? afterEnd : prefix
}

const cursorOffsets = new WeakMap()

function getCursorPosition(doc, path, cursor) {
  const target = valueAtPath(doc, path, 'getCursorPosition')
  const value = textAtTarget(target) || target.value
  if (!(value instanceof Frontend.Text)) {
    throw new RangeError('getCursorPosition() path does not resolve to a string or Text')
  }
  if (cursor === 's') return 0
  if (cursor === 'e') return textLength(value)
  const opId = /^(-?)(\d+)@(.+)$/.exec(cursor)
  if (opId) {
    const elemId = `${opId[2]}@${opId[3]}`
    if (value.context) {
      const visible = value.elems.findIndex(elem => elem.elemId === elemId)
      if (visible >= 0) return textOffset(value, visible)
    }
    const state = Frontend.getBackendState(doc, 'getCursorPosition')
    const index = backend.getCursorPosition(state, Frontend.getObjectId(value), elemId,
      opId[1] === '-' ? 'before' : 'after')
    let offsets = cursorOffsets.get(value)
    if (!offsets) {
      offsets = new Float64Array(value.length + 1)
      for (let element = 0; element < value.length; element++) {
        offsets[element + 1] = offsets[element] + textElementWidth(value.get(element))
      }
      cursorOffsets.set(value, offsets)
    }
    return offsets[Math.min(index, value.length)]
  }
  const match = /^classic:(before|after):(\d+)(?::(.*))?$/.exec(cursor)
  if (!match) throw new RangeError('getCursorPosition() received an invalid cursor')
  const length = textLength(value)
  const position = parseInt(match[2], 10)
  if (match[3] === undefined) return Math.min(position, length)
  let before
  try {
    before = [...decodeURIComponent(match[3])]
  } catch (error) {
    throw new RangeError('getCursorPosition() received an invalid cursor')
  }
  const after = typeof value === 'string' ? [...value] : [...value.toString()]
  return Math.min(updateCursorPosition(before, after, position, match[1]), length)
}

function mark(doc, path, range, name, value) {
  const target = valueAtPath(doc, path, 'mark')
  const text = textAtTarget(target) || target.value
  if (!(text instanceof Frontend.Text) || !text.context) {
    throw new RangeError('mark() path must resolve to Text inside a change block')
  }
  const length = textLength(text)
  if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) ||
      range.start < 0 || range.end < range.start || range.end > length) {
    throw new RangeError('mark() range is invalid')
  }
  if (typeof name !== 'string') throw new TypeError('mark() name must be a string')
  const expand = range.expand || 'after'
  if (!['before', 'after', 'both', 'none'].includes(expand)) throw new RangeError('mark() expand is invalid')
  const objectId = Frontend.getObjectId(text)
  const startIndex = textElementIndex(text, range.start)
  const endIndex = textElementIndex(text, range.end)
  const start = startIndex === 0 ? '_head' : text.getElemId(startIndex - 1)
  const end = endIndex === 0 ? '_head' : text.getElemId(endIndex - 1)
  text.context.addOp({
    action: 'markBegin', obj: objectId, elemId: start, insert: true, name, value,
    expand: expand === 'before' || expand === 'both', pred: []
  })
  text.context.addOp({
    action: 'markEnd', obj: objectId, elemId: end, insert: true,
    expand: expand === 'after' || expand === 'both', pred: []
  })
  text.context.updated[objectId] = text.context.getObject(objectId)
}

function unmark(doc, path, range, name) {
  mark(doc, path, range, name, null)
}

function markRanges(doc, path) {
  const target = valueAtPath(doc, path, 'marks')
  const text = textAtTarget(target) || target.value
  if (!(text instanceof Frontend.Text)) throw new RangeError('marks() path must resolve to Text')
  return markRangesForText(doc, text)
}

function markRangesForText(doc, text) {
  const objectId = Frontend.getObjectId(text)
  const positions = new Map(text.elems.map((elem, index) => [elem.elemId, index + 1]))
  positions.set('_head', 0)
  const pending = [], pairs = [], operations = [], inserts = new Map()
  function scanOps(ops, actor, startOp) {
    let opCounter = startOp
    for (let index = 0; index < ops.length; index++) {
      const op = ops[index]
      const opId = `${opCounter}@${actor}`
      opCounter += op.values ? op.values.length : (op.multiOp || 1)
      if (op.obj !== objectId) continue
      if (op.action === 'markBegin') {
        pending.push({op, id: opId})
      } else if (op.action === 'markEnd' && pending.length > 0) {
        pairs.push({begin: pending.pop(), end: {op, id: opId}})
      } else if (op.insert) {
        if (op.values) {
          let ref = op.elemId
          const start = parseOpId(opId)
          for (let offset = 0; offset < op.values.length; offset++) {
            const elemId = `${start.counter + offset}@${start.actorId}`
            inserts.set(elemId, ref)
            ref = elemId
          }
        } else {
          inserts.set(opId, op.elemId)
        }
      }
    }
  }
  for (const bytes of getAllChanges(doc)) {
    const change = decodeChange(bytes, true)
    scanOps(change.ops, change.actor, change.startOp)
  }
  if (text.context) {
    const size = text.context.ops.reduce((total, op) =>
      total + (op.values ? op.values.length : (op.multiOp || 1)), 0)
    scanOps(text.context.ops, text.context.actorId, text.context.nextOpNum - size)
  }
  // A mark boundary behaves like a zero-width element anchored after
  // `elemId`. An expanding end boundary (and a non-expanding start boundary)
  // floats past elements that were inserted at the anchor by later
  // operations, so that those elements fall inside (respectively outside)
  // the mark. This matches how the Rust implementation orders the boundary
  // within the element sequence.
  function floatingPosition(anchorElemId, markerId) {
    let index = positions.get(anchorElemId)
    if (index === undefined) return undefined
    const marker = parseOpId(markerId), inside = new Set([anchorElemId])
    while (index < text.elems.length) {
      const elemId = text.elems[index].elemId
      const ref = inserts.get(elemId)
      if (ref === undefined || !inside.has(ref)) break
      if (ref === anchorElemId) {
        const elem = parseOpId(elemId)
        const later = elem.counter > marker.counter ||
          (elem.counter === marker.counter && elem.actorId > marker.actorId)
        if (!later) break
      }
      inside.add(elemId)
      index++
    }
    return index
  }
  for (const {begin, end} of pairs) {
    const start = begin.op.expand ? positions.get(begin.op.elemId)
                                  : floatingPosition(begin.op.elemId, begin.id)
    const endPos = end.op.expand ? floatingPosition(end.op.elemId, end.id)
                                 : positions.get(end.op.elemId)
    if (start !== undefined && endPos !== undefined && start <= endPos) {
      operations.push({name: begin.op.name, value: begin.op.value, start, end: endPos, id: begin.id})
    }
  }
  operations.sort((left, right) => {
    const leftId = left.id.split('@'), rightId = right.id.split('@')
    return parseInt(leftId[0], 10) - parseInt(rightId[0], 10) || leftId[1].localeCompare(rightId[1])
  })
  const values = Array.from({length: text.length}, () => ({}))
  for (const operation of operations) {
    for (let index = operation.start; index < operation.end; index++) {
      if (operation.value === null) delete values[index][operation.name]
      else values[index][operation.name] = operation.value
    }
  }
  const offsets = [0]
  for (let index = 0; index < text.length; index++) {
    offsets.push(offsets[index] + textElementWidth(text.get(index)))
  }
  const ranges = []
  const names = new Set(values.flatMap(value => Object.keys(value)))
  for (const name of names) {
    let start = 0
    while (start < values.length) {
      if (!Object.prototype.hasOwnProperty.call(values[start], name)) {
        start++
        continue
      }
      const value = values[start][name]
      let end = start + 1
      while (end < values.length && sameValue(values[end][name], value)) end++
      ranges.push({name, value, start: offsets[start], end: offsets[end]})
      start = end
    }
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end || left.name.localeCompare(right.name))
  return {text, values, ranges}
}

function marks(doc, path) {
  return markRanges(doc, path).ranges
}

function marksAt(doc, path, index) {
  const state = markRanges(doc, path)
  const length = textLength(state.text)
  if (!Number.isInteger(index) || index < 0 || index > length) {
    throw new RangeError('marksAt() index is invalid')
  }
  if (index === length) return {}
  const elementIndex = textElementIndex(state.text, index)
  return elementIndex === state.text.length ? {} : Object.assign({}, state.values[elementIndex])
}

function spans(doc, path) {
  const state = markRanges(doc, path)
  const result = []
  let value = '', active = null
  for (let index = 0; index < state.text.length; index++) {
    const marks = state.values[index]
    const element = state.text.get(index)
    if (typeof element !== 'string') {
      if (value.length > 0) {
        result.push(Object.keys(active).length > 0 ? {type: 'text', value, marks: active} : {type: 'text', value})
        value = ''
      }
      result.push({type: 'block', value: toJS(element)})
      active = null
      continue
    }
    if (active !== null && !sameValue(active, marks)) {
      result.push(Object.keys(active).length > 0 ? {type: 'text', value, marks: active} : {type: 'text', value})
      value = ''
    }
    value += element
    active = marks
  }
  if (value.length > 0) {
    result.push(Object.keys(active).length > 0 ? {type: 'text', value, marks: active} : {type: 'text', value})
  }
  return result
}

function richTextValue(value, block = false) {
  if (typeof value === 'string') return new Frontend.Text(value)
  if (Array.isArray(value)) return value.map(item => richTextValue(item))
  if (!isRecord(value)) return value
  // The Rust implementation generates the operations of a block marker with
  // the `type` property first.
  const keys = block ? Object.keys(value).sort((left, right) => {
    if (left === 'type') return -1
    if (right === 'type') return 1
    return left.localeCompare(right)
  }) : Object.keys(value)
  const result = {}
  for (const key of keys) result[key] = richTextValue(value[key])
  return result
}

function richTextTarget(doc, path, index, name, convert) {
  const target = valueAtPath(doc, path, name)
  let text = textAtTarget(target) || target.value
  if (typeof text === 'string' && convert) {
    target.parent[target.key] = new Frontend.Text(text)
    text = textAtTarget(target) || target.parent[target.key]
  }
  if (!(text instanceof Frontend.Text)) throw new RangeError(`${name}() path must resolve to Text`)
  if (typeof index === 'string') index = getCursorPosition(doc, path, index)
  if (!Number.isInteger(index) || index < 0 || index > textLength(text)) {
    throw new RangeError(`${name}() index is invalid`)
  }
  return {text, index: textElementIndex(text, index)}
}

function block(doc, path, index) {
  const target = richTextTarget(doc, path, index, 'block', false)
  if (target.index === target.text.length) return null
  const value = target.text.get(target.index)
  return isRecord(value) ? toJS(value) : null
}

function splitBlock(doc, path, index, value) {
  if (!isRecord(value)) throw new TypeError('splitBlock() block must be an object')
  const target = richTextTarget(doc, path, index, 'splitBlock', true)
  target.text.insertAt(target.index, richTextValue(value, true))
}

function joinBlock(doc, path, index) {
  const target = richTextTarget(doc, path, index, 'joinBlock', true)
  if (target.index < target.text.length) target.text.deleteAt(target.index)
}

function updateBlock(doc, path, index, value) {
  if (!isRecord(value)) throw new TypeError('updateBlock() block must be an object')
  const target = richTextTarget(doc, path, index, 'updateBlock', true)
  if (target.index === target.text.length) throw new RangeError('updateBlock() index is invalid')
  // The Rust implementation deletes the existing block marker and inserts a
  // replacement built with its properties in sorted order, rather than
  // overwriting the element in place.
  const sorted = {}
  for (const key of Object.keys(value).sort(compareUtf8)) sorted[key] = value[key]
  target.text.deleteAt(target.index)
  target.text.insertAt(target.index, richTextValue(sorted))
}

function updateSpans(doc, path, newSpans, config = {}) {
  if (!Array.isArray(newSpans)) throw new TypeError('updateSpans() spans must be an array')
  const target = richTextTarget(doc, path, 0, 'updateSpans', true)
  // Mirror the Rust implementation: the current and new content become
  // sequences of graphemes and block markers, a Myers diff (with merged
  // delete+insert runs) updates the text and block structure, and a second
  // pass reconciles the marks against the updated document.
  const next = [], nextMarks = []
  let index = 0
  for (const span of newSpans) {
    if (!span || span.type === 'text' && typeof span.value !== 'string' ||
        span.type === 'block' && !isRecord(span.value) || span.type !== 'text' && span.type !== 'block') {
      throw new TypeError('updateSpans() received an invalid span')
    }
    if (span.type === 'block') {
      next.push({block: span.value})
      index++
    } else {
      const value = wellFormedString(span.value)
      next.push(...graphemes(value))
      for (const name of Object.keys(span.marks || {}).sort(compareUtf8)) {
        nextMarks.push({start: index, end: index + value.length, name, value: span.marks[name]})
      }
      index += value.length
    }
  }
  const old = []
  {
    let run = ''
    for (const item of [...target.text]) {
      if (typeof item === 'string') { run += item; continue }
      if (run.length > 0) { old.push(...graphemes(run)); run = '' }
      old.push({block: item})
    }
    if (run.length > 0) old.push(...graphemes(run))
  }
  function width(item) { return typeof item === 'string' ? item.length : 1 }
  function itemEqual(left, right) {
    if (typeof left === 'string' || typeof right === 'string') return left === right
    return sameValue(left.block, right.block)
  }
  let at = 0
  const hook = {
    equal(oldIndex, newIndex, length) {
      for (let offset = 0; offset < length; offset++) at += width(old[oldIndex + offset])
    },
    delete(oldIndex, oldLength) {
      for (let offset = 0; offset < oldLength; offset++) {
        const item = old[oldIndex + offset]
        if (typeof item === 'string') splice(doc, path, at, item.length)
        else joinBlock(doc, path, at)
      }
    },
    insert(oldIndex, newIndex, newLength) {
      let run = ''
      function flush() {
        if (run.length === 0) return
        splice(doc, path, at, 0, run)
        at += run.length
        run = ''
      }
      for (let offset = 0; offset < newLength; offset++) {
        const item = next[newIndex + offset]
        if (typeof item === 'string') { run += item; continue }
        flush()
        splitBlock(doc, path, at, item.block)
        at++
      }
      flush()
    },
    replace(oldIndex, oldLength, newIndex, newLength) {
      let oldAt = oldIndex, newAt = newIndex
      while (oldAt < oldIndex + oldLength || newAt < newIndex + newLength) {
        const oldItem = oldAt < oldIndex + oldLength ? old[oldAt] : undefined
        const newItem = newAt < newIndex + newLength ? next[newAt] : undefined
        if (oldItem === undefined) {
          if (typeof newItem === 'string') {
            splice(doc, path, at, 0, newItem)
            at += newItem.length
          } else {
            splitBlock(doc, path, at, newItem.block)
            at++
          }
          newAt++
        } else if (newItem === undefined) {
          if (typeof oldItem === 'string') splice(doc, path, at, oldItem.length)
          else joinBlock(doc, path, at)
          oldAt++
        } else if (typeof oldItem !== 'string' && typeof newItem !== 'string') {
          if (!sameValue(oldItem.block, newItem.block)) updateBlock(doc, path, at, newItem.block)
          at++
          oldAt++
          newAt++
        } else if (typeof oldItem === 'string' && typeof newItem === 'string') {
          splice(doc, path, at, oldItem.length)
          splice(doc, path, at, 0, newItem)
          at += newItem.length
          oldAt++
          newAt++
        } else if (typeof oldItem !== 'string') {
          joinBlock(doc, path, at)
          splice(doc, path, at, 0, newItem)
          at += newItem.length
          oldAt++
          newAt++
        } else {
          splice(doc, path, at, oldItem.length)
          splitBlock(doc, path, at, newItem.block)
          at++
          oldAt++
          newAt++
        }
      }
    },
    finish() {}
  }
  myersDiff(replaceHook(hook), old, next, itemEqual)

  const defaultExpand = config.defaultExpand || 'after'
  function expandFor(name) { return config.perMarkExpand && config.perMarkExpand[name] || defaultExpand }
  const updated = richTextTarget(doc, path, 0, 'updateSpans', true)
  const currentDoc = updated.text.context.cache._root
  const currentMarks = markRangesForText(currentDoc, updated.text).ranges
  for (const range of currentMarks) {
    if (!nextMarks.some(nextMark => markEqual(range, nextMark))) {
      unmark(doc, path, {start: range.start, end: range.end, expand: expandFor(range.name)}, range.name)
    }
  }
  for (const range of nextMarks) {
    if (currentMarks.some(currentMark => markEqual(range, currentMark))) continue
    mark(doc, path, {start: range.start, end: range.end, expand: expandFor(range.name)}, range.name, range.value)
  }
}

function encodeSyncMessage(message) {
  return backend.encodeSyncMessage(message)
}

function decodeSyncMessage(message) {
  return backend.decodeSyncMessage(message)
}

function encodeSyncState(syncState) {
  return backend.encodeSyncState(syncState)
}

function decodeSyncState(syncState) {
  return backend.decodeSyncState(syncState)
}

function topoHistoryTraversal(doc) {
  const state = Frontend.getBackendState(doc, 'topoHistoryTraversal')
  if (backend.topoHistoryTraversal) return backend.topoHistoryTraversal(state)
  return backend.getAllChanges(state).map(change => decodeChange(change).hash)
}

function inspectChange(doc, hash) {
  const state = Frontend.getBackendState(doc, 'inspectChange')
  const change = backend.getChangeByHash(state, hash)
  return change ? decodeChange(change) : null
}

function fragmentLevel(hash) {
  let level = 0
  while (hash.slice(level * 2, level * 2 + 2) === '00') level++
  return level
}

function fragmentLevelRange(levels) {
  if (levels === undefined || levels === null) return {start: 0, end: Infinity}
  if (typeof levels === 'number') return {start: levels, end: levels + 1}
  if (!isObject(levels)) throw new TypeError('getFragmentMetadata() level must be a number or range')
  const start = levels.start === undefined ? 0 : levels.start
  const end = levels.end === undefined ? Infinity : levels.end
  if (!Number.isInteger(start) || end !== Infinity && !Number.isInteger(end)) {
    throw new TypeError('getFragmentMetadata() range bounds must be integers')
  }
  return {start, end}
}

function cloneFragmentMetadata(fragment) {
  return {
    head: fragment.head,
    level: fragment.level,
    boundary: fragment.boundary.slice(),
    checkpoints: fragment.checkpoints.slice(),
    members: fragment.members.slice()
  }
}

function buildFragmentMetadata(doc) {
  function descending(left, right) {
    return byHash.get(right).index - byHash.get(left).index
  }

  const state = Frontend.getBackendState(doc, 'getFragmentMetadata')
  let cacheKey, history
  if (backend.getHistoryMeta) {
    const metadata = backend.getHistoryMeta(state)
    cacheKey = metadata
    const cached = fragmentMetadataCache.get(cacheKey)
    if (cached) return cached
    history = metadata.map(change => ({
      index: change.index,
      hash: change.hash,
      deps: change.deps,
      level: fragmentLevel(change.hash)
    }))
  } else {
    const changes = backend.getAllChanges(state)
    cacheKey = state.state || state
    const cached = fragmentMetadataCache.get(cacheKey)
    if (cached && cached.length === changes.length) return cached
    history = changes.map((bytes, index) => {
      const change = decodeChangeMeta(bytes, true)
      return {bytes, index, hash: change.hash, deps: change.deps, level: fragmentLevel(change.hash)}
    })
  }
  const byHash = new Map(history.map(change => [change.hash, change]))
  const checkpointByHead = new Map()
  const checkpoints = []

  for (const change of history) {
    if (change.level === 0) continue
    const members = new Set(), boundary = new Set(), includedCheckpoints = new Set()
    const memberOrder = [], queue = [change.hash]
    let queueIndex = 0
    while (queueIndex < queue.length) {
      const hash = queue[queueIndex++]
      if (members.has(hash) || boundary.has(hash)) continue
      const current = byHash.get(hash)
      if (!current) continue
      if (hash !== change.hash && current.level >= change.level) {
        boundary.add(hash)
        const checkpoint = checkpointByHead.get(hash)
        if (checkpoint) for (const ancestor of checkpoint.boundary) boundary.add(ancestor)
      } else {
        members.add(hash)
        memberOrder.push(hash)
        if (current.level > 0) includedCheckpoints.add(hash)
        queue.push(...current.deps)
      }
    }
    const fragment = {
      head: change.hash,
      level: change.level,
      boundary: [...boundary].sort(descending),
      checkpoints: [...includedCheckpoints].sort(descending),
      members: memberOrder
    }
    checkpoints.push(fragment)
    checkpointByHead.set(change.hash, fragment)
  }

  const absorbed = new Set()
  for (const fragment of checkpoints) {
    for (const checkpoint of fragment.checkpoints) {
      if (checkpoint !== fragment.head) absorbed.add(checkpoint)
    }
  }
  const fragments = checkpoints.filter(fragment => !absorbed.has(fragment.head))
  const covered = new Set()
  for (const fragment of fragments) for (const hash of fragment.members) covered.add(hash)
  for (const change of history) {
    if (!covered.has(change.hash)) {
      fragments.push({
        head: change.hash,
        level: 0,
        boundary: change.deps.slice(),
        checkpoints: [],
        members: [change.hash]
      })
    }
  }
  fragments.sort((left, right) => byHash.get(left.head).index - byHash.get(right.head).index)
  const fragmentByHead = new Map(fragments.map(fragment => [fragment.head, fragment]))
  const result = {length: history.length, fragments, history, byHash, fragmentByHead, checkpointByHead, absorbed}
  fragmentMetadataCache.set(cacheKey, result)
  return result
}

function getFragmentMetadata(doc, levels) {
  const {start, end} = fragmentLevelRange(levels)
  return buildFragmentMetadata(doc).fragments
    .filter(fragment => fragment.level >= start && fragment.level < end)
    .map(cloneFragmentMetadata)
}

function bundleFragmentMetadata(doc, metadata) {
  if (!Array.isArray(metadata)) throw new TypeError('bundleFragmentMetadata() metadata must be an array')
  const state = Frontend.getBackendState(doc, 'bundleFragmentMetadata')
  const fragments = buildFragmentMetadata(doc)
  return metadata.map(fragment => {
    if (!fragment || typeof fragment.head !== 'string') throw new RangeError('Invalid fragment metadata')
    const change = fragments.byHash.get(fragment.head)
    if (!change) throw new RangeError(`Unknown fragment head: ${fragment.head}`)
    if (fragment.level === 0) return backend.getChangeByHash(state, fragment.head)
    const canonical = fragments.fragmentByHead.get(fragment.head)
    if (!canonical || canonical.level !== fragment.level) throw new RangeError(`Unavailable fragment: ${fragment.head}`)
    return saveBundle(doc, canonical.members)
  })
}

function getCommits(doc) {
  const metadata = getFragmentMetadata(doc, 0)
  const bundles = bundleFragmentMetadata(doc, metadata)
  return metadata.map((fragment, index) => ({
    head: fragment.head,
    parents: fragment.boundary,
    bytes: bundles[index]
  }))
}

function getFragments(doc, levels = {start: 1}) {
  const metadata = getFragmentMetadata(doc, levels)
  const bundles = bundleFragmentMetadata(doc, metadata)
  return metadata.map((fragment, index) => Object.assign({}, fragment, {bytes: bundles[index]}))
}

function getFragmentMeta(doc, head) {
  if (typeof head !== 'string') throw new TypeError('getFragmentMeta() head must be a string')
  const metadata = buildFragmentMetadata(doc)
  const change = metadata.byHash.get(head)
  if (!change) return null
  if (change.level === 0) {
    return {head, level: 0, boundary: change.deps.slice(), checkpoints: [], members: [head]}
  }
  const fragment = metadata.fragmentByHead.get(head)
  return fragment ? cloneFragmentMetadata(fragment) : null
}

function stats(doc) {
  const state = Frontend.getBackendState(doc, 'stats')
  let result
  if (backend.stats) {
    result = backend.stats(state)
  } else {
    const changes = backend.getAllChanges(state).map(decodeChange)
    result = {
      numChanges: changes.length,
      numOps: changes.reduce((count, change) => count + change.ops.length, 0),
      numActors: new Set(changes.map(change => change.actor)).size
    }
  }
  return Object.assign({
    cargoPackageName: '@automerge/automerge-classic',
    cargoPackageVersion: 'classic',
    rustcVersion: 'not applicable'
  }, result)
}

function resolvedPromise() {
  const scope = typeof self === 'undefined' ? global : self
  const name = 'Promise'
  return scope[name].resolve()
}

function initializeWasm() {
  return resolvedPromise()
}

function initializeBase64Wasm() {
  return resolvedPromise()
}

function wasmInitialized() {
  return resolvedPromise()
}

function isWasmInitialized() {
  return true
}

function use() {}

function dump() {}

function releaseInfo() {
  return {js: {gitHead: 'classic'}, wasm: null}
}

function generateSyncMessage(doc, syncState) {
  const state = Frontend.getBackendState(doc, 'generateSyncMessage')
  return backend.generateSyncMessage(state, syncState)
}

function receiveSyncMessage(doc, oldSyncState, message, options = {}) {
  assertWritable(doc)
  const oldBackendState = Frontend.getBackendState(doc, 'receiveSyncMessage')
  const [backendState, syncState, patch] = backend.receiveSyncMessage(oldBackendState, oldSyncState, message)
  if (!patch) return [doc, syncState, null]

  // The patchCallback is passed as argument all changes that are applied.
  // We get those from the sync message if a patchCallback is present.
  let changes = null
  if (options.patchCallback || doc[OPTIONS].patchCallback) {
    changes = backend.decodeSyncMessage(message).changes
  }
  return [applyBackendPatch(doc, patch, backendState, changes, options, 'receiveSyncMessage'), syncState, null]
}

function initSyncState(options) {
  return backend.initSyncState(options)
}

function hasOurChanges(doc, remoteState) {
  if (!remoteState || !Array.isArray(remoteState.sharedHeads)) return false
  const heads = getHeads(doc)
  return heads.length === remoteState.sharedHeads.length &&
    heads.every((head, index) => head === remoteState.sharedHeads[index])
}

/**
 * Replaces the default backend implementation with a different one.
 * This allows you to switch to using the Rust/WebAssembly implementation.
 */
function setDefaultBackend(newBackend) {
  backend = newBackend
}

// Code that was bundled against the wasm implementation (for example plugin
// bundles that ship their own copy of @automerge/automerge) reads document
// internals through globally registered symbols: Symbol.for('_am_objectId')
// identifies the root, and Symbol.for('_am_meta') carries the internal state,
// whose `handle` exposes the wasm document API. Attaching equivalents to every
// classic document root lets such code read classic documents.
function makeInteropHandle(doc) {
  return {
    getHeads() { return getHeads(doc) },
    diff(before, after) { return diff(doc, before, after) },
    materialize(objId, heads) {
      let target = doc
      if (heads) target = view(doc, heads)
      if (objId !== undefined && objId !== '_root' && objId !== '/') {
        throw new RangeError(`classic interop can only materialize the document root, not ${objId}`)
      }
      return toJS(target)
    },
    stats() { return stats(doc) },
    save() { return save(doc) },
    saveSince(heads) { return saveSince(doc, heads) },
    getChangesMeta(heads) { return getChangesMetaSince(doc, heads || []) },
    topoHistoryTraversal() { return topoHistoryTraversal(doc) }
  }
}

Frontend.setInteropAttach(doc => {
  Object.defineProperty(doc, Symbol.for('_am_objectId'), {value: '_root'})
  let meta
  Object.defineProperty(doc, Symbol.for('_am_meta'), {get() {
    if (!meta) {
      meta = {handle: makeInteropHandle(doc), heads: undefined, freeze: false,
              mostRecentPatch: undefined, patchCallback: undefined}
    }
    return meta
  }})
})

const api = {
  init, from, change, emptyChange, clone, free,
  load, save, merge, getChanges, getAllChanges, applyChanges,
  loadIncremental, saveIncremental, saveSince, saveBundle, readBundle, addCommits, addFragments,
  getHeads, getBackend, getMissingDeps, hasHeads, hasOurChanges, getChangesSince, getChangesMetaSince,
  view, changeAt, diff, diffPath, applyPatch, applyPatches, toJS, isAutomerge, isCounter,
  insertAt, deleteAt, splice, updateText, getCursor, getCursorPosition,
  encodeChange, decodeChange, equals, getHistory, uuid,
  Frontend, setDefaultBackend, generateSyncMessage, receiveSyncMessage, initSyncState,
  encodeSyncMessage, decodeSyncMessage, encodeSyncState, decodeSyncState,
  topoHistoryTraversal, inspectChange, stats,
  getFragmentMetadata, getFragmentMeta, bundleFragmentMetadata, getCommits, getFragments,
  getObjectId, getConflicts,
  getLastLocalChange,
  ImmutableString, RawString: ImmutableString,
  isImmutableString, isRawString: isImmutableString,
  initializeWasm, initializeBase64Wasm, wasmInitialized, isWasmInitialized, use, dump, releaseInfo,
  mark, unmark, marks, marksAt, spans, updateSpans,
  block, splitBlock, joinBlock, updateBlock,
  get Backend() { return backend }
}

for (let name of ['getObjectById', 'getActorId',
     'setActorId',
     'Text', 'Table', 'Counter', 'Observable', 'Int', 'Uint', 'Float64']) {
  api[name] = Frontend[name]
}

api.next = Object.assign({}, api)
Object.defineProperty(api.next, 'Backend', {enumerable: true, get() { return backend }})

module.exports = api
