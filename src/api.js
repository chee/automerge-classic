import * as Frontend from '../frontend/index.js'
import { CHANGE, CONFLICTS, OBJECT_ID, OPTIONS, STATE } from '../frontend/constants.js'
import { decodeChange, decodeChangeColumns, decodeChanges, encodeChange as encodeChangeRaw } from '../backend/columnar.js'
import { compareUtf8, isObject, parseOpId, wellFormedString } from './common.js'
import { ImmutableString, isImmutableString } from './immutable_string.js'
import { graphemes, myersDiff, replaceHook } from './text_diff.js'
import { instantiateText } from '../frontend/text.js'
import * as backend from '../backend/index.js'

const viewDocs = new WeakSet()

/**
 * Automerge.* API
 * The functions in this file constitute the publicly facing Automerge API which combines
 * the features of the Frontend (a document interface) and the backend (CRDT operations)
 */

// The modern package accepts an actor ID string or an options object with
// the keys below; everything else (including the v1 spellings actorId and
// deferActorId) is ignored, matching its behavior exactly
const INIT_OPTION_KEYS = ['freeze', 'patchCallback', 'unchecked', 'allowMissingChanges', 'convertImmutableStringsToText']

export function encodeChange(change, actorOrder) {
  if (!change || !Array.isArray(change.ops)) return encodeChangeRaw(change, actorOrder)
  const ops = change.ops.map(op => {
    const field = Object.keys(op).find(key => (key === 'values' || key === 'multiOp') && op[key] !== undefined)
    if (field) {
      throw new RangeError(`Unable to read JS change: unknown field \`${field}\`, expected one of ` +
        '`ops`, `deps`, `message`, `seq`, `actor`, `requestType`')
    }
    if (op.action === 'inc') return Object.assign({}, op, {datatype: 'int', value: Math.trunc(op.value)})
    if (op.datatype !== undefined || !Number.isInteger(op.value) ||
        op.value < 0 || op.value > Number.MAX_SAFE_INTEGER) return op
    return Object.assign({}, op, {datatype: 'uint'})
  })
  return encodeChangeRaw(Object.assign({}, change, {ops}), actorOrder)
}

function assertWritable(doc) {
  if (viewDocs.has(doc)) {
    throw new RangeError('Cannot change an Automerge view; clone it first')
  }
}

export function init(options) {
  const normalized = {backend, textV2: true}
  if (typeof options === 'string') {
    normalized.actorId = options
  } else if (isObject(options)) {
    for (const key of INIT_OPTION_KEYS) {
      if (options[key] !== undefined) normalized[key] = options[key]
    }
    if (options.actor !== null && options.actor !== undefined) normalized.actorId = options.actor
  } else if (options !== undefined) {
    throw new TypeError(`Unsupported options for init(): ${options}`)
  }
  return Frontend.init(normalized)
}

function fromState(state, options) {
  return Frontend.applyPatch(init(options), backend.getPatch(state), state)
}

/**
 * Returns a new document object initialized with the given state.
 */
export function from(initialState, options) {
  const state = copyPatchValue(initialState)
  const entries = Object.keys(state).sort(compareUtf8).map(key => [key, state[key]])
  return changeWithSource(init(options), {}, doc => { doc[CHANGE].setMapKeys([], entries, true) }, 'from')
}

export function change(doc, options, callback) {
  return changeWithSource(doc, options, callback, 'change')
}

function changeWithSource(doc, options, callback, source) {
  assertWritable(doc)
  if (typeof options === 'function') {
    callback = options
    options = undefined
  }
  return superseded(doc, Frontend.change(doc, patchOptions(doc, options, source), callback)[0])
}

export function emptyChange(doc, options) {
  assertWritable(doc)
  return superseded(doc, Frontend.emptyChange(doc, patchOptions(doc, options, 'emptyChange'))[0])
}

export function clone(doc, options = {}) {
  return fromState(backend.clone(Frontend.getBackendState(doc, 'clone')), options)
}

export function free(doc) {
  backend.free(Frontend.getBackendState(doc, 'free'))
}

export function load(data, options = {}) {
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

export function save(doc) {
  return backend.save(Frontend.getBackendState(doc, 'save'))
}

export function merge(localDoc, remoteDoc, options = {}) {
  assertWritable(localDoc)
  const localState = Frontend.getBackendState(localDoc, 'merge')
  const remoteState = Frontend.getBackendState(remoteDoc, 'merge', 'second')
  return applyChangesWithSource(localDoc, backend.getChangesAdded(localState, remoteState), options, 'merge')
}

export function getChanges(oldDoc, newDoc) {
  const oldState = Frontend.getBackendState(oldDoc, 'getChanges')
  const newState = Frontend.getBackendState(newDoc, 'getChanges', 'second')
  return backend.getChanges(newState, backend.getHeads(oldState))
}

export function getAllChanges(doc) {
  return backend.getAllChanges(Frontend.getBackendState(doc, 'getAllChanges'))
}

export function getHeads(doc) {
  return backend.getHeads(Frontend.getBackendState(doc, 'getHeads'))
}

export function getBackend(doc) {
  return Frontend.getBackendState(doc, 'getBackend')
}

export function getObjectId(object, prop) {
  if (object === null || object === undefined) return null
  return (arguments.length > 1 ? Frontend.getObjectId(object, prop) : Frontend.getObjectId(object)) || null
}

export function getConflicts(object, key) {
  const values = Frontend.getConflicts(object, key)
  if (!values) return
  const projected = {}
  for (const opId of Object.keys(values)) {
    projected[opId] = values[opId] instanceof Frontend.Text ? values[opId].toJSON() : values[opId]
  }
  return projected
}

export function getMissingDeps(doc, heads = []) {
  return backend.getMissingDeps(Frontend.getBackendState(doc, 'getMissingDeps'), heads)
}

export function hasHeads(doc, heads) {
  if (!Array.isArray(heads)) throw new TypeError('Pass an array of hashes to hasHeads()')
  return backend.hasHeads(Frontend.getBackendState(doc, 'hasHeads'), heads)
}

export function getChangesSince(doc, heads) {
  return backend.getChanges(Frontend.getBackendState(doc, 'getChangesSince'), heads)
}

export function getChangesMetaSince(doc, heads) {
  return backend.getChangesMeta(Frontend.getBackendState(doc, 'getChangesMetaSince'), heads)
}

function patchOptions(doc, options, source) {
  const normalized = typeof options === 'string' ? {message: options} : Object.assign({}, options)
  const callback = normalized.patchCallback || doc[OPTIONS] && doc[OPTIONS].patchCallback
  if (callback) {
    normalized.patchCallback = (patch, before, after, local, changes) => {
      callPatchCallback(callback, before, after, changes, source)
    }
  }
  return normalized
}

function callPatchCallback(callback, before, after, changes, source) {
  const scope = documentHasMarkOps(after) ? changeScope(changes, before, after) : {}
  const patches = patchesBetween(before, after, scope.objects, scope.clock)
  if (patches.length > 0) callback(patches, {before, after, source})
}

function applyBackendPatch(doc, patch, backendState, changes, options, source) {
  const newDoc = Frontend.applyPatch(doc, patch, backendState)
  const patchCallback = options.patchCallback || doc[OPTIONS].patchCallback
  if (patchCallback) callPatchCallback(patchCallback, doc, newDoc, changes, source)
  return superseded(doc, newDoc)
}

export function applyChanges(doc, changes, options = {}) {
  return [applyChangesWithSource(doc, changes, options, 'applyChanges')]
}

function applyChangesWithSource(doc, changes, options, source) {
  assertWritable(doc)
  const [newState, patch] = backend.applyChanges(Frontend.getBackendState(doc, 'applyChanges'), changes)
  return applyBackendPatch(doc, patch, newState, changes, options, source)
}

export function loadIncremental(doc, data, options = {}) {
  assertWritable(doc)
  const oldState = Frontend.getBackendState(doc, 'loadIncremental')
  const [newState, patch] = backend.loadIncremental(oldState, data)
  if (!patch) return doc
  return applyBackendPatch(doc, patch, newState, [data], options, 'loadIncremental')
}

export function saveIncremental(doc) {
  return backend.saveIncremental(Frontend.getBackendState(doc, 'saveIncremental'))
}

export function saveSince(doc, heads) {
  return backend.saveSince(Frontend.getBackendState(doc, 'saveSince'), heads)
}

export function saveBundle(doc, hashes) {
  if (!Array.isArray(hashes)) throw new TypeError('saveBundle() hashes must be an array')
  const state = Frontend.getBackendState(doc, 'saveBundle')
  if (new Set(hashes).size !== hashes.length) throw new RangeError('saveBundle() hashes must be unique')
  return backend.saveBundleByHash(state, hashes)
}

export function readBundle(bundle) {
  const {changes, deps} = backend.readBundle(bundle)
  return {changes, deps}
}

function readProperty(value, name, prefix) {
  try {
    return Reflect.get(value, name)
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : String(error)
    throw new RangeError(`${prefix}unable to get property JsValue("${name}"): JsValue(${detail})`)
  }
}

function rustChar(byte) {
  const escapes = {0: '\\0', 9: '\\t', 10: '\\n', 13: '\\r', 39: "\\'", 92: '\\\\'}
  if (escapes[byte]) return `'${escapes[byte]}'`
  if (byte < 0x20 || (byte >= 0x7f && byte <= 0xa0) || byte === 0xad) return `'\\u{${byte.toString(16)}}'`
  return `'${String.fromCharCode(byte)}'`
}

function hashError(hash) {
  if (typeof hash !== 'string') return 'change hash was not a string'
  const bytes = new TextEncoder().encode(hash)
  if (bytes.length % 2 !== 0) return 'Odd number of digits'
  const bad = bytes.findIndex(byte => !/[0-9a-fA-F]/.test(String.fromCharCode(byte)))
  if (bad >= 0) return `Invalid character ${rustChar(bytes[bad])} at position ${bad}`
  if (bytes.length !== 64) return `incorrect length, change hash should be 32 bytes, got ${bytes.length / 2}`
  return null
}

function hashesError(hashes) {
  if (!Array.isArray(hashes)) return 'the change hashes were not an array of strings'
  for (let i = 0; i < hashes.length; i++) {
    const error = hashError(hashes[i])
    if (error) return `could not decode hash ${i}: ${error}`
  }
  return null
}

function isLevel(value) {
  return Number.isInteger(value) && value >= 0
}

function fragmentLevels(levels) {
  if (levels === undefined || levels === null) return [0, Infinity]
  if (typeof levels === 'number') {
    if (!isLevel(levels)) throw new RangeError('fragment level must be a non-negative integer')
    return [levels, levels + 1]
  }
  const prefix = 'bad fragment level range property: '
  const start = readProperty(levels, 'start', prefix)
  if (typeof start === 'number' && !isLevel(start)) throw new RangeError('fragment level range start must be a non-negative integer')
  const end = readProperty(levels, 'end', prefix)
  if (typeof end === 'number' && !isLevel(end)) throw new RangeError('fragment level range end must be a non-negative integer')
  return [typeof start === 'number' ? start : 0, typeof end === 'number' ? end : Infinity]
}

function readInputs(inputs, notArray, readInput) {
  if (!Array.isArray(inputs)) throw new RangeError(notArray)
  const result = []
  for (let i = 0; i < inputs.length; i++) result.push(readInput(inputs[i], i))
  return result
}

function readFragment(value, prefix, withBytes) {
  function read(name) {
    return readProperty(value, name, `${prefix}bad fragment input property: `)
  }
  const head = read('head'), headError = hashError(head)
  if (headError) throw new RangeError(`${prefix}bad fragment head: ${headError}`)
  const fragment = {head: head.toLowerCase()}
  if (!isLevel(read('level'))) throw new RangeError(`${prefix}bad fragment level`)
  for (const name of ['boundary', 'checkpoints', 'members']) {
    const hashes = read(name), error = hashesError(hashes)
    if (error) throw new RangeError(`${prefix}bad fragment ${name}: ${error}`)
    fragment[name] = hashes.map(hash => hash.toLowerCase())
  }
  if (withBytes) {
    fragment.bytes = read('bytes')
    if (!(fragment.bytes instanceof Uint8Array)) throw new RangeError(`${prefix}bad fragment bytes: not a Uint8Array`)
  }
  return fragment
}

function readCommit(value, prefix) {
  function read(name) {
    return readProperty(value, name, `${prefix}bad commit input property: `)
  }
  const head = read('head'), headError = hashError(head)
  if (headError) throw new RangeError(`${prefix}bad commit head: ${headError}`)
  const parents = read('parents'), parentsError = hashesError(parents)
  if (parentsError) throw new RangeError(`${prefix}bad commit parents: ${parentsError}`)
  const bytes = read('bytes')
  if (!(bytes instanceof Uint8Array)) throw new RangeError(`${prefix}bad commit bytes: not a Uint8Array`)
  return {head: head.toLowerCase(), parents: parents.map(parent => parent.toLowerCase()), bytes}
}

function parseErrorMessage(bytes, error, unit) {
  const message = error.message
  if (message.startsWith('Data does not begin with magic bytes')) return `unable to parse ${unit}: failed to parse header: Invalid magic bytes`
  if (unit === 'change' && bytes[8] > 3) return `unable to parse change: failed to parse header: unknown chunk type: ${bytes[8]}`
  if (['subarray exceeds buffer size', 'buffer ended with incomplete number'].includes(message)) return `unable to parse ${unit}: not enough data`
  if (message === 'checksum does not match data' && unit === 'chunk') return 'bad checksum'
  if (message === 'Encoded change has trailing data') return 'leftover data after parsing'
  if (message.startsWith('Unexpected chunk type')) return 'wrong chunk type'
  return unit === 'change' ? `unable to parse change: ${message}` : message
}

export function getFragmentMetadata(doc, levels) {
  const [start, end] = fragmentLevels(levels)
  return backend.getFragments(Frontend.getBackendState(doc, 'getFragmentMetadata'), start, end)
}

export function getFragmentMeta(doc, head) {
  const state = Frontend.getBackendState(doc, 'getFragmentMeta')
  const error = hashError(head)
  if (error) throw error
  return backend.getFragment(state, head.toLowerCase())
}

export function bundleFragmentMetadata(doc, fragments) {
  const state = Frontend.getBackendState(doc, 'bundleFragmentMetadata')
  const inputs = readInputs(fragments, 'fragments must be an array', (fragment, i) => readFragment(fragment, `bad fragment at index ${i}: `, false))
  return backend.bundleFragments(state, inputs)
}

export function getCommits(doc) {
  const state = Frontend.getBackendState(doc, 'getCommits')
  const commits = backend.getFragments(state, 0, 1)
  const bytes = backend.bundleFragments(state, commits)
  return commits.map((fragment, index) => ({head: fragment.head, parents: fragment.boundary, bytes: bytes[index]}))
}

export function getFragments(doc, levels) {
  const state = Frontend.getBackendState(doc, 'getFragments')
  const [start, end] = fragmentLevels(levels === undefined || levels === null ? {start: 1} : levels)
  const fragments = backend.getFragments(state, start, end)
  const bytes = backend.bundleFragments(state, fragments)
  return fragments.map((fragment, index) => Object.assign(fragment, {bytes: bytes[index]}))
}

export function addCommits(doc, commits, options) {
  assertWritable(doc)
  const state = Frontend.getBackendState(doc, 'addCommits')
  const inputs = readInputs(commits, 'commit inputs must be an array', (commit, i) => readCommit(commit, `bad commit input at index ${i}: `))
  for (const commit of inputs) {
    let change
    try {
      change = decodeChangeColumns(commit.bytes)
    } catch (error) {
      throw new RangeError(`bad commit bytes: ${parseErrorMessage(commit.bytes, error, 'change')}`)
    }
    if (change.hash !== commit.head) {
      throw new RangeError(`commit input head mismatch: expected ${commit.head}, actual ${change.hash}`)
    }
    if (change.deps.length !== commit.parents.length || change.deps.some((dep, i) => dep !== commit.parents[i])) {
      throw new RangeError('commit input parents do not match encoded change dependencies')
    }
  }
  const changes = inputs.map(commit => commit.bytes)
  const [newState, patch] = backend.applyChanges(state, changes)
  return applyBackendPatch(doc, patch, newState, changes, options || {}, 'addCommits')
}

export function addFragments(doc, fragments, options) {
  assertWritable(doc)
  const state = Frontend.getBackendState(doc, 'addFragments')
  const inputs = readInputs(fragments, 'fragment inputs must be an array', (fragment, i) => readFragment(fragment, `bad fragment input at index ${i}: `, true))
  const data = new Uint8Array(inputs.reduce((length, input) => length + input.bytes.byteLength, 0))
  let offset = 0
  for (const input of inputs) {
    data.set(input.bytes, offset)
    offset += input.bytes.byteLength
  }
  let newState, patch
  try {
    [newState, patch] = backend.loadIncremental(state, data)
  } catch (error) {
    if (state.frozen) throw error
    throw new RangeError(`error loading fragment bundles: ${parseErrorMessage(data, error, 'chunk')}`)
  }
  if (!patch) return doc
  return applyBackendPatch(doc, patch, newState, [data], options || {}, 'addFragments')
}

export function equals(val1, val2) {
  if (!isObject(val1) || !isObject(val2)) return val1 === val2
  const keys1 = Object.keys(val1).sort(), keys2 = Object.keys(val2).sort()
  return keys1.length === keys2.length &&
    keys1.every((key, i) => key === keys2[i] && equals(val1[key], val2[key]))
}

export function getHistory(doc) {
  const actor = Frontend.getActorId(doc)
  const history = getAllChanges(doc)
  return history.map((change, index) => ({
      get change () {
        return decodeChange(change)
      },
      get snapshot () {
        return fromState(backend.loadChanges(backend.init(), history.slice(0, index + 1)), actor)
      }
    })
  )
}

export function view(doc, heads) {
  if (!Array.isArray(heads)) throw new TypeError('Pass an array of hashes to view()')
  const [state, patch] = backend.view(Frontend.getBackendState(doc, 'view'), heads)
  const snapshot = Frontend.applyPatch(init({freeze: doc[OPTIONS].freeze}), patch, state)
  viewDocs.add(snapshot)
  return snapshot
}

export function changeAt(doc, heads, options, callback) {
  assertWritable(doc)
  if (typeof options === 'function') {
    callback = options
    options = undefined
  }
  const branch = clone(view(doc, heads))
  // The Rust implementation numbers the operations of the isolated change
  // above every operation in the document, not just those it can see, so that
  // successive changes at the same heads are ordered by the order they were
  // made.
  branch[STATE].maxOp = Math.max(branch[STATE].maxOp, doc[STATE].maxOp)
  const branchOptions = isObject(options) ? Object.assign({}, options, {patchCallback: undefined}) : options
  const changed = changeWithSource(branch, branchOptions, callback, 'changeAt')
  if (changed === branch) return {newDoc: doc, newHeads: null}
  const newHeads = getHeads(changed)
  const oldState = Frontend.getBackendState(doc, 'changeAt')
  const changedState = Frontend.getBackendState(changed, 'changeAt', 'second')
  const changes = backend.getChangesAdded(oldState, changedState)
  return {newDoc: applyChangesWithSource(doc, changes, options || {}, 'changeAt'), newHeads}
}

export function toJS(value) {
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

export function isAutomerge(value) {
  return isObject(value) && Frontend.getObjectId(value) === '_root'
}

export function isCounter(value) {
  return value instanceof Frontend.Counter
}

export function getLastLocalChange(doc) {
  return Frontend.getLastLocalChange(doc) || undefined
}

export function insertAt(list, index, ...values) {
  if (!list || typeof list.insertAt !== 'function') {
    throw new RangeError('object cannot be modified outside of a change block')
  }
  list.insertAt(index, ...values)
}

export function deleteAt(list, index, numDelete) {
  if (!list || typeof list.deleteAt !== 'function') {
    throw new RangeError('object cannot be modified outside of a change block')
  }
  list.deleteAt(index, numDelete)
}

function valueAtPath(doc, path, name) {
  if (!Array.isArray(path)) throw new TypeError(`${name}() path must be an array`)
  if (path.length === 0) throw new RangeError(`${name}() path must not be empty`)
  let parent, key, value = doc
  for (const prop of path) {
    if (value === null || value === undefined || !['string', 'number'].includes(typeof prop)) {
      throw new RangeError(`${name}() path does not resolve to a string, Text, or list`)
    }
    parent = value
    key = prop
    value = parent[key]
  }
  return {parent, key, value: value instanceof Frontend.Text ? value : Frontend.getText(parent, key) || value}
}

function valueAt(object, key) {
  return Frontend.getText(object, key) || object[key]
}

function textElementWidth(value) {
  return typeof value === 'string' ? value.length : 1
}

function textLength(text) {
  return text.toJSON().length
}

function textOffsets(text) {
  const offsets = [0]
  for (const value of text) offsets.push(offsets[offsets.length - 1] + textElementWidth(value))
  return offsets
}

function textElementIndex(text, offset) {
  if (offset <= 0) return 0
  if (textLength(text) === text.length) return Math.min(offset, text.length)
  let current = 0, index = 0
  for (const value of text) {
    current += textElementWidth(value)
    index++
    if (offset <= current) return index
  }
  return index
}

function textCursorIndex(text, offset) {
  if (textLength(text) === text.length) return Math.max(0, Math.min(offset, text.length))
  let current = 0, index = 0
  for (const value of text) {
    current += textElementWidth(value)
    if (offset < current) return index
    index++
  }
  return index
}

export function splice(doc, path, index, del, newText = '') {
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
  const text = target.value
  if (typeof text !== 'string' && !(text instanceof Frontend.Text) && !Array.isArray(text)) {
    throw new RangeError('splice() path does not resolve to a string, Text, or list')
  }
  const length = text instanceof Frontend.Text ? textLength(text) : text.length
  if (index < 0 || index > length) throw new RangeError('splice() index is out of bounds')
  del = Math.min(del, length - index)
  if (text instanceof Frontend.Text) {
    spliceText(text, index, del, newText)
  } else if (Array.isArray(text)) {
    text.splice(index, del, ...newText)
  } else {
    target.parent[target.key] = text.slice(0, index) + newText + text.slice(index + del)
  }
}

// The Rust implementation renders the current text with block markers as
// U+FFFC, splits both strings into graphemes, and applies each Myers diff
// edit as a splice. Replicating that exactly keeps the generated operations,
// and therefore the change hashes, identical.
function textEdits(text, newText) {
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
  return edits
}

export function updateText(doc, path, newText) {
  if (typeof newText !== 'string') throw new TypeError('updateText() text must be a string')
  newText = wellFormedString(newText)
  const text = valueAtPath(doc, path, 'updateText').value
  if (!(text instanceof Frontend.Text) && !Array.isArray(text)) {
    throw new RangeError('updateText() path does not resolve to a string, Text, or list')
  }
  for (const edit of textEdits(text, newText)) splice(doc, path, edit.index, edit.del, edit.text)
}

function spliceText(text, index, del, newText) {
  const chars = [...newText]
  const start = textElementIndex(text, index)
  let deleteCount = 0, deleted = 0
  while (start + deleteCount < text.length && deleted < del) {
    deleted += textElementWidth(text.get(start + deleteCount))
    deleteCount++
  }
  if (chars.length > 0) text.insertAt(start, ...chars)
  if (deleteCount > 0) text.deleteAt(start + chars.length, deleteCount)
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
    if (left.length !== right.length) return false
    const rightElems = right.elems
    return left.elems.every((elem, index) => sameValue(elem.value, rightElems[index].value))
  }
  if (left instanceof Frontend.Counter && right instanceof Frontend.Counter) {
    return left.value === right.value
  }
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  if (Array.isArray(left) && Array.isArray(right) || left instanceof Uint8Array && right instanceof Uint8Array) {
    if (left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) {
      if (!sameValue(left[index], right[index])) return false
    }
    return true
  }
  if (!isObject(left) || !isObject(right)) return false
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameValue(left[key], right[key]))
}

function isRecord(value) {
  if (!isObject(value) || Array.isArray(value) || value instanceof Date ||
      value instanceof Frontend.Text || value instanceof Frontend.Counter ||
      ArrayBuffer.isView(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

// Text elements are matched by their element ID where both sides have one:
// two elements can hold the same character and still be different elements,
// and which one survives a change decides which marks apply to it. A block
// marker that keeps its identity is updated in place, like the Rust
// implementation, rather than deleted and reinserted.
function textElements(value) {
  if (value instanceof Frontend.Text) return value.elems
  return [...value].map(item => ({value: item}))
}

function sameTextElement(left, right) {
  if (left.elemId && right.elemId) return left.elemId === right.elemId
  if (sameValue(left.value, right.value)) return true
  if (!isRecord(left.value) || !isRecord(right.value)) return false
  const leftId = left.value[OBJECT_ID], rightId = right.value[OBJECT_ID]
  return Boolean(leftId) && leftId === rightId
}

/**
 * Emits a run of text elements as `splice` patches, starting a new patch
 * whenever the mark set changes, and calling `onBlock` for each non-string
 * element after emitting its placeholder insert. Returns the index reached.
 */
function emitTextRuns(target, path, startIndex, items, marksOf, onBlock) {
  let index = startIndex, text = '', textMarks
  function flushText() {
    if (text.length === 0) return
    const patch = {action: 'splice', path: path.concat(index), value: text}
    if (textMarks && Object.keys(textMarks).length > 0) patch.marks = Object.assign({}, textMarks)
    target.push(patch)
    index += text.length
    text = ''
    textMarks = undefined
  }
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex]
    const itemMarks = marksOf(itemIndex) || {}
    if (typeof item === 'string') {
      if (text.length > 0 && !sameValue(textMarks, itemMarks)) flushText()
      if (text.length === 0) textMarks = itemMarks
      text += item
      continue
    }
    flushText()
    target.push({action: 'insert', path: path.concat(index), values: [{}]})
    onBlock(item, index)
    index++
  }
  flushText()
  return index
}

function appendRichTextDiff(patches, beforeText, afterText, path, afterDoc) {
  const before = textElements(beforeText), after = textElements(afterText)
  const updatedPrefix = [], updatedSuffix = []
  let prefix = 0
  while (prefix < before.length && prefix < after.length && sameTextElement(before[prefix], after[prefix])) {
    if (!sameValue(before[prefix].value, after[prefix].value)) updatedPrefix.push([prefix, prefix])
    prefix++
  }
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
         sameTextElement(before[before.length - suffix - 1], after[after.length - suffix - 1])) {
    if (!sameValue(before[before.length - suffix - 1].value, after[after.length - suffix - 1].value)) {
      updatedSuffix.push([before.length - suffix - 1, after.length - suffix - 1])
    }
    suffix++
  }
  function width(items) {
    return items.reduce((total, item) => total + textElementWidth(item.value), 0)
  }
  function appendUpdated(pairs) {
    for (const [beforeIndex, afterIndex] of pairs.sort((left, right) => left[1] - right[1])) {
      const at = width(after.slice(0, afterIndex))
      // block attributes hold no marks, and their paths run through a text
      // index that the document value cannot be walked through
      appendRecordDiff(patches, before[beforeIndex].value, after[afterIndex].value, path.concat(at), null)
    }
  }
  appendUpdated(updatedPrefix)
  const removed = before.length - prefix - suffix
  const offset = width(before.slice(0, prefix))
  const deleteLength = width(before.slice(prefix, prefix + removed))
  const inserted = after.slice(prefix, after.length - suffix).map(item => item.value)
  const insertBeforeDelete = removed > 0 && inserted.length > 0 && inserted.every(value => typeof value === 'string')
  if (removed > 0 && !insertBeforeDelete) appendDelete(patches, path.concat(offset), deleteLength)
  const markState = afterDoc ? markRanges(afterDoc, path).values : []
  const index = emitTextRuns(patches, path, offset, inserted, i => markState[prefix + i], (value, at) => {
    const updatingBlock = removed === 1 && inserted.length === 1 &&
      isRecord(before[prefix].value) && isRecord(value)
    appendRecordDiff(patches, {}, value, path.concat(at), afterDoc, updatingBlock ? blockKeys(value) : undefined)
  })
  if (insertBeforeDelete) appendDelete(patches, path.concat(index), deleteLength)
  appendUpdated(updatedSuffix)
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
  function sameElement(beforeIndex, afterIndex) {
    return (!beforeIds || !afterIds || beforeIds[beforeIndex] === afterIds[afterIndex]) &&
      sameValue(valueAt(before, beforeIndex), valueAt(after, afterIndex))
  }
  let prefix = 0
  while (prefix < before.length && prefix < after.length && sameElement(prefix, prefix)) prefix++
  let suffix = 0
  while (suffix < before.length - prefix && suffix < after.length - prefix &&
         sameElement(before.length - suffix - 1, after.length - suffix - 1)) suffix++
  const beforeMiddle = before.length - prefix - suffix
  const afterMiddle = after.length - prefix - suffix
  const common = Math.min(beforeMiddle, afterMiddle)
  for (let index = prefix; index < prefix + common; index++) {
    collectValueDiff(units, unit.patches, valueAt(before, index), valueAt(after, index),
      path.concat(index), afterDoc, keyConflict(after, index))
  }
  const start = prefix + common
  if (beforeMiddle > afterMiddle) {
    appendDelete(unit.patches, path.concat(start), beforeMiddle - common)
  } else if (afterMiddle > beforeMiddle) {
    const values = Array.from({length: afterMiddle - common}, (_, offset) => valueAt(after, start + offset))
    const patch = {action: 'insert', path: path.concat(start), values: values.map(patchPlaceholder)}
    insertConflicts(patch, after, start, values.length)
    unit.patches.push(patch)
    collectInitializations(units, values.map((value, offset) => ({value, path: path.concat(start + offset)})), afterDoc)
  }
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
      const unit = {opId: opIdOfObject(value), patches: []}
      units.push(unit)
      const markState = afterDoc ? markRangesForText(afterDoc, value).values : []
      const items = Array.from({length: value.length}, (_, index) => value.get(index))
      emitTextRuns(unit.patches, path, 0, items, index => markState[index], (item, at) => {
        queue.push({value: item, path: path.concat(at)})
      })
    } else if (Array.isArray(value) && value.length > 0) {
      const patch = {action: 'insert', path: path.concat(0), values: value.map(patchPlaceholder)}
      insertConflicts(patch, value, 0, value.length)
      units.push({opId: opIdOfObject(value), patches: [patch]})
      for (let index = 0; index < value.length; index++) {
        queue.push({value: valueAt(value, index), path: path.concat(index)})
      }
    } else if (isRecord(value)) {
      const unit = {opId: opIdOfObject(value), patches: []}
      units.push(unit)
      for (const key of Object.keys(value).sort(compareUtf8)) {
        const patch = {action: 'put', path: path.concat(key), value: patchPlaceholder(value[key])}
        if (keyConflict(value, key)) patch.conflict = true
        unit.patches.push(patch)
        queue.push({value: valueAt(value, key), path: path.concat(key)})
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
    const afterValue = valueAt(after, key)
    if (!beforeSet.has(key)) {
      collectPutValue(units, unit.patches, afterValue, path.concat(key), afterDoc, keyConflict(after, key))
    } else {
      collectValueDiff(units, unit.patches, valueAt(before, key), afterValue, path.concat(key), afterDoc,
        keyConflict(after, key))
    }
  }
}

function collectValueDiff(units, inline, before, after, path, afterDoc, conflict) {
  const beforeId = isObject(before) && Frontend.getObjectId(before)
  const afterId = isObject(after) && Frontend.getObjectId(after)
  if (sameValue(before, after) && (!beforeId || beforeId === afterId)) return
  if (beforeId && afterId && beforeId !== afterId || typeof before === 'string' && typeof after === 'string') {
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
    collectPutValue(units, inline, after, path, afterDoc, conflict)
  }
}

function appendRecordDiff(patches, before, after, path, afterDoc, orderedKeys) {
  const units = []
  collectRecordDiff(units, before, after, path, afterDoc, orderedKeys)
  emitUnits(patches, units)
}

// A set of heads determines the document state, because change hashes cover
// their transitive dependencies, so a view is reusable across documents and
// across successive versions of one document.
//
// An earlier version of a document is a sound stand-in for a view of its own
// heads as far as values go, but not as far as history goes: it shares one
// mutable backend with the versions that follow it, so history queries on it
// report later changes as well. It is therefore only cached as `live`, and
// only reused for a diff that reads no history — that is, when the document
// contains no mark operations.
const viewCache = new Map()
const VIEW_CACHE_SIZE = 2

function headsKey(heads) {
  return heads.slice().sort().join(',')
}

function cacheView(key, entry) {
  viewCache.delete(key)
  viewCache.set(key, entry)
  if (viewCache.size > VIEW_CACHE_SIZE) viewCache.delete(viewCache.keys().next().value)
}

function superseded(doc, newDoc) {
  if (newDoc !== doc && doc[STATE].requests.length === 0) cacheView(headsKey(getHeads(doc)), {value: doc, live: true})
  return newDoc
}

function viewOfDoc(doc) {
  const state = doc[STATE]
  const patch = {clock: state.clock, deps: state.deps, maxOp: state.maxOp, diffs: {objectId: '_root', type: 'map', props: {}}}
  return Frontend.applyPatch(doc, patch, backend.viewOf(state.backendState, state.clock))
}

function diffView(doc, heads, currentKey, marked) {
  const key = headsKey(heads)
  if (key === currentKey) {
    cacheView(key, {value: doc, live: true})
    return doc
  }
  const cached = viewCache.get(key)
  if (cached && !(cached.live && marked)) return cached.value
  const snapshot = cached ? viewOfDoc(cached.value) : view(doc, heads)
  cacheView(key, {value: snapshot, live: false})
  return snapshot
}

export function diff(doc, beforeHeads, afterHeads) {
  if (!Array.isArray(beforeHeads)) throw new TypeError('diff() before must be an array of heads')
  if (!Array.isArray(afterHeads)) throw new TypeError('diff() after must be an array of heads')
  if (!hasHeads(doc, beforeHeads) || !hasHeads(doc, afterHeads)) return []
  const marked = documentHasMarkOps(doc)
  const pending = doc[STATE] && doc[STATE].requests && doc[STATE].requests.length > 0
  const currentKey = pending ? null : headsKey(getHeads(doc))
  const before = diffView(doc, beforeHeads, currentKey, marked)
  const after = diffView(doc, afterHeads, currentKey, marked)
  return patchesBetween(before, after, marked && objectsBetweenHeads(doc, beforeHeads, afterHeads))
}

function resolveObjectPath(doc, pathString) {
  let value = doc, objectId = '_root'
  for (const [i, prop] of pathString.split('/').slice(1).entries()) {
    if (prop === '') break
    let key = prop
    if (Array.isArray(value) || value instanceof Frontend.Text) {
      if (!/^\+?[0-9]+$/.test(prop) || Number(prop) > 0xffffffff) {
        throw new RangeError(`invalid path ${pathString}: path component ${i} (${prop}) should be an integer to index a sequence`)
      }
      key = Number(prop)
    }
    const present = value instanceof Frontend.Text ? key < value.length : Object.prototype.hasOwnProperty.call(value, key)
    if (!present) throw new RangeError(`invalid path ${pathString}: path component ${i} (${prop}) referenced a nonexistent object`)
    objectId = Frontend.getObjectId(value, key)
    if (!objectId) throw new RangeError(`invalid path ${pathString}: path did not refer to an object`)
    value = value instanceof Frontend.Text ? value.get(key) : Frontend.getText(value, key) || value[key]
  }
  return objectId
}

function pathToObject(object, objectId, path) {
  if (Frontend.getObjectId(object) === objectId) return path
  const keys = Array.isArray(object) ? object.map((_, index) => index) : Object.keys(object)
  for (const key of keys) {
    const child = Frontend.getText(object, key) || object[key]
    if (!Frontend.getObjectId(object, key) || child instanceof Frontend.Text && Frontend.getObjectId(object, key) !== objectId) continue
    const found = pathToObject(child, objectId, path.concat(key))
    if (found) return found
  }
  return null
}

function knownHeads(doc, heads) {
  const error = hashesError(heads)
  if (error) throw new RangeError(`invalid before heads: ${error}`)
  return heads.map(head => head.toLowerCase()).filter(head => hasHeads(doc, [head]))
}

export function diffPath(doc, path, before, after, options) {
  if (!Array.isArray(before)) throw new Error('invalid before: must be an array')
  if (!Array.isArray(after)) throw new Error('invalid after: must be an array')
  Frontend.getBackendState(doc, 'diffPath')
  path = path.slice()
  path.unshift('_root')
  const objectId = resolveObjectPath(doc, path.join('/'))
  let recursive
  try {
    recursive = Reflect.get(options, 'recursive') !== false
  } catch (error) {
    recursive = true
  }
  const beforeHeads = knownHeads(doc, before), afterHeads = knownHeads(doc, after)
  const patches = diff(doc, beforeHeads, afterHeads)
  const prefix = pathToObject(diffView(doc, afterHeads, headsKey(getHeads(doc)), false), objectId, [])
  if (!prefix) return []
  return patches.filter(patch => {
    const depth = patch.path.length - prefix.length - (patch.action === 'mark' ? 0 : 1)
    return depth >= 0 && (recursive || depth === 0) && prefix.every((key, i) => patch.path[i] === key)
  })
}

function patchesBetween(before, after, touched, clock) {
  const patches = []
  appendRecordDiff(patches, before, after, [], after)
  appendConflictPatches(patches, before, after, [])
  if (touched) appendMarkPatches(patches, before, after, before, after, [], touched, clock)
  return patches
}

// The object IDs that any operation in the symmetric difference of the two
// head sets writes to. An object outside this set has the same operations in
// both views, so its marks cannot differ.
function objectsBetweenHeads(doc, beforeHeads, afterHeads) {
  const state = Frontend.getBackendState(doc, 'diff')
  const objects = new Set()
  for (const bytes of backend.getChanges(state, beforeHeads).concat(backend.getChanges(state, afterHeads))) {
    for (const op of decodeChange(bytes, true).ops) objects.add(op.obj)
  }
  return objects
}

function commonKeys(before, after) {
  if (Array.isArray(before) && Array.isArray(after)) {
    return Array.from({length: Math.min(before.length, after.length)}, (_, index) => index)
  }
  if (isRecord(before) && isRecord(after)) {
    return Object.keys(after).filter(key => Object.prototype.hasOwnProperty.call(before, key))
  }
  return []
}

function appendConflictPatches(patches, before, after, path) {
  if (before === after) return
  for (const key of commonKeys(before, after)) {
    const beforeValue = valueAt(before, key), afterValue = valueAt(after, key)
    if (beforeValue === afterValue && before[CONFLICTS]?.[key] === after[CONFLICTS]?.[key]) continue
    const beforeConflicts = Frontend.getConflicts(before, key) || {}
    const afterConflicts = Frontend.getConflicts(after, key) || {}
    if (!sameValue(beforeConflicts, afterConflicts) && Object.keys(afterConflicts).length > 1) {
      const patchPath = path.concat(key)
      const put = patches.find(patch => patch.action === 'put' && sameValue(patch.path, patchPath))
      if (put) put.conflict = true
      else if (sameValue(before[key], after[key])) patches.push({action: 'conflict', path: patchPath})
    }
    appendConflictPatches(patches, beforeValue, afterValue, path.concat(key))
  }
}

function markEqual(left, right) {
  return left.name === right.name && left.start === right.start && left.end === right.end &&
    sameValue(left.value, right.value)
}

// A change callback runs against two document versions that share one mutable
// backend, so the earlier one answers history queries with the later changes
// as well. Mark state before the change is therefore computed from the new
// document with this batch of changes left out.
function changeScope(changes, before, after) {
  const objects = new Set()
  if (!Array.isArray(changes)) return {objects}
  const clock = before && before[STATE] && before[STATE].clock || {}
  for (const change of decodeChanges(changes)) {
    // a batch can contain changes the previous state already had, and those
    // are part of it rather than left out of it
    if ((clock[change.actor] || 0) >= change.seq) continue
    for (const op of change.ops) objects.add(op.obj)
  }
  return {objects, clock: Frontend.getBackendState(after).state.opClock(clock)}
}

function markValue(values, name) {
  return values[name] === null ? undefined : values[name]
}

// The text patches of a change already carry the marks of the characters they
// insert, so what is left to report is every element whose marks differ from
// the ones a consumer would already have: its own marks in the previous state
// if it survived the change, and the marks of the splice that inserted it
// otherwise.
function appendTextMarkPatches(patches, beforeDoc, afterDoc, before, after, path, clock) {
  const beforeValues = markRangesForText(clock ? afterDoc : beforeDoc, before, clock).values
  const afterValues = markRangesForText(afterDoc, after).values
  const previous = new Map(before.elems.map((elem, index) => [elem.elemId, beforeValues[index]]))
  const expected = after.elems.map((elem, index) =>
    (previous.has(elem.elemId) ? previous.get(elem.elemId) : afterValues[index]))
  const names = new Set(expected.concat(afterValues).flatMap(values => Object.keys(values)))
  const offsets = textOffsets(after)
  const added = []
  for (const name of [...names].sort(compareUtf8)) {
    let index = 0
    while (index < after.length) {
      if (sameValue(markValue(expected[index], name), markValue(afterValues[index], name))) {
        index++
        continue
      }
      const start = index, value = markValue(afterValues[index], name)
      while (index < after.length && sameValue(markValue(afterValues[index], name), value) &&
             !sameValue(markValue(expected[index], name), value)) index++
      // A removed mark is reported the way the Rust implementation reports
      // it: a mark patch whose value is null
      added.push({name, value: value === undefined ? null : copyPatchValue(value),
        start: offsets[start], end: offsets[index]})
    }
  }
  if (added.length > 0) patches.push({action: 'mark', path, marks: added})
}

function appendMarkPatches(patches, beforeDoc, afterDoc, before, after, path, touched, clock) {
  if (before instanceof Frontend.Text && after instanceof Frontend.Text) {
    if (touched.has(Frontend.getObjectId(before)) || touched.has(Frontend.getObjectId(after))) {
      appendTextMarkPatches(patches, beforeDoc, afterDoc, before, after, path, clock)
    }
    return
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length !== after.length) return
  for (const key of commonKeys(before, after)) {
    appendMarkPatches(patches, beforeDoc, afterDoc, valueAt(before, key), valueAt(after, key), path.concat(key),
      touched, clock)
  }
}

export function applyPatch(doc, patch) {
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
        const range = {start: value.start, end: value.end, expand: 'none'}
        if (value.value === null) unmark(doc, patch.path, range, value.name)
        else mark(doc, patch.path, range, value.name, value.value)
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

export function applyPatches(doc, patches) {
  if (!Array.isArray(patches)) throw new TypeError('applyPatches() requires an array')
  for (const patch of patches) applyPatch(doc, patch)
}

export function getCursor(doc, path, position, move = 'after') {
  const value = valueAtPath(doc, path, 'getCursor').value
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

export function getCursorPosition(doc, path, cursor) {
  const value = valueAtPath(doc, path, 'getCursorPosition').value
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
      if (visible >= 0) return textOffsets(value)[visible]
    }
    const state = Frontend.getBackendState(doc, 'getCursorPosition')
    const index = backend.getCursorPosition(state, Frontend.getObjectId(value), elemId,
      opId[1] === '-' ? 'before' : 'after')
    let offsets = cursorOffsets.get(value)
    if (!offsets) {
      offsets = textOffsets(value)
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
  const after = [...value.toString()]
  return Math.min(updateCursorPosition(before, after, position, match[1]), length)
}

export function mark(doc, path, range, name, value) {
  const text = valueAtPath(doc, path, 'mark').value
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
  // A zero-width non-expanding mark can never cover anything; the Rust
  // implementation ignores it without emitting any operations
  if (range.start === range.end && expand === 'none') return
  const objectId = Frontend.getObjectId(text)
  const startIndex = textElementIndex(text, range.start)
  const endIndex = textElementIndex(text, range.end)
  const start = startIndex === 0 ? '_head' : text.getElemId(startIndex - 1)
  const expandBefore = expand === 'before' || expand === 'both'
  const beginOpId = text.context.nextOpId()
  text.context.addOp({
    action: 'markBegin', obj: objectId, elemId: start, insert: true, name, value,
    expand: expandBefore, pred: []
  })
  // The mark boundaries are elements of the text sequence. If the range is
  // empty and the begin boundary is sticky (expanding), the end boundary is
  // inserted immediately after it, so its reference element is the begin
  // boundary itself — this is what the Rust implementation produces.
  const end = range.start === range.end && expandBefore ? beginOpId
    : endIndex === 0 ? '_head' : text.getElemId(endIndex - 1)
  text.context.addOp({
    action: 'markEnd', obj: objectId, elemId: end, insert: true,
    expand: expand === 'after' || expand === 'both', pred: []
  })
  // Register the text as touched with a fresh copy: reusing the cached
  // object would let later edits in the same change mutate the previous
  // document snapshot in place, and the semantic diff would then see no
  // difference and drop their patches.
  if (!text.context.updated[objectId]) {
    const current = text.context.getObject(objectId)
    text.context.updated[objectId] = instantiateText(objectId, current.chunks.slice())
  }
}

export function unmark(doc, path, range, name) {
  mark(doc, path, range, name, null)
}

function markRanges(doc, path) {
  const text = valueAtPath(doc, path, 'marks').value
  if (!(text instanceof Frontend.Text)) throw new RangeError('marks() path must resolve to Text')
  return markRangesForText(doc, text)
}

const NO_MARKS = Object.freeze({})

function hasMarkOps(ops) {
  return ops.some(op => op.action === 'markBegin' || op.action === 'markEnd')
}

function documentHasMarkOps(doc, text) {
  if (text && text.context && hasMarkOps(text.context.ops)) return true
  const state = Frontend.getBackendState(doc)
  return (state.source || state.state).objectsWithMarks.size > 0
}

function markRangesForText(doc, text, clock) {
  if (!documentHasMarkOps(doc, text)) {
    return {text, values: new Array(text.length).fill(NO_MARKS), ranges: []}
  }
  const objectId = Frontend.getObjectId(text)
  // Mark boundaries are elements of the text sequence in the Rust
  // implementation: mark() inserts a markBegin and a markEnd operation at
  // the given positions, and marks are resolved by scanning the sequence in
  // order (an unclosed markBegin extends to the end of the text). This
  // function reconstructs the full sequence, including deleted elements and
  // the mark boundary elements, and performs the same scan.
  const inserts = new Map(), markers = new Map(), operations = []
  function scanOps(ops, actor, startOp) {
    let opCounter = startOp
    for (const op of ops) {
      const opId = `${opCounter}@${actor}`
      opCounter += op.values ? op.values.length : (op.multiOp || 1)
      if (op.obj !== objectId) continue
      if (op.action === 'markBegin') {
        inserts.set(opId, op.elemId)
        markers.set(opId, {begin: true, name: op.name, value: op.value, expand: !!op.expand})
      } else if (op.action === 'markEnd') {
        inserts.set(opId, op.elemId)
        markers.set(opId, {begin: false, expand: !!op.expand})
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
  const state = Frontend.getBackendState(doc)
  for (const {id, ref, mark} of (state.source || state.state).sequenceInserts(objectId, clock || state.clock)) {
    inserts.set(id, ref)
    if (mark) markers.set(id, mark)
  }
  const scanned = inserts.size
  if (text.context) {
    const size = text.context.ops.reduce((total, op) =>
      total + (op.values ? op.values.length : (op.multiOp || 1)), 0)
    scanOps(text.context.ops, text.context.actorId, text.context.nextOpNum - size)
  }

  // Without mark boundaries there is nothing for the sequence walk to resolve
  if (markers.size === 0) {
    return {text, values: new Array(text.length).fill(NO_MARKS), ranges: []}
  }

  // Order the children of each element in descending operation-ID order, the
  // normal ordering for concurrent insertions. Mark boundaries get no special
  // treatment here: the Rust implementation applies plain RGA ordering too,
  // and instead makes locally-authored insertions anchor on an adjacent
  // sticky mark boundary at authoring time (see adjustInsertAnchors in the
  // backend), so the wire format alone determines the placement.
  let order = inserts.keys()
  if (inserts.size !== scanned) {
    const childrenOf = new Map()
    for (const [elemId, ref] of inserts) {
      if (!childrenOf.has(ref)) childrenOf.set(ref, [])
      childrenOf.get(ref).push(elemId)
    }
    for (const children of childrenOf.values()) {
      children.sort((a, b) => {
        const left = parseOpId(a), right = parseOpId(b)
        return right.counter - left.counter ||
          (right.actorId < left.actorId ? -1 : right.actorId > left.actorId ? 1 : 0)
      })
    }
    order = []
    const stack = (childrenOf.get('_head') || []).slice().reverse()
    while (stack.length > 0) {
      const elemId = stack.pop()
      order.push(elemId)
      const children = childrenOf.get(elemId)
      if (children) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
    }
  }

  // Walk the sequence, tracking the active marks. A markEnd closes the
  // markBegin with the preceding operation ID (mark() always creates them as
  // consecutive operations). For each visible element, the active mark with
  // the highest operation ID provides the value for each mark name.
  const visibleIds = new Set(text.elems.map(elem => elem.elemId))
  const boundaries = new Map()   // markBegin opId -> {name, value, start, end}
  const active = new Map()       // markBegin opId -> same object
  let visibleCount = 0
  for (const elemId of order) {
    const marker = markers.get(elemId)
    if (marker) {
      if (marker.begin) {
        const boundary = {name: marker.name, value: marker.value, start: visibleCount, end: undefined, id: elemId}
        boundaries.set(elemId, boundary)
        active.set(elemId, boundary)
      } else {
        const parsed = parseOpId(elemId)
        const beginId = `${parsed.counter - 1}@${parsed.actorId}`
        const boundary = active.get(beginId)
        if (boundary) {
          boundary.end = visibleCount
          active.delete(beginId)
        }
      }
    } else if (visibleIds.has(elemId)) {
      visibleCount++
    }
  }
  for (const boundary of boundaries.values()) {
    if (boundary.end === undefined) boundary.end = visibleCount
    if (boundary.start <= boundary.end) operations.push(boundary)
  }
  operations.sort((left, right) => {
    const leftId = left.id.split('@'), rightId = right.id.split('@')
    return parseInt(leftId[0], 10) - parseInt(rightId[0], 10) || leftId[1].localeCompare(rightId[1])
  })
  const values = markValuesPerElement(operations, text.length)
  return {text, values, ranges: markRangesFromValues(values, text)}
}

/**
 * Applies resolved mark operations in order, producing the mark set that
 * applies to each element of the text. A null value removes the mark.
 */
function markValuesPerElement(operations, length) {
  if (operations.length === 0) return new Array(length).fill(NO_MARKS)
  const values = Array.from({length}, () => ({}))
  for (const operation of operations) {
    for (let index = operation.start; index < operation.end; index++) {
      if (operation.value === null) delete values[index][operation.name]
      else values[index][operation.name] = operation.value
    }
  }
  return values
}

/**
 * Run-length encodes per-element mark sets into ranges, one run per mark
 * name, with bounds in text offsets rather than element indexes.
 */
function markRangesFromValues(values, text) {
  const offsets = textOffsets(text)
  const ranges = []
  for (const name of new Set(values.flatMap(value => Object.keys(value)))) {
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
  return ranges
}

export function marks(doc, path) {
  return markRanges(doc, path).ranges.map(range => Object.assign({}, range))
}

export function marksAt(doc, path, index) {
  const state = markRanges(doc, path)
  const length = textLength(state.text)
  if (!Number.isInteger(index) || index < 0 || index > length) {
    throw new RangeError('marksAt() index is invalid')
  }
  if (index === length) return {}
  const elementIndex = textElementIndex(state.text, index)
  return elementIndex === state.text.length ? {} : Object.assign({}, state.values[elementIndex])
}

export function spans(doc, path) {
  const state = markRanges(doc, path)
  const result = []
  let value = '', active = null
  function flush() {
    if (value.length > 0) {
      result.push(Object.keys(active).length > 0 ? {type: 'text', value, marks: active} : {type: 'text', value})
    }
    value = ''
  }
  for (let index = 0; index < state.text.length; index++) {
    const marks = state.values[index]
    const element = state.text.get(index)
    if (typeof element !== 'string') {
      flush()
      result.push({type: 'block', value: toJS(element)})
      active = null
      continue
    }
    if (active !== null && !sameValue(active, marks)) flush()
    value += element
    active = marks
  }
  flush()
  return result
}

function blockKeys(value) {
  return Object.keys(value).sort((left, right) => (left === 'type' ? -1 : right === 'type' ? 1 : left.localeCompare(right)))
}

function richTextValue(value, block = false) {
  if (typeof value === 'string') return new Frontend.Text(value)
  if (Array.isArray(value)) return value.map(item => richTextValue(item))
  if (!isRecord(value)) return value
  // The Rust implementation generates the operations of a block marker with
  // the `type` property first.
  const keys = block ? blockKeys(value) : Object.keys(value)
  const result = {}
  for (const key of keys) result[key] = richTextValue(value[key])
  return result
}

function richTextTarget(doc, path, index, name, convert) {
  const target = valueAtPath(doc, path, name)
  let text = target.value
  if (typeof text === 'string' && convert) {
    target.parent[target.key] = new Frontend.Text(text)
    text = valueAt(target.parent, target.key)
  }
  if (!(text instanceof Frontend.Text)) throw new RangeError(`${name}() path must resolve to Text`)
  if (typeof index === 'string') index = getCursorPosition(doc, path, index)
  if (!Number.isInteger(index) || index < 0 || index > textLength(text)) {
    throw new RangeError(`${name}() index is invalid`)
  }
  return {text, index: textElementIndex(text, index)}
}

export function block(doc, path, index) {
  const target = richTextTarget(doc, path, index, 'block', false)
  if (target.index === target.text.length) return null
  const value = target.text.get(target.index)
  return isRecord(value) ? toJS(value) : null
}

export function splitBlock(doc, path, index, value) {
  if (!isRecord(value)) throw new TypeError('splitBlock() block must be an object')
  const target = richTextTarget(doc, path, index, 'splitBlock', true)
  target.text.insertAt(target.index, richTextValue(value, true))
}

export function joinBlock(doc, path, index) {
  const target = richTextTarget(doc, path, index, 'joinBlock', true)
  if (target.index < target.text.length) target.text.deleteAt(target.index)
}

export function updateBlock(doc, path, index, value) {
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

// updateSpans reconciles a block marker with its replacement in place, like
// the Rust implementation, rather than deleting and reinserting the marker.
function updateValue(parent, key, value) {
  const current = valueAt(parent, key)
  if (current instanceof Frontend.Text && typeof value === 'string') {
    for (const edit of textEdits(current, wellFormedString(value))) {
      spliceText(valueAt(parent, key), edit.index, edit.del, edit.text)
    }
  } else if (Array.isArray(current) && Array.isArray(value)) {
    while (current.length > value.length) current.pop()
    for (let index = 0; index < value.length; index++) {
      if (index < current.length) updateValue(current, index, value[index])
      else current.push(richTextValue(value[index]))
    }
  } else if (isRecord(current) && isRecord(value) && !isImmutableString(current) && !isImmutableString(value)) {
    updateRecord(current, value)
  } else if (!sameValue(current, value)) {
    parent[key] = richTextValue(value)
  }
}

function updateRecord(current, value) {
  for (const name of Object.keys(current)) {
    if (!Object.prototype.hasOwnProperty.call(value, name)) delete current[name]
  }
  for (const name of Object.keys(value).sort(compareUtf8)) {
    if (Object.prototype.hasOwnProperty.call(current, name)) updateValue(current, name, value[name])
    else current[name] = richTextValue(value[name])
  }
}

export function updateSpans(doc, path, newSpans, config = {}) {
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
  function itemEqual(left, right) {
    if (typeof left === 'string' || typeof right === 'string') return left === right
    return sameValue(left.block, right.block)
  }
  let at = 0
  function insertItem(item) {
    if (typeof item === 'string') {
      splice(doc, path, at, 0, item)
      at += item.length
    } else {
      splitBlock(doc, path, at, item.block)
      at++
    }
  }
  function deleteItem(item) {
    if (typeof item === 'string') splice(doc, path, at, item.length)
    else joinBlock(doc, path, at)
  }
  const hook = {
    equal(oldIndex, newIndex, length) {
      for (let offset = 0; offset < length; offset++) at += textElementWidth(old[oldIndex + offset])
    },
    delete(oldIndex, oldLength) {
      for (let offset = 0; offset < oldLength; offset++) deleteItem(old[oldIndex + offset])
    },
    insert(oldIndex, newIndex, newLength) {
      let run = ''
      for (let offset = 0; offset < newLength; offset++) {
        const item = next[newIndex + offset]
        if (typeof item === 'string') { run += item; continue }
        if (run.length > 0) insertItem(run)
        run = ''
        insertItem(item)
      }
      if (run.length > 0) insertItem(run)
    },
    replace(oldIndex, oldLength, newIndex, newLength) {
      for (let offset = 0; offset < Math.max(oldLength, newLength); offset++) {
        const oldItem = offset < oldLength ? old[oldIndex + offset] : undefined
        const newItem = offset < newLength ? next[newIndex + offset] : undefined
        if (isObject(oldItem) && isObject(newItem)) {
          if (!sameValue(oldItem.block, newItem.block)) {
            const current = richTextTarget(doc, path, at, 'updateSpans', false)
            updateRecord(current.text.get(current.index), newItem.block)
          }
          at++
        } else {
          if (oldItem !== undefined) deleteItem(oldItem)
          if (newItem !== undefined) insertItem(newItem)
        }
      }
    }
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

export function topoHistoryTraversal(doc) {
  return backend.topoHistoryTraversal(Frontend.getBackendState(doc, 'topoHistoryTraversal'))
}

export function inspectChange(doc, hash) {
  const state = Frontend.getBackendState(doc, 'inspectChange')
  const change = backend.getChangeByHash(state, hash)
  return change ? decodeChange(change) : null
}

export function stats(doc) {
  return Object.assign({
    cargoPackageName: '@automerge/automerge-classic',
    cargoPackageVersion: 'classic',
    rustcVersion: 'not applicable'
  }, backend.stats(Frontend.getBackendState(doc, 'stats')))
}

export function initializeWasm() {
  const scope = typeof self === 'undefined' ? global : self
  const name = 'Promise'
  return scope[name].resolve()
}

export { initializeWasm as initializeBase64Wasm, initializeWasm as wasmInitialized }

export function isWasmInitialized() {
  return true
}

export function use() {}

export function dump() {}

export function generateSyncMessage(doc, syncState) {
  const state = Frontend.getBackendState(doc, 'generateSyncMessage')
  return backend.generateSyncMessage(state, syncState)
}

export function receiveSyncMessage(doc, oldSyncState, message, options = {}) {
  assertWritable(doc)
  const oldBackendState = Frontend.getBackendState(doc, 'receiveSyncMessage')
  const [backendState, syncState, patch] = backend.receiveSyncMessage(oldBackendState, oldSyncState, message)
  if (!patch) return [doc, syncState, null]

  // The patchCallback is passed as argument all changes that are applied.
  // We get those from the sync message if a patchCallback is present.
  const changes = options.patchCallback || doc[OPTIONS].patchCallback ? backend.decodeSyncMessage(message).changes : null
  return [applyBackendPatch(doc, patch, backendState, changes, options, 'receiveSyncMessage'), syncState, null]
}

export function hasOurChanges(doc, remoteState) {
  if (!remoteState || !Array.isArray(remoteState.sharedHeads)) return false
  const heads = getHeads(doc)
  return heads.length === remoteState.sharedHeads.length &&
    heads.every((head, index) => head === remoteState.sharedHeads[index])
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
      const target = heads ? view(doc, heads) : doc
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

export { decodeChange }
export { ImmutableString, ImmutableString as RawString, isImmutableString, isImmutableString as isRawString }
export { getActorId, Counter, Int, Uint, Float64 } from '../frontend/index.js'
export { encodeSyncMessage, decodeSyncMessage, encodeSyncState, decodeSyncState, initSyncState } from '../backend/index.js'
