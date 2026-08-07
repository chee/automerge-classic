// Applying changes moves the mutable document state to a new wrapper and
// marks the old wrapper frozen. Mutating operations must reject frozen
// wrappers, but read-only operations pass `allowFrozen` and read the live
// state, matching the Rust implementation, where reads on an outdated
// document reach the shared document handle. History is append-only, so
// those reads agree with the latest document state.
function backendState(backend, allowFrozen = false) {
  if (backend.frozen && !allowFrozen) {
    throw new Error(
      'Attempting to use an outdated Automerge document that has already been updated. ' +
      'Please use the latest document state, or call Automerge.clone() if you really ' +
      'need to use this old document state.'
    )
  }
  return backend.state
}

module.exports = {
  backendState
}
