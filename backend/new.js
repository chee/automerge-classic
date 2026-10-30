import { PanicError, addInt, compareUtf8, copyObject, isObject, parseOpId, wellFormedString } from '../src/common.js'
import { ACTIONS, CHANGE_COLUMNS, COLUMN_TYPE, DOCUMENT_COLUMNS, DOC_OPS_COLUMNS, OBJECT_TYPE, VALUE_TYPE, changeColumnReaders, decodeChangeColumns, decodeChangeMeta, decodeDocumentHeader, decodeValue, decoderByColumnId, decompressChange, documentChanges, documentRows, encodeDocumentHeader, encoderByColumnId, makeDecoders, readNext } from './columnar.js'
import * as ColumnData from './column_data.js'
import { Decoder, Encoder } from './encoding.js'
const MAX_BLOCK_SIZE = 300 // operations
const MAX_MAP_BLOCK_SIZE = 100
const MAX_SPLICE_OPS = 64
const BLOOM_BITS_PER_ENTRY = 10, BLOOM_NUM_PROBES = 7 // 1% false positive rate
const BLOOM_FILTER_SIZE = Math.floor(BLOOM_BITS_PER_ENTRY * MAX_BLOCK_SIZE / 8) // bytes

const objActorIdx = 0, objCtrIdx = 1, keyActorIdx = 2, keyCtrIdx = 3, keyStrIdx = 4,
  idActorIdx = 5, idCtrIdx = 6, insertIdx = 7, actionIdx = 8, valLenIdx = 9, valRawIdx = 10,
  predNumIdx = 13, predActorIdx = 14, predCtrIdx = 15, succNumIdx = 13, succActorIdx = 14, succCtrIdx = 15,
  expandIdx = 16, markNameIdx = 17

const PRED_COLUMN_IDS = CHANGE_COLUMNS
  .filter(column => ['predNum', 'predActor', 'predCtr'].includes(column.columnName))
  .map(column => column.columnId)

const OPERATIONS = Symbol('operations')
const COLUMN_DATA = new WeakMap()
const COLUMN_SPLICES = new WeakMap()
const ENCODED_COLUMNS = new WeakMap()
const COLUMN_TAILS = new WeakMap()
const SEQUENCE_INSERTS = new WeakMap()
const SEQUENCE_ELEMENTS = new WeakMap()
const BLOCK_OBJECTS = new WeakMap()
const BLOCK_MARKS = new WeakMap()
const MARK_STEPS = new WeakMap()
const HEADS_CLOCKS = new Map()
const CHANGE_TARGETS = new WeakMap()
const LOADED_DOCUMENTS = new WeakMap()
const PATCH_OBJECTS = new WeakMap()
const RAW_OBJECT_IDS = new WeakMap()
const OBJECT_IDS = new WeakMap()
const MAX_TOUCHED_ELEMENTS = 16
const TARGET_COLUMNS = [objActorIdx, objCtrIdx, keyActorIdx, keyCtrIdx, keyStrIdx, insertIdx, actionIdx].map(index => CHANGE_COLUMNS[index])
const COLUMN_SLAB_OPTIONS = {slabRows: 24}
const CONCAT_SNAPSHOT_INTERVAL = 8

function operationValueCount(column, value) {
  if ((column.columnId & 7) === COLUMN_TYPE.VALUE_RAW) return value ? value.byteLength : 0
  return Array.isArray(value) ? value.length : 1
}

function columnOperationCache(columns) {
  let cache = columns[OPERATIONS]
  if (cache) return cache
  for (const column of columns) column.decoder.reset()
  const documentColumns = columns.length === DOC_OPS_COLUMNS.length &&
    columns.every((column, index) => column.columnId === DOC_OPS_COLUMNS[index].columnId)
  const operations = documentColumns ? documentRows(columns.map(column => column.decoder.buf)) : []
  if (!documentColumns) while (!columns[actionIdx].decoder.done) operations.push(readOperation(columns))
  for (const column of columns) column.decoder.reset()
  cache = {operations}
  columns[OPERATIONS] = cache
  return cache
}

function columnDataType(columnId) {
  const type = columnId & 7
  if (type === COLUMN_TYPE.INT_DELTA) return 'delta'
  if (type === COLUMN_TYPE.BOOLEAN) return 'boolean'
  if (type === COLUMN_TYPE.STRING_RLE) return 'string'
  if (type === COLUMN_TYPE.VALUE_RAW) return 'raw'
  return 'uint'
}

function operationColumnValues(operations, columnIndex, columnId) {
  const raw = (columnId & 7) === COLUMN_TYPE.VALUE_RAW
  const values = []
  for (const operation of operations) {
    const value = operation[columnIndex]
    if (raw) {
      if (value) values.push(...value)
    } else if (Array.isArray(value)) {
      values.push(...value)
    } else {
      values.push(value)
    }
  }
  return values
}

function operationColumnData(operations, columnIndex, columnId) {
  return ColumnData.createColumn(columnDataType(columnId),
    operationColumnValues(operations, columnIndex, columnId), COLUMN_SLAB_OPTIONS)
}

function columnEncoders(columns) {
  return columns.map(column => ({columnId: column.columnId, encoder: encoderByColumnId(column.columnId)}))
}

function columnDecoders(encoders) {
  const tails = []
  const columns = encoders.map(({columnId, encoder}) => {
    const {offset, state, lastValue, count, literal, absoluteValue} = encoder
    tails.push({offset, state, lastValue, count, literal, absoluteValue})
    return {columnId, decoder: decoderByColumnId(columnId, encoder.buffer)}
  })
  COLUMN_TAILS.set(columns, tails)
  return columns
}

const DATA_COLUMN = {
  get decoder() {
    if (!this.cachedDecoder) this.cachedDecoder = decoderByColumnId(this.columnId, ColumnData.toBuffer(this.columnData))
    return this.cachedDecoder
  },
  get columnData() {
    return columnDataForColumns(this.columns)[this.index]
  }
}

function operationColumns(template, operations) {
  const encoders = columnEncoders(template)
  appendOperations(encoders, operations)
  const columns = columnDecoders(encoders)
  columns[OPERATIONS] = {operations}
  return columns
}

function appendOperations(encoders, operations) {
  for (let index = 0; index < encoders.length; index++) {
    const {columnId, encoder} = encoders[index]
    if ((columnId & 7) === COLUMN_TYPE.VALUE_RAW) {
      for (const operation of operations) if (operation[index]) encoder.appendRawBytes(operation[index])
    } else {
      for (const value of operationColumnValues(operations, index, columnId)) encoder.appendValue(value)
    }
  }
}

function columnsFromOperations(template, operations) {
  const columns = []
  for (const {columnId, columnName} of template) {
    const column = Object.create(DATA_COLUMN)
    column.columnId = columnId
    if (columnName) column.columnName = columnName
    column.columns = columns
    column.index = columns.length
    column.cachedDecoder = undefined
    columns.push(column)
  }
  columns[OPERATIONS] = {operations}
  return columns
}

function columnDataForColumns(columns) {
  let data = COLUMN_DATA.get(columns)
  if (data) return data
  const splice = COLUMN_SPLICES.get(columns)
  if (splice) {
    data = splice.data.map((column, index) => {
      let start = 0, end = 0
      for (let row = 0; row < splice.endRow; row++) {
        const count = operationValueCount(columns[index], splice.operations[row][index])
        if (row < splice.startRow) start += count
        end += count
      }
      const inserted = operationColumnValues(splice.inserted, index, columns[index].columnId)
      return ColumnData.splice(column, start, end - start, inserted)
    })
    COLUMN_SPLICES.delete(columns)
  } else {
    const operations = columnOperationCache(columns).operations
    data = columns.map((column, index) => operationColumnData(operations, index, column.columnId))
  }
  COLUMN_DATA.set(columns, data)
  return data
}

function spliceColumns(columns, startRow, endRow, inserted, outputOperations) {
  const output = columnsFromOperations(columns, outputOperations)
  const data = COLUMN_DATA.get(columns)
  if (data) {
    COLUMN_SPLICES.set(output, {data, operations: columns[OPERATIONS].operations, startRow, endRow, inserted})
  }
  return output
}

function concatBuffers(buffers) {
  const byteLength = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0)
  const result = new Uint8Array(byteLength)
  let offset = 0
  for (let buffer of buffers) {
    result.set(buffer, offset)
    offset += buffer.byteLength
  }
  return result
}

function compareBlockObject(block, actorIds, actor, counter) {
  if (block.lastObjectCtr === undefined) return 1
  if (block.lastObjectCtr === null) return counter === null ? 0 : -1
  if (counter === null) return 1
  if (block.lastObjectCtr < counter) return -1
  if (block.lastObjectCtr > counter) return 1
  const blockActor = actorIds[block.lastObjectActor]
  if (blockActor < actor) return -1
  if (blockActor > actor) return 1
  return 0
}

function findBlock(blocks, actorIds, actor, counter, key, idActor, idCtr) {
  let left = 0, right = blocks.length - 1
  while (left < right) {
    const middle = (left + right) >>> 1
    const block = blocks[middle]
    let comparison = compareBlockObject(block, actorIds, actor, counter)
    if (comparison === 0 && key !== null && block.lastKey !== undefined) {
      comparison = compareUtf8(block.lastKey, key)
      if (comparison === 0 && idCtr !== undefined) {
        if (block.lastIdCtr < idCtr) comparison = -1
        if (block.lastIdCtr > idCtr) comparison = 1
        if (comparison === 0 && actorIds[block.lastIdActor] < idActor) comparison = -1
        if (comparison === 0 && actorIds[block.lastIdActor] > idActor) comparison = 1
      }
    }
    if (comparison < 0) left = middle + 1; else right = middle
  }
  return left
}

function visibleMapOpsCover(visibleMapOps, op) {
  const property = JSON.stringify([op[objActorIdx], op[objCtrIdx], op[keyStrIdx]])
  const values = visibleMapOps.changes.has(property)
    ? visibleMapOps.changes.get(property) : visibleMapOps.base.get(property)
  if (values === null || (values ? values.size : 0) !== op[predNumIdx]) return false
  for (let index = 0; index < op[predNumIdx]; index++) {
    if (!values.has(`${op[predCtrIdx][index]}@${op[predActorIdx][index]}`)) return false
  }
  return true
}

function updateVisibleMapOps(visibleMapOps, op) {
  if (op[keyStrIdx] === null) return
  const property = JSON.stringify([op[objActorIdx], op[objCtrIdx], op[keyStrIdx]])
  const current = visibleMapOps.changes.has(property)
    ? visibleMapOps.changes.get(property) : visibleMapOps.base.get(property)
  const action = ACTIONS[op[actionIdx]]
  if (current === null || !action || action === 'inc') {
    visibleMapOps.changes.set(property, null)
    return
  }
  const values = new Set(current)
  for (let index = 0; index < op[predNumIdx]; index++) {
    values.delete(`${op[predCtrIdx][index]}@${op[predActorIdx][index]}`)
  }
  if (action !== 'del') values.add(`${op[idCtrIdx]}@${op[idActorIdx]}`)
  visibleMapOps.changes.set(property, values)
}

function setMeta(docState, target, key, value) {
  if (docState.metaUndo) docState.metaUndo.push(target, key, target[key])
  target[key] = value
}

function visibleRow(row, succNum, counters) {
  if (row[insertIdx] && counters.length > 0) counters.length = 0
  const action = ACTIONS[row[actionIdx]]
  if (action === 'inc') {
    let visible = false
    for (const counter of counters) {
      if (counter.ctrs[counter.next] === row[idCtrIdx] && counter.actors[counter.next] === row[idActorIdx]) {
        counter.next++
        if (counter.next === counter.ctrs.length) visible = true
      }
    }
    return visible
  }
  if (succNum === 0) return action !== 'mark'
  if (action === 'set' && (row[valLenIdx] & 0x0f) === VALUE_TYPE.COUNTER) {
    counters.push({ctrs: row[succCtrIdx], actors: row[succActorIdx], next: 0})
  }
  return false
}

function seekWithinOperations(target, cache, actorIds, resumeInsertion) {
  const rows = cache.operations
  const {objActor, objActorNum, objCtr, keyActor, keyActorNum, keyCtr, keyStr, idActor, idCtr, insert} = target
  let index = 0

  if (objCtr !== null && !resumeInsertion) {
    while (index < rows.length) {
      const rowActor = actorIds[rows[index][objActorIdx]], rowCtr = rows[index][objCtrIdx]
      if (rowCtr === null || !rowActor || rowCtr < objCtr || (rowCtr === objCtr && rowActor < objActor)) {
        index++
      } else {
        break
      }
    }
  }

  const first = rows[index]
  if ((!first || first[objCtrIdx] !== objCtr || first[objActorIdx] !== objActorNum) && !resumeInsertion) {
    return {found: keyStr !== null || !(keyCtr !== null && keyCtr > 0 && keyActor !== null), skipCount: index, visibleCount: 0}
  }

  if (keyStr !== null) {
    const keyStart = index
    while (index < rows.length) {
      const row = rows[index]
      if (row[keyStrIdx] !== null && compareUtf8(row[keyStrIdx], keyStr) < 0 &&
          row[objCtrIdx] === objCtr && row[objActorIdx] === objActorNum) {
        index++
      } else {
        break
      }
    }
    if (target.predRows) {
      const lastIndex = rows.length - 1
      const last = rows[lastIndex]
      if (target.predRows.size === 1 && last && lastIndex >= index && last[objCtrIdx] === objCtr && last[objActorIdx] === objActorNum &&
          last[keyStrIdx] === keyStr && target.predRows.has(`${last[idCtrIdx]}@${last[idActorIdx]}`)) {
        return {found: true, skipCount: lastIndex, visibleCount: 0}
      }
      for (let predIndex = index; predIndex < rows.length; predIndex++) {
        const row = rows[predIndex]
        if (row[objCtrIdx] !== objCtr || row[objActorIdx] !== objActorNum || row[keyStrIdx] !== keyStr) break
        if (target.predRows.has(`${row[idCtrIdx]}@${row[idActorIdx]}`)) {
          return {found: true, skipCount: predIndex, visibleCount: 0}
        }
      }
      index = keyStart
    }
    return {found: true, skipCount: index, visibleCount: 0}
  }

  const hasRef = keyCtr !== null && keyCtr > 0 && keyActor !== null
  if (!insert && !hasRef) return {found: true, skipCount: index, visibleCount: 0}
  let found = insert && (resumeInsertion || !hasRef), visibleCount = 0, elemVisible = false
  const counters = []
  for (; index < rows.length; index++) {
    const row = rows[index]
    if (row[objCtrIdx] !== objCtr || row[objActorIdx] !== objActorNum) break
    const isRef = row[insertIdx] && row[idCtrIdx] === keyCtr && row[idActorIdx] === keyActorNum
    if (isRef && !insert) return {found: true, skipCount: index, visibleCount}
    if (found && row[insertIdx] && (row[idCtrIdx] < idCtr || (row[idCtrIdx] === idCtr && actorIds[row[idActorIdx]] <= idActor))) break
    if (row[insertIdx]) elemVisible = false
    if (!elemVisible && (counters.length === 0 && row[succNumIdx] === 0 && row[actionIdx] !== INC_ACTION && row[actionIdx] !== MARK_ACTION ||
        visibleRow(row, row[succNumIdx], counters))) {
      visibleCount++
      elemVisible = true
    }
    if (isRef) found = true
  }
  return {found, skipCount: index, visibleCount}
}

/**
 * Scans a block of document operations, encoded as columns `docCols`, to find the position at which
 * an operation (or sequence of operations) `ops` should be applied. `actorIds` is the array that
 * maps actor numbers to hexadecimal actor IDs. `resumeInsertion` is true if we're performing a list
 * insertion and we already found the reference element in a previous block, but we reached the end
 * of that previous block while scanning for the actual insertion position, and so we're continuing
 * the scan in a subsequent block.
 *
 * Returns an object with keys:
 * - `found`: false if we were scanning for a reference element in a list but couldn't find it;
 *    true otherwise.
 * - `skipCount`: the number of operations, counted from the start of the block, after which the
 *   new operations should be inserted or applied.
 * - `visibleCount`: if modifying a list object, the number of visible (i.e. non-deleted) list
 *   elements that precede the position where the new operations should be applied.
 */
function seekWithinBlock(ops, docCols, actorIds, resumeInsertion) {
  const cached = docCols[OPERATIONS]
  if (cached) return seekWithinOperations(ops, cached, actorIds, resumeInsertion)
  for (let col of docCols) col.decoder.reset()
  const { objActor, objActorNum, objCtr, keyActor, keyCtr, keyStr, idActor, idCtr, insert } = ops
  const [objActorD, objCtrD, /* keyActorD */, /* keyCtrD */, keyStrD, idActorD, idCtrD, insertD, actionD,
    /* valLenD */, /* valRawD */, /* chldActorD */, /* chldCtrD */, succNumD] = docCols.map(col => col.decoder)
  let skipCount = 0, nextObjActor = null, nextObjCtr = null, nextKeyStr = null

  // Seek to the beginning of the object being updated
  if (objCtr !== null && !resumeInsertion) {
    while (!objCtrD.done || !objActorD.done || !actionD.done) {
      nextObjCtr = objCtrD.readValue()
      nextObjActor = actorIds[objActorD.readValue()]
      actionD.skipValues(1)
      if (nextObjCtr === null || !nextObjActor || nextObjCtr < objCtr ||
          (nextObjCtr === objCtr && nextObjActor < objActor)) {
        skipCount += 1
      } else {
        break
      }
    }
  }
  if ((nextObjCtr !== objCtr || nextObjActor !== objActor) && !resumeInsertion) {
    return {found: keyStr !== null || !(keyCtr !== null && keyCtr > 0 && keyActor !== null), skipCount, visibleCount: 0}
  }

  // Seek to the appropriate key (if string key is used)
  if (keyStr !== null) {
    keyStrD.skipValues(skipCount)
    while (!keyStrD.done) {
      const objActorIndex = objActorD.readValue()
      nextObjActor = objActorIndex === null ? null : actorIds[objActorIndex]
      nextObjCtr = objCtrD.readValue()
      nextKeyStr = keyStrD.readValue()
      if (nextKeyStr !== null && compareUtf8(nextKeyStr, keyStr) < 0 &&
          nextObjCtr === objCtr && nextObjActor === objActor) {
        skipCount += 1
      } else {
        break
      }
    }
    if (ops.predIds && nextKeyStr === keyStr && nextObjCtr === objCtr && nextObjActor === objActor) {
      const keyStart = skipCount
      for (const decoder of [objActorD, objCtrD, keyStrD, idActorD, idCtrD]) {
        decoder.reset()
        decoder.skipValues(skipCount)
      }
      while (!idCtrD.done) {
        nextObjActor = actorIds[objActorD.readValue()]
        nextObjCtr = objCtrD.readValue()
        nextKeyStr = keyStrD.readValue()
        const nextIdActor = actorIds[idActorD.readValue()], nextIdCtr = idCtrD.readValue()
        if (nextObjCtr !== objCtr || nextObjActor !== objActor || nextKeyStr !== keyStr) break
        if (ops.predIds.has(`${nextIdCtr}@${nextIdActor}`)) {
          return {found: true, skipCount, visibleCount: 0}
        }
        skipCount++
      }
      skipCount = keyStart
    }
    return {found: true, skipCount, visibleCount: 0}
  }

  // If we are inserting into a list, an opId key is used, and we need to seek to a position *after*
  // the referenced operation. Moreover, we need to skip over any existing operations with a greater
  // opId than the new insertion, for CRDT convergence on concurrent insertions in the same place.
  const hasRef = keyCtr !== null && keyCtr > 0 && keyActor !== null
  if (!insert && !hasRef) return {found: true, skipCount, visibleCount: 0}
  for (const decoder of [objActorD, objCtrD, idActorD, idCtrD, insertD, actionD, succNumD]) {
    decoder.reset()
    decoder.skipValues(skipCount)
  }
  let found = insert && (resumeInsertion || !hasRef), visibleCount = 0, elemVisible = false
  while (!idCtrD.done) {
    const rowObjActor = objActorD.readValue(), rowObjCtr = objCtrD.readValue()
    const rowIdActor = actorIds[idActorD.readValue()], rowIdCtr = idCtrD.readValue()
    const rowInsert = insertD.readValue(), rowAction = actionD.readValue(), rowSuccNum = succNumD.readValue()
    if (rowObjCtr !== objCtr || rowObjActor !== objActorNum) break
    const isRef = rowInsert && rowIdCtr === keyCtr && rowIdActor === keyActor
    // If we are updating an existing list element, seek to just before the referenced ID
    if (isRef && !insert) return {found: true, skipCount, visibleCount}
    // Skip over any list elements with greater ID than the new one, and any non-insertions
    if (found && rowInsert && (rowIdCtr < idCtr || (rowIdCtr === idCtr && rowIdActor <= idActor))) break
    skipCount++
    if (rowInsert) elemVisible = false
    if (!elemVisible) {
      const action = ACTIONS[rowAction]
      if (action === 'inc') return seekWithinOperations(ops, columnOperationCache(docCols), actorIds, resumeInsertion)
      if (rowSuccNum === 0 && action !== 'mark') {
        visibleCount++
        elemVisible = true
      }
    }
    // If insertion is not at the head, search for the reference element
    if (isRef) found = true
  }
  return {found, skipCount, visibleCount}
}

/**
 * Returns the number of list elements that should be added to a list index when skipping over the
 * block with index `blockIndex` in the list object with object ID consisting of actor number
 * `objActorNum` and counter `objCtr`.
 */
function visibleListElements(docState, blockIndex, objActorNum, objCtr) {
  const thisBlock = docState.blocks[blockIndex]
  const nextBlock = docState.blocks[blockIndex + 1]

  if (thisBlock.lastObjectActor !== objActorNum || thisBlock.lastObjectCtr !== objCtr ||
      thisBlock.numVisible === undefined) {
    return 0

    // If a list element is split across the block boundary, don't double-count it
  } else if (thisBlock.lastVisibleActor === nextBlock.firstVisibleActor &&
             thisBlock.lastVisibleActor !== undefined &&
             thisBlock.lastVisibleCtr === nextBlock.firstVisibleCtr &&
             thisBlock.lastVisibleCtr !== undefined) {
    return thisBlock.numVisible - 1
  } else {
    return thisBlock.numVisible
  }
}

function referenceNotFound({keyCtr, keyActor, insert}) {
  return Object.assign(new RangeError(`Reference element not found: ${keyCtr}@${keyActor}`), insert && {panic: 'assertion failed: self.entry.is_empty()'})
}

/**
 * Scans the blocks of document operations to find the position where a new operation should be
 * inserted. Returns an object with keys:
 * - `blockIndex`: the index of the block into which we should insert the new operation
 * - `skipCount`: the number of operations, counted from the start of the block, after which the
 *   new operations should be inserted or merged.
 * - `visibleCount`: if modifying a list object, the number of visible (i.e. non-deleted) list
 *   elements that precede the position where the new operations should be applied.
 */
function seekToOp(docState, ops, startBlockIndex) {
  const { objActor, objActorNum, objCtr, keyActor, keyCtr, keyStr } = ops
  // Skip any blocks that contain only objects with lower objectIds
  let blockIndex = startBlockIndex === undefined
    ? findBlock(docState.blocks, docState.actorIds, objActor, objCtr, keyStr) : startBlockIndex
  let totalVisible = 0

  if (keyStr !== null) {
    // String key is used. First skip any blocks that contain only lower keys
    // When we have a candidate block, decode it to find the exact insertion position
    const {skipCount} = seekWithinBlock(ops, docState.blocks[blockIndex].columns, docState.actorIds, false)
    return {blockIndex, skipCount, visibleCount: 0}

  } else {
    // List operation
    const insertAtHead = keyCtr === null || keyCtr === 0 || keyActor === null
    const keyActorNum = keyActor === null ? null : docState.actorIndexById.get(keyActor)
    let resumeInsertion = false

    while (true) {
      // Search for the reference element, skipping any blocks whose Bloom filter does not contain
      // the reference element. We only do this if not inserting at the head (in which case there is
      // no reference element), or if we already found the reference element in an earlier block (in
      // which case we have resumeInsertion === true). The latter case arises with concurrent
      // insertions at the same position, and so we have to scan beyond the reference element to
      // find the actual insertion position, and that further scan crosses a block boundary.
      if (!insertAtHead && !resumeInsertion) {
        while (blockIndex < docState.blocks.length - 1 &&
               docState.blocks[blockIndex].lastObjectActor === objActorNum &&
               docState.blocks[blockIndex].lastObjectCtr === objCtr &&
               !bloomFilterContains(docState.blocks[blockIndex].bloom, keyActorNum, keyCtr)) {
          // If we reach the end of the list object without a Bloom filter hit, the reference element
          // doesn't exist
          if (docState.blocks[blockIndex].lastObjectCtr > objCtr) {
            if (ops.insert) throw referenceNotFound(ops)
            return null
          }

          // Add up number of visible list elements in any blocks we skip, for list index computation
          totalVisible += visibleListElements(docState, blockIndex, objActorNum, objCtr)
          blockIndex++
        }
      }

      // We have a candidate block. Decode it to see whether it really contains the reference element
      const {found, skipCount, visibleCount} = seekWithinBlock(ops,
                                                               docState.blocks[blockIndex].columns,
                                                               docState.actorIds,
                                                               resumeInsertion)

      if (blockIndex === docState.blocks.length - 1 ||
          docState.blocks[blockIndex].lastObjectActor !== objActorNum ||
          docState.blocks[blockIndex].lastObjectCtr !== objCtr) {
        // Last block: if we haven't found the reference element by now, it's an error
        if (found) {
          return {blockIndex, skipCount, visibleCount: totalVisible + visibleCount}
        } else if (ops.insert) {
          throw referenceNotFound(ops)
        } else {
          return null
        }

      } else if (found && skipCount < docState.blocks[blockIndex].numOps) {
        // The insertion position lies within the current block
        return {blockIndex, skipCount, visibleCount: totalVisible + visibleCount}
      }

      // Reference element not found and there are still blocks left ==> it was probably a false positive.
      // Reference element found, but we skipped all the way to the end of the block ==> we need to
      // continue scanning the next block to find the actual insertion position.
      // Either way, go back round the loop again to skip blocks until the next Bloom filter hit.
      resumeInsertion = found && ops.insert
      totalVisible += visibleListElements(docState, blockIndex, objActorNum, objCtr)
      blockIndex++
    }
  }
}

/**
 * Updates Bloom filter `bloom`, given as a Uint8Array, to contain the list element ID consisting of
 * counter `elemIdCtr` and actor number `elemIdActor`. We don't actually bother computing a hash
 * function, since those two integers serve perfectly fine as input. We turn the two integers into a
 * sequence of probe indexes using the triple hashing algorithm from the following paper:
 *
 * Peter C. Dillinger and Panagiotis Manolios. Bloom Filters in Probabilistic Verification.
 * 5th International Conference on Formal Methods in Computer-Aided Design (FMCAD), November 2004.
 * http://www.ccis.northeastern.edu/home/pete/pub/bloom-filters-verification.pdf
 */
function bloomFilterAdd(bloom, elemIdActor, elemIdCtr) {
  let modulo = 8 * bloom.byteLength, x = elemIdCtr % modulo, y = elemIdActor % modulo

  // Use one step of FNV-1a to compute a third value from the two inputs.
  // Taken from http://www.isthe.com/chongo/tech/comp/fnv/index.html
  // The prime is just over 2^24, so elemIdCtr can be up to about 2^29 = 500 million before the
  // result of the multiplication exceeds 2^53. And even if it does exceed 2^53 and loses precision,
  // that shouldn't be a problem as it should still be deterministic, and the Bloom filter
  // computation only needs to be internally consistent within this library.
  let z = ((elemIdCtr ^ elemIdActor) * 16777619 >>> 0) % modulo

  for (let i = 0; i < BLOOM_NUM_PROBES; i++) {
    bloom[x >>> 3] |= 1 << (x & 7)
    x += y
    if (x >= modulo) x -= modulo
    y += z
    if (y >= modulo) y -= modulo
  }
}

/**
 * Returns true if the list element ID consisting of counter `elemIdCtr` and actor number
 * `elemIdActor` is likely to be contained in the Bloom filter `bloom`.
 */
function bloomFilterContains(bloom, elemIdActor, elemIdCtr) {
  let modulo = 8 * bloom.byteLength, x = elemIdCtr % modulo, y = elemIdActor % modulo
  let z = ((elemIdCtr ^ elemIdActor) * 16777619 >>> 0) % modulo

  // See comments in the bloomFilterAdd function for an explanation
  for (let i = 0; i < BLOOM_NUM_PROBES; i++) {
    if ((bloom[x >>> 3] & (1 << (x & 7))) === 0) {
      return false
    }
    x += y
    if (x >= modulo) x -= modulo
    y += z
    if (y >= modulo) y -= modulo
  }
  return true
}

/**
 * Reads the relevant columns of a block of operations and updates that block to contain the
 * metadata we need to efficiently figure out where to insert new operations.
 */
function updateBlockMetadata(block, visibleMapOps) {
  resetBlockMetadata(block)
  const cached = block.columns[OPERATIONS], counters = []
  if (cached) {
    for (const op of cached.operations) addOperationMetadata(block, op, visibleMapOps, counters)
    return
  }

  for (let col of block.columns) col.decoder.reset()
  const [objActorD, objCtrD, keyActorD, keyCtrD, keyStrD, idActorD, idCtrD, insertD, actionD,
    /* valLenD */, /* valRawD */, /* chldActorD */, /* chldCtrD */, succNumD] = block.columns.map(col => col.decoder)
  const op = []
  while (!idCtrD.done) {
    op[objActorIdx] = objActorD.readValue()
    op[objCtrIdx] = objCtrD.readValue()
    op[keyActorIdx] = keyActorD.readValue()
    op[keyCtrIdx] = keyCtrD.readValue()
    op[keyStrIdx] = keyStrD.readValue()
    op[idActorIdx] = idActorD.readValue()
    op[idCtrIdx] = idCtrD.readValue()
    op[insertIdx] = insertD.readValue()
    op[actionIdx] = actionD.readValue()
    op[succNumIdx] = succNumD.readValue()
    if (op[keyStrIdx] === null && ACTIONS[op[actionIdx]] === 'inc') {
      columnOperationCache(block.columns)
      return updateBlockMetadata(block, visibleMapOps)
    }
    addOperationMetadata(block, op, visibleMapOps, counters)
  }
}

function resetBlockMetadata(block) {
  block.bloom = new Uint8Array(BLOOM_FILTER_SIZE)
  block.numOps = 0
  block.lastKey = undefined
  block.numVisible = undefined
  block.lastObjectActor = undefined
  block.lastObjectCtr = undefined
  block.firstVisibleActor = undefined
  block.firstVisibleCtr = undefined
  block.lastVisibleActor = undefined
  block.lastVisibleCtr = undefined
  block.lastIdActor = undefined
  block.lastIdCtr = undefined
  block.hasListOps = false
}

function addOperationMetadata(block, op, visibleMapOps, counters) {
  block.numOps += 1
  const objActor = op[objActorIdx], objCtr = op[objCtrIdx]
  const keyActor = op[keyActorIdx], keyCtr = op[keyCtrIdx], keyStr = op[keyStrIdx]
  const idActor = op[idActorIdx], idCtr = op[idCtrIdx]
  const insert = op[insertIdx], action = op[actionIdx], succNum = op[succNumIdx]
  block.lastIdActor = idActor
  block.lastIdCtr = idCtr

  if (block.lastObjectActor !== objActor || block.lastObjectCtr !== objCtr) {
    block.numVisible = 0
    block.lastObjectActor = objActor
    block.lastObjectCtr = objCtr
  }

  if (keyStr !== null) {
    if (visibleMapOps) {
      const property = JSON.stringify([objActor, objCtr, keyStr])
      const actionName = ACTIONS[action]
      if (!actionName || actionName === 'inc') {
        visibleMapOps.set(property, null)
      } else if (succNum === 0 && visibleMapOps.get(property) !== null) {
        let values = visibleMapOps.get(property)
        if (!values) {
          values = new Set()
          visibleMapOps.set(property, values)
        }
        values.add(`${idCtr}@${idActor}`)
      }
    }
    // Map key: for each object, record the highest key contained in the block
    block.lastKey = keyStr
  } else if (insert || keyCtr !== null) {
    block.hasListOps = true
    // List element
    block.lastKey = undefined
    const elemIdActor = insert ? idActor : keyActor
    const elemIdCtr = insert ? idCtr : keyCtr
    bloomFilterAdd(block.bloom, elemIdActor, elemIdCtr)

    // If the list element is visible, update the block metadata accordingly
    if (visibleRow(op, succNum, counters)) {
      if (block.firstVisibleActor === undefined) block.firstVisibleActor = elemIdActor
      if (block.firstVisibleCtr === undefined) block.firstVisibleCtr = elemIdCtr
      if (block.lastVisibleActor !== elemIdActor || block.lastVisibleCtr !== elemIdCtr) {
        block.numVisible += 1
        block.lastVisibleActor = elemIdActor
        block.lastVisibleCtr = elemIdCtr
      }
    }
  }
}

/**
 * Updates a block's metadata based on an operation being added to a block.
 */
function addBlockOperation(block, op, actorIds, isChangeOp) {
  block.lastIdActor = op[idActorIdx]
  block.lastIdCtr = op[idCtrIdx]
  if (op[keyStrIdx] !== null) {
    // TODO this comparison should use UTF-8 encoding, not JavaScript's UTF-16
    if (block.lastObjectCtr === op[objCtrIdx] && block.lastObjectActor === op[objActorIdx] &&
        (block.lastKey === undefined || compareUtf8(block.lastKey, op[keyStrIdx]) < 0)) {
      block.lastKey = op[keyStrIdx]
    }
  } else {
    block.hasListOps = true
    // List element
    const elemIdActor = op[insertIdx] ? op[idActorIdx] : op[keyActorIdx]
    const elemIdCtr = op[insertIdx] ? op[idCtrIdx] : op[keyCtrIdx]
    bloomFilterAdd(block.bloom, elemIdActor, elemIdCtr)

    // Set lastVisible on the assumption that this is the last op in the block; if there are further
    // ops after this one in the block, lastVisible will be overwritten again later.
    if ((op[succNumIdx] === 0 || isChangeOp) && ACTIONS[op[actionIdx]] !== 'mark') {
      if (block.firstVisibleActor === undefined) block.firstVisibleActor = elemIdActor
      if (block.firstVisibleCtr === undefined) block.firstVisibleCtr = elemIdCtr
      block.lastVisibleActor = elemIdActor
      block.lastVisibleCtr = elemIdCtr
    }
  }

  // Keep track of the largest objectId contained within a block
  if (block.lastObjectCtr === undefined ||
      op[objActorIdx] !== null && op[objCtrIdx] !== null &&
      (block.lastObjectCtr === null || block.lastObjectCtr < op[objCtrIdx] ||
       (block.lastObjectCtr === op[objCtrIdx] && actorIds[block.lastObjectActor] < actorIds[op[objActorIdx]]))) {
    block.lastObjectActor = op[objActorIdx]
    block.lastObjectCtr = op[objCtrIdx]
    block.lastKey = (op[keyStrIdx] !== null ? op[keyStrIdx] : undefined)
    block.numVisible = 0
  }
}

/**
 * Takes a block containing too many operations, and splits it into a sequence of adjacent blocks of
 * roughly equal size.
 */
function splitBlock(block, maxBlockSize, operations, encode) {
  // Make each of the resulting blocks between 50% and 80% full (leaving a bit of space in each
  // block so that it doesn't get split again right away the next time an operation is added).
  // The upper bound cannot be lower than 75% since otherwise we would end up with a block less than
  // 50% full when going from two to three blocks.
  const numBlocks = Math.ceil(block.numOps / (0.8 * maxBlockSize))
  let blocks = [], opsSoFar = 0
  let keyStrD, insertD, row = 0
  if (!operations) {
    for (let col of block.columns) col.decoder.reset()
    keyStrD = decoderByColumnId(block.columns[keyStrIdx].columnId, block.columns[keyStrIdx].decoder.buf)
    insertD = decoderByColumnId(block.columns[insertIdx].columnId, block.columns[insertIdx].decoder.buf)
  }
  function continuesElement(index) {
    if (operations) return operations[index][keyStrIdx] === null && !operations[index][insertIdx]
    keyStrD.skipValues(index - row)
    insertD.skipValues(index - row)
    row = index + 1
    const keyStr = keyStrD.readValue(), insert = insertD.readValue()
    return keyStr === null && !insert
  }

  for (let i = 1; i <= numBlocks; i++) {
    let end = Math.ceil(i * block.numOps / numBlocks)
    if (end <= opsSoFar) continue
    while (end < block.numOps && continuesElement(end)) end++
    const opsToCopy = end - opsSoFar
    let columns
    if (operations && encode) {
      columns = operationColumns(block.columns, operations.slice(opsSoFar, opsSoFar + opsToCopy))
    } else if (operations) {
      columns = columnsFromOperations(block.columns, operations.slice(opsSoFar, opsSoFar + opsToCopy))
      columnDataForColumns(columns)
    } else {
      const encoders = columnEncoders(block.columns)
      copyColumns(encoders, block.columns, opsToCopy)
      columns = columnDecoders(encoders)
    }
    const newBlock = {columns}
    updateBlockMetadata(newBlock)
    blocks.push(newBlock)
    opsSoFar += opsToCopy
  }
  return blocks
}

/**
 * Takes an array of blocks and concatenates the corresponding columns across all of the blocks.
 */
/**
 * Rewrites the values of every actor-index column in `columns` (a list of
 * `{columnId, encoder}` objects) through the `remap` table, leaving other
 * columns untouched. Used when the actor table is sorted at save time.
 */
function remapActorColumns(columns, remap) {
  return columns.map(column => {
    if ((column.columnId & 7) !== COLUMN_TYPE.ACTOR_ID) return column
    const input = column.encoder.buffer
    const output = new Uint8Array(input.byteLength * Math.max(1, Math.ceil(Math.log2(remap.length) / 7)))
    let i = 0, o = 0
    while (i < input.byteLength) {
      let count = 0, scale = 1, byte
      do {
        byte = input[i++]
        output[o++] = byte
        count += (byte & 0x7f) * scale
        scale *= 128
      } while (byte & 0x80)
      if (byte & 0x40) count -= scale
      if (count === 0) {
        do {
          byte = input[i++]
          output[o++] = byte
        } while (byte & 0x80)
      }
      for (let values = count > 0 ? 1 : -count; values > 0; values--) {
        let value = 0
        scale = 1
        do {
          byte = input[i++]
          value += (byte & 0x7f) * scale
          scale *= 128
        } while (byte & 0x80)
        value = remap[value]
        while (value >= 128) {
          output[o++] = (value & 0x7f) | 0x80
          value >>>= 7
        }
        output[o++] = value
      }
    }
    return {columnId: column.columnId, encoder: {buffer: output.subarray(0, o)}}
  })
}

function encoderState(encoder) {
  return {state: Object.assign(Object.create(Object.getPrototypeOf(encoder)), encoder), literalLength: encoder.literal && encoder.literal.length}
}

function resumeColumn(encoder, {state, literalLength}, buffer) {
  for (const key of Object.keys(encoder)) {
    if (key !== 'buf' && key !== 'offset' && key !== 'literal' && key !== 'count' && encoder[key] !== state[key]) return null
  }
  if (encoder.state === 'nulls' && (encoder.offset === 0) !== (state.offset === 0)) return null
  const tail = buffer.subarray(state.offset), count = encoder.count === undefined ? 0 : encoder.count - state.count
  if (tail.byteLength === 0) return encoder.offset === 0 && state.offset === 0 ? {bytes: tail, headerShift: 0, count} : null
  if (encoder.state === 'literal' || encoder.state === 'loneValue') {
    if (encoder.state === 'literal') {
      if (encoder.literal.length !== literalLength) return null
      for (let i = 0; i < literalLength; i++) if (encoder.literal[i] !== state.literal[i]) return null
    }
    return {bytes: tail, headerShift: 0, count: 0}
  }
  if (count === 0) return {bytes: tail, headerShift: 0, count}
  const decoder = new Decoder(tail), header = new Encoder()
  if (encoder.state === 'nulls') {
    decoder.readInt53()
    header.appendInt53(0)
    header.appendUint53(decoder.readUint53() + count)
  } else if (encoder.state === 'repetition') {
    header.appendInt53(decoder.readInt53() + count)
  } else {
    header.appendUint53(decoder.readUint53() + count)
  }
  return {bytes: concatBuffers([header.buf.subarray(0, header.offset), tail.subarray(decoder.offset)]), headerShift: header.offset - decoder.offset, count}
}

function concatBlocks(blocks, previous) {
  const columnIds = blocks[0].columns.map(column => column.columnId).join()
  const reuse = previous && previous.columnIds === columnIds
  let first = 0, last = 0
  if (reuse) {
    const limit = Math.min(blocks.length, previous.columns.length)
    while (first < limit && blocks[first].columns === previous.columns[first]) first++
    while (last < limit - first &&
      blocks[blocks.length - 1 - last].columns === previous.columns[previous.columns.length - 1 - last]) last++
  }
  const shift = reuse ? blocks.length - previous.columns.length : 0
  const snapshots = reuse ? previous.snapshots.filter(([index]) => index <= first) : []
  const start = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null
  const encoders = start
    ? start[1].map(({state, literalLength}, index) => {
      const encoder = Object.assign(Object.create(Object.getPrototypeOf(state)), state)
      encoder.buf = new Uint8Array(Math.max(16, previous.buffers[index].byteLength))
      encoder.buf.set(previous.buffers[index].subarray(0, state.offset))
      if (literalLength !== undefined) encoder.literal = state.literal.slice(0, literalLength)
      return {columnId: blocks[0].columns[index].columnId, encoder}
    })
    : columnEncoders(blocks[0].columns)
  const oldSnapshots = reuse ? new Map(previous.snapshots) : null
  let tail = null

  for (let blockIndex = start ? start[0] : 0; blockIndex < blocks.length; blockIndex++) {
    const old = blockIndex >= blocks.length - last && oldSnapshots.get(blockIndex - shift)
    if (old) {
      const resumed = []
      for (let index = 0; index < encoders.length; index++) {
        const column = resumeColumn(encoders[index].encoder, old[index], previous.buffers[index])
        if (!column) break
        resumed.push(column)
      }
      if (resumed.length === encoders.length) {
        tail = {blockIndex, old, resumed}
        break
      }
    }
    if (blockIndex > (start ? start[0] : 0) && blockIndex % CONCAT_SNAPSHOT_INTERVAL === 0) {
      snapshots.push([blockIndex, encoders.map(({encoder}) => encoderState(encoder))])
    }
    const block = blocks[blockIndex]
    if (Object.getPrototypeOf(block.columns[0]) === DATA_COLUMN && !COLUMN_DATA.has(block.columns)) {
      let encoded = ENCODED_COLUMNS.get(block.columns)
      if (!encoded) {
        const blockEncoders = columnEncoders(block.columns)
        appendOperations(blockEncoders, block.columns[OPERATIONS].operations)
        encoded = columnDecoders(blockEncoders)
        ENCODED_COLUMNS.set(block.columns, encoded)
      }
      appendBlock(encoders, encoded, block.numOps)
    } else if (block.columns.every(column => column.columnData)) {
      for (let index = 0; index < block.columns.length; index++) {
        appendColumnData(encoders[index].encoder, block.columns[index])
      }
    } else {
      appendBlock(encoders, block.columns, block.numOps)
    }
  }
  let buffers
  if (tail) {
    buffers = encoders.map(({encoder}, index) =>
      concatBuffers([encoder.buf.subarray(0, encoder.offset), tail.resumed[index].bytes]))
    for (const [index, states] of previous.snapshots) {
      if (index + shift < tail.blockIndex) continue
      snapshots.push([index + shift, states.map(({state, literalLength}, column) => {
        const from = tail.old[column].state, {headerShift, count} = tail.resumed[column]
        const offset = encoders[column].encoder.offset
        const pending = state.offset === from.offset
        const moved = Object.assign(Object.create(Object.getPrototypeOf(state)), state,
          {offset: pending ? offset : state.offset - from.offset + offset + headerShift})
        if (pending && count !== 0) moved.count += count
        return {state: moved, literalLength}
      })])
    }
  } else {
    buffers = encoders.map(column => column.encoder.buffer)
  }
  return {
    encoders: encoders.map(({columnId}, index) => ({columnId, encoder: {buffer: buffers[index]}})),
    cache: {columnIds, columns: blocks.map(block => block.columns), snapshots, buffers}
  }
}

function appendBlock(encoders, columns, numOps) {
  const tails = COLUMN_TAILS.get(columns)
  let same = tails !== undefined && columns.length === encoders.length
  for (let index = 0; same && index < columns.length; index++) same = columns[index].columnId === encoders[index].columnId
  if (!same) {
    for (const column of columns) column.decoder.reset()
    return copyColumns(encoders, columns, numOps)
  }
  for (let index = 0; index < columns.length; index++) {
    const {columnId, decoder} = columns[index], {encoder} = encoders[index], tail = tails[index], type = columnId & 7
    if (type === COLUMN_TYPE.VALUE_RAW) {
      encoder.appendRawBytes(decoder.buf)
    } else if (type === COLUMN_TYPE.BOOLEAN) {
      appendBooleanColumn(encoder, decoder, tail)
    } else if (tail.offset === 0 && tail.absoluteValue === undefined) {
      if (tail.state !== 'literal') encoder._appendValue(tail.lastValue, tail.count)
      else appendLiteral(encoder, tail.literal)
    } else {
      appendColumn(encoder, decoder, tail)
    }
  }
}

function appendLiteral(encoder, values) {
  if (values[0] === encoder.lastValue) {
    for (const value of values) encoder._appendValue(value)
    return
  }
  if (encoder.state === 'literal') {
    encoder.literal.push(encoder.lastValue)
  } else if (encoder.state === 'loneValue') {
    encoder.literal = [encoder.lastValue]
  } else {
    encoder.flush()
    encoder.literal = []
  }
  encoder.literal.push(...values)
  encoder.lastValue = encoder.literal.pop()
  encoder.state = 'literal'
}

function appendColumn(encoder, decoder, tail) {
  const buf = decoder.buf, delta = tail.absoluteValue !== undefined
  let pending = delta
  decoder.offset = 0
  while (decoder.offset < tail.offset) {
    const start = decoder.offset, header = decoder.readInt53()
    const first = header === 0 ? null : decoder.readRawValue()
    if (!pending && first !== encoder.lastValue && !(header < 0 && (encoder.state === 'literal' || encoder.state === 'loneValue'))) {
      if (encoder.state === 'literal') encoder.literal.push(encoder.lastValue)
      encoder.flush()
      encoder.appendRawBytes(buf.subarray(start, tail.offset))
      encoder.state = tail.state
      encoder.lastValue = tail.lastValue
      encoder.count = tail.count
      encoder.literal = tail.state === 'literal' ? tail.literal.slice(0, -1) : []
      if (delta) encoder.absoluteValue = tail.absoluteValue
      return
    }
    if (header === 0) {
      encoder._appendValue(null, decoder.readUint53())
    } else {
      pending = appendRun(encoder, first, header > 0 ? header : 1, pending)
      for (let i = header + 1; i < 0; i++) pending = appendRun(encoder, decoder.readRawValue(), 1, pending)
    }
  }
  if (tail.state === 'literal' && !pending) {
    appendLiteral(encoder, tail.literal)
  } else if (tail.state === 'literal') {
    for (const value of tail.literal) pending = appendRun(encoder, value, 1, pending)
  } else {
    pending = appendRun(encoder, tail.lastValue, tail.count, pending)
  }
  if (delta && !pending) encoder.absoluteValue = tail.absoluteValue
}

function appendRun(encoder, value, count, pending) {
  if (pending && value !== null && count > 0) {
    encoder._appendValue(value - encoder.absoluteValue)
    encoder._appendValue(value, count - 1)
    return false
  }
  encoder._appendValue(value, count)
  return pending
}

function appendBooleanColumn(encoder, decoder, tail) {
  if (tail.offset === 0) return encoder.appendValue(tail.lastValue, tail.count)
  decoder.offset = 0
  let value = false, count = decoder.readUint53()
  if (count === 0) {
    value = true
    count = decoder.readUint53()
  }
  if (decoder.offset > tail.offset) return encoder.appendValue(tail.lastValue, tail.count)
  encoder.appendValue(value, count)
  encoder.appendUint53(encoder.count)
  encoder.appendRawBytes(decoder.buf.subarray(decoder.offset, tail.offset))
  encoder.lastValue = tail.lastValue
  encoder.count = tail.count
}

function appendColumnData(encoder, column) {
  const type = column.columnId & 7
  for (const slab of column.columnData.slabs) {
    if (type === COLUMN_TYPE.VALUE_RAW) {
      encoder.appendRawBytes(slab.data)
    } else if (slab.data.byteLength === 0 && type !== COLUMN_TYPE.BOOLEAN) {
      encoder.appendValue(null, slab.rows)
    } else {
      encoder.copyFrom(decoderByColumnId(column.columnId, slab.data), {count: slab.rows})
    }
  }
}

/**
 * Copies `count` rows from the set of input columns `inCols` to the set of output columns
 * `outCols`. The input columns are given as an array of `{columnId, decoder}` objects, and the
 * output columns are given as an array of `{columnId, encoder}` objects. Both are sorted in
 * increasing order of columnId. If there is no matching input column for a given output column, it
 * is filled in with `count` blank values (according to the column type).
 */
function copyColumns(outCols, inCols, count) {
  if (count === 0) return
  let inIndex = 0, lastGroup = -1, lastCardinality = 0, valueColumn = -1, valueBytes = 0
  for (let outCol of outCols) {
    while (inIndex < inCols.length && inCols[inIndex].columnId < outCol.columnId) inIndex++
    let inCol = null
    if (inIndex < inCols.length && inCols[inIndex].columnId === outCol.columnId &&
        inCols[inIndex].decoder.buf.byteLength > 0) {
      inCol = inCols[inIndex].decoder
    }
    const colCount = (outCol.columnId >> 4 === lastGroup) ? lastCardinality : count

    if (outCol.columnId % 8 === COLUMN_TYPE.GROUP_CARD) {
      lastGroup = outCol.columnId >> 4
      if (inCol) {
        lastCardinality = outCol.encoder.copyFrom(inCol, {count, sumValues: true}).sum
      } else {
        outCol.encoder.appendValue(0, count)
        lastCardinality = 0
      }
    } else if (outCol.columnId % 8 === COLUMN_TYPE.VALUE_LEN) {
      if (inCol) {
        if (inIndex + 1 === inCols.length || inCols[inIndex + 1].columnId !== outCol.columnId + 1) {
          throw new RangeError('VALUE_LEN column without accompanying VALUE_RAW column')
        }
        valueColumn = outCol.columnId + 1
        valueBytes = outCol.encoder.copyFrom(inCol, {count: colCount, sumValues: true, sumShift: 4}).sum
      } else {
        outCol.encoder.appendValue(null, colCount)
        valueColumn = outCol.columnId + 1
        valueBytes = 0
      }
    } else if (outCol.columnId % 8 === COLUMN_TYPE.VALUE_RAW) {
      if (outCol.columnId !== valueColumn) {
        throw new RangeError('VALUE_RAW column without accompanying VALUE_LEN column')
      }
      if (valueBytes > 0) {
        outCol.encoder.appendRawBytes(inCol.readRawBytes(valueBytes))
      }
    } else { // ACTOR_ID, INT_RLE, INT_DELTA, BOOLEAN, or STRING_RLE
      if (inCol) {
        outCol.encoder.copyFrom(inCol, {count: colCount})
      } else {
        outCol.encoder.appendValue(blankValue(outCol.columnId), colCount)
      }
    }
  }
}

/**
 * Parses one operation from a set of columns. The argument `columns` contains a list of objects
 * with `columnId` and `decoder` properties. Returns an array in which the i'th element is the
 * value read from the i'th column in `columns`. Does not interpret datatypes; the only
 * interpretation of values is that if `actorTable` is given, a value `v` in a column of type
 * ACTOR_ID is replaced with `actorTable[v]`.
 */
function readOperation(columns, actorTable) {
  let operation = [], colValue, lastGroup = -1, lastCardinality = 0, valueColumn = -1, valueBytes = 0
  for (let col of columns) {
    if (col.columnId % 8 === COLUMN_TYPE.VALUE_RAW) {
      if (col.columnId !== valueColumn) throw new RangeError('unexpected VALUE_RAW column')
      colValue = col.decoder.readRawBytes(valueBytes)
    } else if (col.columnId % 8 === COLUMN_TYPE.GROUP_CARD) {
      lastGroup = col.columnId >> 4
      lastCardinality = col.decoder.readValue() || 0
      colValue = lastCardinality
    } else if (col.columnId >> 4 === lastGroup) {
      colValue = []
      if (col.columnId % 8 === COLUMN_TYPE.VALUE_LEN) {
        valueColumn = col.columnId + 1
        valueBytes = 0
      }
      for (let i = 0; i < lastCardinality; i++) {
        let value = col.decoder.readValue()
        if (col.columnId % 8 === COLUMN_TYPE.ACTOR_ID && actorTable && typeof value === 'number') {
          value = actorTable[value]
        }
        if (col.columnId % 8 === COLUMN_TYPE.VALUE_LEN) {
          valueBytes += value >>> 4
        }
        colValue.push(value)
      }
    } else {
      colValue = col.decoder.readValue()
      if (col.columnId % 8 === COLUMN_TYPE.ACTOR_ID && actorTable && typeof colValue === 'number') {
        colValue = actorTable[colValue]
      }
      if (col.columnId % 8 === COLUMN_TYPE.VALUE_LEN) {
        valueColumn = col.columnId + 1
        valueBytes = colValue >>> 4
      }
    }

    operation.push(colValue)
  }
  return operation
}

function blankValue(columnId) {
  if (columnId % 8 === COLUMN_TYPE.BOOLEAN) return false
  if (columnId % 8 === COLUMN_TYPE.VALUE_LEN) return 0
  return null
}

function mapOperation(outCols, inCols, operation) {
  let inIndex = 0, lastGroup = -1, lastCardinality = 0
  const output = []
  for (const outCol of outCols) {
    while (inIndex < inCols.length && inCols[inIndex].columnId < outCol.columnId) inIndex++
    if (inIndex < inCols.length && inCols[inIndex].columnId === outCol.columnId) {
      const value = operation[inIndex]
      if (outCol.columnId % 8 === COLUMN_TYPE.GROUP_CARD) {
        lastGroup = outCol.columnId >> 4
        lastCardinality = value
      }
      output.push(value)
    } else if (outCol.columnId % 8 === COLUMN_TYPE.GROUP_CARD) {
      lastGroup = outCol.columnId >> 4
      lastCardinality = 0
      output.push(0)
    } else if (outCol.columnId % 8 === COLUMN_TYPE.VALUE_RAW) {
      output.push(new Uint8Array(0))
    } else if (outCol.columnId >> 4 === lastGroup) {
      output.push(new Array(lastCardinality).fill(blankValue(outCol.columnId)))
    } else {
      output.push(blankValue(outCol.columnId))
    }
  }
  return output
}

/**
 * Appends `operation`, in the form returned by `readOperation()`, to the columns in `outCols`. The
 * argument `inCols` provides metadata about the types of columns in `operation`; the value
 * `operation[i]` comes from the column `inCols[i]`.
 */
function appendOperation(outCols, inCols, operation) {
  let inIndex = 0, lastGroup = -1, lastCardinality = 0
  for (let outCol of outCols) {
    while (inIndex < inCols.length && inCols[inIndex].columnId < outCol.columnId) inIndex++

    if (inIndex < inCols.length && inCols[inIndex].columnId === outCol.columnId) {
      const colValue = operation[inIndex]
      if (outCol.columnId % 8 === COLUMN_TYPE.GROUP_CARD) {
        lastGroup = outCol.columnId >> 4
        lastCardinality = colValue
        outCol.encoder.appendValue(colValue)
      } else if (outCol.columnId % 8 === COLUMN_TYPE.VALUE_RAW) {
        if (colValue) outCol.encoder.appendRawBytes(colValue)
      } else if (outCol.columnId >> 4 === lastGroup) {
        if (!Array.isArray(colValue) || colValue.length !== lastCardinality) {
          throw new RangeError('bad group value')
        }
        for (let v of colValue) outCol.encoder.appendValue(v)
      } else {
        outCol.encoder.appendValue(colValue)
      }
    } else if (outCol.columnId % 8 === COLUMN_TYPE.GROUP_CARD) {
      lastGroup = outCol.columnId >> 4
      lastCardinality = 0
      outCol.encoder.appendValue(0)
    } else if (outCol.columnId % 8 !== COLUMN_TYPE.VALUE_RAW) {
      const count = (outCol.columnId >> 4 === lastGroup) ? lastCardinality : 1
      outCol.encoder.appendValue(blankValue(outCol.columnId), count)
    }
  }
}

/**
 * Parses the next operation from block `blockIndex` of the document. Returns an object of the form
 * `{docOp, blockIndex}` where `docOp` is an operation in the form returned by `readOperation()`,
 * and `blockIndex` is the block number to use on the next call (it moves on to the next block when
 * we reach the end of the current block). `docOp` is null if there are no more operations.
 */
function readNextDocOp(docState, blockIndex) {
  let row = docState.readBlockIndex === blockIndex ? docState.readRow : 0
  while (blockIndex < docState.blocks.length) {
    const operations = columnOperationCache(docState.blocks[blockIndex].columns).operations
    if (row < operations.length) {
      docState.readBlockIndex = blockIndex
      docState.readRow = row + 1
      return {docOp: operations[row].map(value => (Array.isArray(value) ? value.slice() : value)), blockIndex}
    }
    if (blockIndex === docState.blocks.length - 1) return {docOp: null, blockIndex}
    blockIndex += 1
    row = 0
  }
  return {docOp: null, blockIndex: docState.blocks.length - 1}
}

/**
 * Parses the next operation from a sequence of changes. `changeState` serves as the state of this
 * pseudo-iterator, and it is mutated to reflect the new operation. In particular,
 * `changeState.nextOp` is set to the operation that was read, and `changeState.done` is set to true
 * when we have finished reading the last operation in the last change.
 */
function readNextChangeOp(docState, changeState) {
  // If we've finished reading one change, move to the next change that contains at least one op
  while (changeState.changeIndex < changeState.changes.length - 1 &&
         (!changeState.columns || changeState.columns[actionIdx].decoder.done)) {
    changeState.changeIndex += 1
    const change = changeState.changes[changeState.changeIndex]
    changeState.columns = makeDecoders(change.columns, CHANGE_COLUMNS)
    changeState.opCtr = change.startOp

    // If it's an empty change (no ops), set its maxOp here since it won't be set below
    if (changeState.columns[actionIdx].decoder.done) {
      change.maxOp = change.startOp - 1
    }

    // Update docState based on the information in the change
    updateBlockColumns(docState, changeState.columns)
    const {actorIds, actorTable} = getActorTable(docState.actorIds, docState.actorIndexById, change)
    docState.actorIds = actorIds
    changeState.actorTable = actorTable
    changeState.actorIndex = docState.actorIndexById.get(change.actorIds[0])
  }

  // Reached the end of the last change?
  if (changeState.columns[actionIdx].decoder.done) {
    changeState.done = true
    changeState.nextOp = null
    return
  }

  changeState.nextOp = readOperation(changeState.columns, changeState.actorTable)
  changeState.nextOp[idActorIdx] = changeState.actorIndex
  changeState.nextOp[idCtrIdx] = changeState.opCtr
  changeState.changes[changeState.changeIndex].maxOp = changeState.opCtr
  if (changeState.opCtr > docState.maxOp) docState.maxOp = changeState.opCtr
  changeState.opCtr += 1

  const op = changeState.nextOp
  if (op[actionIdx] === INC_ACTION || op[actionIdx] === SET_ACTION && (op[valLenIdx] & 0x0f) === VALUE_TYPE.COUNTER) docState.counters = true
  if ((op[objCtrIdx] === null && op[objActorIdx] !== null) ||
      (op[objCtrIdx] !== null && op[objActorIdx] === null)) {
    throw new RangeError(`Mismatched object reference: (${op[objCtrIdx]}, ${op[objActorIdx]})`)
  }
  if ((op[keyCtrIdx] === null && op[keyActorIdx] !== null) ||
      (op[keyCtrIdx] === 0    && op[keyActorIdx] !== null) ||
      (op[keyCtrIdx] >   0    && op[keyActorIdx] === null)) {
    throw new RangeError(`Mismatched operation key: (${op[keyCtrIdx]}, ${op[keyActorIdx]})`)
  }
}

function emptyObjectPatch(objectId, type) {
  if (type === 'list' || type === 'text') {
    return {objectId, type, edits: []}
  } else {
    return {objectId, type, props: {}}
  }
}

/**
 * Returns true if the two given operation IDs have the same actor ID, and the counter of `id2` is
 * exactly `delta` greater than the counter of `id1`.
 */
function opIdDelta(id1, id2, delta = 1) {
  const at1 = id1.indexOf('@'), at2 = id2.indexOf('@')
  return id1.slice(at1) === id2.slice(at2) && Number(id1.slice(0, at1)) + delta === Number(id2.slice(0, at2))
}

/**
 * Appends a list edit operation (insert, update, remove) to an array of existing operations. If the
 * last existing operation can be extended (as a multi-op), we do that.
 */
function appendEdit(existingEdits, nextEdit) {
  if (existingEdits.length === 0) {
    existingEdits.push(nextEdit)
    return
  }

  let lastEdit = existingEdits[existingEdits.length - 1]
  if (lastEdit.action === 'insert' && nextEdit.action === 'insert' &&
      lastEdit.index === nextEdit.index - 1 &&
      lastEdit.value.type === 'value' && nextEdit.value.type === 'value' &&
      lastEdit.elemId === lastEdit.opId && nextEdit.elemId === nextEdit.opId &&
      opIdDelta(lastEdit.elemId, nextEdit.elemId, 1) &&
      lastEdit.value.datatype === nextEdit.value.datatype &&
      typeof lastEdit.value.value === typeof nextEdit.value.value) {
    lastEdit.action = 'multi-insert'
    if (nextEdit.value.datatype) lastEdit.datatype = nextEdit.value.datatype
    lastEdit.values = [lastEdit.value.value, nextEdit.value.value]
    delete lastEdit.value
    delete lastEdit.opId

  } else if (lastEdit.action === 'multi-insert' && nextEdit.action === 'insert' &&
             lastEdit.index + lastEdit.values.length === nextEdit.index &&
             nextEdit.value.type === 'value' && nextEdit.elemId === nextEdit.opId &&
             opIdDelta(lastEdit.elemId, nextEdit.elemId, lastEdit.values.length) &&
             lastEdit.datatype === nextEdit.value.datatype &&
             typeof lastEdit.values[0] === typeof nextEdit.value.value) {
    lastEdit.values.push(nextEdit.value.value)

  } else if (lastEdit.action === 'remove' && nextEdit.action === 'remove' &&
             lastEdit.index === nextEdit.index) {
    lastEdit.count += nextEdit.count

  } else {
    existingEdits.push(nextEdit)
  }
}

/**
 * `edits` is an array of (SingleInsertEdit | MultiInsertEdit | UpdateEdit | RemoveEdit) list edits
 * for a patch. This function appends an UpdateEdit to this array. A conflict is represented by
 * having several consecutive edits with the same index, and this can be realised by calling
 * `appendUpdate` several times for the same list element. On the first such call, `firstUpdate`
 * must be true.
 *
 * It is possible that coincidentally the previous edit (potentially arising from a different
 * change) is for the same index. If this is the case, to avoid accidentally treating consecutive
 * updates for the same index as a conflict, we remove the previous edit for the same index. This is
 * safe because the previous edit is overwritten by the new edit being appended, and we know that
 * it's for the same list elements because there are no intervening insertions/deletions that could
 * have changed the indexes.
 */
function appendUpdate(edits, index, elemId, opId, value, firstUpdate) {
  let insert = false
  if (firstUpdate) {
    // Pop all edits for the same index off the end of the edits array. This sequence may begin with
    // either an insert or an update. If it's an insert, we remember that fact, and use it below.
    while (!insert && edits.length > 0) {
      const lastEdit = edits[edits.length - 1]
      if ((lastEdit.action === 'insert' || lastEdit.action === 'update') && lastEdit.index === index) {
        edits.pop()
        insert = (lastEdit.action === 'insert')
      } else if (lastEdit.action === 'multi-insert' && lastEdit.index + lastEdit.values.length - 1 === index) {
        lastEdit.values.pop()
        insert = true
      } else {
        break
      }
    }
  }

  // If we popped an insert edit off the edits array, we need to turn the new update into an insert
  // in order to ensure the list element still gets inserted (just with a new value).
  if (insert) {
    appendEdit(edits, {action: 'insert', index, elemId, opId, value})
  } else {
    appendEdit(edits, {action: 'update', index, opId, value})
  }
}

/**
 * `edits` is an array of (SingleInsertEdit | MultiInsertEdit | UpdateEdit | RemoveEdit) list edits
 * for a patch. We assume that there is a suffix of this array that consists of an insertion at
 * position `index`, followed by zero or more UpdateEdits at the same index. This function rewrites
 * that suffix to be all updates instead. This is needed because sometimes when generating a patch
 * we think we are performing a list insertion, but then it later turns out that there was already
 * an existing value at that list element, and so we actually need to do an update, not an insert.
 *
 * If the suffix is preceded by one or more updates at the same index, those earlier updates are
 * removed by `appendUpdate()` to ensure we don't inadvertently treat them as part of the same
 * conflict.
 */
function convertInsertToUpdate(edits, index, elemId) {
  let updates = []
  while (edits.length > 0) {
    let lastEdit = edits[edits.length - 1]
    if (lastEdit.action === 'insert') {
      if (lastEdit.index !== index) throw new RangeError('last edit has unexpected index')
      updates.unshift(edits.pop())
      break
    } else if (lastEdit.action === 'update') {
      if (lastEdit.index !== index) throw new RangeError('last edit has unexpected index')
      updates.unshift(edits.pop())
    } else {
      // It's impossible to encounter a remove edit here because the state machine in
      // updatePatchProperty() ensures that a property can have either an insert or a remove edit,
      // but not both. It's impossible to encounter a multi-insert here because multi-inserts always
      // have equal elemId and opId (i.e. they can only be used for the operation that first inserts
      // an element, but not for any subsequent assignments to that list element); moreover,
      // convertInsertToUpdate is only called if an insert action is followed by a non-overwritten
      // document op. The fact that there is a non-overwritten document op after another op on the
      // same list element implies that the original insertion op for that list element must be
      // overwritten, and thus the original insertion op cannot have given rise to a multi-insert.
      throw new RangeError('last edit has unexpected action')
    }
  }

  // Now take the edits we popped off and push them back onto the list again
  let firstUpdate = true
  for (let update of updates) {
    appendUpdate(edits, index, elemId, update.opId, update.value, firstUpdate)
    firstUpdate = false
  }
}

/**
 * Updates `patches` to reflect the operation `op` within the document with state `docState`.
 * Can be called multiple times if there are multiple operations for the same property (e.g. due
 * to a conflict). `propState` is an object that carries over state between such successive
 * invocations for the same property. If the current object is a list, `listIndex` is the index
 * into that list (counting only visible elements). If the operation `op` was already previously
 * in the document, `oldSuccNum` is the value of `op[succNumIdx]` before the current change was
 * applied (allowing us to determine whether this operation was overwritten or deleted in the
 * current change). `oldSuccNum` must be undefined if the operation came from the current change.
 * If we are creating an incremental patch as a result of applying one or more changes, `newBlock`
 * is the block to which the operations are getting written; we will update the metadata on this
 * block. `newBlock` should be null if we are creating a patch for the whole document.
 */
function updatePatchProperty(patches, newBlock, objectId, op, docState, propState, listIndex, oldSuccNum) {
  if (ACTIONS[op[actionIdx]] === 'mark') return
  const isWholeDoc = !newBlock
  const type = op[actionIdx] < ACTIONS.length ? OBJECT_TYPE[ACTIONS[op[actionIdx]]] : null
  const opId = `${op[idCtrIdx]}@${docState.actorIds[op[idActorIdx]]}`
  const elemId = op[keyStrIdx] !== null ? op[keyStrIdx]
    : op[insertIdx] ? opId : `${op[keyCtrIdx]}@${docState.actorIds[op[keyActorIdx]]}`

  // When the change contains a new make* operation (i.e. with an even-numbered action), record the
  // new parent-child relationship in objectMeta. TODO: also handle link/move operations.
  if (op[actionIdx] % 2 === 0 && !docState.objectMeta[opId]) {
    setMeta(docState, docState.objectMeta, opId, {parentObj: objectId, parentKey: elemId, opId, type, children: {}})
    const parent = docState.objectMeta[objectId]
    if (!parent.hasChildren) setMeta(docState, parent, 'hasChildren', true)
    setMeta(docState, parent.children, elemId, Object.assign({}, parent.children[elemId], {[opId]: {objectId: opId, type, props: {}}}))
  }

  // firstOp is true if the current operation is the first of a sequence of ops for the same key
  let prop = propState.get(elemId)
  const firstOp = !prop
  if (!prop) propState.set(elemId, prop = {visibleOps: [], hasChild: false})

  // An operation is overwritten if it is a document operation that has at least one successor
  const isOverwritten = (oldSuccNum !== undefined && op[succNumIdx] > 0)

  // Record all visible values for the property, and whether it has any child object
  if (!isOverwritten) {
    prop.visibleOps.push(op)
    prop.hasChild = prop.hasChild || (op[actionIdx] % 2) === 0 // even-numbered action == make* operation
  }

  const emissions = []
  let wasVisible = oldSuccNum === 0 && ACTIONS[op[actionIdx]] !== 'inc'

  // If this operation's ID appears in the pending-successor index, some
  // earlier operation for this property is waiting to find out whether this
  // successor is an increment (which does not overwrite it) or a real
  // overwrite. A non-increment successor kills those candidates for good.
  const pendingBySucc = prop.counterStates
  if (pendingBySucc && pendingBySucc[opId] && ACTIONS[op[actionIdx]] !== 'inc') {
    for (const state of pendingBySucc[opId]) {
      state.dead = true
      delete state.succs[opId]
    }
    delete pendingBySucc[opId]
  }

  // An operation with successors may still be visible if every successor
  // turns out to be an increment: increments extend a counter rather than
  // overwriting the value. The decision is deferred until the successors
  // have been seen; successors that never appear as rows (deletions) leave
  // the operation hidden.
  if (isOverwritten && ACTIONS[op[actionIdx]] === 'set' && (op[valLenIdx] & 0x0f) === VALUE_TYPE.COUNTER) {
    if (!prop.counterStates) prop.counterStates = {}
    const counterStates = prop.counterStates
    const state = {op, opId, dead: false, value: decodeValue(op[valLenIdx], op[valRawIdx]).value, succs: {}, oldSuccNum, oldIncs: 0}
    for (let i = 0; i < op[succNumIdx]; i++) {
      const succOp = `${op[succCtrIdx][i]}@${docState.actorIds[op[succActorIdx][i]]}`
      if (!counterStates[succOp]) counterStates[succOp] = []
      counterStates[succOp].push(state)
      state.succs[succOp] = true
    }

  } else if (ACTIONS[op[actionIdx]] === 'inc') {
    // An increment operation resolves the pending states registered under
    // its ID. Increments whose counter is not visible at this property (for
    // example because it was concurrently overwritten) contribute nothing,
    // matching the Rust implementation.
    const states = pendingBySucc && pendingBySucc[opId]
    if (!states) return
    delete pendingBySucc[opId]
    const delta = decodeValue(op[valLenIdx], op[valRawIdx]).value
    for (const state of states) {
      state.value = addInt(state.value, delta)
      delete state.succs[opId]
      if (oldSuccNum !== undefined && ++state.oldIncs === state.oldSuccNum) wasVisible = true
      if (state.dead || Object.keys(state.succs).length > 0) continue
      // Every successor was an increment: the operation is visible after all
      const counter = {type: 'value', datatype: 'counter', value: state.value}
      emissions.push([state.opId, counter])
      prop.visibleOps.push(state.op)
      prop.counters = Object.assign({}, prop.counters, {[state.opId]: counter})
    }

  } else if (!isOverwritten) {
    // Add the value to the patch if it is not overwritten (i.e. if it has no succs).
    if (ACTIONS[op[actionIdx]] === 'set') {
      emissions.push([opId, Object.assign({type: 'value'}, decodeValue(op[valLenIdx], op[valRawIdx]))])
    } else if (op[actionIdx] % 2 === 0) { // even-numbered action == make* operation
      if (!patches[opId]) patches[opId] = emptyObjectPatch(opId, type)
      emissions.push([opId, patches[opId]])
    }
  }

  // If one or more of the values of the property is a child object, we update objectMeta to store
  // all of the visible values of the property (even the non-child-object values). Then, when we
  // subsequently process an update within that child object, we can construct the patch to
  // contain the conflicting values.
  const meta = docState.objectMeta[objectId]
  const prevChildren = prop.hasChild || !meta.hasChildren ? undefined : meta.children[elemId]
  if (prop.hasChild || (prevChildren && Object.keys(prevChildren).length > 0)) {
    let values = {}
    for (let visible of prop.visibleOps) {
      const opId = `${visible[idCtrIdx]}@${docState.actorIds[visible[idActorIdx]]}`
      if (prop.counters && prop.counters[opId]) {
        values[opId] = prop.counters[opId]
      } else if (ACTIONS[visible[actionIdx]] === 'set') {
        values[opId] = Object.assign({type: 'value'}, decodeValue(visible[valLenIdx], visible[valRawIdx]))
      } else if (visible[actionIdx] % 2 === 0) {
        const objType = visible[actionIdx] < ACTIONS.length ? OBJECT_TYPE[ACTIONS[visible[actionIdx]]] : null
        values[opId] = emptyObjectPatch(opId, objType)
      }
    }

    // Copy so that objectMeta is not modified if an exception is thrown while applying change
    setMeta(docState, meta.children, elemId, values)
  }

  let patchKey = emissions.length > 0 ? emissions[0][0] : undefined
  let patchValue = emissions.length > 0 ? emissions[0][1] : undefined

  if (!patches[objectId]) patches[objectId] = emptyObjectPatch(objectId, docState.objectMeta[objectId].type)
  const patch = patches[objectId]

  // Updating a list or text object (with elemId key)
  if (op[keyStrIdx] === null) {
    const countsVisible = newBlock && newBlock.lastObjectActor === op[objActorIdx] && newBlock.lastObjectCtr === op[objCtrIdx]
    // If we come across any document op that was previously non-overwritten/non-deleted, that
    // means the current list element already had a value before this change was applied, and
    // therefore the current element cannot be an insert. If we already registered an insert, we
    // have to convert it into an update.
    if (wasVisible && !isWholeDoc && prop.action === 'insert') {
      prop.action = 'update'
      convertInsertToUpdate(patch.edits, listIndex, elemId)
      if (countsVisible) newBlock.numVisible -= 1
    }

    if (patchValue) {
      // If the op has a non-overwritten value and it came from the change, it's an insert.
      // (It's not necessarily the case that op[insertIdx] is true: if a list element is concurrently
      // deleted and updated, the node that first processes the deletion and then the update will
      // observe the update as a re-insertion of the deleted list element.)
      if (!prop.action && (oldSuccNum === undefined || isWholeDoc)) {
        prop.action = 'insert'
        appendEdit(patch.edits, {action: 'insert', index: listIndex, elemId, opId: patchKey, value: patchValue})
        if (countsVisible) newBlock.numVisible += 1

      // If the property has a value and it's not an insert, then it must be an update.
      // We might have previously registered it as a remove, in which case we convert it to update.
      } else if (prop.action === 'remove') {
        let lastEdit = patch.edits[patch.edits.length - 1]
        if (lastEdit.action !== 'remove') throw new RangeError('last edit has unexpected type')
        if (lastEdit.count > 1) lastEdit.count -= 1; else patch.edits.pop()
        prop.action = 'update'
        appendUpdate(patch.edits, listIndex, elemId, patchKey, patchValue, true)
        if (countsVisible) newBlock.numVisible += 1

      } else {
        // A 'normal' update
        appendUpdate(patch.edits, listIndex, elemId, patchKey, patchValue, !prop.action)
        if (!prop.action) prop.action = 'update'
      }

      // Any further values that became visible at the same time (multiple
      // operations resolved by one increment) are additional conflict values
      for (let i = 1; i < emissions.length; i++) {
        appendUpdate(patch.edits, listIndex, elemId, emissions[i][0], emissions[i][1], false)
      }

    } else if (wasVisible && !prop.action) {
      // If the property used to have a non-overwritten/non-deleted value, but no longer, it's a remove
      prop.action = 'remove'
      appendEdit(patch.edits, {action: 'remove', index: listIndex, count: 1})
      if (countsVisible) newBlock.numVisible -= 1
    }

  } else if (patchValue || !isWholeDoc) {
    // Updating a map or table (with string key)
    if (firstOp || !patch.props[op[keyStrIdx]]) patch.props[op[keyStrIdx]] = {}
    for (const [key, value] of emissions) patch.props[op[keyStrIdx]][key] = value
  }
}

/**
 * Applies operations (from one or more changes) to the document by merging the sequence of change
 * ops into the sequence of document ops. The two inputs are `changeState` and `docState`
 * respectively. Assumes that the decoders of both sets of columns are at the position where we want
 * to start merging. `patches` is mutated to reflect the effect of the change operations. `ops` is
 * the operation sequence to apply (as decoded by `groupRelatedOps()`). `docState` is as
 * documented in `applyOps()`. If the operations are updating a list or text object, `listIndex`
 * is the number of visible elements that precede the position at which we start merging.
 * `blockIndex` is the document block number from which we are currently reading.
 */
function mergeDocChangeOps(patches, newBlock, outOps, changeState, docState, listIndex, blockIndex) {
  const firstOp = changeState.nextOp, insert = firstOp[insertIdx]
  const objActor = firstOp[objActorIdx], objCtr = firstOp[objCtrIdx]
  const objectId = objActor === null ? '_root' : `${objCtr}@${docState.actorIds[objActor]}`
  const idActorIndex = changeState.actorIndex, idActor = docState.actorIds[idActorIndex]
  let foundListElem = false, elemVisible = false, propState = new Map(), docOp
  const counters = []
  ;({ docOp, blockIndex } = readNextDocOp(docState, blockIndex))
  let docOpsConsumed = (docOp === null ? 0 : 1)
  let docOpOldSuccNum = (docOp === null ? 0 : docOp[succNumIdx])
  let changeOp = null, changeOps = [], changeCols = [], predSeen = [], lastChangeKey = null
  changeState.objectIds.add(objectId)

  // Merge the two inputs: the sequence of ops in the doc, and the sequence of ops in the change.
  // At each iteration, we either output the doc's op (possibly updated based on the change's ops)
  // or output an op from the change.
  while (true) {
    // The array `changeOps` contains operations from the change(s) we're applying. When the array
    // is empty, we load changes from the change. Typically we load only a single operation at a
    // time, with two exceptions: 1. all operations that update the same key or list element in the
    // same object are put into changeOps at the same time (this is needed so that we can update the
    // succ columns of the document ops correctly); 2. a run of consecutive insertions is also
    // placed into changeOps in one go.
    //
    // When we have processed all the ops in changeOps we try to see whether there are further
    // operations that we can also process while we're at it. Those operations must be for the same
    // object, they must be for a key or list element that appears later in the document, they must
    // either all be insertions or all be non-insertions, and if insertions, they must be
    // consecutive. If these conditions are satisfied, that means the operations can be processed in
    // the same pass. If we encounter an operation that does not meet these conditions, we leave
    // changeOps empty, and this function returns after having processed any remaining document ops.
    //
    // Any operations that could not be processed in a single pass remain in changeState; applyOps
    // will seek to the appropriate position and then call mergeDocChangeOps again.
    if (changeOps.length === 0) {
      foundListElem = false

      let nextOp = changeState.nextOp
      while (!changeState.done && nextOp[idActorIdx] === idActorIndex && nextOp[insertIdx] === insert &&
             nextOp[objActorIdx] === firstOp[objActorIdx] && nextOp[objCtrIdx] === firstOp[objCtrIdx]) {

        // Check if the operation's pred references a previous operation in changeOps
        const lastOp = (changeOps.length > 0) ? changeOps[changeOps.length - 1] : null
        let isOverwrite = false
        for (let i = 0; i < nextOp[predNumIdx]; i++) {
          for (let prevOp of changeOps) {
            if (nextOp[predActorIdx][i] === prevOp[idActorIdx] && nextOp[predCtrIdx][i] === prevOp[idCtrIdx]) {
              isOverwrite = true
            }
          }
        }

        // If any of the following `if` statements is true, we add `nextOp` to `changeOps`. If they
        // are all false, we break out of the loop and stop adding to `changeOps`.
        if (nextOp === firstOp) {
          // First change operation in a mergeDocChangeOps call is always used
        } else if (insert && lastOp !== null && nextOp[keyStrIdx] === null &&
                   nextOp[keyActorIdx] === lastOp[idActorIdx] &&
                   nextOp[keyCtrIdx] === lastOp[idCtrIdx]) {
          // Collect consecutive insertions
        } else if (!insert && lastOp !== null && nextOp[keyStrIdx] !== null &&
                   nextOp[keyStrIdx] === lastOp[keyStrIdx] && !isOverwrite && !docState.predSeek) {
          // Collect several updates to the same key
        } else if (!insert && lastOp !== null &&
                   nextOp[keyStrIdx] === null && lastOp[keyStrIdx] === null &&
                   nextOp[keyActorIdx] === lastOp[keyActorIdx] &&
                   nextOp[keyCtrIdx] === lastOp[keyCtrIdx] && !isOverwrite) {
          // Collect several updates to the same list element
        } else if (!insert && lastOp === null && nextOp[keyStrIdx] === null &&
                   docOp && docOp[insertIdx] && docOp[keyStrIdx] === null &&
                   docOp[idActorIdx] === nextOp[keyActorIdx] &&
                   docOp[idCtrIdx] === nextOp[keyCtrIdx]) {
          // When updating/deleting list elements, keep going if the next elemId in the change
          // equals the next elemId in the doc (i.e. we're updating several consecutive elements)
        } else if (!insert && lastOp === null && nextOp[keyStrIdx] !== null &&
                   lastChangeKey !== null && compareUtf8(lastChangeKey, nextOp[keyStrIdx]) < 0 &&
                   !(docOp && docOp[objActorIdx] === firstOp[objActorIdx] &&
                     docOp[objCtrIdx] === firstOp[objCtrIdx] && docOp[keyStrIdx] === lastChangeKey)) {
          // Allow a single mergeDocChangeOps call to process changes to several keys in the same
          // object, provided that they appear in ascending order. However, if the document still
          // has unprocessed operations for the key we just finished (for example a concurrent
          // value with a higher opId than a deletion we just applied), we must not move on to the
          // next key yet: those operations have to pass through updatePatchProperty first, so
          // that the patch reflects any values that remain visible for that key.
        } else break

        lastChangeKey = (nextOp !== null) ? nextOp[keyStrIdx] : null
        updateVisibleMapOps(docState.visibleMapOps, changeState.nextOp)
        if (ACTIONS[nextOp[actionIdx]] === 'mark' && docState.objectsWithMarks) docState.objectsWithMarks.add(objectId)
        changeOps.push(changeState.nextOp)
        changeCols.push(changeState.columns)
        predSeen.push(new Array(changeState.nextOp[predNumIdx]))
        readNextChangeOp(docState, changeState)
        nextOp = changeState.nextOp
      }
    }

    if (changeOps.length > 0) changeOp = changeOps[0]
    const inCorrectObject = docOp && docOp[objActorIdx] === changeOp[objActorIdx] && docOp[objCtrIdx] === changeOp[objCtrIdx]
    const keyMatches      = docOp && docOp[keyStrIdx] !== null && docOp[keyStrIdx] === changeOp[keyStrIdx]
    const listElemMatches = docOp && docOp[keyStrIdx] === null && changeOp[keyStrIdx] === null &&
      ((!docOp[insertIdx] && docOp[keyActorIdx] === changeOp[keyActorIdx] && docOp[keyCtrIdx] === changeOp[keyCtrIdx]) ||
        (docOp[insertIdx] && docOp[idActorIdx]  === changeOp[keyActorIdx] && docOp[idCtrIdx]  === changeOp[keyCtrIdx]))

    // We keep going until we run out of ops in the change, except that even when we run out, we
    // keep going until we have processed all doc ops for the current key/list element.
    if (changeOps.length === 0 && !(inCorrectObject && (keyMatches || listElemMatches))) break

    let takeDocOp = false, takeChangeOps = 0

    // The change operations come first if we are inserting list elements (seekToOp already
    // determines the correct insertion position), if there is no document operation, if the next
    // document operation is for a different object, or if the change op's string key is
    // lexicographically first (TODO check ordering of keys beyond the basic multilingual plane).
    if (insert || !inCorrectObject ||
        (docOp[keyStrIdx] === null && changeOp[keyStrIdx] !== null) ||
        (docOp[keyStrIdx] !== null && changeOp[keyStrIdx] !== null &&
         compareUtf8(changeOp[keyStrIdx], docOp[keyStrIdx]) < 0)) {
      // Take the operations from the change
      takeChangeOps = changeOps.length
      if (!inCorrectObject && !foundListElem && changeOp[keyStrIdx] === null && !changeOp[insertIdx]) {
        // This can happen if we first update one list element, then another one earlier in the
        // list. That is not allowed: list element updates must occur in ascending order.
        throw new RangeError("could not find list element with ID: " +
                             `${changeOp[keyCtrIdx]}@${docState.actorIds[changeOp[keyActorIdx]]}`)
      }

    } else if (keyMatches || listElemMatches || foundListElem) {
      // The doc operation is for the same key or list element in the same object as the change
      // ops, so we merge them. First, if any of the change ops' `pred` matches the opId of the
      // document operation, we update the document operation's `succ` accordingly.
      for (let opIndex = 0; opIndex < changeOps.length; opIndex++) {
        const op = changeOps[opIndex]
        for (let i = 0; i < op[predNumIdx]; i++) {
          if (!predSeen[opIndex][i] && op[predActorIdx][i] === docOp[idActorIdx] && op[predCtrIdx][i] === docOp[idCtrIdx]) {
            // Insert into the doc op's succ list such that the lists remains sorted
            let j = 0
            while (j < docOp[succNumIdx] && (docOp[succCtrIdx][j] < op[idCtrIdx] ||
                   docOp[succCtrIdx][j] === op[idCtrIdx] && docState.actorIds[docOp[succActorIdx][j]] < idActor)) j++
            docOp[succCtrIdx].splice(j, 0, op[idCtrIdx])
            docOp[succActorIdx].splice(j, 0, idActorIndex)
            docOp[succNumIdx]++
            predSeen[opIndex][i] = true
            break
          }
        }
      }

      if (listElemMatches) foundListElem = true

      if (foundListElem && !listElemMatches) {
        // If the previous docOp was for the correct list element, and the current docOp is for
        // the wrong list element, then place the current changeOp before the docOp.
        takeChangeOps = changeOps.length

      } else if (changeOps.length === 0 || docOp[idCtrIdx] < changeOp[idCtrIdx] ||
          (docOp[idCtrIdx] === changeOp[idCtrIdx] && docState.actorIds[docOp[idActorIdx]] < idActor)) {
        // When we have several operations for the same object and the same key, we want to keep
        // them sorted in ascending order by opId. Here we have docOp with a lower opId, so we
        // output it first.
        takeDocOp = true
        // If this is the insertion of the next list element and the previous element remained
        // visible (e.g. a deletion was outweighed by a concurrent update), advance the list index
        // before generating the patch, the same way documentPatch() does
        if (docOp[insertIdx] && elemVisible) {
          elemVisible = false
          listIndex++
        }
        updatePatchProperty(patches, newBlock, objectId, docOp, docState, propState, listIndex, docOpOldSuccNum)

        // A deletion op in the change is represented in the document only by its entries in the
        // succ list of the operations it overwrites; it has no separate row in the set of ops.
        for (let i = changeOps.length - 1; i >= 0; i--) {
          let deleted = true
          for (let j = 0; j < changeOps[i][predNumIdx]; j++) {
            if (!predSeen[i][j]) deleted = false
          }
          if (ACTIONS[changeOps[i][actionIdx]] === 'del' && deleted) {
            changeOps.splice(i, 1)
            changeCols.splice(i, 1)
            predSeen.splice(i, 1)
          }
        }

      } else if (docOp[idCtrIdx] === changeOp[idCtrIdx] && docState.actorIds[docOp[idActorIdx]] === idActor) {
        throw new RangeError(`duplicate operation ID: ${changeOp[idCtrIdx]}@${idActor}`)
      } else {
        // The changeOp has the lower opId, so we output it first.
        takeChangeOps = 1
      }
    } else {
      // The document operation comes first if its string key is lexicographically first, or if
      // we're using opId keys and the keys don't match (i.e. we scan the document until we find a
      // matching key).
      takeDocOp = true
    }

    if (takeDocOp) {
      outOps.push(docOp)
      addBlockOperation(newBlock, docOp, docState.actorIds, false)

      if (docOp[insertIdx] && elemVisible) {
        elemVisible = false
        listIndex++
      }
      if (!elemVisible && docOp[keyStrIdx] === null && visibleRow(docOp, docOp[succNumIdx], counters)) elemVisible = true
      newBlock.numOps++
      ;({ docOp, blockIndex } = readNextDocOp(docState, blockIndex))
      if (docOp !== null) {
        docOpsConsumed++
        docOpOldSuccNum = docOp[succNumIdx]
      }
    }

    if (takeChangeOps > 0) {
      for (let i = 0; i < takeChangeOps; i++) {
        let op = changeOps[i]
        // Check that we've seen all ops mentioned in `pred` (they must all have lower opIds than
        // the change op's own opId, so we must have seen them already)
        for (let j = 0; j < op[predNumIdx]; j++) {
          if (!predSeen[i][j]) {
            throw new RangeError(`no matching operation for pred: ${op[predCtrIdx][j]}@${docState.actorIds[op[predActorIdx][j]]}`)
          }
        }
        outOps.push(mapOperation(docState.blocks[blockIndex].columns, changeCols[i], op))
        addBlockOperation(newBlock, op, docState.actorIds, true)
        updatePatchProperty(patches, newBlock, objectId, op, docState, propState, listIndex)

        if (ACTIONS[op[actionIdx]] === 'mark') {
          elemVisible = false
        } else if (op[insertIdx]) {
          elemVisible = false
          listIndex++
        } else if (op[keyStrIdx] === null && visibleRow(op, 0, counters)) {
          elemVisible = true
        }
      }

      changeOps.splice(0, takeChangeOps)
      changeCols.splice(0, takeChangeOps)
      predSeen.splice(0, takeChangeOps)
      newBlock.numOps += takeChangeOps
    }
  }

  if (docOp) {
    outOps.push(docOp)
    newBlock.numOps++
    addBlockOperation(newBlock, docOp, docState.actorIds, false)
  }
  return {docOpsConsumed, blockIndex}
}

/**
 * Applies operations from the change (or series of changes) in `changeState` to the document
 * `docState`. Passing `changeState` to `readNextChangeOp` allows iterating over the change ops.
 * `docState` is an object with keys:
 *   - `actorIds` is an array of actorIds (as hex strings) occurring in the document (values in
 *     the document's objActor/keyActor/idActor/... columns are indexes into this array).
 *   - `blocks` is an array of all the blocks of operations in the document.
 *   - `objectMeta` is a map from objectId to metadata about that object.
 *
 * `docState` is mutated to contain the updated document state.
 * `patches` is a patch object that is mutated to reflect the operations applied by this function.
 */
function applyOps(patches, changeState, docState) {
  const [objActorNum, objCtr, keyActorNum, keyCtr, keyStr, idActorNum, idCtr, insert] = changeState.nextOp
  const objActor = objActorNum === null ? null : docState.actorIds[objActorNum]
  const keyActor = keyActorNum === null ? null : docState.actorIds[keyActorNum]
  const ops = {
    objActor, objActorNum, objCtr, keyActor, keyActorNum, keyCtr, keyStr,
    idActor: docState.actorIds[idActorNum], idCtr, insert,
    objId: objActor === null ? '_root' : `${objCtr}@${objActor}`
  }

  let startBlockIndex, predIds, predRows
  if (keyStr !== null && changeState.nextOp[predNumIdx] > 0 &&
      visibleMapOpsCover(docState.visibleMapOps, changeState.nextOp)) {
    predIds = new Set()
    predRows = new Set()
    for (let index = 0; index < changeState.nextOp[predNumIdx]; index++) {
      const predActor = docState.actorIds[changeState.nextOp[predActorIdx][index]]
      const predCtr = changeState.nextOp[predCtrIdx][index]
      predIds.add(`${predCtr}@${predActor}`)
      predRows.add(`${predCtr}@${changeState.nextOp[predActorIdx][index]}`)
      const predBlockIndex = findBlock(
        docState.blocks, docState.actorIds, objActor, objCtr, keyStr, predActor, predCtr)
      if (startBlockIndex === undefined || predBlockIndex < startBlockIndex) {
        startBlockIndex = predBlockIndex
      }
    }
  }
  ops.predIds = predIds
  ops.predRows = predRows
  docState.predSeek = predRows !== undefined
  const position = seekToOp(docState, ops, startBlockIndex)
  if (!position) {
    readNextChangeOp(docState, changeState)
    return
  }
  const {blockIndex, skipCount, visibleCount} = position
  const block = docState.blocks[blockIndex]
  const firstWrite = keyStr !== null && !block.hasListOps && changeState.nextOp[predNumIdx] === 0 && changeState.changes.length === 1
  docState.readBlockIndex = blockIndex
  docState.readRow = skipCount

  const resetFirstVisible = (skipCount === 0) || (block.firstVisibleActor === undefined) ||
    (!insert && block.firstVisibleActor === keyActorNum && block.firstVisibleCtr === keyCtr)
  const newBlock = {
    columns: undefined,
    bloom: new Uint8Array(block.bloom),
    numOps: skipCount,
    lastKey: block.lastKey,
    numVisible: block.numVisible,
    lastObjectActor: block.lastObjectActor,
    lastObjectCtr: block.lastObjectCtr,
    firstVisibleActor: resetFirstVisible ? undefined : block.firstVisibleActor,
    firstVisibleCtr: resetFirstVisible ? undefined : block.firstVisibleCtr,
    lastVisibleActor: undefined,
    lastVisibleCtr: undefined,
    lastIdActor: block.lastIdActor,
    lastIdCtr: block.lastIdCtr,
    hasListOps: block.hasListOps
  }

  // Copy the operations up to the insertion position (the first skipCount operations)
  const outOps = columnOperationCache(block.columns).operations.slice(0, skipCount)

  // Apply the operations from the change. This may cause blockIndex to move forwards if the
  // property being updated straddles a block boundary.
  const {blockIndex: lastBlockIndex, docOpsConsumed} =
    mergeDocChangeOps(patches, newBlock, outOps, changeState, docState, visibleCount, blockIndex)

  // Copy the remaining operations after the insertion position
  const lastBlock = docState.blocks[lastBlockIndex]
  let copyAfterMerge = 0 - skipCount - docOpsConsumed
  for (let i = blockIndex; i <= lastBlockIndex; i++) copyAfterMerge += docState.blocks[i].numOps
  const suffixStart = lastBlock.numOps - copyAfterMerge
  const lastOperations = columnOperationCache(lastBlock.columns).operations
  for (let index = suffixStart; index < lastOperations.length; index++) outOps.push(lastOperations[index])
  newBlock.numOps += copyAfterMerge
  if (copyAfterMerge > 0 && lastBlock.hasListOps) newBlock.hasListOps = true

  const maxBlockSize = keyStr === null || newBlock.hasListOps ? MAX_BLOCK_SIZE : MAX_MAP_BLOCK_SIZE
  const fits = blockIndex === lastBlockIndex && newBlock.numOps <= maxBlockSize
  const encode = firstWrite || outOps.length - skipCount - copyAfterMerge > MAX_SPLICE_OPS
  if (fits && encode) {
    newBlock.columns = operationColumns(block.columns, outOps)
  } else if (fits) {
    newBlock.columns = spliceColumns(
      block.columns, skipCount, suffixStart, outOps.slice(skipCount, outOps.length - copyAfterMerge), outOps)
  } else {
    newBlock.columns = block.columns
  }

  if (fits) {
    // The result is just one output block
    if (copyAfterMerge > 0 && block.lastVisibleActor !== undefined && block.lastVisibleCtr !== undefined) {
      // It's possible that none of the ops after the merge point are visible, in which case the
      // lastVisible may not be strictly correct, because it may refer to an operation before the
      // merge point rather than a list element inserted by the current change. However, this doesn't
      // matter, because the only purpose for which we need it is to check whether one block ends with
      // the same visible element as the next block starts with (to avoid double-counting its index);
      // if the last list element of a block is invisible, the exact value of lastVisible doesn't
      // matter since it will be different from the next block's firstVisible in any case.
      newBlock.lastVisibleActor = block.lastVisibleActor
      newBlock.lastVisibleCtr = block.lastVisibleCtr
    }
    if (copyAfterMerge > 0) {
      newBlock.lastIdActor = block.lastIdActor
      newBlock.lastIdCtr = block.lastIdCtr
    }

    docState.blocks[blockIndex] = newBlock

  } else {
    // Oversized output block must be split into smaller blocks
    docState.blocks.splice(blockIndex, lastBlockIndex - blockIndex + 1, ...splitBlock(newBlock, maxBlockSize, outOps, encode))
  }
}

/**
 * Updates the columns in a document's operation blocks to contain all the columns in a change
 * (including any column types we don't recognise, which have been generated by a future version
 * of Automerge).
 */
function updateBlockColumns(docState, changeCols) {
  // Check that the columns of a change appear at the index at which we expect them to be
  for (let index = 0; index <= predCtrIdx; index++) {
    if (changeCols[index].columnId !== CHANGE_COLUMNS[index].columnId) throw new RangeError('unexpected columnId')
  }

  // Check if there any columns in the change that are not in the document, apart from pred*
  const docCols = docState.blocks[0].columns
  if (hasNewColumns(docCols, changeCols)) {
    let allCols = docCols.map(docCol => ({columnId: docCol.columnId}))
    for (let changeCol of changeCols) {
      const { columnId } = changeCol
      if (!PRED_COLUMN_IDS.includes(columnId) && !docCols.find(docCol => docCol.columnId === columnId)) {
        allCols.push({columnId})
      }
    }
    allCols.sort((a, b) => a.columnId - b.columnId)

    for (let blockIndex = 0; blockIndex < docState.blocks.length; blockIndex++) {
      let block = copyObject(docState.blocks[blockIndex])
      block.columns = makeDecoders(block.columns.map(col => ({columnId: col.columnId, buffer: col.decoder.buf})), allCols)
      docState.blocks[blockIndex] = block
    }
  }
}

function hasNewColumns(docCols, changeCols) {
  let at = 0
  for (const {columnId} of changeCols) {
    if (PRED_COLUMN_IDS.includes(columnId)) continue
    while (at < docCols.length && docCols[at].columnId < columnId) at++
    if (at === docCols.length || docCols[at].columnId !== columnId) return true
  }
  return false
}

/**
 * Takes a decoded change header, including an array of actorIds. Returns an object of the form
 * `{actorIds, actorTable}`, where `actorIds` is an updated array of actorIds appearing in the
 * document (including the new change's actorId). `actorTable` is an array of integers where
 * `actorTable[i]` contains the document's actor index for the actor that has index `i` in the
 * change (`i == 0` is the author of the change).
 */
function getActorTable(actorIds, actorIndexById, change) {
  if (!actorIndexById.has(change.actorIds[0])) {
    if (change.seq !== 1) {
      throw new RangeError(`Seq ${change.seq} is the first change for actor ${change.actorIds[0]}`)
    }
    // Use concat, not push, so that the original array is not mutated
    actorIds = actorIds.concat([change.actorIds[0]])
    actorIndexById.set(change.actorIds[0], actorIds.length - 1)
  }
  const actorTable = [] // translate from change's actor index to doc's actor index
  for (let actorId of change.actorIds) {
    const index = actorIndexById.get(actorId)
    if (index === undefined) {
      throw new PanicError('called `Option::unwrap()` on a `None` value')
    }
    actorTable.push(index)
  }
  return {actorIds, actorTable}
}

/**
 * Finalises the patch for a change. `patches` is a map from objectIds to patch for that
 * particular object, `objectIds` is the array of IDs of objects that are created or updated in the
 * change, and `docState` is an object containing various bits of document state, including
 * `objectMeta`, a map from objectIds to metadata about that object (such as its parent in the
 * document tree). Mutates `patches` such that child objects are linked into their parent object,
 * all the way to the root object.
 */
function setupPatches(patches, objectIds, docState) {
  for (let objectId of objectIds) {
    let meta = docState.objectMeta[objectId], childMeta = null, patchExists = false
    while (true) {
      const hasChildren = childMeta && Object.keys(meta.children[childMeta.parentKey]).length > 0
      if (!patches[objectId]) patches[objectId] = emptyObjectPatch(objectId, meta.type)

      if (childMeta && hasChildren) {
        if (meta.type === 'list' || meta.type === 'text') {
          // In list/text objects, parentKey is an elemID. First see if it already appears in an edit
          for (let edit of patches[objectId].edits) {
            if (edit.opId && meta.children[childMeta.parentKey][edit.opId]) {
              patchExists = true
            }
          }

          // If we need to add an edit, we first have to translate the elemId into an index
          if (!patchExists) {
            const obj = parseOpId(objectId), elem = parseOpId(childMeta.parentKey)
            const seekPos = {
              objActor: obj.actorId,  objCtr: obj.counter,
              keyActor: elem.actorId, keyCtr: elem.counter,
              objActorNum: docState.actorIndexById.get(obj.actorId),
              keyActorNum: docState.actorIndexById.get(elem.actorId),
              keyStr:   null,         insert: false,
              objId:    objectId
            }
            const { visibleCount } = seekToOp(docState, seekPos)

            for (let [opId, value] of Object.entries(meta.children[childMeta.parentKey])) {
              let patchValue = value
              if (value.objectId) {
                if (!patches[value.objectId]) patches[value.objectId] = emptyObjectPatch(value.objectId, value.type)
                patchValue = patches[value.objectId]
              }
              const edit = {action: 'update', index: visibleCount, opId, value: patchValue}
              appendEdit(patches[objectId].edits, edit)
            }
          }

        } else {
          // Non-list object: parentKey is the name of the property being updated (a string)
          if (!patches[objectId].props[childMeta.parentKey]) {
            patches[objectId].props[childMeta.parentKey] = {}
          }
          let values = patches[objectId].props[childMeta.parentKey]

          for (let [opId, value] of Object.entries(meta.children[childMeta.parentKey])) {
            if (values[opId]) {
              patchExists = true
            } else if (value.objectId) {
              if (!patches[value.objectId]) patches[value.objectId] = emptyObjectPatch(value.objectId, value.type)
              values[opId] = patches[value.objectId]
            } else {
              values[opId] = value
            }
          }
        }
      }

      if (patchExists || !meta.parentObj || (childMeta && !hasChildren)) break
      childMeta = meta
      objectId = meta.parentObj
      meta = docState.objectMeta[objectId]
    }
  }
  return patches
}

function topologicalOrder(changes, changeIndexByHash) {
  const pending = [], position = new Map()
  for (const change of changes) {
    if (changeIndexByHash[change.hash] !== undefined || position.has(change.hash)) continue
    position.set(change.hash, pending.length)
    pending.push(change)
  }
  const unsatisfied = new Array(pending.length).fill(0), waiting = new Map()
  for (let i = 0; i < pending.length; i++) {
    for (const dep of pending[i].deps) {
      if (changeIndexByHash[dep] !== undefined) continue
      unsatisfied[i]++
      if (!waiting.has(dep)) waiting.set(dep, [])
      waiting.get(dep).push(i)
    }
  }
  const order = []
  for (let i = 0; i < pending.length; i++) if (unsatisfied[i] === 0) order.push(i)
  for (let k = 0; k < order.length; k++) {
    for (const i of waiting.get(pending[order[k]].hash) || []) {
      if (--unsatisfied[i] === 0) order.push(i)
    }
  }
  const ready = new Set(order)
  return order.map(i => pending[i]).concat(pending.filter((change, i) => !ready.has(i)))
}

/**
 * Takes an array of decoded changes and applies them to a document. `docState` contains a bunch of
 * fields describing the document state. This function mutates `docState` to contain the updated
 * document state, and mutates `patches` to contain a patch to return to the frontend. Only the
 * top-level `docState` object is mutated; all nested objects within it are treated as immutable.
 * `objectIds` is mutated to contain the IDs of objects that are updated in any of the changes.
 *
 * The function detects duplicate changes that we've already applied by looking up each change's
 * hash in `docState.changeIndexByHash`. If we deferred the hash graph computation, that structure
 * will be incomplete, and we run the risk of applying the same change twice. However, we still have
 * the sequence numbers for detecting duplicates. If `throwExceptions` is true, we assume that the
 * set of change hashes is complete, and therefore a duplicate sequence number indicates illegal
 * behaviour. If `throwExceptions` is false, and we detect a possible sequence number reuse, we
 * don't throw an exception but instead enqueue all of the changes. This gives us a chance to
 * recompute the hash graph and eliminate duplicates before raising an error to the application.
 *
 * Returns a two-element array `[applied, enqueued]`, where `applied` is an array of changes that
 * have been applied to the document, and `enqueued` is an array of changes that have not yet been
 * applied because they are missing a dependency.
 */
function applyChanges(patches, decodedChanges, docState, objectIds, throwExceptions) {
  let heads = new Set(docState.heads), changeHashes = new Set()
  let clock = copyObject(docState.clock)
  let applied = [], enqueued = [], gap = false

  for (let change of decodedChanges) {
    // Skip any duplicate changes that we have already seen
    if (docState.changeIndexByHash[change.hash] !== undefined || docState.appliedHashes.has(change.hash) ||
        changeHashes.has(change.hash)) continue

    const expectedSeq = (clock[change.actor] || 0) + 1
    let causallyReady = true

    for (let dep of change.deps) {
      const depIndex = docState.changeIndexByHash[dep]
      if ((depIndex === undefined || depIndex === -1) && !docState.appliedHashes.has(dep) && !changeHashes.has(dep)) {
        causallyReady = false
      }
    }

    if (!causallyReady) {
      enqueued.push(change)
    } else if (change.seq < expectedSeq) {
      if (throwExceptions) {
        throw new RangeError(`Reuse of sequence number ${change.seq} for actor ${change.actor}`)
      } else {
        return [[], decodedChanges]
      }
    } else if (change.seq > expectedSeq) {
      gap = true
      changeHashes.add(change.hash)
      applied.push(change)
    } else {
      clock[change.actor] = change.seq
      changeHashes.add(change.hash)
      for (let dep of change.deps) heads.delete(dep)
      heads.add(change.hash)
      applied.push(change)
    }
  }

  if (gap) {
    const known = new Set(applied.filter(change => change.seq === 1).map(change => change.actor))
    const seqs = copyObject(docState.clock)
    for (const change of applied) {
      if (change.actorIds.some(actor => !docState.actorIndexById.has(actor) && !known.has(actor))) {
        throw new PanicError('called `Option::unwrap()` on a `None` value')
      }
      const expectedSeq = (seqs[change.actor] || 0) + 1
      if (change.seq !== expectedSeq) {
        throw new PanicError(`assertion \`left == right\` failed\n  left: ${expectedSeq}\n right: ${change.seq}`)
      }
      seqs[change.actor] = change.seq
    }
  }

  if (applied.length > 0) {
    for (const change of applied) {
      if (hasNewColumns(docState.blocks[0].columns, change.columns)) {
        updateBlockColumns(docState, makeDecoders(change.columns, CHANGE_COLUMNS))
      }
    }
    let changeState = {changes: applied.slice().sort((a, b) => a.startOp - b.startOp), changeIndex: -1, objectIds}
    readNextChangeOp(docState, changeState)
    while (!changeState.done) applyOps(patches, changeState, docState)

    docState.heads = [...heads].sort()
    docState.clock = clock
  }
  return [applied, enqueued]
}

function lastPropState() {
  let lastKey, lastValue
  return {
    get: key => (key === lastKey ? lastValue : undefined),
    set: (key, value) => { lastKey = key; lastValue = value }
  }
}

function hasCounter(diff) {
  if (diff.datatype === 'counter') return true
  if (diff.props) return Object.values(diff.props).some(values => Object.values(values).some(hasCounter))
  return !!diff.edits && diff.edits.some(edit => edit.datatype === 'counter' || !!edit.value && hasCounter(edit.value))
}

/**
 * Scans the operations in a document and generates a patch that can be sent to the frontend to
 * instantiate the current state of the document. `objectMeta` is mutated to contain information
 * about the parent and children of each object in the document.
 */
function documentPatch(docState, clock) {
  let propState = lastPropState(), blockIndex = 0, rows = columnOperationCache(docState.blocks[0].columns).operations, row = 0
  let patches = {_root: {objectId: '_root', type: 'map', props: {}}}
  let lastObjActor = null, lastObjCtr = null, objectId = '_root', elemVisible = false, listIndex = 0
  let run = null, runActor = null, runCtr = null
  const counters = [], loadBlocks = docState.loadVisibleMapOps ? splitLoadedBlock(docState.blocks[0], rows) : null
  let loadBlock = -1, metadataCounters = []

  while (true) {
    while (row === rows.length && blockIndex < docState.blocks.length - 1) {
      rows = columnOperationCache(docState.blocks[++blockIndex].columns).operations
      row = 0
    }
    if (row === rows.length) break
    if (loadBlocks && row === loadBlocks[loadBlock + 1]?.start) {
      loadBlock++
      metadataCounters = []
    }
    let docOp = rows[row++]
    if (loadBlocks) addOperationMetadata(loadBlocks[loadBlock].block, docOp, docState.loadVisibleMapOps, metadataCounters)
    if (clock) {
      if (!(docOp[idCtrIdx] <= clock[docOp[idActorIdx]])) continue
      const succCtr = [], succActor = []
      for (let i = 0; i < docOp[succNumIdx]; i++) {
        if (docOp[succCtrIdx][i] <= clock[docOp[succActorIdx][i]]) {
          succCtr.push(docOp[succCtrIdx][i])
          succActor.push(docOp[succActorIdx][i])
        }
      }
      docOp = docOp.slice()
      docOp[succNumIdx] = succCtr.length
      docOp[succCtrIdx] = succCtr
      docOp[succActorIdx] = succActor
    }
    if (docOp[objActorIdx] !== lastObjActor || docOp[objCtrIdx] !== lastObjCtr) {
      objectId = `${docOp[objCtrIdx]}@${docState.actorIds[docOp[objActorIdx]]}`
      lastObjActor = docOp[objActorIdx]
      lastObjCtr = docOp[objCtrIdx]
      propState = lastPropState()
      listIndex = 0
      elemVisible = false
    }

    if (docOp[insertIdx] && elemVisible) {
      elemVisible = false
      listIndex++
    }
    if (!elemVisible && docOp[keyStrIdx] === null && visibleRow(docOp, docOp[succNumIdx], counters)) elemVisible = true
    if (ACTIONS[docOp[actionIdx]] === 'mark' && docState.objectsWithMarks) docState.objectsWithMarks.add(objectId)
    if (docOp[idCtrIdx] > docState.maxOp) docState.maxOp = docOp[idCtrIdx]
    for (let i = 0; i < docOp[succNumIdx]; i++) {
      if (docOp[succCtrIdx][i] > docState.maxOp) docState.maxOp = docOp[succCtrIdx][i]
    }

    if (docOp[insertIdx] && docOp[succNumIdx] === 0 && docOp[keyStrIdx] === null && docOp[actionIdx] === 1) {
      const idActor = docOp[idActorIdx], idCtr = docOp[idCtrIdx], opId = `${idCtr}@${docState.actorIds[idActor]}`
      const meta = docState.objectMeta[objectId]
      if (!meta.hasChildren || !meta.children[opId]) {
        propState.set(opId, {visibleOps: [docOp], hasChild: false, action: 'insert'})
        const patch = patches[objectId] || (patches[objectId] = emptyObjectPatch(objectId, meta.type))
        const value = Object.assign({type: 'value'}, decodeValue(docOp[valLenIdx], docOp[valRawIdx]))
        const edits = patch.edits, last = edits[edits.length - 1]
        if (last !== undefined && last === run && last.action === 'multi-insert' && runActor === idActor &&
            runCtr + 1 === idCtr && last.index + last.values.length === listIndex &&
            last.datatype === value.datatype && typeof last.values[0] === typeof value.value) {
          last.values.push(value.value)
        } else {
          appendEdit(edits, {action: 'insert', index: listIndex, elemId: opId, opId, value})
        }
        run = edits[edits.length - 1]
        runActor = idActor
        runCtr = idCtr
        continue
      }
    }
    updatePatchProperty(patches, null, objectId, docOp, docState, propState, listIndex, docOp[succNumIdx])
  }
  if (loadBlocks) docState.blocks = loadBlocks.map(({block}) => block)
  return patches[docState.patchObject || '_root']
}

function splitLoadedBlock(block, rows) {
  if (rows.length <= MAX_BLOCK_SIZE) return [{start: 0, block}]
  const parts = [], size = Math.ceil(rows.length / Math.ceil(rows.length / (0.8 * MAX_BLOCK_SIZE)))
  for (let start = 0; start < rows.length;) {
    let end = Math.min(start + size, rows.length)
    while (end < rows.length && rows[end][keyStrIdx] === null && !rows[end][insertIdx]) end++
    const part = {columns: columnsFromOperations(block.columns, rows.slice(start, end))}
    resetBlockMetadata(part)
    parts.push({start, block: part})
    start = end
  }
  return parts
}

/**
 * Takes an encoded document whose headers have been parsed using `decodeDocumentHeader()` and reads
 * from it the list of changes. Returns the document's current vector clock, i.e. an object mapping
 * each actor ID (as a hex string) to the number of changes seen from that actor. Also returns an
 * array of the actorIds whose most recent change has no dependents (i.e. the actors that
 * contributed the current heads of the document), and an array of encoders that has been
 * initialised to contain the columns of the changes list.
 */
function readDocumentChanges(doc) {
  const columns = makeDecoders(doc.changesColumns, DOCUMENT_COLUMNS)
  const actorD = columns[0].decoder, seqD = columns[1].decoder
  const depsNumD = columns[5].decoder, depsIndexD = columns[6].decoder
  if (columns[0].columnId !== DOCUMENT_COLUMNS[0].columnId || DOCUMENT_COLUMNS[0].columnName !== 'actor' ||
      columns[1].columnId !== DOCUMENT_COLUMNS[1].columnId || DOCUMENT_COLUMNS[1].columnName !== 'seq' ||
      columns[5].columnId !== DOCUMENT_COLUMNS[5].columnId || DOCUMENT_COLUMNS[5].columnName !== 'depsNum' ||
      columns[6].columnId !== DOCUMENT_COLUMNS[6].columnId || DOCUMENT_COLUMNS[6].columnName !== 'depsIndex') {
    throw new RangeError('unexpected columnId')
  }

  let numChanges = 0, clock = {}, actorNums = [], headIndexes = new Set()
  while (!actorD.done) {
    const actorNum = actorD.readValue(), seq = seqD.readValue(), depsNum = depsNumD.readValue()
    const actorId = doc.actorIds[actorNum]
    if (seq !== 1 && seq !== clock[actorId] + 1) {
      throw new RangeError(`Expected seq ${clock[actorId] + 1}, got ${seq} for actor ${actorId}`)
    }
    actorNums.push(actorNum)
    clock[actorId] = seq
    headIndexes.add(numChanges)
    for (let j = 0; j < depsNum; j++) headIndexes.delete(depsIndexD.readValue())
    numChanges++
  }
  const headActors = [...headIndexes].map(index => doc.actorIds[actorNums[index]]).sort()

  for (const column of columns) column.decoder.reset()
  for (let index = 0; index < numChanges; index++) readOperation(columns)
  for (const column of columns) {
    if (!column.decoder.done) throw new RangeError(`excess values in column ${column.columnId}`)
  }

  return {clock, headActors, numChanges}
}

function copyDocumentChanges(columns, numChanges) {
  const decoders = makeDecoders(columns, DOCUMENT_COLUMNS)
  const encoders = columnEncoders(decoders)
  copyColumns(encoders, decoders, numChanges)
  return encoders
}

/**
 * Records the metadata about a change in the appropriate columns.
 */
function appendChange(columns, change, actorIndexById, changeIndexByHash) {
  appendOperation(columns, DOCUMENT_COLUMNS, [
    actorIndexById.get(change.actor), // actor
    change.seq, // seq
    change.maxOp, // maxOp
    change.time, // time
    change.message || null, // message
    change.deps.length, // depsNum
    change.deps.map(dep => changeIndexByHash[dep]), // depsIndex
    change.extraBytes ? (change.extraBytes.byteLength << 4 | VALUE_TYPE.BYTES) : VALUE_TYPE.BYTES, // extraLen
    change.extraBytes // extraRaw
  ])
}

function changeMeta(buffer) {
  const change = decodeChangeColumns(buffer)
  const actionColumn = change.columns.find(column => column.columnId === CHANGE_COLUMNS[actionIdx].columnId)
  let numOps = 0
  if (actionColumn) {
    const actions = decoderByColumnId(actionColumn.columnId, actionColumn.buffer)
    while (!actions.done) {
      actions.readValue()
      numOps++
    }
  }
  return {
    actor: change.actor,
    seq: change.seq,
    startOp: change.startOp,
    maxOp: change.startOp + numOps - 1,
    time: change.time,
    message: change.message,
    deps: change.deps,
    hash: change.hash
  }
}

function buildCursorIndex(blocks, actorIds, objectId) {
  const object = parseOpId(objectId)
  const elements = [], byId = new Map(), counters = []
  for (const block of blocks) {
    for (const column of block.columns) column.decoder.reset()
    while (!block.columns[actionIdx].decoder.done) {
      const op = readOperation(block.columns, actorIds)
      const matches = objectId === '_root'
        ? op[objCtrIdx] === null
        : op[objCtrIdx] === object.counter && op[objActorIdx] === object.actorId
      if (!matches || op[keyStrIdx] !== null) continue
      if (op[insertIdx]) {
        const id = `${op[idCtrIdx]}@${op[idActorIdx]}`
        const key = op[keyCtrIdx] === 0 ? '_head' : `${op[keyCtrIdx]}@${op[keyActorIdx]}`
        elements.push(id)
        // Mark boundaries are elements of the sequence, but they are never
        // visible; including them lets cursors anchored on a boundary resolve
        byId.set(id, {key, visible: visibleRow(op, op[succNumIdx], counters)})
      } else {
        const id = `${op[keyCtrIdx]}@${op[keyActorIdx]}`
        const element = byId.get(id)
        if (element && visibleRow(op, op[succNumIdx], counters)) element.visible = true
      }
    }
  }
  let visibleIndex = 0
  for (const id of elements) {
    const element = byId.get(id)
    element.after = visibleIndex
    if (element.visible) element.position = visibleIndex++
  }
  return byId
}

function blockInserts(block, actorIds, objectId, counter, actor) {
  let byObject = SEQUENCE_INSERTS.get(block.columns)
  if (!byObject) SEQUENCE_INSERTS.set(block.columns, byObject = new Map())
  let entries = byObject.get(objectId)
  if (entries) return entries
  entries = []
  for (const op of columnOperationCache(block.columns).operations) {
    if (op[objCtrIdx] !== counter || op[objActorIdx] !== actor || !op[insertIdx]) continue
    const id = `${op[idCtrIdx]}@${actorIds[op[idActorIdx]]}`
    const ref = op[keyCtrIdx] === 0 ? '_head' : `${op[keyCtrIdx]}@${actorIds[op[keyActorIdx]]}`
    const value = ACTIONS[op[actionIdx]] === 'mark' && op[markNameIdx] !== null && decodeValue(op[valLenIdx], op[valRawIdx])
    const mark = !value ? (ACTIONS[op[actionIdx]] === 'mark' ? {begin: false, expand: !!op[expandIdx]} : null)
      : {begin: true, name: op[markNameIdx], value: value.datatype === 'timestamp' ? new Date(value.value) : value.value, expand: !!op[expandIdx]}
    entries.push({id, ref, mark, counter: op[idCtrIdx], actor: op[idActorIdx]})
  }
  byObject.set(objectId, entries)
  return entries
}

function appendBlockElements(block, actorIds, objectId, counter, actor, elems, counters, clock) {
  let leading = false, inserted = false
  for (const op of columnOperationCache(block.columns).operations) {
    if (op[objCtrIdx] !== counter || op[objActorIdx] !== actor || op[keyStrIdx] !== null) continue
    const visible = clock ? visibleAt(op, clock, null) : visibleRow(op, op[succNumIdx], counters)
    if (op[insertIdx]) {
      inserted = true
      const mark = op[actionIdx] !== MARK_ACTION ? null : op[markNameIdx] === null ? 'end' : 'begin'
      elems.push({actorId: actorIds[op[idActorIdx]], counter: op[idCtrIdx], mark, expand: !!op[expandIdx], visible})
    } else {
      if (!inserted) leading = true
      if (visible && elems.length > 0) elems[elems.length - 1].visible = true
    }
  }
  return leading
}

function loadPart(seq, k) {
  if (seq.parts[k] !== undefined) return seq.parts[k]
  const block = seq.blocks[k]
  let byObject = SEQUENCE_ELEMENTS.get(block.columns)
  if (!byObject) SEQUENCE_ELEMENTS.set(block.columns, byObject = new Map())
  let part = byObject.get(seq.objectId)
  if (part === undefined) {
    part = []
    if (appendBlockElements(block, seq.actorIds, seq.objectId, seq.counter, seq.actor, part, [])) part = null
    byObject.set(seq.objectId, part)
  }
  seq.parts[k] = part && part.slice()
  return seq.parts[k]
}

function findElem(seq, counter, actorId, actor) {
  for (let k = 0; k < seq.parts.length; k++) {
    if (!seq.parts[k]) continue
    const index = seq.parts[k].findIndex(e => e.counter === counter && e.actorId === actorId)
    if (index >= 0) return {part: k, index}
  }
  for (let k = 0; k < seq.parts.length; k++) {
    if (seq.parts[k] !== undefined || actor === undefined || !bloomFilterContains(seq.blocks[k].bloom, actor, counter)) continue
    const part = loadPart(seq, k)
    if (part === null) return null
    const index = part.findIndex(e => e.counter === counter && e.actorId === actorId)
    if (index >= 0) return {part: k, index}
  }
  return undefined
}

function rowAnchor(doc, op) {
  if (op.elemId === '_head') return null
  const obj = parseOpId(op.obj), objActor = doc.actorIndexById.get(obj.actorId)
  const {counter, actorId} = parseOpId(op.elemId), actor = doc.actorIndexById.get(actorId)
  if (objActor === undefined || actor === undefined) return null
  const candidates = [op.elemId], counters = []
  let found = false, plain = false
  for (let index = findBlock(doc.blocks, doc.actorIds, obj.actorId, obj.counter, null); index < doc.blocks.length; index++) {
    const block = doc.blocks[index]
    if (found || bloomFilterContains(block.bloom, actor, counter)) {
      const rows = columnOperationCache(block.columns).operations
      let i = 0
      if (!found) {
        while (i < rows.length && (rows[i][idCtrIdx] !== counter || rows[i][idActorIdx] !== actor || !rows[i][insertIdx])) i++
        found = i++ < rows.length
      }
      for (; i < rows.length; i++) {
        const row = rows[i]
        if (row[objCtrIdx] !== obj.counter || row[objActorIdx] !== objActor) return candidates[candidates.length - 1]
        const visible = visibleRow(row, row[succNumIdx], counters)
        if (!row[insertIdx]) {
          if (visible && plain) return candidates[candidates.length - 1]
        } else if (row[actionIdx] !== MARK_ACTION) {
          if (visible) return candidates[candidates.length - 1]
          plain = true
        } else {
          plain = false
          const id = `${row[idCtrIdx]}@${doc.actorIds[row[idActorIdx]]}`
          const begin = row[markNameIdx] === null ? candidates.indexOf(`${row[idCtrIdx] - 1}@${doc.actorIds[row[idActorIdx]]}`, 1) : -1
          if (begin >= 0) candidates.length = begin
          else if ((row[markNameIdx] !== null) === !!row[expandIdx]) candidates.push(id)
        }
      }
    }
    if (!found && compareBlockObject(block, doc.actorIds, obj.actorId, obj.counter) > 0) return null
  }
  return found ? candidates[candidates.length - 1] : null
}

function insertAnchor(seq, ref) {
  let part = 0, index = 0
  if (ref !== '_head') {
    const {counter, actorId} = parseOpId(ref), found = findElem(seq, counter, actorId, seq.actorIndexById.get(actorId))
    if (found === null) return null
    if (found === undefined) return {ref, part, index}
    part = found.part
    index = found.index + 1
  }
  const candidates = [{ref, counter: null, actorId: null, part, index}]
  for (;; index++) {
    let elems = loadPart(seq, part)
    while (elems && index >= elems.length && part < seq.parts.length - 1) {
      elems = loadPart(seq, ++part)
      index = 0
    }
    if (elems === null) return null
    if (index >= elems.length) break
    const elem = elems[index]
    if (elem.mark === 'end') {
      const found = candidates.findIndex(c => c.counter === elem.counter - 1 && c.actorId === elem.actorId)
      if (found >= 0) {
        candidates.length = found
        continue
      }
    }
    if (elem.mark && (elem.mark === 'begin') === elem.expand) {
      candidates.push({ref: `${elem.counter}@${elem.actorId}`, counter: elem.counter, actorId: elem.actorId, part, index: index + 1})
    } else if (!elem.mark && elem.visible) {
      break
    }
  }
  return candidates[candidates.length - 1]
}

const SAME = 0, ADD = 1, DEL = 2
const NO_MARKS = new Map(), NO_MACHINE = {state: [], current: NO_MARKS, begin: null, from: null}, NULL_VALUE = {value: null}, NO_MARK_DIFF = {before: null, after: null}
const SET_ACTION = ACTIONS.indexOf('set'), DEL_ACTION = ACTIONS.indexOf('del'), INC_ACTION = ACTIONS.indexOf('inc'),
  MARK_ACTION = ACTIONS.indexOf('mark'), MAKE_MAP_ACTION = ACTIONS.indexOf('makeMap')

function changeTargets(buffer) {
  let targets = CHANGE_TARGETS.get(buffer)
  if (!targets) CHANGE_TARGETS.set(buffer, targets = decodeTargets(buffer))
  return targets
}

function decodeTargets(buffer) {
  const targets = new Map(), {startOp, actorIds, readers} = changeColumnReaders(buffer, TARGET_COLUMNS)
  const [objActors, objCtrs, keyActors, keyCtrs, keyStrs, inserts, actions] = readers
  let lastActor, lastCtr, target
  for (let counter = startOp; actions.count > 0 || actions.at < actions.end; counter++) {
    const action = readNext(actions), objActor = readNext(objActors), objCtr = readNext(objCtrs)
    const keyActor = readNext(keyActors), keyCtr = readNext(keyCtrs), keyStr = readNext(keyStrs), insert = readNext(inserts)
    if (objActor !== lastActor || objCtr !== lastCtr) {
      const objectId = objCtr === null ? '_root' : `${objCtr}@${actorIds[objActor]}`
      target = targets.get(objectId)
      if (!target) targets.set(objectId, target = {objectId, mark: false, elements: []})
      lastActor = objActor
      lastCtr = objCtr
    }
    if (action === MARK_ACTION) target.mark = true
    if (target.elements.length > MAX_TOUCHED_ELEMENTS) continue
    if (insert) target.elements.push([actorIds[0], counter])
    else if (keyStr === null && keyCtr) target.elements.push([actorIds[keyActor], keyCtr])
  }
  return [...targets.values()]
}

function changeObjects(targets, objects, actorIndexById) {
  for (const {objectId, mark, elements} of targets) {
    let touched = objects.get(objectId)
    if (!touched) objects.set(objectId, touched = {elements: [], marks: false})
    if (mark) touched.marks = true
    for (let i = 0; i < elements.length && touched.elements.length <= MAX_TOUCHED_ELEMENTS; i++) {
      touched.elements.push([actorIndexById.get(elements[i][0]), elements[i][1]])
    }
  }
}

function blockObjects(block) {
  let objects = BLOCK_OBJECTS.get(block.columns)
  if (objects) return objects
  objects = new Map()
  const rows = columnOperationCache(block.columns).operations
  for (let start = 0; start < rows.length;) {
    const ctr = rows[start][objCtrIdx], actor = rows[start][objActorIdx]
    let end = rows.length
    for (let low = start + 1; low < end;) {
      const middle = (low + end) >>> 1
      if (rows[middle][objCtrIdx] === ctr && rows[middle][objActorIdx] === actor) low = middle + 1; else end = middle
    }
    objects.set(ctr === null ? '_root' : `${ctr}@${actor}`, {start, end})
    start = end
  }
  BLOCK_OBJECTS.set(block.columns, objects)
  return objects
}

function blockMarks(block) {
  let marks = BLOCK_MARKS.get(block.columns)
  if (marks) return marks
  marks = []
  const decoders = block.columns.map(column => column.decoder)
  for (const decoder of decoders) decoder.reset()
  while (!decoders[actionIdx].done) {
    const objActor = decoders[objActorIdx].readValue(), objCtr = decoders[objCtrIdx].readValue()
    const idActor = decoders[idActorIdx].readValue(), idCtr = decoders[idCtrIdx].readValue()
    const action = decoders[actionIdx].readValue(), markName = decoders[markNameIdx].readValue()
    if (action !== MARK_ACTION) continue
    marks.push({obj: `${objCtr}@${objActor}`, id: `${idCtr}@${idActor}`, begin: markName === null && `${idCtr - 1}@${idActor}`})
  }
  for (const decoder of decoders) decoder.reset()
  BLOCK_MARKS.set(block.columns, marks)
  return marks
}

function groupEnd(rows, start, end, type) {
  let next = start + 1
  if (type === 'map') {
    while (next < end && rows[next][keyStrIdx] === rows[start][keyStrIdx]) next++
  } else {
    while (next < end && !rows[next][insertIdx]) next++
  }
  return next
}

function groupIncrements(rows, start, end) {
  let incs = null
  for (let i = start; i < end; i++) {
    if (rows[i][actionIdx] !== INC_ACTION) continue
    if (!incs) incs = new Map()
    incs.set(`${rows[i][idCtrIdx]}@${rows[i][idActorIdx]}`, decodeValue(rows[i][valLenIdx], rows[i][valRawIdx]).value)
  }
  return incs
}

function textWidth(row) {
  if (row[actionIdx] !== SET_ACTION || (row[valLenIdx] === (16 | VALUE_TYPE.UTF8) && row[valRawIdx][0] < 0x80)) return 1
  const decoded = decodeValue(row[valLenIdx], row[valRawIdx])
  return typeof decoded.value === 'string' && !decoded.datatype ? decoded.value.length : 1
}

function segmentSummary(segment, rows, type) {
  if (segment.summary) return segment.summary
  const maxCounters = [], children = [], marks = []
  let visible = 0
  for (let start = segment.start; start < segment.end;) {
    const first = rows[start], action = first[actionIdx]
    if (type !== 'map' && first[insertIdx] && first[succNumIdx] === 0 && (action === SET_ACTION || action === MARK_ACTION) &&
        (start + 1 === segment.end || rows[start + 1][insertIdx])) {
      if (!(first[idCtrIdx] <= maxCounters[first[idActorIdx]])) maxCounters[first[idActorIdx]] = first[idCtrIdx]
      if (action === MARK_ACTION) marks.push(first); else visible += type === 'text' ? textWidth(first) : 1
      start++
      continue
    }
    const end = groupEnd(rows, start, segment.end, type), incs = type === 'text' ? null : groupIncrements(rows, start, end)
    let top = null
    for (let i = start; i < end; i++) {
      const row = rows[i]
      if (!(row[idCtrIdx] <= maxCounters[row[idActorIdx]])) maxCounters[row[idActorIdx]] = row[idCtrIdx]
      for (let j = 0; j < row[succNumIdx]; j++) {
        if (!(row[succCtrIdx][j] <= maxCounters[row[succActorIdx][j]])) maxCounters[row[succActorIdx][j]] = row[succCtrIdx][j]
      }
      if (visibleNow(row, incs)) top = row
    }
    if (top && top[actionIdx] === MARK_ACTION) {
      marks.push(top)
    } else if (top) {
      if (isMakeRow(top)) children.push({row: top, offset: type === 'map' ? top[keyStrIdx] : visible})
      visible += type === 'text' ? textWidth(top) : 1
    }
    start = end
  }
  segment.summary = {maxCounters: maxCounters.flatMap((counter, actor) => (counter === undefined ? [] : [[actor, counter]])), children, marks, visible}
  return segment.summary
}

function settledAt(summary, before, after) {
  for (const [actor, counter] of summary.maxCounters) {
    if (!(counter <= before[actor] && counter <= after[actor])) return false
  }
  return true
}

function startsGroup(part, type, previous) {
  const first = part.operations[part.segment.start]
  if (type !== 'map') return first[insertIdx]
  return !previous || previous.operations[previous.segment.end - 1][keyStrIdx] !== first[keyStrIdx]
}

function touchesBlock(doc, block, key, touched) {
  if (!touched.elements.some(([actor, counter]) => bloomFilterContains(block.bloom, actor, counter))) return false
  const segment = blockObjects(block).get(key)
  if (!segment) return false
  const rows = columnOperationCache(block.columns).operations, elements = touched.elements
  for (let i = segment.start; i < segment.end; i++) {
    const row = rows[i], actor = row[insertIdx] ? row[idActorIdx] : row[keyActorIdx], counter = row[insertIdx] ? row[idCtrIdx] : row[keyCtrIdx]
    for (let k = 0; k < elements.length; k++) if (elements[k][1] === counter && elements[k][0] === actor) return true
  }
  return false
}

function lastCandidateBlock(doc, first, key, touched, actorId, counter) {
  let last = first
  while (last < doc.blocks.length - 1 && compareBlockObject(doc.blocks[last], doc.actorIds, actorId, counter) <= 0) last++
  while (last > first && !touchesBlock(doc, doc.blocks[last], key, touched)) last--
  return last
}

function objectRows(doc, objectId, type, before, after, touched) {
  const {counter, actorId} = objectId === '_root' ? {counter: null, actorId: null} : parseOpId(objectId)
  const key = objectId === '_root' ? objectId : `${counter}@${doc.actorIndexById.get(actorId)}`
  const first = findBlock(doc.blocks, doc.actorIds, actorId, counter, null), parts = []
  const last = touched && type !== 'map' && !touched.marks && touched.elements.length <= MAX_TOUCHED_ELEMENTS
    ? lastCandidateBlock(doc, first, key, touched, actorId, counter) : doc.blocks.length - 1
  let truncated = false
  for (let index = first; index < doc.blocks.length; index++) {
    const block = doc.blocks[index]
    if (index > last) {
      truncated = compareBlockObject(doc.blocks[index - 1], doc.actorIds, actorId, counter) <= 0
      break
    }
    const segment = blockObjects(block).get(key)
    if (segment) parts.push({segment, operations: columnOperationCache(block.columns).operations})
    if (compareBlockObject(block, doc.actorIds, actorId, counter) > 0) break
  }
  const pieces = []
  for (let k = 0; k < parts.length; k++) {
    const {segment, operations} = parts[k]
    if (before !== null && startsGroup(parts[k], type, parts[k - 1]) &&
        (k === parts.length - 1 ? !truncated : startsGroup(parts[k + 1], type, parts[k]))) {
      const summary = segmentSummary(segment, operations, type)
      if (settledAt(summary, before, after)) {
        pieces.push([{skip: true, summary, length: type === 'text' ? segment.end - segment.start : 0}])
        if (type !== 'text') continue
      }
    }
    pieces.push(operations.slice(segment.start, segment.end))
  }
  const rows = [].concat(...pieces)
  rows.truncated = truncated
  return rows
}

function covers(clock, row) {
  return clock !== null && row[idCtrIdx] <= clock[row[idActorIdx]]
}

function isCounterRow(row) {
  return row[actionIdx] === SET_ACTION && (row[valLenIdx] & 0x0f) === VALUE_TYPE.COUNTER
}

function visibleAt(row, clock, incs) {
  const action = row[actionIdx]
  if (action === INC_ACTION || action === DEL_ACTION || !covers(clock, row)) return false
  if (!isCounterRow(row)) incs = null
  for (let i = 0; i < row[succNumIdx]; i++) {
    const counter = row[succCtrIdx][i], actor = row[succActorIdx][i]
    if (counter <= clock[actor] && !(incs && incs.has(`${counter}@${actor}`))) return false
  }
  return true
}

function visibleNow(row, incs) {
  if (row[actionIdx] === INC_ACTION || row[actionIdx] === DEL_ACTION) return false
  if (!isCounterRow(row)) incs = null
  for (let i = 0; i < row[succNumIdx]; i++) {
    if (!(incs && incs.has(`${row[succCtrIdx][i]}@${row[succActorIdx][i]}`))) return false
  }
  return true
}

function incrementsAt(row, clock, incs) {
  let total = 0
  if (clock === null || incs === null || !isCounterRow(row)) return total
  for (let i = 0; i < row[succNumIdx]; i++) {
    const counter = row[succCtrIdx][i], actor = row[succActorIdx][i], key = `${counter}@${actor}`
    if (counter <= clock[actor] && incs.has(key)) total = addInt(total, incs.get(key))
  }
  return total
}

function updateItem(item, expose) {
  item.expose = item.expose || expose
  if (item.expose && item.diff === SAME) item.diff = ADD
  item.update = true
}

function groupItem(entries, before, after, incs, isList) {
  let lastIsSame = false, numNew = 0, numOld = 0, expose = false, lastVisible = null
  for (let i = 0; i < entries.length; i++) {
    const {row, diff} = entries[i]
    if (diff === DEL) {
      expose = lastIsSame
      numOld++
    } else if (diff === SAME) {
      lastIsSame = true
      numNew++
      numOld++
      expose = false
    } else {
      lastIsSame = false
      numNew++
      expose = covers(before, row)
    }
    const incAfter = incrementsAt(row, after, incs)
    const itemDiff = expose && diff === SAME ? ADD : diff
    const item = {row, diff: itemDiff, inc: Number(addInt(incAfter, -incrementsAt(row, before, incs))), incAfter,
      conflict: numNew > 1 && !(diff === SAME && numOld > 1), expose, update: itemDiff === ADD && numOld > 0}
    if (i < entries.length - 1) {
      if (diff !== DEL && entries[i + 1].diff === DEL) lastVisible = item
      continue
    }
    if (lastVisible && (isList || diff === DEL)) {
      updateItem(lastVisible, expose || lastVisible.diff === SAME)
      lastVisible.conflict = numNew > 1
      return lastVisible
    }
    if (diff === SAME && numOld > 1 && numNew === 1) updateItem(item, true)
    return item
  }
}

function propertyItems(rows, type, before, after) {
  const items = [], isList = type !== 'map'
  let index = 0, start = 0
  while (start < rows.length) {
    if (rows[start].skip) {
      items.push({skipped: rows[start].summary, prop: index})
      index += rows[start].summary.visible
      start++
      continue
    }
    let end = start + 1
    while (end < rows.length && !rows[end].skip && (isList ? !rows[end][insertIdx] : rows[end][keyStrIdx] === rows[start][keyStrIdx])) end++
    const incs = groupIncrements(rows, start, end), entries = []
    let top = null
    for (let i = start; i < end; i++) {
      const visibleBefore = visibleAt(rows[i], before, incs), visibleAfter = visibleAt(rows[i], after, incs)
      if (visibleAfter) top = rows[i]
      if (visibleBefore || visibleAfter) entries.push({row: rows[i], diff: visibleAfter ? (visibleBefore ? SAME : ADD) : DEL})
    }
    if (entries.length > 0) {
      const item = groupItem(entries, before, after, incs, isList)
      item.prop = isList ? index : rows[start][keyStrIdx]
      item.top = top
      item.start = start
      item.end = end
      item.incs = incs
      items.push(item)
      if (item.diff !== DEL) index++
    }
    start = end
  }
  return items
}

function batchValues(rows, start, end, before, after, incs) {
  let doc = null, change = null
  for (let i = start; i < end; i++) {
    const row = rows[i]
    if (row[actionIdx] === INC_ACTION) {
      if (covers(before, row) || change || !doc || doc.deleted) continue
      for (let j = 0; j < doc.row[succNumIdx]; j++) {
        if (doc.row[succCtrIdx][j] === row[idCtrIdx] && doc.row[succActorIdx][j] === row[idActorIdx]) change = Object.assign({}, doc)
      }
    } else if (covers(before, row)) {
      if (!visibleAt(row, before, incs)) continue
      const deleted = !visibleAt(row, after, incs)
      if (deleted && doc && !doc.deleted) doc.expose = true
      else doc = {row, deleted, conflict: Boolean(doc && !doc.deleted), expose: !deleted && Boolean(doc && doc.deleted)}
    } else if (visibleAt(row, after, incs)) {
      change = {row, conflict: Boolean(change && !change.deleted), deleted: false}
    }
  }
  return {doc, change}
}

function compareRows(left, right, actorRank) {
  return left[idCtrIdx] - right[idCtrIdx] || actorRank[left[idActorIdx]] - actorRank[right[idActorIdx]]
}

function batchEvents(ctx, objectId, rows, item, isList, events) {
  const {doc, change} = batchValues(rows, item.start, item.end, ctx.before, ctx.after, item.incs), prop = item.prop
  function put(value, conflict, expose) {
    if (expose && isMakeRow(value.row)) exposeObject(ctx, opIdString(value.row, ctx.doc.actorIds))
    events.push({objectId, kind: 'put', prop, value: rowValue(ctx, value.row, incrementsAt(value.row, ctx.after, item.incs)), conflict})
  }
  if (!doc && change) {
    if (isList) events.push({objectId, kind: 'insert', prop, value: rowValue(ctx, change.row, incrementsAt(change.row, ctx.after, item.incs)), conflict: change.conflict})
    else put(change, change.conflict, false)
  } else if (doc && !change) {
    if (doc.expose) put(doc, doc.conflict, true)
    else if (doc.deleted) events.push(isList ? {objectId, kind: 'del', prop, length: 1} : {objectId, kind: 'delMap', prop})
  } else if (doc && change) {
    const order = compareRows(change.row, doc.row, ctx.actorRank)
    if (order === 0) {
      const inc = Number(addInt(incrementsAt(doc.row, ctx.after, item.incs), -incrementsAt(doc.row, ctx.before, item.incs)))
      if (inc !== 0) events.push({objectId, kind: 'inc', prop, value: inc})
    } else if (order < 0) {
      if (isList || !doc.conflict) events.push({objectId, kind: 'conflict', prop})
    } else {
      put(change, isList ? !doc.deleted || change.conflict : (change.conflict && !doc.conflict) || !doc.deleted, false)
    }
  }
}

function compareMarkIds(left, right) {
  return left[0] - right[0] || left[1] - right[1]
}

function findMark(state, id) {
  let low = 0, high = state.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const comparison = compareMarkIds(state[middle].id, id)
    if (comparison === 0) return {found: true, index: middle}
    if (comparison < 0) low = middle + 1; else high = middle
  }
  return {found: false, index: low}
}

function sameScalar(left, right) {
  return left.value === right.value && left.datatype === right.datatype
}

function markBelow(state, index, name) {
  for (let i = index - 1; i >= 0; i--) if (state[i].name === name) return state[i]
  return null
}

function markAbove(state, index, name) {
  for (let i = index; i < state.length; i++) if (state[i].name === name) return true
  return false
}

function markBegin(machine, id, name, value) {
  const {found, index} = findMark(machine.state, id)
  if (found) return
  if (!markAbove(machine.state, index, name)) {
    const below = markBelow(machine.state, index, name)
    if (!below || !sameScalar(below.value, value)) machine.current = new Map(machine.current).set(name, value)
  }
  machine.state.splice(index, 0, {id, name, value})
}

function markEnd(machine, id) {
  const {found, index} = findMark(machine.state, [id[0] - 1, id[1]])
  if (!found) return
  const [mark] = machine.state.splice(index, 1)
  if (markAbove(machine.state, index, mark.name)) return
  const below = markBelow(machine.state, index, mark.name)
  if (below && sameScalar(below.value, mark.value)) return
  machine.current = new Map(machine.current)
  if (below) machine.current.set(mark.name, below.value); else machine.current.delete(mark.name)
}

function markChanges(marks) {
  if (marks.changes) return marks.changes
  const changes = []
  marks.changes = changes
  if (!marks.before && !marks.after) return changes
  const names = new Set([...(marks.before || NO_MARKS).keys(), ...(marks.after || NO_MARKS).keys()])
  for (const name of [...names].sort(compareUtf8)) {
    const before = marks.before && marks.before.get(name), after = marks.after && marks.after.get(name)
    if (before && !after) {
      if (before.value !== null) changes.push([name, NULL_VALUE])
    } else if (after && !before) {
      if (after.value !== null) changes.push([name, after])
    } else if (!sameScalar(before, after)) {
      changes.push([name, after])
    }
  }
  return changes
}

function sameMarkList(left, right) {
  if (left === right) return true
  if (!left || !right || left.length !== right.length) return false
  return left.every(([name, value], i) => name === right[i][0] && sameScalar(value, right[i][1]))
}

function marksWithDiff(marks, diff) {
  if (diff === SAME) return marks
  if (diff === ADD && marks.after) return {before: null, after: marks.after}
  return NO_MARK_DIFF
}

function addedMarks(marks, raw) {
  if (!marks.after) return []
  return [...marks.after].filter(([, value]) => raw || value.value !== null).sort((left, right) => compareUtf8(left[0], right[0]))
}

function textSpans(rows, before, after, actorRank, addedKey) {
  const spans = [], shared = {state: [], current: NO_MARKS}, machines = {before: shared, after: shared}
  let index = 0, next = null, marks = NO_MARK_DIFF
  function flush() {
    if (next && next.length > 0) {
      spans.push({diff: next.diff, text: next.text, index, marks: next.marks})
      if (next.diff !== DEL) index += next.length
    }
    next = null
  }
  function applyMark(row, diff) {
    const id = [row[idCtrIdx], actorRank[row[idActorIdx]]], name = row[markNameIdx]
    const value = name === null ? null : decodeValue(row[valLenIdx], row[valRawIdx])
    if (diff !== SAME && machines.before === machines.after) {
      machines.after = {state: machines.before.state.slice(), current: machines.before.current}
    }
    const targets = machines.before === machines.after ? [machines.before]
      : diff === ADD ? [machines.after] : diff === DEL ? [machines.before] : [machines.before, machines.after]
    for (const machine of targets) {
      if (name === null) markEnd(machine, id); else markBegin(machine, id, name, value)
    }
    const markBefore = machines.before.current.size > 0 ? machines.before.current : null
    const markAfter = machines.after.current.size > 0 ? machines.after.current : null
    marks = markBefore || markAfter ? {before: markBefore, after: markAfter} : NO_MARK_DIFF
  }
  let topBefore = null, topAfter = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.skip) {
      const states = [machines.before.state, machines.after.state]
      if (states[0] === states[1] || (states[0].length === states[1].length && states[0].every((mark, k) => compareMarkIds(mark.id, states[1][k].id) === 0))) {
        if (row.summary.visible > 0) {
          flush()
          spans.push({skipped: row.summary, index})
        }
        for (const mark of row.summary.marks) applyMark(mark, SAME)
        index += row.summary.visible
        i += row.length
      }
      continue
    }
    if (row[insertIdx]) {
      topBefore = null
      topAfter = null
      for (let j = i; j < rows.length && (j === i || (!rows[j].skip && !rows[j][insertIdx])); j++) {
        if (visibleAt(rows[j], before, null)) topBefore = rows[j]
        if (visibleAt(rows[j], after, null)) topAfter = rows[j]
      }
    }
    if (row !== topBefore && row !== topAfter) continue
    const diff = row === topAfter ? (row === topBefore ? SAME : ADD) : DEL, action = row[actionIdx]
    if (action === MARK_ACTION) {
      applyMark(row, diff)
      continue
    }
    if (action === MAKE_MAP_ACTION) {
      flush()
      spans.push({diff, row, index, expose: covers(before, row), marks})
      if (diff !== DEL) index++
      continue
    }
    let text = '\ufffc'
    if (action === SET_ACTION) {
      const decoded = decodeValue(row[valLenIdx], row[valRawIdx])
      if (typeof decoded.value === 'string' && !decoded.datatype) text = decoded.value
    } else if (action === DEL_ACTION || action === INC_ACTION) {
      continue
    }
    const changes = addedKey && diff === ADD ? addedKey : markChanges
    if (next && (diff !== next.diff || (marks !== next.marks && !sameMarkList(changes(marks), changes(next.marks))))) flush()
    if (!next) next = {diff, text: '', length: 0, marks: marksWithDiff(marks, diff)}
    next.text += text
    next.length += text.length
  }
  flush()
  return spans
}

function exportMarks(marks) {
  const changes = markChanges(marks)
  return changes.length > 0 ? changes : null
}

function opIdString(row, actorIds) {
  return `${row[idCtrIdx]}@${actorIds[row[idActorIdx]]}`
}

function isMakeRow(row) {
  return row[actionIdx] < ACTIONS.length && row[actionIdx] % 2 === 0
}

function rowValue(ctx, row, incAfter) {
  if (isMakeRow(row)) {
    const value = ctx.valueOf({objectType: OBJECT_TYPE[ACTIONS[row[actionIdx]]]})
    if (isObject(value)) OBJECT_IDS.set(value, opIdString(row, ctx.doc.actorIds))
    return value
  }
  const decoded = decodeValue(row[valLenIdx], row[valRawIdx])
  if (decoded.datatype === 'counter') decoded.value = addInt(decoded.value, incAfter)
  return ctx.valueOf(decoded)
}

function diffRows(ctx, objectId, diff) {
  const key = diff ? `diff ${objectId}` : objectId
  let rows = ctx.rows.get(key)
  if (!rows) {
    rows = objectRows(ctx.doc, objectId, objectType(ctx, objectId), diff ? ctx.before : null, ctx.after,
      diff ? ctx.touched.get(objectId) : null)
    ctx.rows.set(key, rows)
  }
  return rows
}

function objectType(ctx, objectId) {
  const meta = ctx.doc.objectMeta[objectId]
  return meta && meta.type
}

function updatePathMap(ctx, parent) {
  const type = objectType(ctx, parent), rows = diffRows(ctx, parent, false)
  if (type === 'text') {
    for (const span of textSpans(rows, null, ctx.after, ctx.actorRank)) {
      if (span.row) ctx.pathMap.set(opIdString(span.row, ctx.doc.actorIds), {prop: span.index, parent})
    }
  } else {
    for (const item of propertyItems(rows, type, null, ctx.after)) {
      if (isMakeRow(item.row)) ctx.pathMap.set(opIdString(item.row, ctx.doc.actorIds), {prop: item.prop, parent})
    }
  }
}

function rootEntry(doc, objectId, key) {
  const values = doc.visibleMapOps.get(JSON.stringify([null, null, key]))
  if (!values) return undefined
  let top = null
  for (const value of values) {
    const at = value.indexOf('@'), id = `${value.slice(0, at)}@${doc.actorIds[value.slice(at + 1)]}`
    if (top === null || compareObjectIds(id, top) > 0) top = id
  }
  return top === objectId ? {prop: key, parent: '_root'} : null
}

function parentEntry(ctx, objectId) {
  const entry = ctx.pathMap.get(objectId)
  if (entry) return entry
  const meta = ctx.doc.objectMeta[objectId]
  if (!meta || ctx.seen.has(objectId)) return null
  const skipped = ctx.skipped.has(meta.parentObj) && skippedEntry(ctx, meta.parentObj, objectId)
  if (skipped) {
    ctx.pathMap.set(objectId, skipped)
    return skipped
  }
  const root = meta.parentObj === '_root' && ctx.after.every(counter => counter >= ctx.doc.maxOp) ? rootEntry(ctx.doc, objectId, meta.parentKey) : undefined
  ctx.seen.add(objectId)
  if (root !== undefined) {
    if (root) ctx.pathMap.set(objectId, root)
    return root
  }
  updatePathMap(ctx, meta.parentObj)
  return ctx.pathMap.get(objectId) || null
}

function patchPath(ctx, objectId) {
  const path = []
  while (objectId !== '_root') {
    const entry = ctx.pathMap.get(objectId) || parentEntry(ctx, objectId)
    if (!entry) return null
    path.push(entry.prop)
    objectId = entry.parent
  }
  return path.reverse()
}

function reachable(ctx, objectId) {
  if (ctx.reachable.has(objectId)) return ctx.reachable.get(objectId)
  const meta = ctx.doc.objectMeta[objectId]
  let result = false
  const unscanned = meta && ctx.truncated.has(meta.parentObj) && !ctx.truncated.get(meta.parentObj).has(objectId)
  if (meta && ctx.children.has(meta.parentObj) && !unscanned) {
    result = ctx.children.get(meta.parentObj).has(objectId) || skippedEntry(ctx, meta.parentObj, objectId) !== null
  } else if (meta && (!ctx.touched.has(meta.parentObj) || unscanned)) {
    result = parentEntry(ctx, objectId) !== null && reachable(ctx, meta.parentObj)
  }
  ctx.reachable.set(objectId, result)
  return result
}

function lastPatch(ctx, objectId) {
  const last = ctx.patches.length - 1
  return last >= 0 && ctx.patchObjects[last] === objectId ? ctx.patches[last] : null
}

function pushPatch(ctx, objectId, patch) {
  ctx.patches.push(patch)
  ctx.patchObjects.push(objectId)
  ctx.lastMarks = null
}

function popPatch(ctx) {
  ctx.patches.pop()
  ctx.patchObjects.pop()
}

function addPatch(ctx, objectId, prop, patch) {
  const path = patchPath(ctx, objectId)
  if (!path) return false
  patch.path = prop === undefined ? path : path.concat(prop)
  pushPatch(ctx, objectId, patch)
  return true
}

function lastIndex(patch) {
  return patch.path[patch.path.length - 1]
}

function insertPatch(ctx, objectId, index, value, conflict) {
  const last = lastPatch(ctx, objectId)
  if (last && last.action === 'insert' && index >= lastIndex(last) && index <= lastIndex(last) + last.values.length) {
    last.values.splice(index - lastIndex(last), 0, value)
    last.conflicts.splice(index - lastIndex(last), 0, conflict)
    return
  }
  addPatch(ctx, objectId, index, {action: 'insert', path: null, values: [value], conflicts: [conflict]})
}

function splicePatch(ctx, objectId, index, text, marks) {
  const last = lastPatch(ctx, objectId)
  if (last && last.action === 'splice' && sameMarkList(marks, ctx.lastMarks) &&
      index >= lastIndex(last) && index <= lastIndex(last) + last.value.length) {
    const at = index - lastIndex(last)
    last.value = last.value.slice(0, at) + text + last.value.slice(at)
    return
  }
  if (addPatch(ctx, objectId, index, {action: 'splice', path: null, value: text, marks})) ctx.lastMarks = marks
}

function deletePatch(ctx, objectId, index, length) {
  const last = lastPatch(ctx, objectId)
  if (last && (last.action === 'splice' || last.action === 'insert')) {
    const tail = lastIndex(last), size = last.action === 'splice' ? last.value.length : last.values.length
    if (index >= tail && index + length - 1 < tail + size && index + length - 1 >= tail) {
      const at = index - tail
      if (last.action === 'splice') {
        last.value = last.value.slice(0, at) + last.value.slice(at + length)
        if (last.value.length === 0) popPatch(ctx)
      } else {
        last.values.splice(at, length)
        last.conflicts.splice(at, length)
        if (last.values.length === 0) popPatch(ctx)
      }
      return
    }
  } else if (last && last.action === 'del' && typeof lastIndex(last) === 'number' && lastIndex(last) === index) {
    last.length += length
    return
  }
  addPatch(ctx, objectId, index, {action: 'del', path: null, length})
}

function markPatch(ctx, objectId, marks) {
  const last = lastPatch(ctx, objectId)
  if (last && last.action === 'mark') {
    last.marks.push(...marks)
    return
  }
  if (marks.length > 0) addPatch(ctx, objectId, undefined, {action: 'mark', path: null, marks})
}

function conflictPatch(ctx, objectId, prop) {
  const last = lastPatch(ctx, objectId)
  if (last && last.action === 'put' && lastIndex(last) === prop) {
    last.conflict = true
    return
  }
  addPatch(ctx, objectId, prop, {action: 'conflict', path: null})
}

function exposeObject(ctx, objectId) {
  if (!ctx.exposed.includes(objectId)) {
    ctx.exposed.push(objectId)
    ctx.exposed.sort(compareObjectIds)
  }
}

function compareObjectIds(left, right) {
  if (left === right) return 0
  if (left === '_root') return -1
  if (right === '_root') return 1
  const l = parseOpId(left), r = parseOpId(right)
  return l.counter - r.counter || (l.actorId < r.actorId ? -1 : l.actorId > r.actorId ? 1 : 0)
}

function flushExposed(ctx, objectId) {
  ctx.exposed.splice(ctx.exposed.indexOf(objectId), 1)
  const type = objectType(ctx, objectId), rows = diffRows(ctx, objectId, false)
  if (type === 'text') {
    for (const span of textSpans(rows, null, ctx.after, ctx.actorRank)) {
      if (span.row) {
        const value = ctx.valueOf({objectType: 'map'})
        OBJECT_IDS.set(value, opIdString(span.row, ctx.doc.actorIds))
        exposeObject(ctx, opIdString(span.row, ctx.doc.actorIds))
        insertPatch(ctx, objectId, span.index, value, false)
      } else {
        splicePatch(ctx, objectId, span.index, span.text, exportMarks(span.marks))
      }
    }
    return
  }
  for (const item of propertyItems(rows, type, null, ctx.after)) {
    if (isMakeRow(item.row)) exposeObject(ctx, opIdString(item.row, ctx.doc.actorIds))
    const value = rowValue(ctx, item.row, item.incAfter)
    if (type === 'list') insertPatch(ctx, objectId, item.prop, value, item.conflict)
    else addPatch(ctx, objectId, item.prop, item.conflict ? {action: 'put', path: null, value, conflict: true} : {action: 'put', path: null, value})
  }
}

function skippedEntry(ctx, parent, objectId) {
  let entries = ctx.skippedEntries.get(parent)
  if (!entries) {
    entries = new Map()
    for (const {summary, base} of ctx.skipped.get(parent) || []) {
      for (const {row, offset} of summary.children) {
        entries.set(opIdString(row, ctx.doc.actorIds), {prop: typeof offset === 'string' ? offset : base + offset, parent})
      }
    }
    ctx.skippedEntries.set(parent, entries)
  }
  return entries.get(objectId) || null
}

function markEvent(events, objectId, marks, index, length) {
  let last = events[events.length - 1]
  if (!last || last.kind !== 'mark') events.push(last = {objectId, kind: 'mark', marks: new Map()})
  for (const [name, value] of marks) {
    let ranges = last.marks.get(name)
    if (!ranges) last.marks.set(name, ranges = [])
    const tail = ranges[ranges.length - 1]
    if (tail && sameScalar(tail.value, value) && tail.end === index) tail.end += length
    else ranges.push({value, start: index, end: index + length})
  }
}

function trailingInsertShift(ctx, rows, type, events, first) {
  let last = -1
  for (let i = 0; i < rows.length; i++) if (rows[i].skip || rows[i][insertIdx] && covers(ctx.before, rows[i])) last = i
  if (last < 0 || rows[last].skip) return
  let end = last + 1
  while (end < rows.length && !rows[end].skip && !rows[end][insertIdx]) end++
  const group = rows.slice(last, end), ids = new Set(group.map(row => `${row[idCtrIdx]}@${row[idActorIdx]}`))
  function compare(a, b) { return a[0] - b[0] || ctx.actorRank[a[1]] - ctx.actorRank[b[1]] }
  let maxDoc = null, update = null
  for (const row of group) {
    const id = [row[idCtrIdx], row[idActorIdx]]
    for (let i = 0; i < row[succNumIdx]; i++) {
      const succ = [row[succCtrIdx][i], row[succActorIdx][i]]
      if (!ids.has(`${succ[0]}@${succ[1]}`) && ctx.after && succ[0] <= ctx.after[succ[1]] && !(ctx.before && succ[0] <= ctx.before[succ[1]]) &&
          (!update || compare(succ, update.id) > 0)) update = {id: succ, visible: false}
    }
    if (covers(ctx.before, row)) {
      if (!maxDoc || compare(id, maxDoc) > 0) maxDoc = id
    } else if (covers(ctx.after, row) && (!update || compare(id, update.id) > 0)) {
      update = {id, visible: row[actionIdx] !== INC_ACTION && visibleAt(row, ctx.after, null)}
    }
  }
  if (!update || update.visible || compare(update.id, maxDoc) < 0) return
  const top = group.find(row => row[actionIdx] !== MARK_ACTION && visibleAt(row, ctx.after, groupIncrements(group, 0, group.length)))
  if (!top) return
  const width = type === 'text' ? textWidth(top) : 1
  let trailing = 0
  for (let i = end; i < rows.length;) {
    let next = i + 1
    while (next < rows.length && !rows[next].skip && !rows[next][insertIdx]) next++
    const visible = rows.slice(i, next).find(row => !row.skip && row[actionIdx] !== MARK_ACTION && visibleAt(row, ctx.after, groupIncrements(rows, i, next)))
    if (visible) trailing += type === 'text' ? textWidth(visible) : 1
    i = next
  }
  for (let i = events.length - 1; i >= first && trailing > 0; i--) {
    const event = events[i]
    if (event.kind !== 'insert' && event.kind !== 'splice') continue
    trailing -= event.kind === 'splice' ? event.text.length : 1
    event.prop -= width
  }
}

function objectEvents(ctx, objectId, events) {
  const first = events.length
  objectEventsInner(ctx, objectId, events)
  if (ctx.batch && objectType(ctx, objectId) !== 'map' && events.slice(first).some(event => event.kind === 'insert' || event.kind === 'splice')) {
    const rows = diffRows(ctx, objectId, true)
    trailingInsertShift(ctx, rows.truncated ? diffRows(ctx, objectId, false) : rows, objectType(ctx, objectId), events, first)
  }
}

function objectEventsInner(ctx, objectId, events) {
  const type = objectType(ctx, objectId), rows = diffRows(ctx, objectId, true), children = new Set(), skipped = []
  ctx.children.set(objectId, children)
  ctx.skipped.set(objectId, skipped)
  if (rows.truncated) {
    ctx.truncated.set(objectId, new Set(rows.flatMap(row => (row.skip ? row.summary.children.map(child => child.row) : [row]))
      .filter(isMakeRow).map(row => opIdString(row, ctx.doc.actorIds))))
  }
  if (type === 'text') {
    for (const span of textSpans(rows, ctx.before, ctx.after, ctx.actorRank, ctx.batch && (marks => addedMarks(marks, true)))) {
      if (span.skipped) {
        skipped.push({summary: span.skipped, base: span.index})
      } else if (span.row) {
        if (span.diff !== DEL) {
          children.add(opIdString(span.row, ctx.doc.actorIds))
          ctx.pathMap.set(opIdString(span.row, ctx.doc.actorIds), {prop: span.index, parent: objectId})
        }
        if (span.diff === ADD) {
          const value = ctx.valueOf({objectType: 'map'})
          OBJECT_IDS.set(value, opIdString(span.row, ctx.doc.actorIds))
          events.push({objectId, kind: 'insert', prop: span.index, value, conflict: false, row: span.row})
          if (span.expose) exposeObject(ctx, opIdString(span.row, ctx.doc.actorIds))
        } else if (span.diff === DEL) {
          events.push({objectId, kind: 'del', prop: span.index, length: 1})
        } else if (ctx.batch) {
          const marks = exportMarks(span.marks)
          if (marks) markEvent(events, objectId, marks, span.index, 1)
        }
      } else if (span.diff === ADD) {
        const marks = addedMarks(span.marks, ctx.batch)
        events.push({objectId, kind: 'splice', prop: span.index, text: span.text, marks: marks.length > 0 ? marks : null})
      } else if (span.diff === DEL) {
        events.push({objectId, kind: 'del', prop: span.index, length: span.text.length})
      } else {
        const marks = exportMarks(span.marks)
        if (marks) markEvent(events, objectId, marks, span.index, span.text.length)
      }
    }
    return
  }
  const isList = type === 'list'
  for (const item of propertyItems(rows, type, ctx.before, ctx.after)) {
    if (item.skipped) {
      skipped.push({summary: item.skipped, base: item.prop})
      continue
    }
    if (item.diff !== DEL && isMakeRow(item.row)) children.add(opIdString(item.row, ctx.doc.actorIds))
    if (item.top && isMakeRow(item.top)) ctx.pathMap.set(opIdString(item.top, ctx.doc.actorIds), {prop: item.prop, parent: objectId})
    if (ctx.batch) {
      batchEvents(ctx, objectId, rows, item, isList, events)
    } else if (item.diff === ADD) {
      const value = rowValue(ctx, item.row, item.incAfter)
      if (item.expose && isMakeRow(item.row)) exposeObject(ctx, opIdString(item.row, ctx.doc.actorIds))
      events.push({objectId, kind: isList && !item.update ? 'insert' : 'put', prop: item.prop, value, conflict: item.conflict, row: item.row})
    } else if (item.diff === SAME) {
      if (item.inc !== 0) events.push({objectId, kind: 'inc', prop: item.prop, value: item.inc, row: item.row})
      else if (item.conflict) events.push({objectId, kind: 'conflict', prop: item.prop})
    } else if (isList) {
      events.push({objectId, kind: 'del', prop: item.prop, length: 1})
    } else {
      events.push({objectId, kind: 'delMap', prop: item.prop})
    }
  }
}

const EVENT_PATCHES = {
  put: (ctx, event) => addPatch(ctx, event.objectId, event.prop, event.conflict
    ? {action: 'put', path: null, value: event.value, conflict: true} : {action: 'put', path: null, value: event.value}),
  insert: (ctx, event) => insertPatch(ctx, event.objectId, event.prop, event.value, event.conflict),
  splice: (ctx, event) => splicePatch(ctx, event.objectId, event.prop, event.text, event.marks),
  del: (ctx, event) => deletePatch(ctx, event.objectId, event.prop, event.length),
  delMap: (ctx, event) => addPatch(ctx, event.objectId, event.prop, {action: 'del', path: null}),
  inc: (ctx, event) => addPatch(ctx, event.objectId, event.prop, {action: 'inc', path: null, value: event.value}),
  conflict: (ctx, event) => conflictPatch(ctx, event.objectId, event.prop),
  mark: (ctx, event) => {
    const marks = []
    for (const name of [...event.marks.keys()].sort(compareUtf8)) {
      for (const {value, start, end} of event.marks.get(name)) marks.push({name, value: ctx.valueOf(value, true), start, end})
    }
    markPatch(ctx, event.objectId, marks)
  }
}

function exportPatch(ctx, patch) {
  if (patch.action === 'insert') {
    const result = {action: 'insert', path: patch.path, values: patch.values}
    if (patch.conflicts.some(Boolean)) result.conflicts = patch.conflicts
    return result
  }
  if (patch.action === 'splice') return exportSplice(ctx, patch.path, patch.value, patch.marks)
  if (patch.action === 'del' && patch.length !== undefined) return exportDel(patch.path, patch.length)
  return patch
}

function exportSplice(ctx, path, value, marks) {
  const result = {action: 'splice', path, value: wellFormedString(value)}
  if (marks) result.marks = Object.fromEntries(marks.map(([name, value]) => [name, ctx.valueOf(value, true)]))
  return result
}

function exportDel(path, length) {
  return length > 1 ? {action: 'del', path, length} : {action: 'del', path}
}

function descendsFrom(objectMeta, objectId, ancestor) {
  while (objectId !== ancestor) {
    if (!objectMeta[objectId]) return false
    objectId = objectMeta[objectId].parentObj
  }
  return true
}

function diffContext(doc, beforeClock, afterClock, objectIds, valueOf, start, batch) {
  const sortedActors = doc.actorIds.slice().sort()
  return {
    doc, valueOf, before: beforeClock, after: afterClock, rows: new Map(), pathMap: new Map(), seen: new Set(),
    actorRank: doc.actorIds.map(actor => sortedActors.indexOf(actor)),
    patches: [], patchObjects: [], lastMarks: null, exposed: [], batch,
    touched: objectIds, children: new Map(), skipped: new Map(), skippedEntries: new Map(), truncated: new Map(), reachable: new Map().set(start, true)
  }
}

function documentDiff(doc, beforeClock, afterClock, objectIds, valueOf, start, recursive, batch, actorMap) {
  const ctx = diffContext(doc, beforeClock, afterClock, objectIds, valueOf, start, batch)
  const events = []
  for (const objectId of [...objectIds.keys()].sort(compareObjectIds)) {
    if ((objectId === start || recursive && (start === '_root' || descendsFrom(doc.objectMeta, objectId, start))) && (batch || reachable(ctx, objectId))) {
      objectEvents(ctx, objectId, events)
    }
  }
  return buildPatches(ctx, actorMap ? remapActors(ctx, events, actorMap) : events)
}

function remappedId(id, actorMap) {
  if (id === '_root') return id
  const {counter, actorId} = parseOpId(id)
  if (!actorMap.has(actorId)) return id
  const actor = actorMap.get(actorId)
  if (isObject(actor)) throw new PanicError(`index out of bounds: the len is ${actor.len} but the index is ${actor.index}`)
  return actor === null ? null : `${counter}@${actor}`
}

function remapActors(ctx, events, actorMap) {
  ctx.exposed = ctx.exposed.map(id => remappedId(id, actorMap)).filter(id => id !== null).sort(compareObjectIds)
  const kept = []
  for (const event of events) {
    const objectId = remappedId(event.objectId, actorMap)
    if (objectId === null) continue
    const id = event.row && opIdString(event.row, ctx.doc.actorIds), rawId = id && remappedId(id, actorMap)
    if (rawId === null) continue
    if (rawId !== id && isMakeRow(event.row) && isObject(event.value)) {
      OBJECT_IDS.set(event.value, rawId)
      if (!ctx.doc.objectMeta[rawId]) RAW_OBJECT_IDS.set(event.value, rawId)
    }
    kept.push(objectId === event.objectId ? event : Object.assign({}, event, {objectId}))
  }
  return kept
}

function spliceMarks(ctx, event, actor) {
  if (!ctx.doc.objectsWithMarks.has(event.objectId)) return null
  const doc = ctx.doc, clock = ctx.after.slice(), {counter, actorId} = parseOpId(event.objectId)
  const key = `${counter}@${doc.actorIndexById.get(actorId)}`
  let machine = NO_MACHINE, top = null, inMark = false, last = false
  clock[actor] = event.counter
  for (let index = findBlock(doc.blocks, doc.actorIds, actorId, counter, null); !last && index < doc.blocks.length; index++) {
    const block = doc.blocks[index], segment = blockObjects(block).get(key)
    last = compareBlockObject(block, doc.actorIds, actorId, counter) > 0
    if (!segment) continue
    const rows = columnOperationCache(block.columns).operations
    if (opensGroup(block, key) && !bloomFilterContains(block.bloom, actor, event.counter) && (last || opensGroup(doc.blocks[index + 1], key))) {
      const summary = segmentSummary(segment, rows, 'text')
      if (settledAt(summary, ctx.before, clock)) {
        if (inMark && top && top[actionIdx] === MARK_ACTION) machine = markStep(ctx, top, machine, null)
        inMark = false
        machine = markStep(ctx, summary, machine, summary.marks)
        continue
      }
    }
    for (let i = segment.start; i < segment.end; i++) {
      const row = rows[i]
      if (!inMark && row[actionIdx] !== MARK_ACTION && row[idCtrIdx] !== event.counter) continue
      if (row[insertIdx]) {
        if (inMark && top && top[actionIdx] === MARK_ACTION) machine = markStep(ctx, top, machine, null)
        if (row[idCtrIdx] === event.counter && row[idActorIdx] === actor) {
          return exportMarks({before: null, after: machine.current.size > 0 ? machine.current : null})
        }
        inMark = row[actionIdx] === MARK_ACTION
        top = null
      }
      if (inMark && visibleAt(row, clock, null)) top = row
    }
  }
  return null
}

function opensGroup(block, key) {
  const segment = block && blockObjects(block).get(key)
  return !segment || columnOperationCache(block.columns).operations[segment.start][insertIdx]
}

function markStep(ctx, key, machine, rows) {
  const step = MARK_STEPS.get(key)
  if (step && step.from === machine && step.actorIds === ctx.doc.actorIds) return step.to
  let to = machine
  if (rows) {
    for (const row of rows) to = markStep(ctx, row, to, null)
  } else if (key[markNameIdx] === null && machine.begin && machine.begin[idCtrIdx] === key[idCtrIdx] - 1 && machine.begin[idActorIdx] === key[idActorIdx]) {
    to = machine.from
  } else {
    to = {state: machine.state.slice(), current: machine.current, begin: null, from: null}
    machineMark(to, key, ctx.actorRank)
    if (key[markNameIdx] !== null && to.state.length > machine.state.length) {
      to.begin = key
      to.from = machine
    }
  }
  MARK_STEPS.set(key, {from: machine, to, actorIds: ctx.doc.actorIds})
  return to
}

function machineMark(machine, row, actorRank) {
  const id = [row[idCtrIdx], actorRank[row[idActorIdx]]], name = row[markNameIdx]
  if (name === null) markEnd(machine, id); else markBegin(machine, id, name, decodeValue(row[valLenIdx], row[valRawIdx]))
}

function rootObject(doc, objectId) {
  const meta = doc.objectMeta[objectId]
  return meta && meta.parentObj === '_root' && rootEntry(doc, objectId, meta.parentKey)
}

function localContext(doc, change, actor, startOp, afterClock, objects, valueOf) {
  const beforeClock = afterClock.slice(), parents = new Set(), objectIds = new Map()
  beforeClock[actor] = startOp - 1
  for (const objectId of objects) {
    let meta = doc.objectMeta[objectId]
    while (meta && meta.parentObj && !parents.has(meta.parentObj)) {
      parents.add(meta.parentObj)
      meta = doc.objectMeta[meta.parentObj]
    }
  }
  const touchedParents = [...parents].filter(objectId => objects.has(objectId)).sort(compareObjectIds)
  if (touchedParents.length > 0) changeObjects(decodeTargets(change), objectIds, doc.actorIndexById)
  const ctx = diffContext(doc, beforeClock, afterClock, objectIds, valueOf, '_root', false)
  for (const objectId of touchedParents) objectEvents(ctx, objectId, [])
  ctx.exposed = []
  return ctx
}

function localPatches(doc, change, actor, startOp, clock, events, valueOf) {
  const objects = new Set(events.map(event => event.objectId)), pathMap = new Map(), event = events[0]
  for (const objectId of objects) if (objectId !== '_root') pathMap.set(objectId, rootObject(doc, objectId))
  const lean = objects.has('_root') ? objects.size === 1 : [...pathMap.values()].every(Boolean)
  const ctx = lean && ![...objects].some(objectId => doc.objectsWithMarks.has(objectId))
    ? {valueOf, pathMap, patches: [], patchObjects: [], lastMarks: null, exposed: []}
    : localContext(doc, change, actor, startOp, doc.opClock(clock), objects, valueOf)
  if (lean && events.length === 1 && (event.kind === 'splice' || event.kind === 'del')) {
    const path = [pathMap.get(event.objectId).prop, event.prop]
    return [event.kind === 'splice' ? exportSplice(ctx, path, event.text, doc.objectsWithMarks.has(event.objectId) ? spliceMarks(ctx, event, actor) : null) : exportDel(path, event.length)]
  }
  return eventPatches(doc, ctx, events, actor, valueOf)
}

function eventPatches(doc, ctx, events, actor, valueOf) {
  const sorted = events.slice().sort((left, right) => compareObjectIds(left.objectId, right.objectId)).map(event => {
    if (event.kind === 'put' || event.kind === 'insert') return Object.assign({}, event, {value: valueOf(event.value), conflict: false})
    if (event.kind === 'splice') return {objectId: event.objectId, kind: 'splice', prop: event.prop, text: event.text, marks: doc.objectsWithMarks.has(event.objectId) ? spliceMarks(ctx, event, actor) : null}
    return event
  })
  return buildPatches(ctx, sorted)
}

function isolatedPatches(doc, current, scope, after, touched, change, actor, events, valueOf, actorMap) {
  const isolation = diffContext(doc, current, scope, touched, valueOf, '_root', false)
  let diffEvents = []
  for (const objectId of [...touched.keys()].sort(compareObjectIds)) {
    if (reachable(isolation, objectId)) objectEvents(isolation, objectId, diffEvents)
  }
  if (actorMap) diffEvents = remapActors(isolation, diffEvents, actorMap)
  const changed = new Map()
  changeObjects(decodeTargets(change), changed, doc.actorIndexById)
  const local = diffContext(doc, scope, after, changed, valueOf, '_root', false)
  const ctx = diffContext(doc, scope, after, new Map(), valueOf, '_root', false)
  ctx.exposed = isolation.exposed
  const sorted = diffEvents.concat(events.map(event => {
    if (event.kind === 'put' || event.kind === 'insert') return Object.assign({}, event, {value: valueOf(event.value), conflict: false})
    if (event.kind === 'splice') return {objectId: event.objectId, kind: 'splice', prop: event.prop, text: event.text, marks: spliceMarks(local, event, actor)}
    return event
  })).sort((left, right) => compareObjectIds(left.objectId, right.objectId))
  return buildPatches(ctx, sorted)
}

function buildPatches(ctx, events) {
  for (const event of events) {
    while (ctx.exposed.length > 0 && compareObjectIds(ctx.exposed[0], event.objectId) < 0) flushExposed(ctx, ctx.exposed[0])
    if (ctx.exposed[0] === event.objectId) continue
    if (EVENT_PATCHES[event.kind]) EVENT_PATCHES[event.kind](ctx, event)
  }
  while (ctx.exposed.length > 0) flushExposed(ctx, ctx.exposed[0])
  return ctx.patches.map((patch, i) => {
    const exported = exportPatch(ctx, patch)
    PATCH_OBJECTS.set(exported, ctx.patchObjects[i])
    return exported
  })
}

class BackendDoc {
  constructor(buffer) {
    this.maxOp = 0
    this.numChangeOps = 0
    this.haveHashGraph = false
    this.changes = []
    this.historyHashes = []
    this.changeIndexByHash = {}
    this.dependenciesByHash = {}
    this.dependentsByHash = {}
    this.hashesByActor = {}
    this.actorIds = []
    this.actorIndexById = new Map()
    this.heads = []
    this.clock = {}
    this.queue = []
    this.saveCursor = 0
    this.objectMeta = {_root: {parentObj: null, parentKey: null, opId: null, type: 'map', children: {}}}
    this.visibleMapOps = new Map()
    this.cursorIndex = new Map()
    this.objectsWithMarks = new Set()

    this.patchActors = []
    this.counters = false
    if (buffer) {
      const doc = decodeDocumentHeader(buffer)
      const {clock, headActors, numChanges} = readDocumentChanges(doc)
      this.binaryDoc = buffer
      this.numChangeOps = null
      this.changes = new Array(numChanges)
      this.historyHashes = new Array(numChanges)
      this.saveCursor = numChanges
      this.actorIds = doc.actorIds
      this.actorIndexById = new Map(this.actorIds.map((actor, index) => [actor, index]))
      this.heads = doc.heads
      this.clock = clock
      this.changesColumns = doc.changesColumns
      this.changesEncoders = null
      this.extraBytes = doc.extraBytes

      // If there is a single head, we can unambiguously point at the actorId and sequence number of
      // the head hash without having to reconstruct the hash graph
      if (doc.heads.length === 1 && headActors.length === 1) {
        this.hashesByActor[headActors[0]] = []
        this.hashesByActor[headActors[0]][clock[headActors[0]] - 1] = doc.heads[0]
      }

      // The encoded document gives each change an index, and expresses dependencies in terms of
      // those indexes. Initialise the translation table from hash to index.
      if (doc.heads.length === doc.headsIndexes.length) {
        for (let i = 0; i < doc.heads.length; i++) {
          this.changeIndexByHash[doc.heads[i]] = doc.headsIndexes[i]
        }
      } else if (doc.heads.length === 1) {
        // If there is only one head, it must be the last change
        this.changeIndexByHash[doc.heads[0]] = numChanges - 1
      } else {
        // We know the heads hashes, but not their indexes
        for (let head of doc.heads) this.changeIndexByHash[head] = -1
      }

      this.blocks = [{columns: makeDecoders(doc.opsColumns, DOC_OPS_COLUMNS)}]
      resetBlockMetadata(this.blocks[0])
      LOADED_DOCUMENTS.set(buffer, {header: doc, columns: this.blocks[0].columns})

      let docState = {blocks: this.blocks, actorIds: this.actorIds, objectMeta: this.objectMeta, maxOp: 0,
        objectsWithMarks: this.objectsWithMarks, loadVisibleMapOps: this.visibleMapOps}
      this.initPatch = documentPatch(docState)
      this.counters = hasCounter(this.initPatch)
      this.blocks = docState.blocks
      this.maxOp = docState.maxOp

    } else {
      this.haveHashGraph = true
      this.changesEncoders = columnEncoders(DOCUMENT_COLUMNS)
      this.changesColumns = null
      this.blocks = [{columns: makeDecoders([], DOC_OPS_COLUMNS)}]
      updateBlockMetadata(this.blocks[0])
    }
  }

  /**
   * Adjusts the `elemId` references of the insertion operations in a local change so that they
   * match what the Rust implementation would have generated. In Rust, mark boundaries are elements
   * of the sequence, and an insertion whose position immediately follows a "sticky" boundary (an
   * expanding markBegin, or a non-expanding markEnd) anchors on the boundary element itself rather
   * than on the preceding visible element; a begin/end pair that would be straddled by the
   * insertion point is skipped over entirely. This is a port of the candidate logic in
   * `InsertQuery` (rust/automerge/src/op_set2/op_set/insert.rs). Applying the same adjustment at
   * authoring time means the wire format alone determines placement, and the apply side can use
   * plain RGA ordering. Mutates `change.ops` in place. Only runs for objects that contain marks.
   */
  adjustInsertAnchors(change, clock) {
    const marked = new Set(this.objectsWithMarks)
    for (const op of change.ops) if (op.action === 'markBegin') marked.add(op.obj)
    if (!change.ops.some(op => op.insert && marked.has(op.obj))) return
    const targets = change.ops.filter(op => marked.has(op.obj) && op.elemId !== undefined)
    const anchor = !clock && targets.length === 1 && targets[0].insert ? rowAnchor(this, targets[0]) : null
    if (anchor !== null) {
      targets[0].elemId = anchor
      return
    }
    const elemIds = change.ops.map(op => op.elemId)
    if (!clock && this.anchorInserts(change, marked, true)) return
    change.ops.forEach((op, i) => { op.elemId = elemIds[i] })
    this.anchorInserts(change, marked, false, clock)
  }

  anchorInserts(change, marked, lazy, clock) {
    const sequences = new Map()
    let opNum = change.startOp
    for (const op of change.ops) {
      const count = op.values ? op.values.length : op.multiOp || 1
      if (marked.has(op.obj) && op.elemId !== undefined) {
        if (!sequences.has(op.obj)) sequences.set(op.obj, this.sequenceParts(op.obj, lazy, clock))
        const seq = sequences.get(op.obj)
        if (op.insert) {
          const anchor = insertAnchor(seq, op.elemId), elems = anchor && loadPart(seq, anchor.part)
          if (!elems) return false
          op.elemId = anchor.ref
          const mark = op.action === 'markBegin' ? 'begin' : op.action === 'markEnd' ? 'end' : null
          for (let i = 0; i < count; i++) {
            elems.splice(anchor.index + i, 0, {actorId: change.actor, counter: opNum + i, mark, expand: !!op.expand, visible: true})
          }
        } else {
          const {counter, actorId} = parseOpId(op.elemId), actor = this.actorIndexById.get(actorId)
          for (let i = 0; i < count; i++) {
            const found = findElem(seq, counter + i, actorId, actor)
            if (found === null) return false
            if (found) seq.parts[found.part][found.index] = Object.assign({}, seq.parts[found.part][found.index], {visible: op.action !== 'del'})
          }
        }
      }
      opNum += count
    }
    return true
  }

  sequenceParts(objectId, lazy, clock) {
    const {counter, actorId} = parseOpId(objectId), blocks = []
    const actor = this.actorIndexById.get(actorId)
    if (actor !== undefined) {
      for (let index = findBlock(this.blocks, this.actorIds, actorId, counter, null); index < this.blocks.length; index++) {
        blocks.push(this.blocks[index])
        if (compareBlockObject(this.blocks[index], this.actorIds, actorId, counter) > 0) break
      }
    }
    const seq = {blocks, parts: new Array(blocks.length), objectId, counter, actor, actorIds: this.actorIds, actorIndexById: this.actorIndexById}
    if (!lazy || blocks.length === 0) {
      const elems = [], counters = []
      for (const block of blocks) appendBlockElements(block, this.actorIds, objectId, counter, actor, elems, counters, clock)
      seq.blocks = [null]
      seq.parts = [elems]
    }
    return seq
  }

  /**
   * Makes a copy of this BackendDoc that can be independently modified.
   */
  clone() {
    let copy = new BackendDoc()
    copy.maxOp = this.maxOp
    copy.numChangeOps = this.numChangeOps
    copy.haveHashGraph = this.haveHashGraph
    copy.changes = this.changes.slice()
    copy.historyHashes = this.historyHashes.slice()
    copy.changeIndexByHash = copyObject(this.changeIndexByHash)
    copy.dependenciesByHash = copyObject(this.dependenciesByHash)
    copy.dependentsByHash = Object.entries(this.dependentsByHash).reduce((acc, [k, v]) => { acc[k] = v.slice(); return acc }, {})
    copy.hashesByActor = Object.entries(this.hashesByActor).reduce((acc, [k, v]) => { acc[k] = v.slice(); return acc }, {})
    copy.actorIds = this.actorIds // immutable, no copying needed
    copy.actorIndexById = this.actorIndexById
    copy.heads = this.heads // immutable, no copying needed
    copy.clock = this.clock // immutable, no copying needed
    copy.blocks = this.blocks // immutable, no copying needed
    copy.objectMeta = Object.fromEntries(Object.entries(this.objectMeta)
      .map(([objectId, meta]) => [objectId, Object.assign({}, meta, {children: Object.assign({}, meta.children)})]))
    copy.visibleMapOps = new Map(this.visibleMapOps)
    copy.cursorIndex = this.cursorIndex
    copy.objectsWithMarks = new Set(this.objectsWithMarks)
    copy.anchorSource = this.anchorSource
    copy.queue = this.queue // immutable, no copying needed
    copy.saveCursor = this.saveCursor
    copy.patchActors = this.patchActors
    copy.counters = this.counters
    copy.changesEncoders = this.changesEncoders &&
      this.changesEncoders.map(col => ({columnId: col.columnId, encoder: col.encoder.clone()}))
    copy.changesColumns = this.changesColumns
    copy.binaryDoc = this.binaryDoc
    copy.concatCache = this.concatCache
    copy.initPatch = this.initPatch
    copy.extraBytes = this.extraBytes
    return copy
  }

  /**
   * Parses the changes given as Uint8Arrays in `changeBuffers`, and applies them to the current
   * document. Returns a patch to apply to the frontend. If an exception is thrown, the document
   * object is not modified.
   */
  applyChanges(changeBuffers, isLocal = false, inOrder = false) {
    if (changeBuffers instanceof Uint8Array) {
      throw new TypeError('applyChanges takes an array of Uint8Arrays, not just a single Uint8Array')
    }
    if (!Array.isArray(changeBuffers)) {
      throw new TypeError('applyChanges takes an array of Uint8Arrays')
    }

    // decoded change has the form { actor, seq, startOp, time, message, deps, actorIds, hash, columns, buffer }
    return this.applyDecodedChanges(changeBuffers.map(buffer => {
      const raw = decompressChange(buffer), decoded = decodeChangeColumns(raw)
      decoded.buffer = raw
      return decoded
    }), isLocal, inOrder)
  }

  applyDecodedChanges(decodedChanges, isLocal, inOrder) {
    let queue = this.queue.concat(decodedChanges)
    if (!this.haveHashGraph) {
      const hashes = new Set(queue.map(change => change.hash))
      if (queue.some(change => change.seq <= (this.clock[change.actor] || 0) ||
          change.deps.some(dep => !(this.changeIndexByHash[dep] >= 0) && !hashes.has(dep)))) {
        this.computeHashGraph()
      }
    }
    if (queue.length > 1 && !inOrder) queue = topologicalOrder(queue, this.changeIndexByHash)

    let patches = {_root: {objectId: '_root', type: 'map', props: {}}}
    let docState = {
      maxOp: this.maxOp,
      changeIndexByHash: this.changeIndexByHash,
      appliedHashes: new Set(),
      actorIds: this.actorIds,
      actorIndexById: new Map(this.actorIndexById),
      heads: this.heads,
      clock: this.clock,
      blocks: this.blocks.slice(),
      visibleMapOps: {base: this.visibleMapOps, changes: new Map()},
      objectMeta: this.objectMeta,
      metaUndo: [],
      objectsWithMarks: new Set(this.objectsWithMarks),
      predSeek: false
    }
    let allApplied = [], objectIds = new Set()

    try {
      while (true) {
        const [applied, enqueued] = applyChanges(patches, queue, docState, objectIds, this.haveHashGraph)
        queue = enqueued
        for (const change of applied) docState.appliedHashes.add(change.hash)
        if (applied.length > 0) allApplied = allApplied.concat(applied)
        if (queue.length === 0) break

        // If we are missing a dependency, and we haven't computed the hash graph yet, first compute
        // the hashes to see if we actually have it already
        if (applied.length === 0) {
          if (this.haveHashGraph) break
          this.computeHashGraph()
          docState.changeIndexByHash = this.changeIndexByHash
        }
      }

      setupPatches(patches, objectIds, docState)
    } catch (e) {
      const undo = docState.metaUndo
      for (let i = undo.length - 3; i >= 0; i -= 3) {
        if (undo[i + 2] === undefined) delete undo[i][undo[i + 1]]
        else undo[i][undo[i + 1]] = undo[i + 2]
      }
      throw e
    }

    if (allApplied.length > 0 && !this.changesEncoders) {
      this.changesEncoders = copyDocumentChanges(this.changesColumns, this.changes.length)
      this.changesColumns = null
    }

    // Update the document state only if `applyChanges` does not throw an exception
    for (let change of allApplied) {
      this.changes.push(change.buffer)
      this.historyHashes.push(change.hash)
      if (!this.hashesByActor[change.actor]) this.hashesByActor[change.actor] = []
      this.hashesByActor[change.actor][change.seq - 1] = change.hash
      this.changeIndexByHash[change.hash] = this.changes.length - 1
      this.dependenciesByHash[change.hash] = change.deps
      this.dependentsByHash[change.hash] = []
      for (let dep of change.deps) {
        if (!this.dependentsByHash[dep]) this.dependentsByHash[dep] = []
        this.dependentsByHash[dep].push(change.hash)
      }
      appendChange(this.changesEncoders, change, docState.actorIndexById, this.changeIndexByHash)
      if (this.numChangeOps !== null) this.numChangeOps += change.maxOp - change.startOp + 1
    }

    this.maxOp        = docState.maxOp
    if (docState.counters) this.counters = true
    this.actorIds     = docState.actorIds
    this.actorIndexById = docState.actorIndexById
    this.heads        = docState.heads
    this.clock        = docState.clock
    this.blocks       = docState.blocks
    this.objectMeta   = docState.objectMeta
    this.objectsWithMarks = docState.objectsWithMarks
    for (const [property, values] of docState.visibleMapOps.changes) {
      if (values && values.size === 0) this.visibleMapOps.delete(property)
      else this.visibleMapOps.set(property, values)
    }
    this.queue        = queue
    this.binaryDoc    = null
    this.initPatch    = null
    if (objectIds.size > 0) {
      this.cursorIndex = new Map(this.cursorIndex)
      for (const objectId of objectIds) this.cursorIndex.delete(objectId)
    }

    let patch = {
      maxOp: this.maxOp, clock: this.clock, deps: this.heads,
      pendingChanges: this.queue.length, diffs: patches._root
    }
    if (isLocal && decodedChanges.length === 1) {
      patch.actor = decodedChanges[0].actor
      patch.seq = decodedChanges[0].seq
    }
    return patch
  }

  /**
   * Reconstructs the full change history of a document, and initialises the variables that allow us
   * to traverse the hash graph of changes and their dependencies. When a compressed document is
   * loaded we defer the computation of this hash graph to make loading faster, but if the hash
   * graph is later needed (e.g. for the sync protocol), this function fills it in.
   */
  computeHashGraph() {
    const saveCursor = this.saveCursor
    let binaryDoc
    try {
      binaryDoc = this.save()
    } finally {
      this.saveCursor = saveCursor
    }
    const changes = []
    const historyHashes = []
    const changeIndexByHash = {}
    const dependenciesByHash = {}
    const dependentsByHash = {}
    const hashesByActor = {}
    const clock = {}
    let numChangeOps = 0

    const loaded = LOADED_DOCUMENTS.get(binaryDoc)
    const decoded = loaded ? documentChanges(binaryDoc, columnOperationCache(loaded.columns).operations, loaded.header) : documentChanges(binaryDoc)
    for (let change of decoded) {
      changes.push(change.bytes)
      historyHashes.push(change.hash)
      changeIndexByHash[change.hash] = changes.length - 1
      dependenciesByHash[change.hash] = change.deps
      dependentsByHash[change.hash] = []
      for (let dep of change.deps) dependentsByHash[dep].push(change.hash)
      if (change.seq === 1) hashesByActor[change.actor] = []
      hashesByActor[change.actor].push(change.hash)
      const expectedSeq = (clock[change.actor] || 0) + 1
      if (change.seq !== expectedSeq) {
        throw new RangeError(`Expected seq ${expectedSeq}, got seq ${change.seq} from actor ${change.actor}`)
      }
      clock[change.actor] = change.seq
      numChangeOps += change.numOps
    }
    this.haveHashGraph = true
    this.changes = changes
    this.historyHashes = historyHashes
    this.changeIndexByHash = changeIndexByHash
    this.dependenciesByHash = dependenciesByHash
    this.dependentsByHash = dependentsByHash
    this.hashesByActor = hashesByActor
    this.clock = clock
    this.numChangeOps = numChangeOps
  }

  /**
   * Returns all the changes that need to be sent to another replica. `haveDeps` is a list of change
   * hashes (as hex strings) of the heads that the other replica has. The changes in `haveDeps` and
   * any of their transitive dependencies will not be returned; any changes later than or concurrent
   * to the hashes in `haveDeps` will be returned. If `haveDeps` is an empty array, all changes are
   * returned. Hashes that are not known to this replica are ignored, matching
   * the Rust implementation.
   */
  getChanges(haveDeps) {
    return this.changeIndexesSince(haveDeps).map(index => this.changes[index])
  }

  changeIndexesSince(haveDeps) {
    if (this.heads.length > 0 && this.heads.every(hash => haveDeps.includes(hash))) return []
    if (!this.haveHashGraph) this.computeHashGraph()
    haveDeps = haveDeps.filter(hash => this.dependentsByHash[hash])

    // If the other replica has nothing, return all changes in history order
    if (haveDeps.length === 0) {
      return this.changes.map((change, index) => index)
    }

    // Fast path for the common case where all new changes depend only on haveDeps
    let stack = [], seenHashes = {}, toReturn = [], aborted = false
    const have = new Set(haveDeps)
    for (let hash of haveDeps) {
      seenHashes[hash] = true
      const successors = this.dependentsByHash[hash]
      if (!successors) throw new RangeError(`hash not found: ${hash}`)
      stack.push(...successors)
    }

    // Depth-first traversal of the hash graph to find all changes that depend on `haveDeps`
    while (stack.length > 0) {
      const hash = stack.pop()
      if (have.has(hash)) {
        aborted = true
        break
      }
      if (seenHashes[hash]) continue
      seenHashes[hash] = true
      toReturn.push(hash)
      if (!this.dependenciesByHash[hash].every(dep => seenHashes[dep])) {
        // If a change depends on a hash we have not seen, abort the traversal and fall back to the
        // slower algorithm. This will sometimes abort even if all new changes depend on `haveDeps`,
        // because our depth-first traversal is not necessarily a topological sort of the graph.
        // The abort must be recorded explicitly: checking `stack.length` is not enough, because
        // the stack can be empty at this point even though the change we just took has
        // dependencies that were never visited.
        aborted = true
        break
      }
      stack.push(...this.dependentsByHash[hash])
    }

    // If the traversal above has encountered all the heads, and was not aborted early due to
    // a missing dependency, then the set of changes it has found is complete, so we can return it
    if (!aborted && stack.length === 0 && this.heads.every(head => seenHashes[head])) {
      return toReturn.map(hash => this.changeIndexByHash[hash]).sort((a, b) => a - b)
    }

    // If we haven't encountered all of the heads, we have to search harder. This will happen if
    // changes were added that are concurrent to `haveDeps`
    stack = haveDeps.slice()
    seenHashes = {}
    while (stack.length > 0) {
      const hash = stack.pop()
      if (!seenHashes[hash]) {
        const deps = this.dependenciesByHash[hash]
        if (!deps) throw new RangeError(`hash not found: ${hash}`)
        stack.push(...deps)
        seenHashes[hash] = true
      }
    }

    const indexes = []
    for (let index = 0; index < this.historyHashes.length; index++) {
      if (!seenHashes[this.historyHashes[index]]) indexes.push(index)
    }
    return indexes
  }

  /**
   * Returns all changes that are present in this BackendDoc, but not present in the `other`
   * BackendDoc.
   */
  getChangesAdded(other) {
    if (!this.haveHashGraph) this.computeHashGraph()

    // Depth-first traversal from the heads through the dependency graph,
    // until we reach a change that is already present in opSet1
    let stack = this.heads.slice(), seenHashes = {}, toReturn = []
    while (stack.length > 0) {
      const hash = stack.pop()
      if (!seenHashes[hash] && other.changeIndexByHash[hash] === undefined) {
        seenHashes[hash] = true
        toReturn.push(hash)
        stack.push(...this.dependenciesByHash[hash])
      }
    }

    // Return those changes in the reverse of the order in which the depth-first search
    // found them. This is not necessarily a topological sort, but should usually be close.
    return toReturn.reverse().map(hash => this.changes[this.changeIndexByHash[hash]])
  }

  getChangeByHash(hash) {
    if (!this.haveHashGraph) this.computeHashGraph()
    return this.changes[this.changeIndexByHash[hash]]
  }

  getChangesByHash(hashes) {
    if (!Array.isArray(hashes)) throw new TypeError('Pass an array of hashes to Backend.getChangesByHash()')
    if (!this.haveHashGraph) this.computeHashGraph()
    const seen = new Set(), indexes = []
    for (const hash of hashes) {
      if (seen.has(hash)) throw new RangeError('Backend.getChangesByHash() hashes must be unique')
      seen.add(hash)
      const index = this.changeIndexByHash[hash]
      if (!Number.isInteger(index) || this.historyHashes[index] !== hash) {
        throw new RangeError(`Unknown change hash: ${hash}`)
      }
      indexes.push(index)
    }
    indexes.sort((left, right) => left - right)
    return indexes.map(index => this.changes[index])
  }

  /**
   * Returns the hashes of any missing dependencies, i.e. where we have tried to apply a change that
   * has a dependency on a change we have not seen.
   *
   * If the argument `heads` is given (an array of hexadecimal strings representing hashes as
   * returned by `getHeads()`), this function also ensures that all of those hashes resolve to
   * either a change that has been applied to the document, or that has been enqueued for later
   * application once missing dependencies have arrived. Any missing heads hashes are included in
   * the returned array.
   */
  getMissingDeps(heads = []) {
    if (heads.length === 0 && this.queue.length === 0) return []
    if (!this.haveHashGraph) this.computeHashGraph()

    let allDeps = new Set(heads), inQueue = new Set()
    for (let change of this.queue) {
      inQueue.add(change.hash)
      for (let dep of change.deps) allDeps.add(dep)
    }

    let missing = []
    for (let hash of allDeps) {
      if (this.changeIndexByHash[hash] === undefined && !inQueue.has(hash)) missing.push(hash)
    }
    return missing.sort()
  }

  hasHeads(heads) {
    if (!this.haveHashGraph && !heads.every(hash => this.changeIndexByHash[hash] !== undefined)) this.computeHashGraph()
    return heads.every(hash => this.changeIndexByHash[hash] !== undefined)
  }

  getCursorPosition(objectId, elemId, move) {
    let index = this.cursorIndex.get(objectId)
    if (!index) {
      index = buildCursorIndex(this.blocks, this.actorIds, objectId)
      this.cursorIndex.set(objectId, index)
    }
    const element = index.get(elemId)
    if (!element) throw new RangeError('getCursorPosition() received an unknown cursor')
    if (element.visible) return element.position
    if (move === 'after') return element.after
    if (element.before !== undefined) return element.before
    let key = element.key
    while (key !== '_head') {
      const parent = index.get(key)
      if (!parent) break
      if (parent.visible) {
        element.before = parent.position
        return element.before
      }
      key = parent.key
    }
    element.before = 0
    return element.before
  }

  getChangesMeta(heads) {
    return this.getChanges(heads).map(changeMeta)
  }

  clockAt(heads) {
    if (!this.haveHashGraph) this.computeHashGraph()
    const changeOf = new Map()
    for (const [actor, hashes] of Object.entries(this.hashesByActor)) {
      for (let i = 0; i < hashes.length; i++) changeOf.set(hashes[i], {actor, seq: i + 1})
    }
    const clock = {}, ancestors = new Set(), covered = new Set(), stack = heads.slice()
    while (stack.length > 0) {
      const hash = stack.pop()
      if (ancestors.has(hash)) continue
      const change = changeOf.get(hash)
      if (!change) throw new RangeError(`Unknown change hash: ${hash}`)
      ancestors.add(hash)
      if (!(clock[change.actor] >= change.seq)) clock[change.actor] = change.seq
      for (const dep of this.dependenciesByHash[hash]) {
        covered.add(dep)
        stack.push(dep)
      }
    }
    return {clock, heads: [...new Set(heads)].filter(hash => !covered.has(hash)).sort(), hashes: [...ancestors]}
  }

  isolatedActor(actor, heads) {
    const visible = this.clockAt(heads).clock
    const maxOp = (actorId, seq) => (seq === 0 ? 0 : changeMeta(this.changes[this.changeIndexByHash[this.hashesByActor[actorId][seq - 1]]]).maxOp)
    for (let level = 0; ; level++) {
      let candidate = actor
      if (level > 0) {
        let leb = ''
        for (let n = level; ; n >>>= 7) {
          const byte = n & 0x7f
          if (n < 0x80) { leb += byte.toString(16).padStart(2, '0'); break }
          leb += (byte | 0x80).toString(16).padStart(2, '0')
        }
        candidate = '13b22309' + leb + actor
      }
      const seq = this.clock[candidate] || 0, max = maxOp(candidate, seq)
      if (max === 0 || maxOp(candidate, visible[candidate] || 0) >= max) return {actor: candidate, seq: seq + 1}
    }
  }

  opClock(clock) {
    return this.actorIds.map(actor => {
      const seq = clock[actor] || 0
      if (seq >= (this.clock[actor] || 0)) return this.maxOp
      if (seq === 0) return 0
      if (!(this.hashesByActor[actor] && this.hashesByActor[actor][seq])) this.computeHashGraph()
      return decodeChangeMeta(this.changes[this.changeIndexByHash[this.hashesByActor[actor][seq]]]).startOp - 1
    })
  }

  viewAt(heads) {
    const {clock, heads: deps} = this.clockAt(heads)
    const opClock = this.opClock(clock)
    const objectMeta = {_root: {parentObj: null, parentKey: null, opId: null, type: 'map', children: {}}}
    const docState = {blocks: this.blocks, actorIds: this.actorIds, objectMeta, maxOp: 0}
    const diffs = documentPatch(docState, opClock)
    return {patch: {maxOp: docState.maxOp, clock, deps, pendingChanges: 0, diffs}, clock: opClock}
  }

  headsClock(heads) {
    const key = heads.slice().sort().join(',')
    let clock = HEADS_CLOCKS.get(key)
    if (!clock) clock = key === this.heads.slice().sort().join(',') ? this.clock : this.clockAt(heads).clock
    HEADS_CLOCKS.delete(key)
    HEADS_CLOCKS.set(key, clock)
    if (HEADS_CLOCKS.size > 16) HEADS_CLOCKS.delete(HEADS_CLOCKS.keys().next().value)
    return clock
  }

  diff(beforeHeads, afterHeads, valueOf, objectId = '_root', recursive = true, actorMap = null) {
    if (!this.haveHashGraph) this.computeHashGraph()
    const before = this.headsClock(beforeHeads), after = this.headsClock(afterHeads)
    return documentDiff(this, this.opClock(before), this.opClock(after), this.touchedObjects(before, after, changeTargets), valueOf, objectId, recursive, false, actorMap)
  }

  touchedObjects(before, after, targetsOf) {
    const objectIds = new Map()
    if (Object.values(before).every(seq => !seq) || Object.values(after).every(seq => !seq)) {
      for (const id of Object.keys(this.objectMeta)) objectIds.set(id, {elements: [], marks: true})
      return objectIds
    }
    for (const actor of new Set(Object.keys(before).concat(Object.keys(after)))) {
      const low = Math.min(before[actor] || 0, after[actor] || 0), high = Math.max(before[actor] || 0, after[actor] || 0)
      for (let seq = low + 1; seq <= high; seq++) {
        if (!(this.hashesByActor[actor] && this.hashesByActor[actor][seq - 1])) this.computeHashGraph()
        changeObjects(targetsOf(this.changes[this.changeIndexByHash[this.hashesByActor[actor][seq - 1]]]), objectIds, this.actorIndexById)
      }
    }
    return objectIds
  }

  clockDiff(before, after, valueOf, batch) {
    return documentDiff(this, this.opClock(before), this.opClock(after), this.touchedObjects(before, after, decodeTargets), valueOf, '_root', true, batch)
  }

  localPatches(change, actorId, startOp, clock, events, valueOf) {
    return localPatches(this, change, this.actorIndexById.get(actorId), startOp, clock, events, valueOf)
  }

  isolatedPatches(currentHeads, scopeHeads, newHeads, change, actorId, events, valueOf, actorMap) {
    if (!this.haveHashGraph) this.computeHashGraph()
    const current = this.headsClock(currentHeads), scope = this.headsClock(scopeHeads)
    return isolatedPatches(this, this.opClock(current), this.opClock(scope), this.opClock(this.headsClock(newHeads)),
      this.touchedObjects(current, scope, changeTargets), change, this.actorIndexById.get(actorId), events, valueOf, actorMap)
  }

  sequenceInserts(objectId, clock) {
    const {counter, actorId} = objectId === '_root' ? {counter: null, actorId: null} : parseOpId(objectId)
    const actor = actorId === null ? null : this.actorIndexById.get(actorId)
    const inserts = []
    if (actor === undefined) return inserts
    for (let index = findBlock(this.blocks, this.actorIds, actorId, counter, null); index < this.blocks.length; index++) {
      const block = this.blocks[index]
      const entries = blockInserts(block, this.actorIds, objectId, counter, actor)
      for (const entry of entries) if (!clock || entry.counter <= clock[entry.actor]) inserts.push(entry)
      if (compareBlockObject(block, this.actorIds, actorId, counter) > 0) break
    }
    return inserts
  }

  topoHistoryTraversal() {
    if (!this.haveHashGraph) this.computeHashGraph()
    return this.historyHashes.slice()
  }

  stats() {
    if (!this.haveHashGraph) this.computeHashGraph()
    return {numChanges: this.changes.length, numOps: this.numChangeOps, numActors: this.actorIds.length}
  }

  saveIncremental() {
    if (this.saveCursor === this.changes.length) return new Uint8Array()
    if (this.changes.slice(this.saveCursor).some(change => !change)) this.computeHashGraph()
    const bytes = concatBuffers(this.changes.slice(this.saveCursor))
    this.saveCursor = this.changes.length
    return bytes
  }

  saveSince(heads) {
    return concatBuffers(this.getChanges(heads))
  }

  /**
   * Serialises the current document state into a single byte array.
   */
  save() {
    this.saveCursor = this.changes.length
    if (this.binaryDoc) return this.binaryDoc
    if (!this.changesEncoders) {
      this.changesEncoders = copyDocumentChanges(this.changesColumns, this.changes.length)
      this.changesColumns = null
    }

    // Getting the byte array for the changes columns finalises their encoders, after which we can
    // no longer append values to them. We therefore copy their data over to fresh encoders.
    let changesColumns = this.changesEncoders.map(col => ({columnId: col.columnId, encoder: col.encoder.clone()}))
    const concatenated = concatBlocks(this.blocks, this.concatCache)
    this.concatCache = concatenated.cache
    let opsColumns = concatenated.encoders.filter(({columnId, encoder}) => {
      if (columnId !== (9 << 4 | COLUMN_TYPE.BOOLEAN) || encoder.buffer.byteLength === 0) return true
      const decoder = decoderByColumnId(columnId, encoder.buffer)
      decoder.readRecord()
      return decoder.offset < encoder.buffer.byteLength
    })
    let actorIds = this.actorIds

    // The document format requires the actor table to be lexicographically
    // sorted, and the Rust implementation validates the document against
    // that assumption. Actors are registered in the order they are first
    // seen, so if that order is not sorted, remap every actor-index column.
    if (actorIds.some((actor, index) => index > 0 && actorIds[index - 1] > actor)) {
      const sortedActors = actorIds.slice().sort()
      const remap = actorIds.map(actor => sortedActors.indexOf(actor))
      changesColumns = remapActorColumns(changesColumns, remap)
      opsColumns = remapActorColumns(opsColumns, remap)
      actorIds = sortedActors
    }

    this.binaryDoc = encodeDocumentHeader({
      changesColumns,
      opsColumns,
      actorIds,
      heads: this.heads,
      headsIndexes: this.heads.map(hash => this.changeIndexByHash[hash]),
      extraBytes: this.extraBytes
    })
    return this.binaryDoc
  }

  marksInOrder() {
    if (this.objectsWithMarks.size === 0) return true
    const begins = new Map()
    for (const block of this.blocks) {
      for (const {obj, id, begin} of blockMarks(block)) {
        if (!begin) begins.set(id, obj)
        else if (begins.get(begin) !== obj) return false
      }
    }
    return true
  }

  objectPatch(objectId) {
    const objectMeta = {_root: {parentObj: null, parentKey: null, opId: null, type: 'map', children: {}}}
    return documentPatch({blocks: this.blocks, actorIds: this.actorIds, objectMeta, maxOp: 0, patchObject: objectId})
  }

  /**
   * Returns a patch from which we can initialise the current state of the backend.
   */
  getPatch() {
    const objectMeta = {_root: {parentObj: null, parentKey: null, opId: null, type: 'map', children: {}}}
    const docState = {blocks: this.blocks, actorIds: this.actorIds, objectMeta, maxOp: 0}
    const diffs = this.initPatch ? this.initPatch : documentPatch(docState)
    return {
      maxOp: this.maxOp, clock: this.clock, deps: this.heads,
      pendingChanges: this.queue.length, diffs
    }
  }
}

export { MAX_BLOCK_SIZE, MAX_MAP_BLOCK_SIZE, BackendDoc, concatBuffers, bloomFilterContains, markEvent, OBJECT_IDS, PATCH_OBJECTS, RAW_OBJECT_IDS }
