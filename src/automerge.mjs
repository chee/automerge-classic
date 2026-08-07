import Automerge from './automerge.js'

const {
  Backend, Counter, Float64, Frontend, ImmutableString, Int, Observable,
  RawString, Table, Text, Uint, addCommits, addFragments, applyChanges, applyPatch, applyPatches, block,
  change, changeAt, clone,
  decodeChange, decodeSyncMessage, decodeSyncState, deleteAt, emptyChange,
  diff, diffPath, dump, encodeChange, encodeSyncMessage, encodeSyncState, equals, free, from,
  generateSyncMessage, getActorId, getAllChanges, getChanges,
  getBackend, getCommits,
  getChangesMetaSince, getChangesSince, getConflicts, getCursor,
  getFragmentMeta, getFragmentMetadata,
  getFragments,
  getCursorPosition, getHeads, getHistory,
  getLastLocalChange, getMissingDeps, getObjectById, getObjectId, hasHeads,
  hasOurChanges,
  init, initSyncState, initializeBase64Wasm, initializeWasm, insertAt,
  inspectChange, isAutomerge, isCounter, isImmutableString, isRawString,
  isWasmInitialized, joinBlock, load, loadIncremental, mark, marks, marksAt,
  merge, next, receiveSyncMessage, releaseInfo, save, saveIncremental, saveSince,
  readBundle, saveBundle,
  bundleFragmentMetadata,
  setActorId, setDefaultBackend, spans, splice, splitBlock, stats,
  topoHistoryTraversal, toJS, unmark, updateBlock, updateSpans, updateText, use,
  uuid, view, wasmInitialized
} = Automerge

export {
  Backend, Counter, Float64, Frontend, ImmutableString, Int, Observable,
  RawString, Table, Text, Uint, addCommits, addFragments, applyChanges, applyPatch, applyPatches, block,
  change, changeAt, clone,
  decodeChange, decodeSyncMessage, decodeSyncState, deleteAt, emptyChange,
  diff, diffPath, dump, encodeChange, encodeSyncMessage, encodeSyncState, equals, free, from,
  generateSyncMessage, getActorId, getAllChanges, getChanges,
  getBackend, getCommits,
  getChangesMetaSince, getChangesSince, getConflicts, getCursor,
  getFragmentMeta, getFragmentMetadata,
  getFragments,
  getCursorPosition, getHeads, getHistory,
  getLastLocalChange, getMissingDeps, getObjectById, getObjectId, hasHeads,
  hasOurChanges,
  init, initSyncState, initializeBase64Wasm, initializeWasm, insertAt,
  inspectChange, isAutomerge, isCounter, isImmutableString, isRawString,
  isWasmInitialized, joinBlock, load, loadIncremental, mark, marks, marksAt,
  merge, next, receiveSyncMessage, releaseInfo, save, saveIncremental, saveSince,
  readBundle, saveBundle,
  bundleFragmentMetadata,
  setActorId, setDefaultBackend, spans, splice, splitBlock, stats,
  topoHistoryTraversal, toJS, unmark, updateBlock, updateSpans, updateText, use,
  uuid, view, wasmInitialized
}

export default Automerge
