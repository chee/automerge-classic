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

Current seven-process medians after selective live slabs:

| Workload | Classic JS | Rust/WASM 3.2 | Ratio |
| --- | ---: | ---: | ---: |
| 6,000 writes to one numeric map property | 376.896 ms | 182.266 ms | 2.07× |
| 3,000 numeric list appends | 224.797 ms | 168.893 ms | 1.33× |
| 2,000 distinct numeric map properties | 369.849 ms | 437.112 ms | 0.85× |
| 2,000 one-character text appends | 168.788 ms | 84.901 ms | 1.99× |

Additional seven-process medians:

| Workload | Classic adaptive | Rust/WASM 3.2 | Ratio |
| --- | ---: | ---: | ---: |
| 1,000 cursors in a 21,000-character edited text | 15.049 ms | 6.802 ms | 2.21× |
| Cold save after 6,000 overwrites | 5.734 ms | 2.011 ms | 2.85× |
| Load that document | 13.365 ms | 17.683 ms | 0.76× |
| Warm cached save | 0.002 ms | 0.408 ms | 0.005× |
| Merge two 1,000-write branches | 16.592 ms | 13.444 ms | 1.23× |

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
- Current source result: 668 passing, 1 pending, no failures; TypeScript passes.

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

## Known non-goals unless a consumer requires them

- Reproducing a real wasm object identity from `getBackend`.
- Matching Rust instruction-level throughput.
- Porting Rust ownership, borrowing, or unsafe-memory techniques into JavaScript.
- Changing wire formats to suit the JavaScript implementation.
