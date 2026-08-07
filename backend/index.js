const {
  init, clone, free, applyChanges, applyLocalChange, save, saveIncremental, saveSince,
  load, loadChanges, loadIncremental, getPatch, getHeads, getAllChanges, getChanges,
  getChangesAdded, getChangeByHash, getMissingDeps, hasHeads, getCursorPosition, getChangesMeta,
  getHistoryMeta, getChangesByHash, topoHistoryTraversal, stats, saveBundle, saveBundleByHash, readBundle
} = require("./backend")
const { receiveSyncMessage, generateSyncMessage, encodeSyncMessage, decodeSyncMessage, encodeSyncState, decodeSyncState, initSyncState } = require('./sync')

module.exports = {
  init, clone, free, applyChanges, applyLocalChange, save, saveIncremental, saveSince,
  load, loadChanges, loadIncremental, getPatch, getHeads, getAllChanges, getChanges,
  getChangesAdded, getChangeByHash, getMissingDeps, hasHeads, getCursorPosition, getChangesMeta,
  getHistoryMeta, getChangesByHash, topoHistoryTraversal, stats, saveBundle, saveBundleByHash, readBundle,
  receiveSyncMessage, generateSyncMessage, encodeSyncMessage, decodeSyncMessage, encodeSyncState, decodeSyncState, initSyncState
}
