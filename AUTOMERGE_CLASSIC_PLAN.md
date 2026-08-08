# Automerge Classic modernization plan

## Goal

Make `@automerge/automerge-classic` a practical plain-JavaScript replacement for `@automerge/automerge` through a pnpm override. Preserve the current Automerge binary formats and JavaScript behavior, including modern primitive-string text, rich text, sync v2, bundles, fragments, incremental loading, package subpaths, and the intentionally empty `automerge.wasm` export.

The performance target is practical parity for normal document workloads. Exact Rust throughput is not required. Pathological quadratic behavior is not acceptable.

## Reference implementations

- `../automerge`, branch `fragment`, currently at `658be7caa`.
- `../automerge/rust/hexane` for editable RLE, delta, boolean, raw, slab, cursor, and aggregate column storage.
- Installed `@automerge/automerge` 3.2.0 for runtime and patch-output probes.
- Rust-produced fixtures in `test/interop_fixtures.js`.

## Completed

### Binary formats and storage

- Current change and document containers load in both implementations.
- Bundle encoding and decoding are implemented.
- Bundle operation IDs use the normal counter column accepted by Rust 3.2.
- Fragment metadata, fragment hierarchy, bundling, commits, and fragment import are implemented.
- Incremental save, incremental load, and save-since are implemented.
- Empty map keys encode and decode correctly.
- Bytes use `Uint8Array` at the public API.
- UTF-8 key ordering matches the Rust ordering, including astral characters and invalid surrogate replacement.
- Actor lookup uses an ID-to-index map.
- Loaded documents defer full change-graph reconstruction, history-column materialization, and operation-block splitting.
- History metadata and fragment metadata are cached.
- Loaded clones retain the deferred representation. The first mutation materializes mutable history columns and splits the touched oversized block.
- `backend/column_data.js` implements immutable slabbed RLE, delta, boolean, integer, string, and raw byte columns with get, range, splice, save, load, and canonical validation. It has focused and randomized tests.
- Live operation blocks use immutable compressed slabs for repeated map overwrites and batched map merges. Untouched slabs are shared across document snapshots.
- List edits, text edits, and first writes to map keys retain the streaming column path because measured slab conversion was slower for those workloads.
- Saving slab-backed blocks streams their logical column data into the canonical document encoder without first materializing an intermediate canonical block buffer.
- Causally applied batches expand their document schema before merging operations, so future columns introduced by later changes are retained.
- Nonblank future scalar, grouped, value-length, and raw columns survive save, load, and lazy history reconstruction with exact original change bytes and hashes.
- Failed batched apply and failed lazy history reconstruction commit no partial hash graph or document state.
- Change application uses a transaction-local hash-index overlay, preserving rollback without copying the full history index for every change.

### Backend performance

- Document operation lookup uses binary block search.
- Map properties track their current visible operation IDs.
- Safe sequential overwrites start at the predecessor block.
- Concurrent conflicts fall back to the full property scan when the visible predecessor set is incomplete.
- Actor scans were replaced with indexed lookup.
- Block metadata records terminal operation IDs.
- A regression covers an old visible concurrent value alongside a later sequential overwrite.
- Map-only operation blocks use a 100-operation maximum. Blocks containing list or text operations retain the established 600-operation maximum.
- Empty missing-dependency queries avoid reconstructing the hash graph.
- Cursor lookup uses a lazy per-object element-ID index and a lazy UTF-16 prefix table. Committed changes invalidate only touched objects.

Measured in one local process before the current adaptive-slab change:

| Workload | Classic JS | Rust/WASM 3.2 |
| --- | ---: | ---: |
| 6,000 writes to one numeric map property | 1,568 ms | 180 ms |
| 3,000 numeric list appends | 188 ms | 139 ms |
| 2,000 distinct numeric map properties | 500 ms | 385 ms |
| 2,000 one-character text appends | 117 ms | 51 ms |

A global 100-operation block experiment reduced the 6,000-write case to 411 ms, list appends to 148 ms, map growth to 319 ms, and text appends to 97 ms. Seven fresh-process adaptive medians before live operation slabs were 478.316 ms, 226.698 ms, 388.032 ms, and 158.000 ms respectively while preserving the large text/list blocks and their raw encoding tests. Rust/WASM 3.2 medians were 182.266 ms, 168.893 ms, 437.112 ms, and 84.901 ms.

Current paired seven-process medians after selective live slabs:

Each sample ran in a fresh Node process. Implementation order alternated between samples. Module initialization and workload setup were outside the timed regions.

| Workload | Classic JS | Rust/WASM 3.2.5 | Classic/WASM |
| --- | ---: | ---: | ---: |
| 6,000 writes to one numeric map property | 433.712 ms | 174.101 ms | 2.49× |
| 3,000 numeric list appends | 248.245 ms | 168.843 ms | 1.47× |
| 2,000 distinct numeric map properties | 417.135 ms | 434.996 ms | 0.96× |
| 2,000 one-character text appends | 196.303 ms | 80.910 ms | 2.43× |

Additional paired seven-process medians:

| Workload | Classic adaptive | Rust/WASM 3.2.5 | Classic/WASM |
| --- | ---: | ---: | ---: |
| Cold save after 6,000 overwrites | 6.163 ms | 2.661 ms | 2.32× |
| Load that document | 13.374 ms | 17.351 ms | 0.77× |
| Merge two 1,000-write branches | 16.465 ms | 18.076 ms | 0.91× |

Earlier independent seven-process medians:

| Workload | Classic adaptive | Rust/WASM 3.2 | Classic/WASM |
| --- | ---: | ---: | ---: |
| 1,000 cursors in a 21,000-character edited text | 15.049 ms | 6.802 ms | 2.21× |
| Warm cached save | 0.002 ms | 0.408 ms | 0.005× |

The cursor index improved the repeated lookup fixture by 14.05×. A representative first lookup builds the index and UTF-16 table in about 13.7 ms; the next 999 lookups total about 0.5 ms. Lazy load improved the 6,000-overwrite fixture by 20.56×. The first mutation after load pays about 8 ms locally to materialize mutable structures.

### Modern JavaScript API

- The package root defaults to modern string encoding.
- Plain JavaScript strings become CRDT text objects internally and remain primitive strings publicly.
- Scalar wire-format strings materialize as `ImmutableString`/`RawString`.
- `getObjectId(container, property)` and `getConflicts` work with projected primitive strings.
- UTF-16 positions match the current JavaScript package for splice, updateText, marks, spans, blocks, and cursors.
- Cursor behavior inside surrogate pairs matches 3.2.
- Marks, block markers, spans, updateSpans, and semantic rich-text patches are implemented.
- Inserted text patches include inherited marks when required.
- Text replacement patch order, mark and unmark callbacks, block update key order, and marked-text load patches match 3.2 fixtures.
- `diff`, `diffIncremental`, patch callbacks, applyPatch, and applyPatches use the modern patch shape.
- One- and two-argument patch callbacks receive semantic patch arrays.
- Four-argument callbacks retain the classic backend-patch compatibility path.
- `applyChanges` returns the modern one-element tuple.
- `receiveSyncMessage` returns a null third tuple element, matching 3.2.
- Read-only sync and sync capabilities are implemented.
- `allowMissingChanges` and `convertImmutableStringsToText` are implemented.
- `from(existingDocument)` and clone/load option behavior are covered.
- `src/classic.js` and `src/classic.mjs` provide explicit legacy `Text` behavior with `textV2:false`.

### Package compatibility

- Root, `./slim`, and `./classic` expose CommonJS and ESM entry points.
- Webpack emits self-contained browser-native `dist/automerge.mjs` and `dist/classic.mjs` bundles.
- Browser and workerd import conditions use the self-contained ESM bundles.
- Node CommonJS and Node ESM imports work.
- The root and slim API export sets match the modern package surface used by the compatibility tests.
- `./automerge.wasm` exports an intentional zero-byte module.
- `./automerge.wasm.base64` exports an empty base64 string in CommonJS and ESM.
- Package dry-run includes ESM bundles, source maps, classic entry points, and both wasm compatibility assets.
- An actual pnpm override smoke test has loaded CommonJS, ESM, and Automerge Repo consumers.
- Automerge Repo and solid-primitives source typechecks have passed against the classic package declarations.
- Strict package-consumer TypeScript resolves the override and accepts 3.2 list helpers, insert patch metadata, open operation actions, and the base64 wasm subpath.

### Rust behavior parity

- Map key enumeration matches the Rust implementation: each apply adds its new keys in UTF-8 order after existing keys, load and `toJS` produce fully sorted keys, and object-literal insertion order is preserved in generated operations.
- `getConflicts` returns conflicting values in ascending opId order.
- Semantic patches carry `conflict: true` on conflicted puts and `conflicts` arrays on conflicted list inserts, and patch emission for new and changed objects is ordered by object creation, matching Rust output for load, applyChanges, sync, and diff.
- `updateText` is a port of the Rust Myers diff over graphemes, producing identical operations and change hashes, and tolerating inline block markers.
- `updateSpans` is a port of the Rust Myers block diff with the replace combiner, the `after` default expand, and mark reconciliation against the updated document.
- Mark boundaries honor the `expand` flags when resolving positions, so text inserted at an expanding boundary joins the mark exactly as in Rust.
- Strings are stored well-formed: unpaired surrogates become U+FFFD at ingestion, so live documents match their saved-and-reloaded form and the Rust in-memory representation.
- `getChanges` ignores heads unknown to the new document instead of throwing.
- `from()` no longer sets an "Initialization" change message.
- `updateBlock` deletes and reinserts the block marker, and `splitBlock` emits the `type` property first.
- `test/rust_parity_test.js` pins these behaviors with expectations captured from the Rust implementation; `test/live_interop_test.js` runs 16 cross-implementation integration tests (identical hashes for identical API calls, cross loads, bidirectional sync with concurrent edits, rich text and marks over sync, patch and diff parity, cursors, incremental saves, an automerge-repo-style lifecycle, and export-surface coverage) against `AUTOMERGE_MODERN_PATH` or a built `../automerge/javascript`, and skips when neither is available.
- Read-only backend operations (`stats`, `hasHeads`, `save`, `saveSince`, `getChanges`, `getChangeByHash`, `getMissingDeps`, cursor and history/fragment reads, `getChangesAdded`) accept outdated document snapshots, reading the live state like the Rust implementation. Mutating operations still reject them. Automerge Repo calls these on old snapshots while handling inbound sync.
- Every document root also carries the wasm implementation's globally registered symbols: `Symbol.for('_am_objectId')` is `'_root'`, and `Symbol.for('_am_meta')` exposes `{handle, heads, ...}` with a read-only handle facade (`getHeads`, `diff`, `materialize`, `stats`, `save`, `saveSince`, `getChangesMeta`, `topoHistoryTraversal`). Plugin bundles that ship their own copy of the wasm `@automerge/automerge` (for example Patchwork package bundles) read documents through these symbols; the facade lets them project classic documents. Verified with Patchwork's Playwright end-to-end suite: 12 of 13 chromium tests pass over the classic override; the remaining failure (cross-profile sync via the live sync server) also fails — earlier — with the wasm fragment-branch build, so it is not a classic regression.

### Tests currently present

- JS/Rust document, change, bundle, sync, bytes, Unicode, table, and conflict fixtures.
- Out-of-order dependency delivery.
- Concatenated incremental chunks.
- Cross-runtime concurrent string edits.
- Mark and block-marker wire compatibility.
- Fragment hierarchy and bundle selection.
- Column slab operations and canonical encoding.
- Modern API and TypeScript compatibility.
- Direct package assertions for the zero-byte wasm and empty base64 exports.
- Legacy `Text` and Observable behavior through the classic facade.
- Native ESM evaluation with no CommonJS imports.
- Lazy loaded-state materialization and indexed live/deleted cursors.
- Immutable operation-slab sharing across cloned document snapshots.
- Randomized staged/current comparison across sequential map edits and concurrent branches, using both batched and one-change-at-a-time application.
- Batched future-column retention, grouped future value/raw columns, exact future-column history reconstruction, and transactional failure recovery.
- Exact semantic patches for local changes, load, applyChanges, merge, and sync.
- Rust parity regressions for key ordering, conflicts, patch order, updateText, updateSpans, mark boundaries, surrogate handling, and getChanges.
- Live cross-implementation integration tests against the built `../automerge/javascript` package.
- Patch-convergence fuzzing (`test/patch_convergence_test.js`): three peers make concurrent map/list/text/mark changes and exchange them over partial out-of-order syncs; after every step, applying the patchCallback stream to a plain value must equal `toJS(doc)`, and after full synchronization the peers must converge with matching spans. The fuzz found four bugs, all fixed with minimized regressions pinned:
  - `mark()` before text edits in the same change registered the old cached text object as updated, so later edits mutated the previous snapshot in place and their patches were dropped;
  - saved documents emitted the actor table in first-seen order; the Rust implementation requires it sorted and rejected such documents with "mismatching heads" (save now remaps every actor-index column);
  - a delete whose predecessors were already overwritten, batched with changes to other keys, emitted a patch that dropped the concurrently surviving value (the multi-key merge walk now drains the current key's document ops first);
  - `getChanges`'s fast path could return a change without its dependencies when the traversal aborted on the last stack entry (the abort is now tracked explicitly), leaving receiving peers unable to converge.
- A second, wider fuzzing pass (counters, blocks, updateSpans in the mix; save-bytes loadability in the Rust implementation checked continuously) found and fixed six more bugs:
  - a batched patch that references the same child object several times through conflict re-listing duplicated its contents when applied (each shared child patch is now applied once per pass);
  - counters could not be overwritten with plain values, unlike the Rust implementation;
  - successive increments emitted their pred against the previous increment instead of the counter operation, so reloads and remote peers dropped all but the first increment;
  - an increment on a conflicted key wiped the other conflicting values from the local state;
  - increments whose counter is not visible crashed the backend instead of contributing nothing;
  - values whose only successors are increments were hidden by reload and by patches (visibility is now deferred until the successors are known, with multiple candidates per successor supported); and marks anchored on deleted elements were dropped by marks()/spans() (anchors now resolve through the full insertion tree, including tombstones).
- Known Rust-implementation inconsistencies found by the fuzz (classic follows the replay semantics, which converge): the Rust implementation's local and reload views drop conflicts that its own change replay preserves after a multi-pred increment, and values whose only successors are increments survive its replay but are dropped by its own document encoding. Classic is self-consistent (live == reload == replay) in both cases.
- A third fuzzing pass (100 seeds × 100 steps in both plain and blocks modes, all clean) found and fixed two more bugs:
  - insertions at sticky mark boundaries anchored on the preceding character instead of the boundary element, diverging from the Rust wire format (fixed by porting Rust's `InsertQuery` authoring-time anchor adjustment and switching mark resolution to plain RGA ordering — this also resolved the previously open stacked marks/blocks divergence);
  - deleting two consecutive list elements where the first survives through a concurrent overwrite removed the survivor instead of the second element in the incremental patch (the list index now advances past the surviving element before the removal patch is generated, matching the load path).
- Current source result: 786 passing, 1 pending (env-gated live interop), no failures; TypeScript passes; lint passes; ESM smoke passes; the full suite also passes against the built bundle (`TEST_DIST=1 mocha`).
- Bundle size: webpack builds in production mode (minified, external source maps), and the runtime dependencies are down to `fflate` (raw DEFLATE, replacing pako — output verified cross-loadable with the Rust implementation in both directions, including compressed change chunks and compressed document columns) and `fast-sha256` (uuid replaced by `crypto.getRandomValues`). `dist/automerge.js` is ~207 KB minified (~61 KB gzipped), down from ~752 KB.

## Implementation checklist

### 1. Validate adaptive map slabs

- Completed: track whether an operation block contains list/text operations.
- Completed: use the existing 600-operation maximum for blocks containing list/text operations.
- Completed: use a 100-operation maximum for map-only blocks.
- Completed: preserve metadata through split, clone, and block replacement.
- Completed: retain one validated compressed operation block on load and split the touched output on its first mutation.
- Completed: raw column-encoding block tests and the concurrent-visible-value regression pass.
- Completed: the four benchmark workloads were measured again.
- Completed: seven fresh-process medians were collected for the four mutation workloads plus cursor lookup, save, load, and merge.

### 2. Audit semantic patches against 3.2

- Completed: compare put, delete, increment, list insert/delete, text splice, conflicts, marks, unmarks, blocks, and inherited marks.
- Completed: compare local change, applyChanges, load, merge, and receiveSyncMessage callbacks.
- Completed: correct text replacement ordering, local mark callback state, null-valued unmark patches, block update key order, and inherited marks on load splices.
- Completed: add exact local and transport fixtures for the confirmed mismatches.
- Completed: keep legacy four-argument callback behavior separately tested.

### 3. Audit lower-level exports

- Completed: absent or empty messages decode as `null`.
- Completed: false `insert` is omitted from public decoded map operations.
- Completed: byte scalars decode publicly as `number[]` without a datatype while internal reconstruction retains `Uint8Array` and type 7.
- Completed: nonnegative direct integers infer uint; increments retain signed/int behavior.
- Completed: declarations and exact codec and byte-mark regressions were updated.
- Completed: decoded trailing bytes use public `extra_bytes: number[]` while internal reconstruction retains raw bytes.
- Completed: unknown scalar types decode as `{type_code, bytes}`.
- Completed: supplied hashes require a 32-byte hexadecimal shape and are not compared with the computed hash, matching 3.2.
- Completed: reject the classic `values` and `multiOp` operation shorthands only at the public `Automerge.encodeChange` facade while retaining them for internal frontend encoding.

### 4. Resolve backend-handle compatibility boundaries

- Completed: audited Automerge Repo 2.4 and the current local Repo source. Neither calls `getBackend()` nor `use()`.
- Completed: keep `slim` immediately usable and tolerant of the intentionally empty wasm/base64 initialization inputs.
- Completed: keep `use(api)` as a compatibility no-op.
- Known boundary: Rust returns a stable wasm handle from `getBackend`; classic returns its opaque `{state, heads}` wrapper. No consumer in scope observes that identity or shape.
- If a future consumer needs handle methods, the first justified facade methods are `saveIncremental()` and `materialize()`.

### 5. Complete Hexane integration

- Completed: profile the adaptive compressed-block backend after the map-slab work.
- Completed: profile `copyColumns`, `mergeDocChangeOps`, frontend materialization, load, save, and cursor lookup.
- Completed: integrate immutable compressed column slabs into the live operation store for repeated map overwrites and batched map merges.
- Completed: use 24-row slabs, binary slab lookup, aggregate row counts, immutable clone sharing, and targeted splice of affected logical ranges.
- Completed: preserve the established streaming path for list, text, and new-map-key edits after benchmarks showed regressions under unconditional slab conversion.
- Completed: preserve canonical output by merging logical slab streams through the existing encoders at save boundaries.
- Completed: exact staged/current save-byte comparison on a deterministic overwrite document.
- Completed: 120 randomized staged/current comparisons across sequential and concurrent map histories, with identical bytes and patches.
- Completed: audit slab offsets, mixed streaming/slab paths, splits, concatenation, conflict preservation, clones, transactional failure, and future-column schema changes.
- Completed invariants:
  - immutable document snapshots;
  - canonical RLE/delta output;
  - transactional apply on error;
  - efficient splice without decoding untouched slabs;
  - aggregate row counts and binary slab lookup;
  - clone shares immutable slabs;
  - save concatenates canonical column data.
- Known format boundary: a saved document cannot distinguish a future column absent from an original change from that column explicitly containing only default values. Exact lazy history reconstruction rejects an ambiguous hash non-destructively.

### 6. Cursor and list indexing

- Completed: repeated cursor lookup was profiled at 31.08× slower than 3.2 before indexing.
- Completed: add a lazy per-object element-ID/position index and immutable clone sharing with targeted invalidation.
- Completed: route public visible and deleted operation cursors through the backend index.
- Completed: add a lazy UTF-16 prefix table for public offsets.
- Completed: preserve deleted-cursor before/after movement semantics.
- Completed: cover surrogate pairs, deleted runs, both concurrent merge orders, marks, loads, and block markers.
- Current gap: 15.049 ms versus 6.802 ms for 1,000 lookups, concentrated in the cold first index build.

### 7. Package-level override verification

- Completed: build all distribution files and evaluate browser-native ESM without CommonJS imports.
- Completed: inspect the packed file list and export map.
- Completed: install the packed tarball as a pnpm override for `@automerge/automerge` in a temporary consumer.
- Completed: verify CommonJS root, Node ESM root, `./slim`, `./classic`, raw zero-byte `./automerge.wasm`, empty `./automerge.wasm.base64`, and TypeScript package resolution.
- Completed: repeat the packed override smoke under pnpm 11 using workspace-level overrides; dependency aliasing and every runtime subpath passed offline.
- Completed earlier: Automerge Repo initialization and sync through a local override consumer.
- Completed: install Automerge Repo 2.5 in a fresh pnpm override consumer and verify repository construction, document creation, and document mutation.

The packed override passes CommonJS root, Node ESM root, slim, classic, raw zero-byte wasm, empty base64, strict TypeScript resolution, and an Automerge Repo 2.5 consumer.

### 8. Final verification at this checkpoint

- Completed: `pnpm test`: 668 passing, 1 pending.
- Completed: `pnpm run test:esm`.
- Completed: full suite with live Rust/WASM 3.2.5 enabled: 669 passing.
- Completed: bundle, fragment, incremental load, and sync v2 fixtures through the full suite.
- Completed: `pnpm lint`.
- Completed: package dry-run; the packed raw wasm file is present and has size zero.
- Completed: fresh pnpm 11 packed-package override smoke for CommonJS, ESM, slim, classic, wasm, and base64 entry points.
- Completed: strict TypeScript package-consumer smoke through the pnpm override.
- Completed: performance matrix with seven-process medians.
- Completed: removed an O(history) transactional hash-index copy found during final benchmarking; isolated repeated-write medians returned to linear behavior.
- Completed: 120 randomized staged/current backend comparisons with identical saved bytes and patches.
- Completed: `git diff --check`.
- Preserve unrelated workspace files, including `.package.json.swp` if present.

## Acceptance criteria

- A pnpm override can replace `@automerge/automerge` for the tested Repo, CommonJS, ESM, browser, and TypeScript consumers.
- Current Rust/WASM documents and changes load in classic, and classic output loads in Rust/WASM.
- Primitive strings merge character-by-character and use UTF-16 API positions.
- Rich-text patch output contains marks and block information required by mirrors.
- Bundles, fragments, incremental loading, and sync v2 interoperate.
- The raw empty wasm subpath and empty base64 subpath resolve.
- Full tests and typechecking pass.
- No known quadratic repeated-map-overwrite path remains.
- Remaining incompatibilities are listed with concrete affected APIs and evidence.

## Known limitations

- `getBackend()` returns the classic opaque backend wrapper rather than a wasm object. Automerge Repo does not inspect this boundary.
- Exact history reconstruction after loading a saved document is impossible for a hypothetical future column whose values are all encoding defaults within a change. The document format stores the merged column values but no per-change column-presence bit. `getChanges()` detects the hash mismatch and leaves the loaded backend unchanged.
- `backend/column_data.js` is internal. Its immutable slab sharing relies on internal callers not mutating returned slab objects or byte arrays.
- The Rust implementation iterates a `std::collections::HashMap` when generating the property operations of a block marker, so the operation order of a multi-property block (and therefore the change hash) is nondeterministic in Rust itself. Classic uses a fixed deterministic order (`type` first for `splitBlock`, sorted for `updateBlock`); either order interoperates.
- `diff()` emits the same patch set with the same per-object grouping and object ordering as Rust, but within one object Rust orders patches by the operation order of the underlying changes, while classic orders deletions first and then keys in sorted order. Patches on distinct keys commute, so applying the patches yields the same result.
- Mark boundaries are now handled the way the Rust implementation handles them, at both ends of the pipeline. Reading: boundaries are elements of the text sequence ordered by plain RGA (descending operation ID among siblings), marks are resolved with a linear sequence scan in which an unclosed begin extends to the end of the text, zero-width non-expanding marks are ignored without emitting operations, and an empty expanding mark anchors its end boundary on its own begin boundary. Writing: boundary stickiness is applied at authoring time, as in Rust's `InsertQuery` — a locally authored insertion whose position immediately follows a sticky boundary (an expanding begin or a non-expanding end) anchors its wire `elemId` on the boundary element itself, and a begin/end pair straddling the insertion point is skipped over entirely (`adjustInsertAnchors` in `backend/new.js`, gated on the object containing marks so mark-free documents pay nothing). All verified hash-identical with the Rust implementation, including inserts at sticky and empty-mark boundaries and the stacked marks/blocks arrangement previously pinned as an open divergence (fixture `test/fixtures/mark_block_stack.json`, test now enabled).

## Known non-goals unless a consumer requires them

- Reproducing a real wasm object identity from `getBackend`.
- Matching Rust instruction-level throughput.
- Porting Rust ownership, borrowing, or unsafe-memory techniques into JavaScript.
- Changing wire formats to suit the JavaScript implementation.
