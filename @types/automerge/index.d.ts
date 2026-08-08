declare namespace Automerge {
  /**
   * The return type of `Automerge.init<T>()`, `Automerge.change<T>()`, etc. where `T` is the
   * original type. It is a recursively frozen version of the original type.
   */
  type Doc<T> = {readonly [P in keyof T]: T[P]}

  type ChangeFn<T> = (doc: T) => void

  // Automerge.* functions

  function init<T>(options?: InitOptions<T>): Doc<T>
  function from<T>(initialState: T | Doc<T>, options?: InitOptions<T>): Doc<T>
  function clone<T>(doc: Doc<T>, options?: InitOptions<T>): Doc<T>
  function free<T>(doc: Doc<T>): void

  type InitOptions<T> =
    | string // = actorId
    | { 
      actor?: string | null
      actorId?: string
      allowMissingChanges?: boolean
      convertImmutableStringsToText?: boolean
      deferActorId?: boolean
      freeze?: boolean
      patchCallback?: PatchCallback<T> | LegacyPatchCallback<T>
      unchecked?: boolean
    }

  type ChangeOptions<T> =
    | string // = message
    | {
      message?: string
      time?: number
      patchCallback?: PatchCallback<T> | LegacyPatchCallback<T>
    }

  type PatchCallback<T> = (patches: Patch[], info: PatchInfo<T>) => void
  type LegacyPatchCallback<T> = (patch: BackendPatch, before: T, after: T, local: boolean, changes: BinaryChange[]) => void
  function merge<T>(localdoc: Doc<T>, remotedoc: Doc<T>, options?: ApplyOptions<T>): Doc<T>

  function change<T>(doc: Doc<T>, options: ChangeOptions<T>, callback: ChangeFn<T>): Doc<T>
  function change<T>(doc: Doc<T>, callback: ChangeFn<T>): Doc<T>
  function emptyChange<D extends Doc<any>>(doc: D, options?: ChangeOptions<D>): D
  function applyChanges<T>(doc: Doc<T>, changes: BinaryChange[], options?: ApplyOptions<T>): [Doc<T>]
  function applyPatch(doc: unknown, patch: Patch): void
  function applyPatches(doc: unknown, patches: Patch[]): void
  function changeAt<T>(doc: Doc<T>, heads: Heads, options: ChangeOptions<T>, callback: ChangeFn<T>): ChangeAtResult<T>
  function changeAt<T>(doc: Doc<T>, heads: Heads, callback: ChangeFn<T>): ChangeAtResult<T>
  function equals<T>(val1: T, val2: T): boolean
  function encodeChange(change: DecodedChange | ChangeToEncode): Change
  function decodeChange(binaryChange: Change): DecodedChange

  function getActorId<T>(doc: Doc<T>): string
  function getBackend<T>(doc: Doc<T>): BackendState
  function getAllChanges<T>(doc: Doc<T>): BinaryChange[]
  function getChanges<T>(olddoc: Doc<T>, newdoc: Doc<T>): BinaryChange[]
  function getChangesMetaSince<T>(doc: Doc<T>, heads: Heads): ChangeMetadata[]
  function getChangesSince<T>(doc: Doc<T>, heads: Heads): BinaryChange[]
  function getConflicts<T>(doc: Doc<T>, key: keyof T): any
  function getCursor<T>(doc: Doc<T>, path: Prop[], position: CursorPosition, move?: MoveCursor): Cursor
  function getCursorPosition<T>(doc: Doc<T>, path: Prop[], cursor: Cursor): number
  function getHeads<T>(doc: Doc<T>): Heads
  function getHistory<T>(doc: Doc<T>): State<T>[]
  function getLastLocalChange<T>(doc: Doc<T>): Change | undefined
  function getMissingDeps<T>(doc: Doc<T>, heads?: Heads): Heads
  function getObjectId(object: any, prop?: Prop): OpId | null
  function hasHeads<T>(doc: Doc<T>, heads: Heads): boolean
  function hasOurChanges<T>(doc: Doc<T>, remoteState: SyncState): boolean
  function inspectChange<T>(doc: Doc<T>, hash: Hash): DecodedChange | null
  function isAutomerge(value: unknown): boolean
  function isCounter(value: unknown): value is Counter
  function stats<T>(doc: Doc<T>): Stats
  function topoHistoryTraversal<T>(doc: Doc<T>): Hash[]
  function toJS<T>(doc: Doc<T>): T
  function view<T>(doc: Doc<T>, heads: Heads): Doc<T>
  function diff<T>(doc: Doc<T>, before: Heads, after: Heads): Patch[]
  function dump<T>(doc: Doc<T>): void

  function load<T>(data: BinaryDocument, options?: InitOptions<T>): Doc<T>
  function loadIncremental<T>(doc: Doc<T>, data: Uint8Array, options?: ApplyOptions<T>): Doc<T>
  function save<T>(doc: Doc<T>): BinaryDocument
  function saveIncremental<T>(doc: Doc<T>): Uint8Array
  function saveSince<T>(doc: Doc<T>, heads: Heads): Uint8Array
  function saveBundle<T>(doc: Doc<T>, hashes: Heads): Uint8Array
  interface DecodedBundle {changes: DecodedChange[], deps: Heads}
  function readBundle(bundle: Uint8Array): DecodedBundle

  function generateSyncMessage<T>(doc: Doc<T>, syncState: SyncState): [SyncState, SyncMessage | null]
  function receiveSyncMessage<T>(doc: Doc<T>, syncState: SyncState, message: SyncMessage, options?: ApplyOptions<T>): [Doc<T>, SyncState, null]
  function initSyncState(options?: {readOnly?: boolean}): SyncState
  function encodeSyncMessage(message: DecodedSyncMessage): SyncMessage
  function decodeSyncMessage(bytes: SyncMessage): DecodedSyncMessage
  function encodeSyncState(syncState: SyncState): BinarySyncState
  function decodeSyncState(bytes: BinarySyncState): SyncState

  function insertAt<T>(list: T[], index: number, ...values: T[]): void
  function deleteAt<T>(list: T[], index: number, numDelete?: number): void
  function splice<T>(doc: Doc<T>, path: Prop[], index: number | Cursor, del: number, newText?: string): void
  function updateText<T>(doc: Doc<T>, path: Prop[], newText: string): void

  function initializeWasm(wasm?: unknown): Promise<void>
  function initializeBase64Wasm(wasm?: string): Promise<void>
  function wasmInitialized(): Promise<void>
  function isWasmInitialized(): boolean
  function use(api: unknown): void

  function mark<T>(doc: Doc<T>, path: Prop[], range: MarkRange, name: string, value: MarkValue): void
  function unmark<T>(doc: Doc<T>, path: Prop[], range: MarkRange, name: string): void
  function marks<T>(doc: Doc<T>, path: Prop[]): Mark[]
  function marksAt<T>(doc: Doc<T>, path: Prop[], index: number): MarkSet
  function spans<T>(doc: Doc<T>, path: Prop[]): Span[]
  function updateSpans<T>(doc: Doc<T>, path: Prop[], spans: Span[], config?: UpdateSpansConfig): void
  function block<T>(doc: Doc<T>, path: Prop[], index: number | Cursor): {[key: string]: MaterializeValue} | null
  function splitBlock<T>(doc: Doc<T>, path: Prop[], index: number | Cursor, block: {[key: string]: MaterializeValue}): void
  function joinBlock<T>(doc: Doc<T>, path: Prop[], index: number | Cursor): void
  function updateBlock<T>(doc: Doc<T>, path: Prop[], index: number | Cursor, block: {[key: string]: MaterializeValue}): void

  // custom CRDT types

  class List<T> extends Array<T> {
    insertAt(index: number, ...args: T[]): List<T>
    deleteAt(index: number, numDelete?: number): List<T>
  }

  class ImmutableString {
    constructor(value: string)
    readonly val: string
    toJSON(): string
    toString(): string
    valueOf(): string
  }

  const RawString: typeof ImmutableString
  type RawString = ImmutableString
  function isImmutableString(value: unknown): value is ImmutableString
  function isRawString(value: unknown): value is ImmutableString

  // Note that until https://github.com/Microsoft/TypeScript/issues/2361 is addressed, we
  // can't treat a Counter like a literal number without force-casting it as a number.
  // This won't compile:
  //   `assert.strictEqual(c + 10, 13) // Operator '+' cannot be applied to types 'Counter' and '10'.ts(2365)`
  // But this will:
  //   `assert.strictEqual(c as unknown as number + 10, 13)`
  class Counter extends Number {
    constructor(value?: number)
    increment(delta?: number): void
    decrement(delta?: number): void
    toString(): string
    valueOf(): number
    value: number
  }

  class Int { constructor(value: number) }
  class Uint { constructor(value: number) }
  class Float64 { constructor(value: number) }

  // Readonly variants

  type ReadonlyList<T> = ReadonlyArray<T> & List<T>

  // Internals

  type Hash = string // 64-digit hex string
  type Heads = Hash[]
  type Prop = string | number
  type Cursor = string
  type CursorPosition = number | 'start' | 'end'
  type MoveCursor = 'before' | 'after'
  type OpId = string // of the form `${counter}@${actorId}`
  type ActorId = string
  type ObjID = OpId

  interface Clock {
    [actorId: string]: number
  }

  interface State<T> {
    change: DecodedChange
    snapshot: T
  }

  interface ApplyOptions<T> {
    patchCallback?: PatchCallback<T> | LegacyPatchCallback<T>
  }

  type PatchSource =
    | 'from'
    | 'emptyChange'
    | 'change'
    | 'changeAt'
    | 'merge'
    | 'loadIncremental'
    | 'applyChanges'
    | 'receiveSyncMessage'

  interface PatchInfo<T> {
    before: Doc<T>
    after: Doc<T>
    source: PatchSource
  }

  interface ChangeAtResult<T> {
    newDoc: Doc<T>
    newHeads: Heads | null
  }

  interface ChangeMetadata {
    actor: string
    deps: Heads
    hash: Hash
    maxOp: number
    message: string | null
    seq: number
    startOp: number
    time: number
  }

  interface Stats {
    cargoPackageName: string
    cargoPackageVersion: string
    numActors: number
    numChanges: number
    numOps: number
    rustcVersion: string
  }

  interface BackendState {
    // no public methods or properties
  }

  type Change = Uint8Array
  type BinaryChange = Change
  type BinaryDocument = Uint8Array
  type BinarySyncState = Uint8Array
  type BinarySyncMessage = Uint8Array

  interface SyncState {
    // no public methods or properties
    sharedHeads: Heads
    lastSentHeads: Heads
    theirHeads: Heads | null
    theirNeed: Heads | null
    theirHave: SyncHave[] | null
    sentHashes: {[hash: string]: boolean}
    readOnly?: boolean
    peerReadOnly?: boolean
  }

  type SyncMessage = Uint8Array

  interface DecodedSyncMessage {
    heads: Hash[]
    need: Hash[]
    have: SyncHave[]
    changes: Change[]
    type?: 'v1' | 'v2'
    supportedCapabilities?: string[]
  }

  interface SyncHave {
    lastSync: Hash[]
    bloom: Uint8Array
  }

  interface DecodedChange {
    message: string | null
    actor: string
    time: number
    seq: number
    startOp: number
    hash: Hash
    deps: Hash[]
    ops: Op[]
  }

  type ChangeToEncode = Omit<DecodedChange, 'hash'> & {hash?: Hash}
  type API = any

  interface Op {
    action: string
    obj: OpId
    key?: string | number
    insert?: boolean
    elemId?: OpId
    child?: OpId
    value?: number | boolean | string | null | number[] | Uint8Array
    datatype?: DataType
    pred?: OpId[]
    values?: (number | boolean | string | null)[]
    multiOp?: number
  }

  type MarkValue = string | number | null | boolean | Date | Uint8Array

  interface MarkSet {
    [name: string]: MarkValue
  }

  interface Mark {
    name: string
    value: MarkValue
    start: number
    end: number
  }

  interface MarkRange {
    expand?: 'before' | 'after' | 'both' | 'none'
    start: number
    end: number
  }

  type ScalarValue = string | number | null | boolean | Date | Counter | Uint8Array | ImmutableString
  type AutomergeValue = ScalarValue | {[key: string]: AutomergeValue} | AutomergeValue[]
  type MapValue = {[key: string]: AutomergeValue}
  type ListValue = AutomergeValue[]
  type MaterializeValue = {[key: string]: MaterializeValue} | MaterializeValue[] | ScalarValue
  type Conflicts = {[opId: string]: AutomergeValue}
  type Span = {type: 'text', value: string, marks?: MarkSet} | {type: 'block', value: {[key: string]: MaterializeValue}}
  type UpdateSpansConfig = {
    defaultExpand?: 'before' | 'after' | 'both' | 'none'
    perMarkExpand?: {[key: string]: 'before' | 'after' | 'both' | 'none'}
  }

  type Patch = PutPatch | DelPatch | SpliceTextPatch | IncPatch | InsertPatch | MarkPatch | UnmarkPatch | ConflictPatch
  type PatchValue = string | number | boolean | null | Date | Uint8Array | Counter | {[key: string]: any} | any[]

  interface PutPatch {
    action: 'put'
    path: Prop[]
    value: PatchValue
    conflict?: boolean
  }

  interface DelPatch {
    action: 'del'
    path: Prop[]
    length?: number
  }

  interface SpliceTextPatch {
    action: 'splice'
    path: Prop[]
    value: string
    marks?: MarkSet
  }

  interface IncPatch {
    action: 'inc'
    path: Prop[]
    value: number
  }

  interface InsertPatch {
    action: 'insert'
    path: Prop[]
    values: PatchValue[]
    marks?: MarkSet
    conflicts?: boolean[]
  }

  interface MarkPatch {
    action: 'mark'
    path: Prop[]
    marks: Mark[]
  }

  interface UnmarkPatch {
    action: 'unmark'
    path: Prop[]
    name: string
    start: number
    end: number
  }

  interface ConflictPatch {
    action: 'conflict'
    path: Prop[]
  }

  interface BackendPatch {
    actor?: string
    seq?: number
    pendingChanges: number
    clock: Clock
    deps: Hash[]
    diffs: MapDiff
    maxOp: number
  }

  // Describes changes to a map (in which case propName represents a key in the
  // map) or a table object (in which case propName is the primary key of a row).
  interface MapDiff {
    objectId: OpId        // ID of object being updated
    type: 'map' | 'table' // type of object being updated
    // For each key/property that is changing, props contains one entry
    // (properties that are not changing are not listed). The nested object is
    // empty if the property is being deleted, contains one opId if it is set to
    // a single value, and contains multiple opIds if there is a conflict.
    props: {[propName: string]: {[opId: string]: MapDiff | ListDiff | ValueDiff }}
  }

  // Describes changes to a list or Automerge.Text object, in which each element
  // is identified by its index.
  interface ListDiff {
    objectId: OpId        // ID of object being updated
    type: 'list' | 'text' // type of objct being updated
    // This array contains edits in the order they should be applied.
    edits: (SingleInsertEdit | MultiInsertEdit | UpdateEdit | RemoveEdit)[]
  }

  // Describes the insertion of a single element into a list or text object.
  // The element can be a nested object.
  interface SingleInsertEdit {
    action: 'insert'
    index: number   // the list index at which to insert the new element
    elemId: OpId    // the unique element ID of the new list element
    opId: OpId      // ID of the operation that assigned this value
    value: MapDiff | ListDiff | ValueDiff
  }

  // Describes the insertion of a consecutive sequence of primitive values into
  // a list or text object. In the case of text, the values are strings (each
  // character as a separate string value). Each inserted value is given a
  // consecutive element ID: starting with `elemId` for the first value, the
  // subsequent values are given elemIds with the same actor ID and incrementing
  // counters. To insert non-primitive values, use SingleInsertEdit.
  interface MultiInsertEdit {
    action: 'multi-insert'
    index: number   // the list index at which to insert the first value
    elemId: OpId    // the unique ID of the first inserted element
    values: number[] | boolean[] | string[] | null[] // list of values to insert
    datatype?: DataType // all values must be of the same datatype
  }

  // Describes the update of the value or nested object at a particular index
  // of a list or text object. In the case where there are multiple conflicted
  // values at the same list index, multiple UpdateEdits with the same index
  // (but different opIds) appear in the edits array of ListDiff.
  interface UpdateEdit {
    action: 'update'
    index: number   // the list index to update
    opId: OpId      // ID of the operation that assigned this value
    value: MapDiff | ListDiff | ValueDiff
  }

  // Describes the deletion of one or more consecutive elements from a list or
  // text object.
  interface RemoveEdit {
    action: 'remove'
    index: number   // index of the first list element to remove
    count: number   // number of list elements to remove
  }

  // Describes a primitive value, optionally tagged with a datatype that
  // indicates how the value should be interpreted.
  interface ValueDiff {
    type: 'value'
    value: number | boolean | string | null
    datatype?: DataType
  }

  type OpAction =
    | 'del'
    | 'inc'
    | 'set'
    | 'link'
    | 'makeText'
    | 'makeTable'
    | 'makeList'
    | 'makeMap'
    | 'markBegin'
    | 'markEnd'

  type CollectionType =
    | 'list' //..
    | 'map'
    | 'table'
    | 'text'

  type DataType =
    | 'int'
    | 'uint'
    | 'float64'
    | 'counter'
    | 'timestamp'
    | 'bytes'

  // TYPE UTILITY FUNCTIONS

  // Type utility function: Freeze
  // Generates a readonly version of a given object, array, or map type applied recursively to the nested members of the root type.
  // It's like TypeScript's `readonly`, but goes all the way down a tree.

  // prettier-ignore
  type Freeze<T> =
    T extends Function ? T
    : T extends List<infer T> ? FreezeList<T>
    : T extends Array<infer T> ? FreezeArray<T>
    : T extends Map<infer K, infer V> ? FreezeMap<K, V>
    : T extends string & infer O ? string & O
    : FreezeObject<T>

  interface FreezeList<T> extends ReadonlyList<Freeze<T>> {}
  interface FreezeArray<T> extends ReadonlyArray<Freeze<T>> {}
  interface FreezeMap<K, V> extends ReadonlyMap<Freeze<K>, Freeze<V>> {}
  type FreezeObject<T> = { readonly [P in keyof T]: Freeze<T[P]> }

}

export import Doc = Automerge.Doc
export import ChangeFn = Automerge.ChangeFn
export import init = Automerge.init
export import from = Automerge.from
export import clone = Automerge.clone
export import free = Automerge.free
export import InitOptions = Automerge.InitOptions
export import ChangeOptions = Automerge.ChangeOptions
export import PatchCallback = Automerge.PatchCallback
export import LegacyPatchCallback = Automerge.LegacyPatchCallback
export import merge = Automerge.merge
export import change = Automerge.change
export import emptyChange = Automerge.emptyChange
export import applyChanges = Automerge.applyChanges
export import applyPatch = Automerge.applyPatch
export import applyPatches = Automerge.applyPatches
export import changeAt = Automerge.changeAt
export import equals = Automerge.equals
export import encodeChange = Automerge.encodeChange
export import decodeChange = Automerge.decodeChange
export import getActorId = Automerge.getActorId
export import getBackend = Automerge.getBackend
export import getAllChanges = Automerge.getAllChanges
export import getChanges = Automerge.getChanges
export import getChangesMetaSince = Automerge.getChangesMetaSince
export import getChangesSince = Automerge.getChangesSince
export import getConflicts = Automerge.getConflicts
export import getCursor = Automerge.getCursor
export import getCursorPosition = Automerge.getCursorPosition
export import getHeads = Automerge.getHeads
export import getHistory = Automerge.getHistory
export import getLastLocalChange = Automerge.getLastLocalChange
export import getMissingDeps = Automerge.getMissingDeps
export import getObjectId = Automerge.getObjectId
export import hasHeads = Automerge.hasHeads
export import hasOurChanges = Automerge.hasOurChanges
export import inspectChange = Automerge.inspectChange
export import isAutomerge = Automerge.isAutomerge
export import isCounter = Automerge.isCounter
export import stats = Automerge.stats
export import topoHistoryTraversal = Automerge.topoHistoryTraversal
export import toJS = Automerge.toJS
export import view = Automerge.view
export import diff = Automerge.diff
export import dump = Automerge.dump
export import load = Automerge.load
export import loadIncremental = Automerge.loadIncremental
export import save = Automerge.save
export import saveIncremental = Automerge.saveIncremental
export import saveSince = Automerge.saveSince
export import saveBundle = Automerge.saveBundle
export import readBundle = Automerge.readBundle
export import DecodedBundle = Automerge.DecodedBundle
export import generateSyncMessage = Automerge.generateSyncMessage
export import receiveSyncMessage = Automerge.receiveSyncMessage
export import initSyncState = Automerge.initSyncState
export import encodeSyncMessage = Automerge.encodeSyncMessage
export import decodeSyncMessage = Automerge.decodeSyncMessage
export import encodeSyncState = Automerge.encodeSyncState
export import decodeSyncState = Automerge.decodeSyncState
export import insertAt = Automerge.insertAt
export import deleteAt = Automerge.deleteAt
export import splice = Automerge.splice
export import updateText = Automerge.updateText
export import initializeWasm = Automerge.initializeWasm
export import initializeBase64Wasm = Automerge.initializeBase64Wasm
export import wasmInitialized = Automerge.wasmInitialized
export import isWasmInitialized = Automerge.isWasmInitialized
export import use = Automerge.use
export import mark = Automerge.mark
export import unmark = Automerge.unmark
export import marks = Automerge.marks
export import marksAt = Automerge.marksAt
export import spans = Automerge.spans
export import updateSpans = Automerge.updateSpans
export import block = Automerge.block
export import splitBlock = Automerge.splitBlock
export import joinBlock = Automerge.joinBlock
export import updateBlock = Automerge.updateBlock
export import List = Automerge.List
export import ImmutableString = Automerge.ImmutableString
export import RawString = Automerge.RawString
export import isImmutableString = Automerge.isImmutableString
export import isRawString = Automerge.isRawString
export import Counter = Automerge.Counter
export import Int = Automerge.Int
export import Uint = Automerge.Uint
export import Float64 = Automerge.Float64
export import ReadonlyList = Automerge.ReadonlyList
export import Hash = Automerge.Hash
export import Heads = Automerge.Heads
export import Prop = Automerge.Prop
export import Cursor = Automerge.Cursor
export import CursorPosition = Automerge.CursorPosition
export import MoveCursor = Automerge.MoveCursor
export import OpId = Automerge.OpId
export import ActorId = Automerge.ActorId
export import ObjID = Automerge.ObjID
export import Clock = Automerge.Clock
export import State = Automerge.State
export import ApplyOptions = Automerge.ApplyOptions
export import PatchSource = Automerge.PatchSource
export import PatchInfo = Automerge.PatchInfo
export import ChangeAtResult = Automerge.ChangeAtResult
export import ChangeMetadata = Automerge.ChangeMetadata
export import Stats = Automerge.Stats
export import BackendState = Automerge.BackendState
export import BinaryChange = Automerge.BinaryChange
export import BinaryDocument = Automerge.BinaryDocument
export import BinarySyncState = Automerge.BinarySyncState
export import BinarySyncMessage = Automerge.BinarySyncMessage
export import SyncState = Automerge.SyncState
export import SyncMessage = Automerge.SyncMessage
export import DecodedSyncMessage = Automerge.DecodedSyncMessage
export import SyncHave = Automerge.SyncHave
export import Change = Automerge.Change
export import DecodedChange = Automerge.DecodedChange
export import ChangeToEncode = Automerge.ChangeToEncode
export import API = Automerge.API
export import Op = Automerge.Op
export import MarkValue = Automerge.MarkValue
export import MarkSet = Automerge.MarkSet
export import Mark = Automerge.Mark
export import MarkRange = Automerge.MarkRange
export import ScalarValue = Automerge.ScalarValue
export import AutomergeValue = Automerge.AutomergeValue
export import MapValue = Automerge.MapValue
export import ListValue = Automerge.ListValue
export import MaterializeValue = Automerge.MaterializeValue
export import Conflicts = Automerge.Conflicts
export import Span = Automerge.Span
export import UpdateSpansConfig = Automerge.UpdateSpansConfig
export import Patch = Automerge.Patch
export import PatchValue = Automerge.PatchValue
export import PutPatch = Automerge.PutPatch
export import DelPatch = Automerge.DelPatch
export import SpliceTextPatch = Automerge.SpliceTextPatch
export import IncPatch = Automerge.IncPatch
export import InsertPatch = Automerge.InsertPatch
export import MarkPatch = Automerge.MarkPatch
export import UnmarkPatch = Automerge.UnmarkPatch
export import ConflictPatch = Automerge.ConflictPatch
export import BackendPatch = Automerge.BackendPatch
export import MapDiff = Automerge.MapDiff
export import ListDiff = Automerge.ListDiff
export import SingleInsertEdit = Automerge.SingleInsertEdit
export import MultiInsertEdit = Automerge.MultiInsertEdit
export import UpdateEdit = Automerge.UpdateEdit
export import RemoveEdit = Automerge.RemoveEdit
export import ValueDiff = Automerge.ValueDiff
export import OpAction = Automerge.OpAction
export import CollectionType = Automerge.CollectionType
export import DataType = Automerge.DataType
export import Freeze = Automerge.Freeze
export import FreezeList = Automerge.FreezeList
export import FreezeArray = Automerge.FreezeArray
export import FreezeMap = Automerge.FreezeMap
export import FreezeObject = Automerge.FreezeObject
export import next = Automerge
