const { parseOpId, copyObject, compareUtf8 } = require('../src/common')
const { COLUMN_TYPE, VALUE_TYPE, ACTIONS, OBJECT_TYPE, DOC_OPS_COLUMNS, CHANGE_COLUMNS, DOCUMENT_COLUMNS,
  encoderByColumnId, decoderByColumnId, makeDecoders, decodeValue,
  encodeChange, decodeChangeColumns, decodeChanges,
  decodeDocumentHeader, encodeDocumentHeader } = require('./columnar')
const ColumnData = require('./column_data')

const MAX_BLOCK_SIZE = 600 // operations
const MAX_MAP_BLOCK_SIZE = 100
const BLOOM_BITS_PER_ENTRY = 10, BLOOM_NUM_PROBES = 7 // 1% false positive rate
const BLOOM_FILTER_SIZE = Math.floor(BLOOM_BITS_PER_ENTRY * MAX_BLOCK_SIZE / 8) // bytes

const objActorIdx = 0, objCtrIdx = 1, keyActorIdx = 2, keyCtrIdx = 3, keyStrIdx = 4,
  idActorIdx = 5, idCtrIdx = 6, insertIdx = 7, actionIdx = 8, valLenIdx = 9, valRawIdx = 10,
  predNumIdx = 13, predActorIdx = 14, predCtrIdx = 15, succNumIdx = 13, succActorIdx = 14, succCtrIdx = 15,
  expandIdx = 16, markNameIdx = 17

const PRED_COLUMN_IDS = CHANGE_COLUMNS
  .filter(column => ['predNum', 'predActor', 'predCtr'].includes(column.columnName))
  .map(column => column.columnId)

const COLUMN_OPERATIONS = new WeakMap()
const COLUMN_DATA = new WeakMap()
const COLUMN_SLAB_OPTIONS = {slabRows: 24}

function operationValueCount(column, value) {
  if ((column.columnId & 7) === COLUMN_TYPE.VALUE_RAW) return value ? value.byteLength : 0
  return Array.isArray(value) ? value.length : 1
}

function cacheColumnOperations(columns, operations) {
  const offsets = columns.map(() => [0])
  for (const operation of operations) {
    for (let index = 0; index < columns.length; index++) {
      const count = operationValueCount(columns[index], operation[index])
      offsets[index].push(offsets[index][offsets[index].length - 1] + count)
    }
  }
  const cache = {operations, offsets}
  COLUMN_OPERATIONS.set(columns, cache)
  return cache
}

function columnOperationCache(columns) {
  let cache = COLUMN_OPERATIONS.get(columns)
  if (cache) return cache
  for (const column of columns) column.decoder.reset()
  const operations = []
  while (!columns[actionIdx].decoder.done) operations.push(readOperation(columns))
  for (const column of columns) column.decoder.reset()
  return cacheColumnOperations(columns, operations)
}

function copyOperation(operation) {
  return operation.map(value => (Array.isArray(value) ? value.slice() : value))
}

function columnDataType(columnId) {
  const type = columnId & 7
  if (type === COLUMN_TYPE.INT_DELTA) return 'delta'
  if (type === COLUMN_TYPE.BOOLEAN) return 'boolean'
  if (type === COLUMN_TYPE.STRING_RLE) return 'string'
  if (type === COLUMN_TYPE.VALUE_RAW) return 'raw'
  return 'uint'
}

function operationColumnValues(operations, columnIndex, raw) {
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

function makeDataColumn(template, data) {
  let decoder
  const column = {
    columnId: template.columnId,
    get decoder() {
      if (!decoder) decoder = decoderByColumnId(template.columnId, ColumnData.toBuffer(data))
      return decoder
    }
  }
  if (template.columnName) column.columnName = template.columnName
  Object.defineProperty(column, 'columnData', {value: data})
  return column
}

function columnDataForColumns(columns) {
  let data = COLUMN_DATA.get(columns)
  if (data) return data
  const operations = columnOperationCache(columns).operations
  data = columns.map((column, index) => {
    if (column.columnData) return column.columnData
    const raw = (column.columnId & 7) === COLUMN_TYPE.VALUE_RAW
    return ColumnData.createColumn(
      columnDataType(column.columnId),
      operationColumnValues(operations, index, raw),
      COLUMN_SLAB_OPTIONS)
  })
  COLUMN_DATA.set(columns, data)
  return data
}

function columnsFromOperations(template, operations) {
  const data = template.map((column, index) => {
    const raw = (column.columnId & 7) === COLUMN_TYPE.VALUE_RAW
    return ColumnData.createColumn(
      columnDataType(column.columnId),
      operationColumnValues(operations, index, raw),
      COLUMN_SLAB_OPTIONS)
  })
  const columns = template.map((column, index) => makeDataColumn(column, data[index]))
  COLUMN_DATA.set(columns, data)
  cacheColumnOperations(columns, operations)
  return columns
}

function spliceColumns(columns, startRow, endRow, operations, outputOperations) {
  const cache = columnOperationCache(columns)
  const data = columnDataForColumns(columns).map((column, index) => {
    const raw = (columns[index].columnId & 7) === COLUMN_TYPE.VALUE_RAW
    const inserted = operationColumnValues(operations, index, raw)
    const start = cache.offsets[index][startRow]
    const end = cache.offsets[index][endRow]
    return ColumnData.splice(column, start, end - start, inserted)
  })
  const output = columns.map((column, index) => makeDataColumn(column, data[index]))
  COLUMN_DATA.set(output, data)
  const offsets = columns.map((column, columnIndex) => {
    const oldOffsets = cache.offsets[columnIndex]
    const result = oldOffsets.slice(0, startRow + 1)
    let offset = result[result.length - 1]
    for (const operation of operations) {
      offset += operationValueCount(column, operation[columnIndex])
      result.push(offset)
    }
    const delta = offset - oldOffsets[endRow]
    for (let row = endRow + 1; row < oldOffsets.length; row++) result.push(oldOffsets[row] + delta)
    return result
  })
  COLUMN_OPERATIONS.set(output, {operations: outputOperations, offsets})
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

/**
 * Updates `objectTree`, which is a tree of nested objects, so that afterwards
 * `objectTree[path[0]][path[1]][...] === value`. Only the root object is mutated, whereas any
 * nested objects are copied before updating. This means that once the root object has been
 * shallow-copied, this function can be used to update it without mutating the previous version.
 */
function deepCopyUpdate(objectTree, path, value) {
  if (path.length === 1) {
    objectTree[path[0]] = value
  } else {
    let child = Object.assign({}, objectTree[path[0]])
    deepCopyUpdate(child, path.slice(1), value)
    objectTree[path[0]] = child
  }
}

function seekWithinOperations(target, cache, actorIds, resumeInsertion) {
  const rows = cache.operations
  const {objActor, objCtr, keyActor, keyCtr, keyStr, idActor, idCtr, insert} = target
  let index = 0, visibleCount = 0, elemVisible = false

  if (objCtr !== null && !resumeInsertion) {
    while (index < rows.length) {
      const row = rows[index]
      const rowActor = row[objActorIdx] === null ? null : actorIds[row[objActorIdx]]
      const rowCtr = row[objCtrIdx]
      if (rowCtr === null || !rowActor || rowCtr < objCtr || (rowCtr === objCtr && rowActor < objActor)) {
        index++
      } else {
        break
      }
    }
  }

  const first = rows[index]
  const firstActor = first && first[objActorIdx] !== null ? actorIds[first[objActorIdx]] : null
  if ((!first || first[objCtrIdx] !== objCtr || firstActor !== objActor) && !resumeInsertion) {
    return {found: true, skipCount: index, visibleCount}
  }

  if (keyStr !== null) {
    const keyStart = index
    while (index < rows.length) {
      const row = rows[index]
      const rowActor = row[objActorIdx] === null ? null : actorIds[row[objActorIdx]]
      if (row[keyStrIdx] !== null && compareUtf8(row[keyStrIdx], keyStr) < 0 &&
          row[objCtrIdx] === objCtr && rowActor === objActor) {
        index++
      } else {
        break
      }
    }
    if (target.predRows) {
      const lastIndex = rows.length - 1
      const last = rows[lastIndex]
      const lastActor = last && last[objActorIdx] !== null ? actorIds[last[objActorIdx]] : null
      if (target.predRows.size === 1 && last && lastIndex >= index && last[objCtrIdx] === objCtr && lastActor === objActor &&
          last[keyStrIdx] === keyStr && target.predRows.has(`${last[idCtrIdx]}@${last[idActorIdx]}`)) {
        return {found: true, skipCount: lastIndex, visibleCount}
      }
      for (let predIndex = index; predIndex < rows.length; predIndex++) {
        const row = rows[predIndex]
        const rowActor = row[objActorIdx] === null ? null : actorIds[row[objActorIdx]]
        if (row[objCtrIdx] !== objCtr || rowActor !== objActor || row[keyStrIdx] !== keyStr) break
        if (target.predRows.has(`${row[idCtrIdx]}@${row[idActorIdx]}`)) {
          return {found: true, skipCount: predIndex, visibleCount}
        }
      }
      index = keyStart
    }
    return {found: true, skipCount: index, visibleCount}
  }

  if (insert) {
    if (!resumeInsertion && keyCtr !== null && keyCtr > 0 && keyActor !== null) {
      let found = false
      while (index < rows.length) {
        const row = rows[index]
        const rowActor = row[objActorIdx] === null ? null : actorIds[row[objActorIdx]]
        if (row[objCtrIdx] !== objCtr || rowActor !== objActor) break
        index++
        if (row[insertIdx]) elemVisible = false
        if (row[succNumIdx] === 0 && ACTIONS[row[actionIdx]] !== 'mark' && !elemVisible) {
          visibleCount++
          elemVisible = true
        }
        if (row[idCtrIdx] === keyCtr && actorIds[row[idActorIdx]] === keyActor && row[insertIdx]) {
          found = true
          break
        }
      }
      if (!found) return {found: false, skipCount: index, visibleCount}
    }

    while (index < rows.length) {
      const row = rows[index]
      const rowActor = row[objActorIdx] === null ? null : actorIds[row[objActorIdx]]
      const rowIdActor = actorIds[row[idActorIdx]]
      if (row[objCtrIdx] !== objCtr || rowActor !== objActor ||
          (row[insertIdx] && row[idCtrIdx] < idCtr) ||
          (row[insertIdx] && row[idCtrIdx] === idCtr && rowIdActor <= idActor)) break
      index++
      if (row[insertIdx]) elemVisible = false
      if (row[succNumIdx] === 0 && ACTIONS[row[actionIdx]] !== 'mark' && !elemVisible) {
        visibleCount++
        elemVisible = true
      }
    }
    return {found: true, skipCount: index, visibleCount}
  }

  if (keyCtr !== null && keyCtr > 0 && keyActor !== null) {
    while (index < rows.length) {
      const row = rows[index]
      const rowActor = row[objActorIdx] === null ? null : actorIds[row[objActorIdx]]
      if (row[objCtrIdx] !== objCtr || rowActor !== objActor ||
          (row[insertIdx] && row[idCtrIdx] === keyCtr && actorIds[row[idActorIdx]] === keyActor)) break
      index++
      if (row[insertIdx]) elemVisible = false
      if (row[succNumIdx] === 0 && ACTIONS[row[actionIdx]] !== 'mark' && !elemVisible) {
        visibleCount++
        elemVisible = true
      }
    }
    const row = rows[index]
    const rowActor = row && row[objActorIdx] !== null ? actorIds[row[objActorIdx]] : null
    if (!row || row[objCtrIdx] !== objCtr || rowActor !== objActor ||
        row[idCtrIdx] !== keyCtr || actorIds[row[idActorIdx]] !== keyActor || !row[insertIdx]) {
      return {found: false, skipCount: index, visibleCount}
    }
  }
  return {found: true, skipCount: index, visibleCount}
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
  const cached = COLUMN_OPERATIONS.get(docCols)
  if (cached) return seekWithinOperations(ops, cached, actorIds, resumeInsertion)
  for (let col of docCols) col.decoder.reset()
  const { objActor, objCtr, keyActor, keyCtr, keyStr, idActor, idCtr, insert } = ops
  const [objActorD, objCtrD, /* keyActorD */, /* keyCtrD */, keyStrD, idActorD, idCtrD, insertD, actionD,
    /* valLenD */, /* valRawD */, /* chldActorD */, /* chldCtrD */, succNumD] = docCols.map(col => col.decoder)
  let skipCount = 0, visibleCount = 0, elemVisible = false, nextObjActor = null, nextObjCtr = null
  let nextIdActor = null, nextIdCtr = null, nextKeyStr = null, nextInsert = null, nextAction = null, nextSuccNum = 0

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
    return {found: true, skipCount, visibleCount}
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
      objActorD.reset()
      objCtrD.reset()
      keyStrD.reset()
      idActorD.reset()
      idCtrD.reset()
      objActorD.skipValues(skipCount)
      objCtrD.skipValues(skipCount)
      keyStrD.skipValues(skipCount)
      idActorD.skipValues(skipCount)
      idCtrD.skipValues(skipCount)
      while (!idCtrD.done) {
        nextObjActor = actorIds[objActorD.readValue()]
        nextObjCtr = objCtrD.readValue()
        nextKeyStr = keyStrD.readValue()
        nextIdActor = actorIds[idActorD.readValue()]
        nextIdCtr = idCtrD.readValue()
        if (nextObjCtr !== objCtr || nextObjActor !== objActor || nextKeyStr !== keyStr) break
        if (ops.predIds.has(`${nextIdCtr}@${nextIdActor}`)) {
          return {found: true, skipCount, visibleCount}
        }
        skipCount++
      }
      skipCount = keyStart
    }
    return {found: true, skipCount, visibleCount}
  }

  idCtrD.skipValues(skipCount)
  idActorD.skipValues(skipCount)
  insertD.skipValues(skipCount)
  succNumD.skipValues(skipCount)
  actionD.reset()
  actionD.skipValues(skipCount)
  nextIdCtr = idCtrD.readValue()
  nextIdActor = actorIds[idActorD.readValue()]
  nextInsert = insertD.readValue()
  nextAction = actionD.readValue()
  nextSuccNum = succNumD.readValue()

  // If we are inserting into a list, an opId key is used, and we need to seek to a position *after*
  // the referenced operation. Moreover, we need to skip over any existing operations with a greater
  // opId than the new insertion, for CRDT convergence on concurrent insertions in the same place.
  if (insert) {
    // If insertion is not at the head, search for the reference element
    if (!resumeInsertion && keyCtr !== null && keyCtr > 0 && keyActor !== null) {
      skipCount += 1
      while (!idCtrD.done && !idActorD.done && (nextIdCtr !== keyCtr || nextIdActor !== keyActor)) {
        if (nextInsert) elemVisible = false
        if (nextSuccNum === 0 && ACTIONS[nextAction] !== 'mark' && !elemVisible) {
          visibleCount += 1
          elemVisible = true
        }
        nextIdCtr = idCtrD.readValue()
        nextIdActor = actorIds[idActorD.readValue()]
        nextObjCtr = objCtrD.readValue()
        nextObjActor = actorIds[objActorD.readValue()]
        nextInsert = insertD.readValue()
        nextAction = actionD.readValue()
        nextSuccNum = succNumD.readValue()
        if (nextObjCtr === objCtr && nextObjActor === objActor) skipCount += 1; else break
      }
      if (nextObjCtr !== objCtr || nextObjActor !== objActor || nextIdCtr !== keyCtr ||
          nextIdActor !== keyActor || !nextInsert) {
        return {found: false, skipCount, visibleCount}
      }
      if (nextInsert) elemVisible = false
      if (nextSuccNum === 0 && ACTIONS[nextAction] !== 'mark' && !elemVisible) {
        visibleCount += 1
        elemVisible = true
      }

      // Set up the next* variables to the operation following the reference element
      if (idCtrD.done || idActorD.done) return {found: true, skipCount, visibleCount}
      nextIdCtr = idCtrD.readValue()
      nextIdActor = actorIds[idActorD.readValue()]
      nextObjCtr = objCtrD.readValue()
      nextObjActor = actorIds[objActorD.readValue()]
      nextInsert = insertD.readValue()
      nextAction = actionD.readValue()
      nextSuccNum = succNumD.readValue()
    }

    // Skip over any list elements with greater ID than the new one, and any non-insertions
    while ((!nextInsert || nextIdCtr > idCtr || (nextIdCtr === idCtr && nextIdActor > idActor)) &&
           nextObjCtr === objCtr && nextObjActor === objActor) {
      skipCount += 1
      if (nextInsert) elemVisible = false
      if (nextSuccNum === 0 && ACTIONS[nextAction] !== 'mark' && !elemVisible) {
        visibleCount += 1
        elemVisible = true
      }
      if (!idCtrD.done && !idActorD.done) {
        nextIdCtr = idCtrD.readValue()
        nextIdActor = actorIds[idActorD.readValue()]
        nextObjCtr = objCtrD.readValue()
        nextObjActor = actorIds[objActorD.readValue()]
        nextInsert = insertD.readValue()
        nextAction = actionD.readValue()
        nextSuccNum = succNumD.readValue()
      } else {
        break
      }
    }

  } else if (keyCtr !== null && keyCtr > 0 && keyActor !== null) {
    // If we are updating an existing list element, seek to just before the referenced ID
    while ((!nextInsert || nextIdCtr !== keyCtr || nextIdActor !== keyActor) &&
           nextObjCtr === objCtr && nextObjActor === objActor) {
      skipCount += 1
      if (nextInsert) elemVisible = false
      if (nextSuccNum === 0 && ACTIONS[nextAction] !== 'mark' && !elemVisible) {
        visibleCount += 1
        elemVisible = true
      }
      if (!idCtrD.done && !idActorD.done) {
        nextIdCtr = idCtrD.readValue()
        nextIdActor = actorIds[idActorD.readValue()]
        nextObjCtr = objCtrD.readValue()
        nextObjActor = actorIds[objActorD.readValue()]
        nextInsert = insertD.readValue()
        nextAction = actionD.readValue()
        nextSuccNum = succNumD.readValue()
      } else {
        break
      }
    }
    if (nextObjCtr !== objCtr || nextObjActor !== objActor || nextIdCtr !== keyCtr ||
        nextIdActor !== keyActor || !nextInsert) {
      return {found: false, skipCount, visibleCount}
    }
  }
  return {found: true, skipCount, visibleCount}
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
            throw new RangeError(`Reference element not found: ${keyCtr}@${keyActor}`)
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
        } else {
          throw new RangeError(`Reference element not found: ${keyCtr}@${keyActor}`)
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
    x = (x + y) % modulo
    y = (y + z) % modulo
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
    x = (x + y) % modulo
    y = (y + z) % modulo
  }
  return true
}

/**
 * Reads the relevant columns of a block of operations and updates that block to contain the
 * metadata we need to efficiently figure out where to insert new operations.
 */
function updateBlockMetadata(block, visibleMapOps) {
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

  const cached = COLUMN_OPERATIONS.get(block.columns)
  if (cached) {
    for (const op of cached.operations) {
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
        block.lastKey = keyStr
      } else if (insert || keyCtr !== null) {
        block.hasListOps = true
        block.lastKey = undefined
        const elemIdActor = insert ? idActor : keyActor
        const elemIdCtr = insert ? idCtr : keyCtr
        bloomFilterAdd(block.bloom, elemIdActor, elemIdCtr)
        if (succNum === 0 && ACTIONS[action] !== 'mark') {
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
    return
  }

  for (let col of block.columns) col.decoder.reset()
  const [objActorD, objCtrD, keyActorD, keyCtrD, keyStrD, idActorD, idCtrD, insertD, actionD,
    /* valLenD */, /* valRawD */, /* chldActorD */, /* chldCtrD */, succNumD] = block.columns.map(col => col.decoder)

  while (!idCtrD.done) {
    block.numOps += 1
    const objActor = objActorD.readValue(), objCtr = objCtrD.readValue()
    const keyActor = keyActorD.readValue(), keyCtr = keyCtrD.readValue(), keyStr = keyStrD.readValue()
    const idActor = idActorD.readValue(), idCtr = idCtrD.readValue()
    const insert = insertD.readValue(), action = actionD.readValue(), succNum = succNumD.readValue()
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
      if (succNum === 0 && ACTIONS[action] !== 'mark') {
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
function splitBlock(block, maxBlockSize, operations) {
  if (maxBlockSize === undefined) maxBlockSize = MAX_BLOCK_SIZE
  // Make each of the resulting blocks between 50% and 80% full (leaving a bit of space in each
  // block so that it doesn't get split again right away the next time an operation is added).
  // The upper bound cannot be lower than 75% since otherwise we would end up with a block less than
  // 50% full when going from two to three blocks.
  const numBlocks = Math.ceil(block.numOps / (0.8 * maxBlockSize))
  let blocks = [], opsSoFar = 0

  if (operations) {
    for (let i = 1; i <= numBlocks; i++) {
      const opsToCopy = Math.ceil(i * block.numOps / numBlocks) - opsSoFar
      const blockOps = operations.slice(opsSoFar, opsSoFar + opsToCopy)
      const newBlock = {columns: columnsFromOperations(block.columns, blockOps)}
      updateBlockMetadata(newBlock)
      blocks.push(newBlock)
      opsSoFar += opsToCopy
    }
    return blocks
  }

  for (let col of block.columns) col.decoder.reset()

  for (let i = 1; i <= numBlocks; i++) {
    const opsToCopy = Math.ceil(i * block.numOps / numBlocks) - opsSoFar
    const encoders = block.columns.map(col => ({columnId: col.columnId, encoder: encoderByColumnId(col.columnId)}))
    copyColumns(encoders, block.columns, opsToCopy)
    const decoders = encoders.map(col => {
      const decoder = decoderByColumnId(col.columnId, col.encoder.buffer)
      return {columnId: col.columnId, decoder}
    })

    const newBlock = {columns: decoders}
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
    const decoder = decoderByColumnId(column.columnId, column.encoder.buffer)
    const encoder = encoderByColumnId(column.columnId)
    while (!decoder.done) {
      const value = decoder.readValue()
      encoder.appendValue(value === null ? null : remap[value])
    }
    return {columnId: column.columnId, encoder}
  })
}

function concatBlocks(blocks) {
  const encoders = blocks[0].columns.map(col => ({columnId: col.columnId, encoder: encoderByColumnId(col.columnId)}))

  for (let block of blocks) {
    if (block.columns.every(column => column.columnData)) {
      for (let index = 0; index < block.columns.length; index++) {
        appendColumnData(encoders[index].encoder, block.columns[index])
      }
    } else {
      for (let col of block.columns) col.decoder.reset()
      copyColumns(encoders, block.columns, block.numOps)
    }
  }
  return encoders
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
        const blankValue = (outCol.columnId % 8 === COLUMN_TYPE.BOOLEAN) ? false : null
        outCol.encoder.appendValue(blankValue, colCount)
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
      let blank = null
      if (outCol.columnId % 8 === COLUMN_TYPE.BOOLEAN) blank = false
      if (outCol.columnId % 8 === COLUMN_TYPE.VALUE_LEN) blank = 0
      output.push(new Array(lastCardinality).fill(blank))
    } else if (outCol.columnId % 8 === COLUMN_TYPE.BOOLEAN) {
      output.push(false)
    } else if (outCol.columnId % 8 === COLUMN_TYPE.VALUE_LEN) {
      output.push(0)
    } else {
      output.push(null)
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
      let blankValue = null
      if (outCol.columnId % 8 === COLUMN_TYPE.BOOLEAN) blankValue = false
      if (outCol.columnId % 8 === COLUMN_TYPE.VALUE_LEN) blankValue = 0
      outCol.encoder.appendValue(blankValue, count)
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
  if (docState.readFromColumns) {
    let block = docState.blocks[blockIndex]
    if (!block.columns[actionIdx].decoder.done) {
      return {docOp: readOperation(block.columns), blockIndex}
    } else if (blockIndex === docState.blocks.length - 1) {
      return {docOp: null, blockIndex}
    } else {
      blockIndex += 1
      block = docState.blocks[blockIndex]
      for (const column of block.columns) column.decoder.reset()
      return {docOp: readOperation(block.columns), blockIndex}
    }
  }
  let row = docState.readBlockIndex === blockIndex ? docState.readRow : 0
  while (blockIndex < docState.blocks.length) {
    const operations = columnOperationCache(docState.blocks[blockIndex].columns).operations
    if (row < operations.length) {
      docState.readBlockIndex = blockIndex
      docState.readRow = row + 1
      return {docOp: copyOperation(operations[row]), blockIndex}
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
  const parsed1 = parseOpId(id1), parsed2 = parseOpId(id2)
  return parsed1.actorId === parsed2.actorId && parsed1.counter + delta === parsed2.counter
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
  const elemIdActor = op[insertIdx] ? op[idActorIdx] : op[keyActorIdx]
  const elemIdCtr = op[insertIdx] ? op[idCtrIdx] : op[keyCtrIdx]
  const elemId = op[keyStrIdx] !== null ? op[keyStrIdx] : `${elemIdCtr}@${docState.actorIds[elemIdActor]}`

  // When the change contains a new make* operation (i.e. with an even-numbered action), record the
  // new parent-child relationship in objectMeta. TODO: also handle link/move operations.
  if (op[actionIdx] % 2 === 0 && !docState.objectMeta[opId]) {
    docState.objectMeta[opId] = {parentObj: objectId, parentKey: elemId, opId, type, children: {}}
    deepCopyUpdate(docState.objectMeta, [objectId, 'children', elemId, opId], {objectId: opId, type, props: {}})
  }

  // firstOp is true if the current operation is the first of a sequence of ops for the same key
  const firstOp = !propState[elemId]
  if (!propState[elemId]) propState[elemId] = {visibleOps: [], hasChild: false}

  // An operation is overwritten if it is a document operation that has at least one successor
  const isOverwritten = (oldSuccNum !== undefined && op[succNumIdx] > 0)

  // Record all visible values for the property, and whether it has any child object
  if (!isOverwritten) {
    propState[elemId].visibleOps.push(op)
    propState[elemId].hasChild = propState[elemId].hasChild || (op[actionIdx] % 2) === 0 // even-numbered action == make* operation
  }

  // If one or more of the values of the property is a child object, we update objectMeta to store
  // all of the visible values of the property (even the non-child-object values). Then, when we
  // subsequently process an update within that child object, we can construct the patch to
  // contain the conflicting values.
  const prevChildren = docState.objectMeta[objectId].children[elemId]
  if (propState[elemId].hasChild || (prevChildren && Object.keys(prevChildren).length > 0)) {
    let values = {}
    for (let visible of propState[elemId].visibleOps) {
      const opId = `${visible[idCtrIdx]}@${docState.actorIds[visible[idActorIdx]]}`
      if (ACTIONS[visible[actionIdx]] === 'set') {
        values[opId] = Object.assign({type: 'value'}, decodeValue(visible[valLenIdx], visible[valRawIdx]))
      } else if (visible[actionIdx] % 2 === 0) {
        const objType = visible[actionIdx] < ACTIONS.length ? OBJECT_TYPE[ACTIONS[visible[actionIdx]]] : null
        values[opId] = emptyObjectPatch(opId, objType)
      }
    }

    // Copy so that objectMeta is not modified if an exception is thrown while applying change
    deepCopyUpdate(docState.objectMeta, [objectId, 'children', elemId], values)
  }

  const emissions = []

  // If this operation's ID appears in the pending-successor index, some
  // earlier operation for this property is waiting to find out whether this
  // successor is an increment (which does not overwrite it) or a real
  // overwrite. A non-increment successor kills those candidates for good.
  const pendingBySucc = propState[elemId] && propState[elemId].counterStates
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
  if (isOverwritten && (ACTIONS[op[actionIdx]] === 'set' || op[actionIdx] % 2 === 0)) {
    if (!propState[elemId].counterStates) propState[elemId].counterStates = {}
    const counterStates = propState[elemId].counterStates
    const isCounter = ACTIONS[op[actionIdx]] === 'set' && (op[valLenIdx] & 0x0f) === VALUE_TYPE.COUNTER
    const state = {
      op, opId, isCounter, dead: false,
      value: isCounter ? decodeValue(op[valLenIdx], op[valRawIdx]).value : undefined,
      succs: {}
    }
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
      if (state.isCounter) state.value += delta
      delete state.succs[opId]
      if (state.dead || Object.keys(state.succs).length > 0) continue
      // Every successor was an increment: the operation is visible after all
      if (state.isCounter) {
        emissions.push([state.opId, {type: 'value', datatype: 'counter', value: state.value}])
      } else if (ACTIONS[state.op[actionIdx]] === 'set') {
        emissions.push([state.opId, Object.assign({type: 'value'}, decodeValue(state.op[valLenIdx], state.op[valRawIdx]))])
      } else {
        const objType = state.op[actionIdx] < ACTIONS.length ? OBJECT_TYPE[ACTIONS[state.op[actionIdx]]] : null
        if (!patches[state.opId]) patches[state.opId] = emptyObjectPatch(state.opId, objType)
        emissions.push([state.opId, patches[state.opId]])
      }
      propState[elemId].visibleOps.push(state.op)
      propState[elemId].hasChild = propState[elemId].hasChild || (state.op[actionIdx] % 2) === 0
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
  let patchKey = emissions.length > 0 ? emissions[0][0] : undefined
  let patchValue = emissions.length > 0 ? emissions[0][1] : undefined

  if (!patches[objectId]) patches[objectId] = emptyObjectPatch(objectId, docState.objectMeta[objectId].type)
  const patch = patches[objectId]

  // Updating a list or text object (with elemId key)
  if (op[keyStrIdx] === null) {
    // If we come across any document op that was previously non-overwritten/non-deleted, that
    // means the current list element already had a value before this change was applied, and
    // therefore the current element cannot be an insert. If we already registered an insert, we
    // have to convert it into an update.
    if (oldSuccNum === 0 && !isWholeDoc && propState[elemId].action === 'insert') {
      propState[elemId].action = 'update'
      convertInsertToUpdate(patch.edits, listIndex, elemId)
      if (newBlock && newBlock.lastObjectActor === op[objActorIdx] && newBlock.lastObjectCtr === op[objCtrIdx]) {
        newBlock.numVisible -= 1
      }
    }

    if (patchValue) {
      // If the op has a non-overwritten value and it came from the change, it's an insert.
      // (It's not necessarily the case that op[insertIdx] is true: if a list element is concurrently
      // deleted and updated, the node that first processes the deletion and then the update will
      // observe the update as a re-insertion of the deleted list element.)
      if (!propState[elemId].action && (oldSuccNum === undefined || isWholeDoc)) {
        propState[elemId].action = 'insert'
        appendEdit(patch.edits, {action: 'insert', index: listIndex, elemId, opId: patchKey, value: patchValue})
        if (newBlock && newBlock.lastObjectActor === op[objActorIdx] && newBlock.lastObjectCtr === op[objCtrIdx]) {
          newBlock.numVisible += 1
        }

      // If the property has a value and it's not an insert, then it must be an update.
      // We might have previously registered it as a remove, in which case we convert it to update.
      } else if (propState[elemId].action === 'remove') {
        let lastEdit = patch.edits[patch.edits.length - 1]
        if (lastEdit.action !== 'remove') throw new RangeError('last edit has unexpected type')
        if (lastEdit.count > 1) lastEdit.count -= 1; else patch.edits.pop()
        propState[elemId].action = 'update'
        appendUpdate(patch.edits, listIndex, elemId, patchKey, patchValue, true)
        if (newBlock && newBlock.lastObjectActor === op[objActorIdx] && newBlock.lastObjectCtr === op[objCtrIdx]) {
          newBlock.numVisible += 1
        }

      } else {
        // A 'normal' update
        appendUpdate(patch.edits, listIndex, elemId, patchKey, patchValue, !propState[elemId].action)
        if (!propState[elemId].action) propState[elemId].action = 'update'
      }

      // Any further values that became visible at the same time (multiple
      // operations resolved by one increment) are additional conflict values
      for (let i = 1; i < emissions.length; i++) {
        appendUpdate(patch.edits, listIndex, elemId, emissions[i][0], emissions[i][1], false)
      }

    } else if (oldSuccNum === 0 && !propState[elemId].action) {
      // If the property used to have a non-overwritten/non-deleted value, but no longer, it's a remove
      propState[elemId].action = 'remove'
      appendEdit(patch.edits, {action: 'remove', index: listIndex, count: 1})
      if (newBlock && newBlock.lastObjectActor === op[objActorIdx] && newBlock.lastObjectCtr === op[objCtrIdx]) {
        newBlock.numVisible -= 1
      }
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
function mergeDocChangeOps(patches, newBlock, outCols, outOps, changeState, docState, listIndex, blockIndex) {
  const firstOp = changeState.nextOp, insert = firstOp[insertIdx]
  const objActor = firstOp[objActorIdx], objCtr = firstOp[objCtrIdx]
  const objectId = objActor === null ? '_root' : `${objCtr}@${docState.actorIds[objActor]}`
  const idActorIndex = changeState.actorIndex, idActor = docState.actorIds[idActorIndex]
  let foundListElem = false, elemVisible = false, propState = {}, docOp
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
                   nextOp[keyStrIdx] === lastOp[keyStrIdx] && !isOverwrite) {
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
          if (op[predActorIdx][i] === docOp[idActorIdx] && op[predCtrIdx][i] === docOp[idCtrIdx]) {
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
      if (outCols) appendOperation(outCols, docState.blocks[blockIndex].columns, docOp)
      if (outOps) outOps.push(docOp)
      addBlockOperation(newBlock, docOp, docState.actorIds, false)

      if (docOp[insertIdx] && elemVisible) {
        elemVisible = false
        listIndex++
      }
      if (docOp[succNumIdx] === 0 && ACTIONS[docOp[actionIdx]] !== 'mark') elemVisible = true
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
        if (outCols) appendOperation(outCols, changeCols[i], op)
        if (outOps) outOps.push(mapOperation(docState.blocks[blockIndex].columns, changeCols[i], op))
        addBlockOperation(newBlock, op, docState.actorIds, true)
        updatePatchProperty(patches, newBlock, objectId, op, docState, propState, listIndex)

        if (ACTIONS[op[actionIdx]] === 'mark') {
          elemVisible = false
        } else if (op[insertIdx]) {
          elemVisible = false
          listIndex++
        } else {
          elemVisible = true
        }
      }

      if (takeChangeOps === changeOps.length) {
        changeOps.length = 0
        changeCols.length = 0
        predSeen.length = 0
      } else {
        changeOps.splice(0, takeChangeOps)
        changeCols.splice(0, takeChangeOps)
        predSeen.splice(0, takeChangeOps)
      }
      newBlock.numOps += takeChangeOps
    }
  }

  if (docOp) {
    if (outCols) appendOperation(outCols, docState.blocks[blockIndex].columns, docOp)
    if (outOps) outOps.push(docOp)
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
  if (ACTIONS[changeState.nextOp[actionIdx]] === 'mark' && docState.objectsWithMarks) {
    docState.objectsWithMarks.add(ops.objId)
  }

  let startBlockIndex
  let predIds
  let predRows
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
  const {blockIndex, skipCount, visibleCount} = seekToOp(docState, ops, startBlockIndex)
  const block = docState.blocks[blockIndex]
  const useSlabs = keyStr !== null && !block.hasListOps &&
    (changeState.nextOp[predNumIdx] > 0 || changeState.changes.length > 1)
  docState.readFromColumns = !useSlabs
  if (useSlabs) {
    docState.readBlockIndex = blockIndex
    docState.readRow = skipCount
  }

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
  const outCols = useSlabs ? null : block.columns.map(column => ({
    columnId: column.columnId,
    encoder: encoderByColumnId(column.columnId)
  }))
  const outOps = useSlabs ? columnOperationCache(block.columns).operations.slice(0, skipCount) : null
  if (outCols) {
    for (const column of block.columns) column.decoder.reset()
    copyColumns(outCols, block.columns, skipCount)
  }

  // Apply the operations from the change. This may cause blockIndex to move forwards if the
  // property being updated straddles a block boundary.
  const {blockIndex: lastBlockIndex, docOpsConsumed} =
    mergeDocChangeOps(patches, newBlock, outCols, outOps, changeState, docState, visibleCount, blockIndex)

  // Copy the remaining operations after the insertion position
  const lastBlock = docState.blocks[lastBlockIndex]
  let copyAfterMerge = -skipCount - docOpsConsumed
  for (let i = blockIndex; i <= lastBlockIndex; i++) copyAfterMerge += docState.blocks[i].numOps
  const suffixStart = lastBlock.numOps - copyAfterMerge
  if (useSlabs) {
    const lastOperations = columnOperationCache(lastBlock.columns).operations
    for (let index = suffixStart; index < lastOperations.length; index++) outOps.push(lastOperations[index])
  }
  if (outCols) {
    copyColumns(outCols, lastBlock.columns, copyAfterMerge)
    for (const column of lastBlock.columns) {
      if (!column.decoder.done) throw new RangeError(`excess ops in column ${column.columnId}`)
    }
  }
  newBlock.numOps += copyAfterMerge
  if (copyAfterMerge > 0 && lastBlock.hasListOps) newBlock.hasListOps = true

  const maxBlockSize = keyStr === null || newBlock.hasListOps ? MAX_BLOCK_SIZE : MAX_MAP_BLOCK_SIZE
  if (blockIndex === lastBlockIndex && newBlock.numOps <= maxBlockSize) {
    if (outCols) {
      newBlock.columns = outCols.map(column => ({
        columnId: column.columnId,
        decoder: decoderByColumnId(column.columnId, column.encoder.buffer)
      }))
    } else {
      const insertedEnd = outOps.length - copyAfterMerge
      newBlock.columns = spliceColumns(
        block.columns, skipCount, suffixStart, outOps.slice(skipCount, insertedEnd), outOps)
    }
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
    let newBlocks
    if (outCols) {
      newBlock.columns = outCols.map(column => ({
        columnId: column.columnId,
        decoder: decoderByColumnId(column.columnId, column.encoder.buffer)
      }))
      newBlocks = splitBlock(newBlock, maxBlockSize)
    } else {
      newBlock.columns = block.columns
      newBlocks = splitBlock(newBlock, maxBlockSize, outOps)
    }
    docState.blocks.splice(blockIndex, lastBlockIndex - blockIndex + 1, ...newBlocks)
  }
}

/**
 * Updates the columns in a document's operation blocks to contain all the columns in a change
 * (including any column types we don't recognise, which have been generated by a future version
 * of Automerge).
 */
function updateBlockColumns(docState, changeCols) {
  // Check that the columns of a change appear at the index at which we expect them to be
  if (changeCols[objActorIdx ].columnId !== CHANGE_COLUMNS[objActorIdx ].columnId || CHANGE_COLUMNS[objActorIdx ].columnName !== 'objActor'  ||
      changeCols[objCtrIdx   ].columnId !== CHANGE_COLUMNS[objCtrIdx   ].columnId || CHANGE_COLUMNS[objCtrIdx   ].columnName !== 'objCtr'    ||
      changeCols[keyActorIdx ].columnId !== CHANGE_COLUMNS[keyActorIdx ].columnId || CHANGE_COLUMNS[keyActorIdx ].columnName !== 'keyActor'  ||
      changeCols[keyCtrIdx   ].columnId !== CHANGE_COLUMNS[keyCtrIdx   ].columnId || CHANGE_COLUMNS[keyCtrIdx   ].columnName !== 'keyCtr'    ||
      changeCols[keyStrIdx   ].columnId !== CHANGE_COLUMNS[keyStrIdx   ].columnId || CHANGE_COLUMNS[keyStrIdx   ].columnName !== 'keyStr'    ||
      changeCols[idActorIdx  ].columnId !== CHANGE_COLUMNS[idActorIdx  ].columnId || CHANGE_COLUMNS[idActorIdx  ].columnName !== 'idActor'   ||
      changeCols[idCtrIdx    ].columnId !== CHANGE_COLUMNS[idCtrIdx    ].columnId || CHANGE_COLUMNS[idCtrIdx    ].columnName !== 'idCtr'     ||
      changeCols[insertIdx   ].columnId !== CHANGE_COLUMNS[insertIdx   ].columnId || CHANGE_COLUMNS[insertIdx   ].columnName !== 'insert'    ||
      changeCols[actionIdx   ].columnId !== CHANGE_COLUMNS[actionIdx   ].columnId || CHANGE_COLUMNS[actionIdx   ].columnName !== 'action'    ||
      changeCols[valLenIdx   ].columnId !== CHANGE_COLUMNS[valLenIdx   ].columnId || CHANGE_COLUMNS[valLenIdx   ].columnName !== 'valLen'    ||
      changeCols[valRawIdx   ].columnId !== CHANGE_COLUMNS[valRawIdx   ].columnId || CHANGE_COLUMNS[valRawIdx   ].columnName !== 'valRaw'    ||
      changeCols[predNumIdx  ].columnId !== CHANGE_COLUMNS[predNumIdx  ].columnId || CHANGE_COLUMNS[predNumIdx  ].columnName !== 'predNum'   ||
      changeCols[predActorIdx].columnId !== CHANGE_COLUMNS[predActorIdx].columnId || CHANGE_COLUMNS[predActorIdx].columnName !== 'predActor' ||
      changeCols[predCtrIdx  ].columnId !== CHANGE_COLUMNS[predCtrIdx  ].columnId || CHANGE_COLUMNS[predCtrIdx  ].columnName !== 'predCtr') {
    throw new RangeError('unexpected columnId')
  }

  // Check if there any columns in the change that are not in the document, apart from pred*
  const docCols = docState.blocks[0].columns
  if (!changeCols.every(changeCol => PRED_COLUMN_IDS.includes(changeCol.columnId) ||
                                     docCols.find(docCol => docCol.columnId === changeCol.columnId))) {
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
      throw new RangeError(`actorId ${actorId} is not known to document`)
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
  let applied = [], enqueued = []

  for (let change of decodedChanges) {
    // Skip any duplicate changes that we have already seen
    if (docState.changeIndexByHash[change.hash] !== undefined || changeHashes.has(change.hash)) continue

    const expectedSeq = (clock[change.actor] || 0) + 1
    let causallyReady = true

    for (let dep of change.deps) {
      const depIndex = docState.changeIndexByHash[dep]
      if ((depIndex === undefined || depIndex === -1) && !changeHashes.has(dep)) {
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
      throw new RangeError(`Skipped sequence number ${expectedSeq} for actor ${change.actor}`)
    } else {
      clock[change.actor] = change.seq
      changeHashes.add(change.hash)
      for (let dep of change.deps) heads.delete(dep)
      heads.add(change.hash)
      applied.push(change)
    }
  }

  if (applied.length > 0) {
    for (const change of applied) {
      const docCols = docState.blocks[0].columns
      if (change.columns.some(changeCol => !PRED_COLUMN_IDS.includes(changeCol.columnId) &&
          !docCols.some(docCol => docCol.columnId === changeCol.columnId))) {
        updateBlockColumns(docState, makeDecoders(change.columns, CHANGE_COLUMNS))
      }
    }
    let changeState = {changes: applied, changeIndex: -1, objectIds}
    readNextChangeOp(docState, changeState)
    while (!changeState.done) applyOps(patches, changeState, docState)

    docState.heads = [...heads].sort()
    docState.clock = clock
  }
  return [applied, enqueued]
}

/**
 * Scans the operations in a document and generates a patch that can be sent to the frontend to
 * instantiate the current state of the document. `objectMeta` is mutated to contain information
 * about the parent and children of each object in the document.
 */
function documentPatch(docState) {
  docState.readFromColumns = true
  for (let col of docState.blocks[0].columns) col.decoder.reset()
  let propState = {}, docOp = null, blockIndex = 0
  let patches = {_root: {objectId: '_root', type: 'map', props: {}}}
  let lastObjActor = null, lastObjCtr = null, objectId = '_root', elemVisible = false, listIndex = 0

  while (true) {
    ({ docOp, blockIndex } = readNextDocOp(docState, blockIndex))
    if (docOp === null) break
    if (docOp[objActorIdx] !== lastObjActor || docOp[objCtrIdx] !== lastObjCtr) {
      objectId = `${docOp[objCtrIdx]}@${docState.actorIds[docOp[objActorIdx]]}`
      lastObjActor = docOp[objActorIdx]
      lastObjCtr = docOp[objCtrIdx]
      propState = {}
      listIndex = 0
      elemVisible = false
    }

    if (docOp[insertIdx] && elemVisible) {
      elemVisible = false
      listIndex++
    }
    if (docOp[succNumIdx] === 0 && ACTIONS[docOp[actionIdx]] !== 'mark') elemVisible = true
    if (ACTIONS[docOp[actionIdx]] === 'mark' && docState.objectsWithMarks) docState.objectsWithMarks.add(objectId)
    if (docOp[idCtrIdx] > docState.maxOp) docState.maxOp = docOp[idCtrIdx]
    for (let i = 0; i < docOp[succNumIdx]; i++) {
      if (docOp[succCtrIdx][i] > docState.maxOp) docState.maxOp = docOp[succCtrIdx][i]
    }

    updatePatchProperty(patches, null, objectId, docOp, docState, propState, listIndex, docOp[succNumIdx])
  }
  return patches._root
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
  const encoders = decoders.map(col => ({columnId: col.columnId, encoder: encoderByColumnId(col.columnId)}))
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
    change.message, // message
    change.deps.length, // depsNum
    change.deps.map(dep => changeIndexByHash[dep]), // depsIndex
    change.extraBytes ? (change.extraBytes.byteLength << 4 | VALUE_TYPE.BYTES) : VALUE_TYPE.BYTES, // extraLen
    change.extraBytes // extraRaw
  ])
}

function buildCursorIndex(blocks, actorIds, objectId) {
  const object = parseOpId(objectId)
  const elements = [], byId = new Map()
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
        byId.set(id, {key, visible: op[actionIdx] !== ACTIONS.indexOf('mark') && op[succNumIdx] === 0})
      } else if (op[actionIdx] !== ACTIONS.indexOf('mark')) {
        const id = `${op[keyCtrIdx]}@${op[keyActorIdx]}`
        const element = byId.get(id)
        if (element && op[succNumIdx] === 0) element.visible = true
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
    this.historyMeta = null
    this.objectMeta = {_root: {parentObj: null, parentKey: null, opId: null, type: 'map', children: {}}}
    this.visibleMapOps = new Map()
    this.cursorIndex = new Map()
    this.objectsWithMarks = new Set()

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
      updateBlockMetadata(this.blocks[0], this.visibleMapOps)

      let docState = {blocks: this.blocks, actorIds: this.actorIds, objectMeta: this.objectMeta, maxOp: 0,
        objectsWithMarks: this.objectsWithMarks}
      this.initPatch = documentPatch(docState)
      this.maxOp = docState.maxOp

    } else {
      this.haveHashGraph = true
      this.changesEncoders = DOCUMENT_COLUMNS.map(col => ({columnId: col.columnId, encoder: encoderByColumnId(col.columnId)}))
      this.changesColumns = null
      this.blocks = [{
        columns: makeDecoders([], DOC_OPS_COLUMNS),
        bloom: new Uint8Array(BLOOM_FILTER_SIZE),
        numOps: 0,
        lastKey: undefined,
        numVisible: undefined,
        lastObjectActor: undefined,
        lastObjectCtr: undefined,
        firstVisibleActor: undefined,
        firstVisibleCtr: undefined,
        lastVisibleActor: undefined,
        lastVisibleCtr: undefined,
        lastIdActor: undefined,
        lastIdCtr: undefined,
        hasListOps: false
      }]
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
  adjustInsertAnchors(change) {
    if (this.objectsWithMarks.size === 0) return
    const objects = new Map()
    for (const op of change.ops) {
      if (!op.insert || op.elemId === undefined || !this.objectsWithMarks.has(op.obj)) continue
      if (!objects.has(op.obj)) objects.set(op.obj, new Map())
      objects.get(op.obj).set(op.elemId, null)
    }
    if (objects.size === 0) return
    for (const [objectId, anchors] of objects) this.scanInsertAnchors(objectId, anchors)
    for (const op of change.ops) {
      if (!op.insert || op.elemId === undefined) continue
      const anchors = objects.get(op.obj)
      const anchor = anchors && anchors.get(op.elemId)
      if (anchor && anchor !== op.elemId) op.elemId = anchor
    }
  }

  /**
   * For each key of `anchors` (an element ID that a local insertion wants to insert after, or
   * `_head`), walks the document operations of the list object `objectId` and determines the
   * element the insertion should actually anchor on, following the Rust `InsertQuery` semantics.
   * Fills in the values of `anchors`; references that are not found (e.g. elements created earlier
   * in the same change) are left as null.
   */
  scanInsertAnchors(objectId, anchors) {
    const object = parseOpId(objectId)
    const states = new Map()
    for (const refKey of anchors.keys()) {
      states.set(refKey, refKey === '_head'
        ? {phase: 'active', candidates: [{ref: '_head', id: null}]}
        : {phase: 'seeking', candidates: [{ref: refKey, id: null}]})
    }
    let remaining = states.size
    for (const block of this.blocks) {
      if (remaining === 0) break
      for (const column of block.columns) column.decoder.reset()
      while (remaining > 0 && !block.columns[actionIdx].decoder.done) {
        const op = readOperation(block.columns, this.actorIds)
        if (op[objCtrIdx] !== object.counter || op[objActorIdx] !== object.actorId ||
            op[keyStrIdx] !== null) continue
        const action = ACTIONS[op[actionIdx]]
        if (action === 'inc') continue
        const insert = op[insertIdx], isMark = action === 'mark'
        const rowId = `${op[idCtrIdx]}@${op[idActorIdx]}`
        const markName = op[markNameIdx], expand = !!op[expandIdx]
        const visible = op[succNumIdx] === 0
        for (const [refKey, state] of states) {
          if (state.phase === 'done') continue
          if (state.phase === 'seeking') {
            if (insert && rowId === refKey) state.phase = 'run'
            continue
          }
          if (state.phase === 'run') {
            // Skip the update operations of the reference element; candidate collection begins
            // at the next inserted element
            if (!insert) continue
            state.phase = 'active'
          }
          if (isMark) {
            if (markName === null) {
              // A markEnd whose matching markBegin is itself a candidate: the points between the
              // pair are invalid insertion spots, drop the pair's candidates
              const beginId = `${op[idCtrIdx] - 1}@${op[idActorIdx]}`
              const index = state.candidates.findIndex(c => c.id === beginId)
              if (index >= 0) {
                state.candidates.length = index
                continue
              }
            }
            const sticky = markName === null ? !expand : expand
            if (sticky) state.candidates.push({ref: rowId, id: rowId})
          } else if (visible) {
            anchors.set(refKey, state.candidates[state.candidates.length - 1].ref)
            state.phase = 'done'
            remaining--
          }
        }
      }
    }
    for (const [refKey, state] of states) {
      if (state.phase === 'active') {
        anchors.set(refKey, state.candidates[state.candidates.length - 1].ref)
      }
    }
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
    copy.objectMeta = this.objectMeta // immutable, no copying needed
    copy.visibleMapOps = new Map(this.visibleMapOps)
    copy.cursorIndex = this.cursorIndex
    copy.objectsWithMarks = new Set(this.objectsWithMarks)
    copy.queue = this.queue // immutable, no copying needed
    copy.saveCursor = this.saveCursor
    copy.changesEncoders = this.changesEncoders &&
      this.changesEncoders.map(col => ({columnId: col.columnId, encoder: col.encoder.clone()}))
    copy.changesColumns = this.changesColumns
    copy.binaryDoc = this.binaryDoc
    copy.initPatch = this.initPatch
    copy.extraBytes = this.extraBytes
    copy.historyMeta = this.historyMeta
    return copy
  }

  /**
   * Parses the changes given as Uint8Arrays in `changeBuffers`, and applies them to the current
   * document. Returns a patch to apply to the frontend. If an exception is thrown, the document
   * object is not modified.
   */
  applyChanges(changeBuffers, isLocal = false) {
    if (changeBuffers instanceof Uint8Array) {
      throw new TypeError('applyChanges takes an array of Uint8Arrays, not just a single Uint8Array')
    }
    if (!Array.isArray(changeBuffers)) {
      throw new TypeError('applyChanges takes an array of Uint8Arrays')
    }

    // decoded change has the form { actor, seq, startOp, time, message, deps, actorIds, hash, columns, buffer }
    let decodedChanges = changeBuffers.map(buffer => {
      const decoded = decodeChangeColumns(buffer)
      decoded.buffer = buffer
      return decoded
    })

    let patches = {_root: {objectId: '_root', type: 'map', props: {}}}
    let docState = {
      maxOp: this.maxOp,
      changeIndexByHash: Object.create(this.changeIndexByHash),
      actorIds: this.actorIds,
      actorIndexById: new Map(this.actorIndexById),
      heads: this.heads,
      clock: this.clock,
      blocks: this.blocks.slice(),
      visibleMapOps: {base: this.visibleMapOps, changes: new Map()},
      objectMeta: Object.assign({}, this.objectMeta),
      objectsWithMarks: new Set(this.objectsWithMarks)
    }
    let queue = (this.queue.length === 0) ? decodedChanges : decodedChanges.concat(this.queue)
    let allApplied = [], objectIds = new Set()

    while (true) {
      const [applied, enqueued] = applyChanges(patches, queue, docState, objectIds, this.haveHashGraph)
      queue = enqueued
      for (let i = 0; i < applied.length; i++) {
        docState.changeIndexByHash[applied[i].hash] = this.changes.length + allApplied.length + i
      }
      if (applied.length > 0) allApplied = allApplied.concat(applied)
      if (queue.length === 0) break

      // If we are missing a dependency, and we haven't computed the hash graph yet, first compute
      // the hashes to see if we actually have it already
      if (applied.length === 0) {
        if (this.haveHashGraph) break
        this.computeHashGraph()
        docState.changeIndexByHash = Object.create(this.changeIndexByHash)
        for (let i = 0; i < allApplied.length; i++) {
          docState.changeIndexByHash[allApplied[i].hash] = this.changes.length + i
        }
      }
    }

    setupPatches(patches, objectIds, docState)

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
    if (allApplied.length > 0) this.historyMeta = null

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

    for (let change of decodeChanges([binaryDoc])) {
      const binaryChange = encodeChange(change) // TODO: avoid decoding and re-encoding again
      changes.push(binaryChange)
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
      numChangeOps += change.ops.length
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
    this.historyMeta = null
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
    if (!this.haveHashGraph) this.computeHashGraph()
    haveDeps = haveDeps.filter(hash => this.dependentsByHash[hash])

    // If the other replica has nothing, return all changes in history order
    if (haveDeps.length === 0) {
      return this.changes.slice()
    }

    // Fast path for the common case where all new changes depend only on haveDeps
    let stack = [], seenHashes = {}, toReturn = [], aborted = false
    for (let hash of haveDeps) {
      seenHashes[hash] = true
      const successors = this.dependentsByHash[hash]
      if (!successors) throw new RangeError(`hash not found: ${hash}`)
      stack.push(...successors)
    }

    // Depth-first traversal of the hash graph to find all changes that depend on `haveDeps`
    while (stack.length > 0) {
      const hash = stack.pop()
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
      return toReturn.map(hash => this.changes[this.changeIndexByHash[hash]])
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

    return this.changes.filter((change, index) => !seenHashes[this.historyHashes[index]])
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

  getHistoryMeta() {
    if (!this.haveHashGraph) this.computeHashGraph()
    if (!this.historyMeta) {
      this.historyMeta = Object.freeze(this.historyHashes.map((hash, index) => Object.freeze({
        index,
        hash,
        deps: Object.freeze(this.dependenciesByHash[hash].slice())
      })))
    }
    return this.historyMeta
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
    if (!this.haveHashGraph) this.computeHashGraph()
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
    return this.getChanges(heads).map(buffer => {
      const change = decodeChangeColumns(buffer)
      const actionColumn = change.columns.find(column => column.columnId === CHANGE_COLUMNS[actionIdx].columnId)
      if (!actionColumn) throw new RangeError('change is missing action column')
      const actions = decoderByColumnId(actionColumn.columnId, actionColumn.buffer)
      let numOps = 0
      while (!actions.done) {
        actions.readValue()
        numOps++
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
    })
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
    let opsColumns = concatBlocks(this.blocks)
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

module.exports = { MAX_BLOCK_SIZE, MAX_MAP_BLOCK_SIZE, BackendDoc, bloomFilterContains }
