import { inflateSync as inflateRaw } from 'fflate'
import { deflate } from './deflate.js'
import { copyObject, equalBytes, parseOpId } from '../src/common.js'
import { BooleanDecoder, BooleanEncoder, Decoder, DeltaDecoder, DeltaEncoder, Encoder, RLEDecoder, RLEEncoder, bytesToHexString, hexStringToBytes, stringToUtf8, utf8ToString } from './encoding.js'
// Maybe we should be using the platform's built-in hash implementation?
// Node has the crypto module: https://nodejs.org/api/crypto.html and browsers have
// https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest
// However, the WebCrypto API is asynchronous (returns promises), which would
// force all our APIs to become asynchronous as well, which would be annoying.
//
// I think on balance, it's safe enough to use a random library off npm:
// - We only need one hash function (not a full suite of crypto algorithms);
// - SHA256 is quite simple and has fairly few opportunities for subtle bugs
//   (compared to asymmetric cryptography anyway);
// - It does not need a secure source of random bits and does not need to be
//   constant-time;
// - I have reviewed the source code and it seems pretty reasonable.
import { sha256 } from './sha256.js'
import { decodeBundle } from './bundle.js'
// These bytes don't mean anything, they were generated randomly
const MAGIC_BYTES = new Uint8Array([0x85, 0x6f, 0x4a, 0x83])

const CHUNK_TYPE_DOCUMENT = 0
const CHUNK_TYPE_CHANGE = 1
const CHUNK_TYPE_DEFLATE = 2 // like CHUNK_TYPE_CHANGE but with DEFLATE compression

// Minimum number of bytes in a value before we enable DEFLATE compression (there is no point
// compressing very short values since compression may actually make them bigger)
const DEFLATE_MIN_SIZE = 256
const DEFLATED_COLUMNS = new Map()

// The least-significant 3 bits of a columnId indicate its datatype
const COLUMN_TYPE = {
  GROUP_CARD: 0, ACTOR_ID: 1, INT_RLE: 2, INT_DELTA: 3, BOOLEAN: 4,
  STRING_RLE: 5, VALUE_LEN: 6, VALUE_RAW: 7
}

// The 4th-least-significant bit of a columnId is set if the column is DEFLATE-compressed
const COLUMN_TYPE_DEFLATE = 8

// In the values in a column of type VALUE_LEN, the bottom four bits indicate the type of the value,
// one of the following types in VALUE_TYPE. The higher bits indicate the length of the value in the
// associated VALUE_RAW column (in bytes).
const VALUE_TYPE = {
  NULL: 0, FALSE: 1, TRUE: 2, LEB128_UINT: 3, LEB128_INT: 4, IEEE754: 5,
  UTF8: 6, BYTES: 7, COUNTER: 8, TIMESTAMP: 9, MIN_UNKNOWN: 10, MAX_UNKNOWN: 15
}

// make* actions must be at even-numbered indexes in this list
const ACTIONS = ['makeMap', 'set', 'makeList', 'del', 'makeText', 'inc', 'makeTable', 'mark']

// Tables were a v1-only feature; documents containing them materialize as plain maps of rows
const OBJECT_TYPE = {makeMap: 'map', makeList: 'list', makeText: 'text', makeTable: 'map'}
const NUMBER_TYPES = new Map([
  ['counter', VALUE_TYPE.COUNTER], ['timestamp', VALUE_TYPE.TIMESTAMP], ['uint', VALUE_TYPE.LEB128_UINT],
  ['int', VALUE_TYPE.LEB128_INT], ['float64', VALUE_TYPE.IEEE754]
])
const UNKNOWN_COLUMNS = Symbol('unknownColumns')
const RAW_VALUE = Symbol('rawValue')

const COMMON_COLUMNS = [
  {columnName: 'objActor',  columnId: 0 << 4 | COLUMN_TYPE.ACTOR_ID},
  {columnName: 'objCtr',    columnId: 0 << 4 | COLUMN_TYPE.INT_RLE},
  {columnName: 'keyActor',  columnId: 1 << 4 | COLUMN_TYPE.ACTOR_ID},
  {columnName: 'keyCtr',    columnId: 1 << 4 | COLUMN_TYPE.INT_DELTA},
  {columnName: 'keyStr',    columnId: 1 << 4 | COLUMN_TYPE.STRING_RLE},
  {columnName: 'idActor',   columnId: 2 << 4 | COLUMN_TYPE.ACTOR_ID},
  {columnName: 'idCtr',     columnId: 2 << 4 | COLUMN_TYPE.INT_DELTA},
  {columnName: 'insert',    columnId: 3 << 4 | COLUMN_TYPE.BOOLEAN},
  {columnName: 'action',    columnId: 4 << 4 | COLUMN_TYPE.INT_RLE},
  {columnName: 'valLen',    columnId: 5 << 4 | COLUMN_TYPE.VALUE_LEN},
  {columnName: 'valRaw',    columnId: 5 << 4 | COLUMN_TYPE.VALUE_RAW},
  {columnName: 'chldActor', columnId: 6 << 4 | COLUMN_TYPE.ACTOR_ID},
  {columnName: 'chldCtr',   columnId: 6 << 4 | COLUMN_TYPE.INT_DELTA}
]

const CHANGE_COLUMNS = COMMON_COLUMNS.concat([
  {columnName: 'predNum',   columnId: 7 << 4 | COLUMN_TYPE.GROUP_CARD},
  {columnName: 'predActor', columnId: 7 << 4 | COLUMN_TYPE.ACTOR_ID},
  {columnName: 'predCtr',   columnId: 7 << 4 | COLUMN_TYPE.INT_DELTA},
  {columnName: 'expand',    columnId: 9 << 4 | COLUMN_TYPE.BOOLEAN},
  {columnName: 'markName',  columnId: 10 << 4 | COLUMN_TYPE.STRING_RLE}
])

const DOC_OPS_COLUMNS = COMMON_COLUMNS.concat([
  {columnName: 'succNum',   columnId: 8 << 4 | COLUMN_TYPE.GROUP_CARD},
  {columnName: 'succActor', columnId: 8 << 4 | COLUMN_TYPE.ACTOR_ID},
  {columnName: 'succCtr',   columnId: 8 << 4 | COLUMN_TYPE.INT_DELTA},
  {columnName: 'expand',    columnId: 9 << 4 | COLUMN_TYPE.BOOLEAN},
  {columnName: 'markName',  columnId: 10 << 4 | COLUMN_TYPE.STRING_RLE}
])

const DOCUMENT_COLUMNS = [
  {columnName: 'actor',     columnId: 0 << 4 | COLUMN_TYPE.ACTOR_ID},
  {columnName: 'seq',       columnId: 0 << 4 | COLUMN_TYPE.INT_DELTA},
  {columnName: 'maxOp',     columnId: 1 << 4 | COLUMN_TYPE.INT_DELTA},
  {columnName: 'time',      columnId: 2 << 4 | COLUMN_TYPE.INT_DELTA},
  {columnName: 'message',   columnId: 3 << 4 | COLUMN_TYPE.STRING_RLE},
  {columnName: 'depsNum',   columnId: 4 << 4 | COLUMN_TYPE.GROUP_CARD},
  {columnName: 'depsIndex', columnId: 4 << 4 | COLUMN_TYPE.INT_DELTA},
  {columnName: 'extraLen',  columnId: 5 << 4 | COLUMN_TYPE.VALUE_LEN},
  {columnName: 'extraRaw',  columnId: 5 << 4 | COLUMN_TYPE.VALUE_RAW}
]

/**
 * Maps an opId of the form {counter: 12345, actorId: 'someActorId'} to the form
 * {counter: 12345, actorNum: 123, actorId: 'someActorId'}, where the actorNum
 * is the index into the `actorIds` array.
 */
function actorIdToActorNum(opId, actorIds) {
  if (!opId || !opId.actorId) return opId
  const actorNum = actorIds.get(opId.actorId)
  if (actorNum === undefined) throw new RangeError('missing actorId') // should not happen
  return {counter: opId.counter, actorNum, actorId: opId.actorId}
}

/**
 * Comparison function to pass to Array.sort(), which compares two opIds in the
 * form produced by `actorIdToActorNum` so that they are sorted in increasing
 * Lamport timestamp order (sorted first by counter, then by actorId).
 */
function compareParsedOpIds(id1, id2) {
  if (id1.counter < id2.counter) return -1
  if (id1.counter > id2.counter) return +1
  if (id1.actorId < id2.actorId) return -1
  if (id1.actorId > id2.actorId) return +1
  return 0
}

/**
 * Takes `changes`, an array of changes (represented as JS objects). Returns an
 * object `{changes, actorIds}`, where `changes` is a copy of the argument in
 * which all string opIds have been replaced with `{counter, actorNum}` objects,
 * and where `actorIds` is a lexicographically sorted array of actor IDs occurring
 * in any of the operations. `actorNum` is an index into that array of actorIds.
 * If `single` is true, the actorId of the author of the change is moved to the
 * beginning of the array of actorIds, so that `actorNum` is zero when referencing
 * the author of the change itself. This special-casing is omitted if `single` is
 * false.
 */
function parseAllOpIds(changes, single, actorOrder) {
  const actors = {}, newChanges = []
  for (let change of changes) {
    change = copyObject(change)
    actors[change.actor] = true
    change.ops = expandMultiOps(change.ops, change.startOp, change.actor)
    change.ops = change.ops.map(op => {
      const unknownColumns = op[UNKNOWN_COLUMNS]
      const rawValue = op[RAW_VALUE]
      op = copyObject(op)
      if (unknownColumns) op[UNKNOWN_COLUMNS] = unknownColumns
      if (rawValue) op[RAW_VALUE] = rawValue
      if (op.obj !== '_root') op.obj = parseOpId(op.obj)
      if (op.elemId && op.elemId !== '_head') op.elemId = parseOpId(op.elemId)
      if (op.child) op.child = parseOpId(op.child)
      if (op.pred) op.pred = op.pred.map(parseOpId)
      if (op.obj.actorId) actors[op.obj.actorId] = true
      if (op.elemId && op.elemId.actorId) actors[op.elemId.actorId] = true
      if (op.child && op.child.actorId) actors[op.child.actorId] = true
      for (let pred of op.pred) actors[pred.actorId] = true
      if (unknownColumns) {
        for (const [columnId, value] of Object.entries(unknownColumns)) {
          if ((Number(columnId) & 7) !== COLUMN_TYPE.ACTOR_ID) continue
          for (const actor of Array.isArray(value) ? value : [value]) {
            if (actor !== null) actors[actor] = true
          }
        }
      }
      return op
    })
    newChanges.push(change)
  }

  let actorIds
  if (Array.isArray(actorOrder)) {
    const remaining = new Set(Object.keys(actors))
    actorIds = actorOrder.filter(actor => remaining.delete(actor))
    if (remaining.size > 0) throw new RangeError(`Missing actors: ${Array.from(remaining).join(', ')}`)
  } else {
    actorIds = Object.keys(actors).sort()
  }
  if (single) {
    actorIds = [changes[0].actor].concat(actorIds.filter(actor => actor !== changes[0].actor))
  }
  const actorIndex = new Map(actorIds.map((actor, index) => [actor, index]))
  for (let change of newChanges) {
    for (let op of change.ops) {
      op.obj = actorIdToActorNum(op.obj, actorIndex)
      op.elemId = actorIdToActorNum(op.elemId, actorIndex)
      op.child = actorIdToActorNum(op.child, actorIndex)
      op.pred = op.pred.map(pred => actorIdToActorNum(pred, actorIndex))
      if (op[UNKNOWN_COLUMNS]) {
        const columns = {}
        for (const [columnId, value] of Object.entries(op[UNKNOWN_COLUMNS])) {
          columns[columnId] = (Number(columnId) & 7) === COLUMN_TYPE.ACTOR_ID
            ? (Array.isArray(value) ? value.map(actor => (actor === null ? null : actorIndex.get(actor)))
              : value === null ? null : actorIndex.get(value))
            : value
        }
        op[UNKNOWN_COLUMNS] = columns
      }
    }
  }
  return {changes: newChanges, actorIds}
}

/**
 * Encodes the `obj` property of operation `op` into the two columns
 * `objActor` and `objCtr`.
 */
function encodeObjectId(op, columns) {
  if (op.obj === '_root') {
    columns.objActor.appendValue(null)
    columns.objCtr.appendValue(null)
  } else if (op.obj.actorNum >= 0 && op.obj.counter > 0) {
    columns.objActor.appendValue(op.obj.actorNum)
    columns.objCtr.appendValue(op.obj.counter)
  } else {
    throw new RangeError(`Unexpected objectId reference: ${JSON.stringify(op.obj)}`)
  }
}

/**
 * Encodes the `key` and `elemId` properties of operation `op` into the three
 * columns `keyActor`, `keyCtr`, and `keyStr`.
 */
function encodeOperationKey(op, columns) {
  if (op.key !== undefined) {
    columns.keyActor.appendValue(null)
    columns.keyCtr.appendValue(null)
    columns.keyStr.appendValue(op.key)
  } else if (op.elemId === '_head' && op.insert) {
    columns.keyActor.appendValue(null)
    columns.keyCtr.appendValue(0)
    columns.keyStr.appendValue(null)
  } else if (op.elemId && op.elemId.actorNum >= 0 && op.elemId.counter > 0) {
    columns.keyActor.appendValue(op.elemId.actorNum)
    columns.keyCtr.appendValue(op.elemId.counter)
    columns.keyStr.appendValue(null)
  } else {
    throw new RangeError(`Unexpected operation key: ${JSON.stringify(op)}`)
  }
}

/**
 * Encodes the `action` property of operation `op` into the `action` column.
 */
function encodeOperationAction(op, columns) {
  const actionCode = op.action === 'markBegin' || op.action === 'markEnd'
    ? ACTIONS.indexOf('mark')
    : ACTIONS.indexOf(op.action)
  if (actionCode >= 0) {
    columns.action.appendValue(actionCode)
  } else if (typeof op.action === 'number') {
    columns.action.appendValue(op.action)
  } else {
    throw new RangeError(`Unexpected operation action: ${op.action}`)
  }
}

/**
 * Encodes the `value` property of operation `op` into the two columns
 * `valLen` and `valRaw`.
 */
function encodeValue(op, columns) {
  if (op[RAW_VALUE]) {
    columns.valLen.appendValue(op[RAW_VALUE].sizeTag)
    columns.valRaw.appendRawBytes(op[RAW_VALUE].rawValue)
    return
  }
  const hasValue = op.action === 'set' || op.action === 'inc' ||
    op.action === 'markBegin' || op.action === 'mark' && (op.markName !== undefined || op.name !== undefined)
  if (!hasValue || op.value === null) {
    columns.valLen.appendValue(VALUE_TYPE.NULL)
  } else if (op.value === false) {
    columns.valLen.appendValue(VALUE_TYPE.FALSE)
  } else if (op.value === true) {
    columns.valLen.appendValue(VALUE_TYPE.TRUE)
  } else if (typeof op.value === 'string') {
    const numBytes = columns.valRaw.appendRawBytes(stringToUtf8(op.value))
    columns.valLen.appendValue(numBytes << 4 | VALUE_TYPE.UTF8)
  } else if (ArrayBuffer.isView(op.value)) {
    const numBytes = columns.valRaw.appendRawBytes(
      new Uint8Array(op.value.buffer, op.value.byteOffset, op.value.byteLength)
    )
    columns.valLen.appendValue(numBytes << 4 | VALUE_TYPE.BYTES)
  } else if (typeof op.value === 'number') {
    let typeTag = NUMBER_TYPES.get(op.datatype), numBytes
    // increment operators get resolved here ...
    if (!typeTag) typeTag = Number.isSafeInteger(op.value) ? VALUE_TYPE.LEB128_INT : VALUE_TYPE.IEEE754
    if (typeTag === VALUE_TYPE.LEB128_UINT) {
      numBytes = columns.valRaw.appendUint53(op.value)
    } else if (typeTag === VALUE_TYPE.IEEE754) {
      const bytes = new Uint8Array(8)
      new DataView(bytes.buffer).setFloat64(0, op.value, true)
      numBytes = columns.valRaw.appendRawBytes(bytes)
    } else {
      numBytes = columns.valRaw.appendInt53(op.value)
    }
    columns.valLen.appendValue(numBytes << 4 | typeTag)
  } else if (typeof op.datatype === 'number' && op.datatype >= VALUE_TYPE.MIN_UNKNOWN &&
             op.datatype <= VALUE_TYPE.MAX_UNKNOWN && op.value instanceof Uint8Array) {
    const numBytes = columns.valRaw.appendRawBytes(op.value)
    columns.valLen.appendValue(numBytes << 4 | op.datatype)
  } else if (op.datatype) {
      throw new RangeError(`Unknown datatype ${op.datatype} for value ${op.value}`)
  } else {
    throw new RangeError(`Unsupported value in operation: ${op.value}`)
  }
}

/**
 * Given `sizeTag` (an unsigned integer read from a VALUE_LEN column) and `bytes` (a Uint8Array
 * read from a VALUE_RAW column, with length `sizeTag >> 4`), this function returns an object of the
 * form `{value: value, datatype: datatypeTag}` where `value` is a JavaScript primitive datatype
 * corresponding to the value, and `datatypeTag` is a datatype annotation such as 'counter'.
 */
function decodeValue(sizeTag, bytes) {
  if (sizeTag === VALUE_TYPE.NULL) return {value: null}
  if (sizeTag === VALUE_TYPE.FALSE) return {value: false}
  if (sizeTag === VALUE_TYPE.TRUE) return {value: true}
  const type = sizeTag % 16
  if (type === VALUE_TYPE.UTF8) return {value: utf8ToString(bytes)}
  if (type === VALUE_TYPE.LEB128_UINT) return {value: new Decoder(bytes).readUint53(), datatype: 'uint'}
  if (type === VALUE_TYPE.LEB128_INT) return {value: new Decoder(bytes).readInt53(), datatype: 'int'}
  if (type === VALUE_TYPE.IEEE754) {
    if (bytes.byteLength !== 8) throw new RangeError(`Invalid length for floating point number: ${bytes.byteLength}`)
    return {value: new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true), datatype: 'float64'}
  }
  if (type === VALUE_TYPE.COUNTER) return {value: new Decoder(bytes).readInt53(), datatype: 'counter'}
  if (type === VALUE_TYPE.TIMESTAMP) return {value: new Decoder(bytes).readInt53(), datatype: 'timestamp'}
  return {value: bytes, datatype: type}
}

/**
 * Reads one value from the column `columns[colIndex]` and interprets it based
 * on the column type. `actorIds` is a list of actors that appear in the change;
 * `actorIds[0]` is the actorId of the change's author. Mutates the `result`
 * object with the value, and returns the number of columns processed (this is 2
 * in the case of a pair of VALUE_LEN and VALUE_RAW columns, which are processed
 * in one go).
 */
function setColumnValue(result, columnId, columnName, value) {
  if (columnName === undefined) {
    if (!result[UNKNOWN_COLUMNS]) result[UNKNOWN_COLUMNS] = {}
    result[UNKNOWN_COLUMNS][columnId] = value
  } else {
    result[columnName] = value
  }
}

function decodeValueColumns(columns, colIndex, actorIds, result) {
  const { columnId, columnName, decoder } = columns[colIndex]
  if (columnId % 8 === COLUMN_TYPE.VALUE_LEN && colIndex + 1 < columns.length &&
      columns[colIndex + 1].columnId === columnId + 1) {
    const sizeTag = decoder.readValue()
    const rawValue = columns[colIndex + 1].decoder.readRawBytes(sizeTag >> 4)
    if (columnName === undefined) {
      setColumnValue(result, columnId, columnName, sizeTag)
      setColumnValue(result, columnId + 1, undefined, rawValue)
    } else {
      const { value, datatype } = decodeValue(sizeTag, rawValue)
      result[columnName] = value
      if (datatype) result[columnName + '_datatype'] = datatype
      result[RAW_VALUE] = {sizeTag, rawValue}
    }
    return 2
  } else if (columnId % 8 === COLUMN_TYPE.ACTOR_ID) {
    const actorNum = decoder.readValue()
    if (actorNum === null) {
      setColumnValue(result, columnId, columnName, null)
    } else {
      if (!actorIds[actorNum]) throw new RangeError(`No actor index ${actorNum}`)
      setColumnValue(result, columnId, columnName, actorIds[actorNum])
    }
  } else {
    setColumnValue(result, columnId, columnName, decoder.readValue())
  }
  return 1
}

function encodeOp(op, columns) {
  encodeObjectId(op, columns)
  encodeOperationKey(op, columns)
  columns.insert.appendValue(!!op.insert)
  encodeOperationAction(op, columns)
  encodeValue(op, columns)
  if (columns.expand) columns.expand.appendValue(!!op.expand)
  const markName = op.markName === undefined ? op.name : op.markName
  columns.markName.appendValue(markName === undefined ? null : markName)
}

/**
 * Encodes an array of operations in a set of columns. The operations need to
 * be parsed with `parseAllOpIds()` beforehand. Returns an array of
 * `{columnId, columnName, encoder}` objects.
 */
function encodeOps(ops) {
  const expand = ops.some(op => op.expand), columns = {}
  for (const {columnName, columnId} of CHANGE_COLUMNS) {
    if (columnName !== 'expand' || expand) columns[columnName] = encoderByColumnId(columnId)
  }

  const unknownColumnIds = new Set()
  for (const op of ops) {
    if (op[UNKNOWN_COLUMNS]) {
      for (const columnId of Object.keys(op[UNKNOWN_COLUMNS])) unknownColumnIds.add(Number(columnId))
    }
  }
  const unknownColumns = Array.from(unknownColumnIds).sort((left, right) => left - right)
    .map(columnId => ({columnId, encoder: encoderByColumnId(columnId)}))

  for (let op of ops) {
    encodeOp(op, columns)
    if (op.child && op.child.counter) {
      columns.chldActor.appendValue(op.child.actorNum)
      columns.chldCtr.appendValue(op.child.counter)
    } else {
      columns.chldActor.appendValue(null)
      columns.chldCtr.appendValue(null)
    }
    columns.predNum.appendValue(op.pred.length)
    op.pred.sort(compareParsedOpIds)
    for (const pred of op.pred) {
      columns.predActor.appendValue(pred.actorNum)
      columns.predCtr.appendValue(pred.counter)
    }
    appendUnknownOperation(unknownColumns, op[UNKNOWN_COLUMNS])
  }

  return CHANGE_COLUMNS.filter(({columnName}) => columns[columnName])
    .map(({columnId, columnName}) => ({columnId, columnName, encoder: columns[columnName]}))
    .concat(unknownColumns).sort((a, b) => a.columnId - b.columnId)
}

function appendUnknownOperation(columns, values) {
  let lastGroup = -1, lastCardinality = 0
  for (const column of columns) {
    const columnId = column.columnId, type = columnId & 7
    const present = values && Object.prototype.hasOwnProperty.call(values, columnId)
    const value = present ? values[columnId] : undefined
    if (type === COLUMN_TYPE.GROUP_CARD) {
      lastGroup = columnId >> 4
      lastCardinality = present ? value : 0
      column.encoder.appendValue(lastCardinality)
    } else if (type === COLUMN_TYPE.VALUE_RAW) {
      if (present) {
        for (const bytes of Array.isArray(value) ? value : [value]) column.encoder.appendRawBytes(bytes)
      }
    } else if (Array.isArray(value)) {
      for (const item of value) column.encoder.appendValue(item)
    } else {
      const blank = type === COLUMN_TYPE.BOOLEAN ? false : (type === COLUMN_TYPE.VALUE_LEN ? 0 : null)
      if (columnId >> 4 === lastGroup) {
        column.encoder.appendValue(blank, lastCardinality)
      } else {
        column.encoder.appendValue(present ? value : blank)
      }
    }
  }
}

function validDatatype(value, datatype) {
  if (datatype === undefined) {
    return (typeof value === 'string' || typeof value === 'boolean' || value === null || value instanceof Uint8Array)
  } else {
    return typeof value === 'number'
  }
}

function expandMultiOps(ops, startOp, actor) {
  let opNum = startOp
  let expandedOps = []
  for (const op of ops) {
    if (op.action === 'set' && op.values && op.insert) {
      if (op.pred.length !== 0) throw new RangeError('multi-insert pred must be empty')
      let lastElemId = op.elemId
      const datatype = op.datatype
      for (const value of op.values) {
        if (!validDatatype(value, datatype)) throw new RangeError(`Decode failed: bad value/datatype association (${value},${datatype})`)
        expandedOps.push({action: 'set', obj: op.obj, elemId: lastElemId, datatype, value, pred: [], insert: true})
        lastElemId = `${opNum}@${actor}`
        opNum += 1
      }
    } else if (op.action === 'del' && op.multiOp > 1) {
      if (op.pred.length !== 1) throw new RangeError('multiOp deletion must have exactly one pred')
      const startElemId = parseOpId(op.elemId), startPred = parseOpId(op.pred[0])
      for (let i = 0; i < op.multiOp; i++) {
        const elemId = `${startElemId.counter + i}@${startElemId.actorId}`
        const pred = [`${startPred.counter + i}@${startPred.actorId}`]
        expandedOps.push({action: 'del', obj: op.obj, elemId, pred})
        opNum += 1
      }
    } else {
      expandedOps.push(op)
      opNum += 1
    }
  }
  return expandedOps
}

/**
 * Takes a change as decoded by `decodeColumns`, and changes it into the form
 * expected by the rest of the backend. If `forDocument` is true, we use the op
 * structure of a whole document, otherwise we use the op structure for an
 * individual change.
 */
function decodeOps(ops, forDocument) {
  const forBundle = forDocument === 'bundle'
  forDocument = forDocument === true
  const newOps = []
  for (let op of ops) {
    const obj = (op.objCtr === null) ? '_root' : `${op.objCtr}@${op.objActor}`
    const elemId = op.keyStr !== null ? undefined : (op.keyCtr === 0 ? '_head' : `${op.keyCtr}@${op.keyActor}`)
    let action = ACTIONS[op.action] || op.action
    if (action === 'mark') action = op.markName === null ? 'markEnd' : 'markBegin'
    const newOp = elemId ? {obj, elemId, action} : {obj, key: op.keyStr, action}
    newOp.insert = !!op.insert
    if (ACTIONS[op.action] === 'set' || ACTIONS[op.action] === 'inc' || action === 'markBegin') {
      newOp.value = op.valLen
      if (op.valLen_datatype) newOp.datatype = op.valLen_datatype
    }
    if (op[RAW_VALUE]) Object.defineProperty(newOp, RAW_VALUE, {value: op[RAW_VALUE], writable: true, configurable: true})
    if (action === 'markBegin') newOp.name = op.markName
    if (action === 'markBegin' || action === 'markEnd') newOp.expand = !!op.expand
    if (!!op.chldCtr !== !!op.chldActor) {
      throw new RangeError(`Mismatched child columns: ${op.chldCtr} and ${op.chldActor}`)
    }
    if (op.chldCtr !== null) newOp.child = `${op.chldCtr}@${op.chldActor}`
    if (forDocument) {
      newOp.id = `${op.idCtr}@${op.idActor}`
      newOp.succ = op.succNum.map(succ => `${succ.succCtr}@${succ.succActor}`)
      checkSortedOpIds(op.succNum.map(succ => ({counter: succ.succCtr, actorId: succ.succActor})))
    } else {
      if (forBundle) newOp.id = `${op.idCtr}@${op.idActor}`
      newOp.pred = op.predNum.map(pred => `${pred.predCtr}@${pred.predActor}`)
      checkSortedOpIds(op.predNum.map(pred => ({counter: pred.predCtr, actorId: pred.predActor})))
    }
    if (op[UNKNOWN_COLUMNS]) Object.defineProperty(newOp, UNKNOWN_COLUMNS, {value: op[UNKNOWN_COLUMNS], writable: true, configurable: true})
    newOps.push(newOp)
  }
  return newOps
}

/**
 * Throws an exception if the opIds in the given array are not in sorted order.
 */
function checkSortedOpIds(opIds) {
  let last = null
  for (let opId of opIds) {
    if (last && compareParsedOpIds(last, opId) !== -1) {
      throw new RangeError('operation IDs are not in ascending order')
    }
    last = opId
  }
}

function encoderByColumnId(columnId) {
  if ((columnId & 7) === COLUMN_TYPE.INT_DELTA) {
    return new DeltaEncoder()
  } else if ((columnId & 7) === COLUMN_TYPE.BOOLEAN) {
    return new BooleanEncoder()
  } else if ((columnId & 7) === COLUMN_TYPE.STRING_RLE) {
    return new RLEEncoder('utf8')
  } else if ((columnId & 7) === COLUMN_TYPE.VALUE_RAW) {
    return new Encoder()
  } else {
    return new RLEEncoder('uint')
  }
}

function decoderByColumnId(columnId, buffer) {
  if ((columnId & 7) === COLUMN_TYPE.INT_DELTA) {
    return new DeltaDecoder(buffer)
  } else if ((columnId & 7) === COLUMN_TYPE.BOOLEAN) {
    return new BooleanDecoder(buffer)
  } else if ((columnId & 7) === COLUMN_TYPE.STRING_RLE) {
    return new RLEDecoder('utf8', buffer)
  } else if ((columnId & 7) === COLUMN_TYPE.VALUE_RAW) {
    return new Decoder(buffer)
  } else {
    return new RLEDecoder('uint', buffer)
  }
}

function makeDecoders(columns, columnSpec) {
  const emptyBuf = new Uint8Array(0)
  let decoders = [], columnIndex = 0, specIndex = 0

  while (columnIndex < columns.length || specIndex < columnSpec.length) {
    if (columnIndex === columns.length ||
        (specIndex < columnSpec.length && columnSpec[specIndex].columnId < columns[columnIndex].columnId)) {
      const {columnId, columnName} = columnSpec[specIndex]
      decoders.push({columnId, columnName, decoder: decoderByColumnId(columnId, emptyBuf)})
      specIndex++
    } else if (specIndex === columnSpec.length || columns[columnIndex].columnId < columnSpec[specIndex].columnId) {
      const {columnId, buffer} = columns[columnIndex]
      decoders.push({columnId, decoder: decoderByColumnId(columnId, buffer)})
      columnIndex++
    } else { // columns[columnIndex].columnId === columnSpec[specIndex].columnId
      const {columnId, buffer} = columns[columnIndex], {columnName} = columnSpec[specIndex]
      decoders.push({columnId, columnName, decoder: decoderByColumnId(columnId, buffer)})
      columnIndex++
      specIndex++
    }
  }
  return decoders
}

function decodeColumns(columns, actorIds, columnSpec) {
  columns = makeDecoders(columns, columnSpec)
  let parsedRows = []
  while (columns.some(col => !col.decoder.done)) {
    let row = {}, col = 0
    while (col < columns.length) {
      const columnId = columns[col].columnId
      let groupId = columnId >> 4, groupCols = 1
      while (col + groupCols < columns.length && columns[col + groupCols].columnId >> 4 === groupId) {
        groupCols++
      }

      if (columnId % 8 === COLUMN_TYPE.GROUP_CARD) {
        const values = [], count = columns[col].decoder.readValue()
        const groupedUnknown = {}
        for (let colOffset = 1; colOffset < groupCols; colOffset++) {
          if (columns[col + colOffset].columnName === undefined) {
            groupedUnknown[columns[col + colOffset].columnId] = []
          }
        }
        for (let i = 0; i < count; i++) {
          let value = {}
          for (let colOffset = 1; colOffset < groupCols;) {
            colOffset += decodeValueColumns(columns, col + colOffset, actorIds, value)
          }
          if (value[UNKNOWN_COLUMNS]) {
            for (const [unknownId, unknownValue] of Object.entries(value[UNKNOWN_COLUMNS])) {
              groupedUnknown[unknownId].push(unknownValue)
            }
          }
          values.push(value)
        }
        setColumnValue(row, columnId, columns[col].columnName, columns[col].columnName === undefined ? count : values)
        for (const [unknownId, unknownValues] of Object.entries(groupedUnknown)) {
          setColumnValue(row, Number(unknownId), undefined, unknownValues)
        }
        col += groupCols
      } else {
        col += decodeValueColumns(columns, col, actorIds, row)
      }
    }
    parsedRows.push(row)
  }
  return parsedRows
}

function decodeColumnInfo(decoder) {
  // A number that is all 1 bits except for the bit that indicates whether a column is
  // deflate-compressed. We ignore this bit when checking whether columns are sorted by ID.
  const COLUMN_ID_MASK = (-1 ^ COLUMN_TYPE_DEFLATE) >>> 0

  let lastColumnId = -1, columns = [], numColumns = decoder.readUint53()
  for (let i = 0; i < numColumns; i++) {
    const columnId = decoder.readUint53(), bufferLen = decoder.readUint53()
    if ((columnId & COLUMN_ID_MASK) <= (lastColumnId & COLUMN_ID_MASK)) {
      throw new RangeError('Columns must be in ascending order')
    }
    lastColumnId = columnId
    columns.push({columnId, bufferLen})
  }
  return columns
}

function encodeColumnInfo(encoder, columns) {
  const nonEmptyColumns = []
  for (const column of columns) {
    const byteLength = column.encoder.buffer.byteLength
    if (byteLength > 0) nonEmptyColumns.push([column.columnId, byteLength])
  }
  encoder.appendUint53(nonEmptyColumns.length)
  for (const [columnId, byteLength] of nonEmptyColumns) {
    encoder.appendUint53(columnId)
    encoder.appendUint53(byteLength)
  }
}

function decodeChangeHeader(decoder) {
  const numDeps = decoder.readUint53(), deps = []
  for (let i = 0; i < numDeps; i++) {
    deps.push(bytesToHexString(decoder.readRawBytes(32)))
  }
  let change = {
    actor:   decoder.readHexString(),
    seq:     decoder.readUint53(),
    startOp: decoder.readUint53(),
    time:    decoder.readInt53(),
    message: decoder.readPrefixedString(),
    deps
  }
  const actorIds = [change.actor], numActorIds = decoder.readUint53()
  for (let i = 0; i < numActorIds; i++) actorIds.push(decoder.readHexString())
  change.actorIds = actorIds
  return change
}

/**
 * Assembles a chunk of encoded data containing a checksum, headers, and a
 * series of encoded columns. Calls `encodeHeaderCallback` with an encoder that
 * should be used to add the headers. The columns should be given as `columns`.
 */
function encodeContainer(chunkType, encodeContentsCallback) {
  const CHECKSUM_SIZE = 4 // checksum is first 4 bytes of SHA-256 hash of the rest of the data
  const HEADER_SPACE = MAGIC_BYTES.byteLength + CHECKSUM_SIZE + 1 + 5 // 1 byte type + 5 bytes length
  const body = new Encoder()
  // Make space for the header at the beginning of the body buffer. We will
  // copy the header in here later. This is cheaper than copying the body since
  // the body is likely to be much larger than the header.
  body.appendRawBytes(new Uint8Array(HEADER_SPACE))
  encodeContentsCallback(body)

  const bodyBuf = body.buffer
  const header = new Encoder()
  header.appendByte(chunkType)
  header.appendUint53(bodyBuf.byteLength - HEADER_SPACE)

  // Compute the hash over chunkType, length, and body
  const headerBuf = header.buffer
  const hash = sha256(headerBuf, bodyBuf.subarray(HEADER_SPACE)), checksum = hash.subarray(0, CHECKSUM_SIZE)

  // Copy header into the body buffer so that they are contiguous
  bodyBuf.set(MAGIC_BYTES, HEADER_SPACE - headerBuf.byteLength - CHECKSUM_SIZE - MAGIC_BYTES.byteLength)
  bodyBuf.set(checksum,    HEADER_SPACE - headerBuf.byteLength - CHECKSUM_SIZE)
  bodyBuf.set(headerBuf,   HEADER_SPACE - headerBuf.byteLength)
  return {hash, bytes: bodyBuf.subarray(HEADER_SPACE - headerBuf.byteLength - CHECKSUM_SIZE - MAGIC_BYTES.byteLength)}
}

function decodeContainerHeader(decoder, computeHash) {
  if (!equalBytes(decoder.readRawBytes(MAGIC_BYTES.byteLength), MAGIC_BYTES)) {
    throw new RangeError('Data does not begin with magic bytes 85 6f 4a 83')
  }
  const expectedHash = decoder.readRawBytes(4)
  const hashStartOffset = decoder.offset
  const chunkType = decoder.readByte()
  const chunkLength = decoder.readUint53()
  const header = {chunkType, chunkLength, chunkData: decoder.readRawBytes(chunkLength)}

  if (computeHash) {
    const binaryHash = sha256(decoder.buf.subarray(hashStartOffset, decoder.offset))
    if (!equalBytes(binaryHash.subarray(0, 4), expectedHash)) {
      throw new RangeError('checksum does not match data')
    }
    header.hash = bytesToHexString(binaryHash)
  }
  return header
}

function encodeChange(changeObj, actorOrder) {
  return encodeChangeColumns(changeObj, actorOrder).buffer
}

function encodeChangeColumns(changeObj, actorOrder) {
  if (changeObj.hash !== undefined && changeObj.hash !== null &&
      (typeof changeObj.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(changeObj.hash))) {
    throw new RangeError('Change hash must be a 32-byte hexadecimal string')
  }
  const { changes, actorIds } = parseAllOpIds([changeObj], true, actorOrder)
  const change = changes[0]
  let extraBytes = change.extraBytes
  if (change.extra_bytes !== undefined) {
    if (!Array.isArray(change.extra_bytes) ||
        change.extra_bytes.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new RangeError('extra_bytes must be an array of bytes')
    }
    extraBytes = new Uint8Array(change.extra_bytes)
  }
  return encodeChangeContainer(change, actorIds, extraBytes)
}

function encodeChangeContainer(change, actorIds, extraBytes, opColumns) {
  if (!Array.isArray(change.deps)) throw new TypeError('deps is not an array')
  const deps = change.deps.slice().sort(), message = change.message || ''
  let columns
  const { hash, bytes } = encodeContainer(CHUNK_TYPE_CHANGE, encoder => {
    encoder.appendUint53(deps.length)
    for (let hash of deps) {
      encoder.appendRawBytes(hexStringToBytes(hash))
    }
    encoder.appendHexString(change.actor)
    encoder.appendUint53(change.seq)
    encoder.appendUint53(change.startOp)
    encoder.appendInt53(change.time)
    encoder.appendPrefixedString(message)
    encoder.appendUint53(actorIds.length - 1)
    for (let actor of actorIds.slice(1)) encoder.appendHexString(actor)

    columns = []
    for (const column of opColumns || encodeOps(change.ops)) {
      const buffer = column.encoder.buffer
      if (buffer.byteLength > 0) columns.push({columnId: column.columnId, bufferLen: buffer.byteLength, buffer})
    }
    encoder.appendUint53(columns.length)
    for (const column of columns) {
      encoder.appendUint53(column.columnId)
      encoder.appendUint53(column.bufferLen)
    }
    for (const column of columns) encoder.appendRawBytes(column.buffer)
    if (extraBytes) encoder.appendRawBytes(extraBytes)
  })

  const decoded = {
    actor: change.actor, seq: change.seq, startOp: change.startOp, time: change.time, message, deps, actorIds
  }
  if (extraBytes && extraBytes.byteLength > 0) decoded.extraBytes = extraBytes
  decoded.columns = columns
  decoded.hash = bytesToHexString(hash)
  decoded.buffer = (bytes.byteLength >= DEFLATE_MIN_SIZE) ? recodeChange(bytes, CHUNK_TYPE_DEFLATE, data => deflate(data).output) : bytes
  return decoded
}

function decodeChangeColumns(buffer, computeHash = true) {
  if (buffer[8] === CHUNK_TYPE_DEFLATE) buffer = recodeChange(buffer, CHUNK_TYPE_CHANGE, inflateRaw)
  const decoder = new Decoder(buffer)
  const header = decodeContainerHeader(decoder, computeHash)
  const chunkDecoder = new Decoder(header.chunkData)
  if (!decoder.done) throw new RangeError('Encoded change has trailing data')
  if (header.chunkType !== CHUNK_TYPE_CHANGE) throw new RangeError(`Unexpected chunk type: ${header.chunkType}`)

  const change = decodeChangeHeader(chunkDecoder)
  const columns = decodeColumnInfo(chunkDecoder)
  for (let i = 0; i < columns.length; i++) {
    if ((columns[i].columnId & COLUMN_TYPE_DEFLATE) !== 0) {
      throw new RangeError('change must not contain deflated columns')
    }
    columns[i].buffer = chunkDecoder.readRawBytes(columns[i].bufferLen)
  }
  if (!chunkDecoder.done) {
    const restLen = chunkDecoder.buf.byteLength - chunkDecoder.offset
    change.extraBytes = chunkDecoder.readRawBytes(restLen)
  }

  change.columns = columns
  change.hash = header.hash
  return change
}

/**
 * Decodes one change in binary format into its JS object representation.
 */
function decodeChange(buffer, raw = false) {
  const change = decodeChangeColumns(buffer)
  change.ops = decodeOps(decodeColumns(change.columns, change.actorIds, CHANGE_COLUMNS), false)
  delete change.actorIds
  delete change.columns
  if (raw !== true) {
    if (change.message === '') change.message = null
    if (change.extraBytes) {
      change.extra_bytes = Array.from(change.extraBytes)
      delete change.extraBytes
    }
    for (const op of change.ops) {
      delete op[UNKNOWN_COLUMNS]
      delete op[RAW_VALUE]
      if (!op.insert) delete op.insert
      if (typeof op.datatype === 'number' && op.datatype >= VALUE_TYPE.MIN_UNKNOWN &&
          op.datatype <= VALUE_TYPE.MAX_UNKNOWN) {
        op.value = {type_code: op.datatype, bytes: Array.from(op.value)}
        delete op.datatype
      } else if (op.datatype === VALUE_TYPE.BYTES) {
        op.value = Array.from(op.value)
        delete op.datatype
      } else if (op.action !== 'set') {
        delete op.datatype
      }
    }
  }
  return change
}

/**
 * Decodes the header fields of a change in binary format, but does not decode
 * the operations. Saves work when we only need to inspect the headers. Only
 * computes the hash of the change if `computeHash` is true.
 */
function decodeChangeMeta(buffer, computeHash) {
  if (buffer[8] === CHUNK_TYPE_DEFLATE) buffer = recodeChange(buffer, CHUNK_TYPE_CHANGE, inflateRaw)
  const header = decodeContainerHeader(new Decoder(buffer), computeHash)
  if (header.chunkType !== CHUNK_TYPE_CHANGE) {
    throw new RangeError('Buffer chunk type is not a change')
  }
  const meta = decodeChangeHeader(new Decoder(header.chunkData))
  meta.change = buffer
  if (computeHash) meta.hash = header.hash
  return meta
}

function recodeChange(buffer, chunkType, transform) {
  const data = transform(decodeContainerHeader(new Decoder(buffer), false).chunkData)
  const encoder = new Encoder()
  encoder.appendRawBytes(buffer.subarray(0, 8)) // copy MAGIC_BYTES and checksum
  encoder.appendByte(chunkType)
  encoder.appendUint53(data.byteLength)
  encoder.appendRawBytes(data)
  return encoder.buffer
}

function decompressChange(buffer) {
  return buffer[8] === CHUNK_TYPE_DEFLATE ? recodeChange(buffer, CHUNK_TYPE_CHANGE, inflateRaw) : buffer
}

/**
 * Takes an Uint8Array that may contain multiple concatenated changes, and
 * returns an array of subarrays, each subarray containing one change.
 */
function splitContainers(buffer) {
  let decoder = new Decoder(buffer), chunks = [], startOffset = 0
  while (!decoder.done) {
    decodeContainerHeader(decoder, false)
    chunks.push(buffer.subarray(startOffset, decoder.offset))
    startOffset = decoder.offset
  }
  return chunks
}

/**
 * Decodes a list of changes from the binary format into JS objects.
 * `binaryChanges` is an array of `Uint8Array` objects.
 */
function decodeChanges(binaryChanges) {
  let decoded = []
  for (let binaryChange of binaryChanges) {
    for (let chunk of splitContainers(binaryChange)) {
      if (chunk[8] === CHUNK_TYPE_DOCUMENT) {
        decoded = decoded.concat(decodeDocument(chunk))
      } else if (chunk[8] === CHUNK_TYPE_CHANGE || chunk[8] === CHUNK_TYPE_DEFLATE) {
        decoded.push(decodeChange(chunk, true))
      } else if (chunk[8] === 3) {
        decoded = decoded.concat(decodeBundle(chunk).changes)
      } else {
        // ignoring chunk of unknown type
      }
    }
  }
  return decoded
}

function isBlankUnknownValue(columnId, value) {
  const type = columnId & 7
  if (Array.isArray(value)) return value.every(item => isBlankUnknownValue(columnId, item))
  if (type === COLUMN_TYPE.VALUE_RAW) return !value || value.byteLength === 0
  if (type === COLUMN_TYPE.GROUP_CARD || type === COLUMN_TYPE.VALUE_LEN) return value === null || value === 0
  if (type === COLUMN_TYPE.BOOLEAN) return value === false
  return value === null
}

function stripBlankUnknownColumns(change) {
  const columnIds = new Set()
  for (const op of change.ops) {
    if (op[UNKNOWN_COLUMNS]) {
      for (const columnId of Object.keys(op[UNKNOWN_COLUMNS])) columnIds.add(Number(columnId))
    }
  }
  for (const columnId of columnIds) {
    if (change.ops.every(op => !op[UNKNOWN_COLUMNS] ||
        !Object.prototype.hasOwnProperty.call(op[UNKNOWN_COLUMNS], columnId) ||
        isBlankUnknownValue(columnId, op[UNKNOWN_COLUMNS][columnId]))) {
      for (const op of change.ops) {
        if (op[UNKNOWN_COLUMNS]) delete op[UNKNOWN_COLUMNS][columnId]
      }
    }
  }
  for (const op of change.ops) {
    if (op[UNKNOWN_COLUMNS] && Object.keys(op[UNKNOWN_COLUMNS]).length === 0) delete op[UNKNOWN_COLUMNS]
  }
}

/**
 * Takes a set of operations `ops` loaded from an encoded document, and
 * reconstructs the changes that they originally came from.
 * Does not return anything, only mutates `changes`.
 */
function groupChangeOps(changes, ops) {
  let changesByActor = {} // map from actorId to array of changes by that actor
  for (let change of changes) {
    change.ops = []
    if (!changesByActor[change.actor]) changesByActor[change.actor] = []
    if (change.seq !== changesByActor[change.actor].length + 1) {
      throw new RangeError(`Expected seq = ${changesByActor[change.actor].length + 1}, got ${change.seq}`)
    }
    if (change.seq > 1 && changesByActor[change.actor][change.seq - 2].maxOp > change.maxOp) {
      throw new RangeError('maxOp must increase monotonically per actor')
    }
    changesByActor[change.actor].push(change)
  }

  let opsById = {}
  for (let op of ops) {
    if (op.action === 'del') throw new RangeError('document should not contain del operations')
    op.pred = opsById[op.id] ? opsById[op.id].pred : []
    opsById[op.id] = op
    for (let succ of op.succ) {
      if (!opsById[succ]) {
        if (op.elemId) {
          const elemId = op.insert ? op.id : op.elemId
          opsById[succ] = {id: succ, action: 'del', obj: op.obj, elemId, pred: []}
        } else {
          opsById[succ] = {id: succ, action: 'del', obj: op.obj, key: op.key, pred: []}
        }
      }
      opsById[succ].pred.push(op.id)
    }
    delete op.succ
  }
  for (let op of Object.values(opsById)) {
    if (op.action === 'del') ops.push(op)
  }

  for (let op of ops) {
    const { counter, actorId } = parseOpId(op.id)
    const actorChanges = changesByActor[actorId]
    // Binary search to find the change that should contain this operation
    let left = 0, right = actorChanges.length
    while (left < right) {
      const index = Math.floor((left + right) / 2)
      if (actorChanges[index].maxOp < counter) {
        left = index + 1
      } else {
        right = index
      }
    }
    if (left >= actorChanges.length) {
      throw new RangeError(`Operation ID ${op.id} outside of allowed range`)
    }
    actorChanges[left].ops.push(op)
  }

  for (let change of changes) {
    change.ops.sort((op1, op2) => compareParsedOpIds(parseOpId(op1.id), parseOpId(op2.id)))
    change.startOp = change.maxOp - change.ops.length + 1
    delete change.maxOp
    for (let i = 0; i < change.ops.length; i++) {
      const op = change.ops[i], expectedId = `${change.startOp + i}@${change.actor}`
      if (op.id !== expectedId) {
        throw new RangeError(`Expected opId ${expectedId}, got ${op.id}`)
      }
      delete op.id
    }
    stripBlankUnknownColumns(change)
  }
}

function decodeDocumentChanges(changes, expectedHeads) {
  let heads = {} // change hashes that are not a dependency of any other change
  for (let i = 0; i < changes.length; i++) {
    let change = changes[i]
    change.deps = []
    for (let {depsIndex: index} of change.depsNum) {
      if (!changes[index] || !changes[index].hash) {
        throw new RangeError(`No hash for index ${index} while processing index ${i}`)
      }
      const hash = changes[index].hash
      change.deps.push(hash)
      delete heads[hash]
    }
    change.deps.sort()
    delete change.depsNum

    if (change.extraLen_datatype !== VALUE_TYPE.BYTES) {
      throw new RangeError(`Bad datatype for extra bytes: ${VALUE_TYPE.BYTES}`)
    }
    change.extraBytes = change.extraLen
    delete change.extraLen_datatype

    // Encoding and decoding again to compute the hash of the change
    changes[i] = decodeChange(encodeChange(change), true)
    heads[changes[i].hash] = true
  }

  const actualHeads = Object.keys(heads).sort()
  if (actualHeads.length !== expectedHeads.length || actualHeads.some((head, i) => head !== expectedHeads[i])) {
    throw new RangeError(`Mismatched heads hashes: expected ${expectedHeads.join(', ')}, got ${actualHeads.join(', ')}`)
  }
}

function encodeDocumentHeader(doc) {
  const { changesColumns, opsColumns, actorIds, heads, headsIndexes, extraBytes } = doc
  changesColumns.concat(opsColumns).forEach((column, index) => deflateColumn(column, index))

  return encodeContainer(CHUNK_TYPE_DOCUMENT, encoder => {
    encoder.appendUint53(actorIds.length)
    for (let actor of actorIds) {
      encoder.appendHexString(actor)
    }
    encoder.appendUint53(heads.length)
    for (let head of heads.sort()) {
      encoder.appendRawBytes(hexStringToBytes(head))
    }
    encodeColumnInfo(encoder, changesColumns)
    encodeColumnInfo(encoder, opsColumns)
    for (let column of changesColumns.concat(opsColumns)) encoder.appendRawBytes(column.encoder.buffer)
    for (let index of headsIndexes) encoder.appendUint53(index)
    if (extraBytes) encoder.appendRawBytes(extraBytes)
  }).bytes
}

function decodeDocumentHeader(buffer) {
  const documentDecoder = new Decoder(buffer)
  const header = decodeContainerHeader(documentDecoder, true)
  const decoder = new Decoder(header.chunkData)
  if (!documentDecoder.done) throw new RangeError('Encoded document has trailing data')
  if (header.chunkType !== CHUNK_TYPE_DOCUMENT) throw new RangeError(`Unexpected chunk type: ${header.chunkType}`)

  const actorIds = [], numActors = decoder.readUint53()
  for (let i = 0; i < numActors; i++) {
    actorIds.push(decoder.readHexString())
  }
  const heads = [], headsIndexes = [], numHeads = decoder.readUint53()
  for (let i = 0; i < numHeads; i++) {
    heads.push(bytesToHexString(decoder.readRawBytes(32)))
  }

  const changesColumns = decodeColumnInfo(decoder)
  const opsColumns = decodeColumnInfo(decoder)
  for (let column of changesColumns.concat(opsColumns)) {
    column.buffer = decoder.readRawBytes(column.bufferLen)
    inflateColumn(column)
  }
  if (!decoder.done) {
    for (let i = 0; i < numHeads; i++) headsIndexes.push(decoder.readUint53())
  }

  const extraBytes = decoder.readRawBytes(decoder.buf.byteLength - decoder.offset)
  return { changesColumns, opsColumns, actorIds, heads, headsIndexes, extraBytes }
}

function decodeDocument(buffer) {
  const { changesColumns, opsColumns, actorIds, heads } = decodeDocumentHeader(buffer)
  const changes = decodeColumns(changesColumns, actorIds, DOCUMENT_COLUMNS)
  const ops = decodeOps(decodeColumns(opsColumns, actorIds, DOC_OPS_COLUMNS), true)
  groupChangeOps(changes, ops)
  decodeDocumentChanges(changes, heads)
  return changes
}

function documentChanges(buffer) {
  const { changesColumns, opsColumns, actorIds, heads } = decodeDocumentHeader(buffer)
  if (!changesColumns.every(column => DOCUMENT_COLUMNS.some(spec => spec.columnId === column.columnId)) ||
      !opsColumns.every(column => DOC_OPS_COLUMNS.some(spec => spec.columnId === column.columnId))) {
    return decodeDocument(buffer).map(change => ({
      actor: change.actor, seq: change.seq, deps: change.deps, hash: change.hash,
      numOps: change.ops.length, bytes: encodeChange(change)
    }))
  }

  function readActor(decoder) {
    const actorNum = decoder.readValue()
    if (actorNum !== null && !actorIds[actorNum]) throw new RangeError(`No actor index ${actorNum}`)
    return actorNum
  }

  const [actorD, seqD, maxOpD, timeD, messageD, depsNumD, depsIndexD, extraLenD, extraRawD] =
    makeDecoders(changesColumns, DOCUMENT_COLUMNS).map(column => column.decoder)
  const changes = [], changesByActor = []
  while (!actorD.done) {
    const actorNum = readActor(actorD), seq = seqD.readValue(), maxOp = maxOpD.readValue()
    const time = timeD.readValue(), message = messageD.readValue(), depsIndex = []
    for (let i = depsNumD.readValue() || 0; i > 0; i--) depsIndex.push(depsIndexD.readValue())
    const sizeTag = extraLenD.readValue()
    const { value: extraBytes, datatype } = decodeValue(sizeTag, extraRawD.readRawBytes(sizeTag >> 4))
    if (datatype !== VALUE_TYPE.BYTES) throw new RangeError(`Bad datatype for extra bytes: ${VALUE_TYPE.BYTES}`)
    const actorChanges = changesByActor[actorNum] || (changesByActor[actorNum] = [])
    if (seq !== actorChanges.length + 1) {
      throw new RangeError(`Expected seq = ${actorChanges.length + 1}, got ${seq}`)
    }
    if (seq > 1 && actorChanges[seq - 2].maxOp > maxOp) throw new RangeError('maxOp must increase monotonically per actor')
    const change = {actorNum, seq, maxOp, time, message, depsIndex, extraBytes, ops: [], succs: []}
    actorChanges.push(change)
    changes.push(change)
  }

  function changeOf(actorNum, counter) {
    const actorChanges = changesByActor[actorNum] || []
    let left = 0, right = actorChanges.length
    while (left < right) {
      const index = (left + right) >> 1
      if (actorChanges[index].maxOp < counter) left = index + 1
      else right = index
    }
    if (left >= actorChanges.length) {
      throw new RangeError(`Operation ID ${counter}@${actorIds[actorNum]} outside of allowed range`)
    }
    return actorChanges[left]
  }

  const [objActorD, objCtrD, keyActorD, keyCtrD, keyStrD, idActorD, idCtrD, insertD, actionD, valLenD, valRawD,
    chldActorD, chldCtrD, succNumD, succActorD, succCtrD, expandD, markNameD] =
    makeDecoders(opsColumns, DOC_OPS_COLUMNS).map(column => column.decoder)
  while (!idCtrD.done) {
    const objActor = readActor(objActorD), objCtr = objCtrD.readValue()
    const keyActor = readActor(keyActorD), keyCtr = keyCtrD.readValue(), keyStr = keyStrD.readValue()
    const idActor = readActor(idActorD), idCtr = idCtrD.readValue()
    const insert = !!insertD.readValue(), action = actionD.readValue()
    const sizeTag = valLenD.readValue(), rawValue = sizeTag >> 4 ? valRawD.readRawBytes(sizeTag >> 4) : null
    const chldActor = readActor(chldActorD), chldCtr = chldCtrD.readValue()
    const succNum = succNumD.readValue() || 0
    if (action === 3) throw new RangeError('document should not contain del operations')
    if (!!chldCtr !== (chldActor !== null)) throw new RangeError(`Mismatched child columns: ${chldCtr} and ${chldActor}`)
    const op = {
      idCtr, objActor, objCtr, keyActor, keyCtr, keyStr, insert, action, sizeTag, rawValue,
      chldActor, chldCtr, expand: false, markName: null, pred: null
    }
    changeOf(idActor, idCtr).ops.push(op)
    let lastActor = null, lastCtr = null
    for (let i = 0; i < succNum; i++) {
      const succActor = readActor(succActorD), succCtr = succCtrD.readValue()
      if (lastCtr !== null && (lastCtr > succCtr || lastCtr === succCtr && actorIds[lastActor] >= actorIds[succActor])) {
        throw new RangeError('operation IDs are not in ascending order')
      }
      lastActor = succActor
      lastCtr = succCtr
      changeOf(succActor, succCtr).succs.push({counter: succCtr, pred: {actorNum: idActor, counter: idCtr}, op})
    }
    const expand = expandD.readValue(), markName = markNameD.readValue()
    if (action === 7) {
      op.expand = !!expand
      op.markName = markName
    }
  }

  const opColumnSpecs = CHANGE_COLUMNS.filter(({columnName}) => columnName !== 'idActor' && columnName !== 'idCtr')
  const hashes = [], headSet = new Set(), result = []
  const encoders = opColumnSpecs.map(({columnId}) => encoderByColumnId(columnId))
  const opColumns = opColumnSpecs.map(({columnId}, index) => ({columnId, encoder: encoders[index]}))
  const [objActorE, objCtrE, keyActorE, keyCtrE, keyStrE, insertE, actionE, valLenE, valRawE,
    chldActorE, chldCtrE, predNumE, predActorE, predCtrE, expandE, markNameE] = encoders
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i], actor = actorIds[change.actorNum]
    let length = 0
    for (const op of change.ops) length = Math.max(length, change.maxOp - op.idCtr + 1)
    for (const {counter} of change.succs) length = Math.max(length, change.maxOp - counter + 1)
    const slots = new Array(length).fill(null)
    for (const op of change.ops) {
      if (slots[change.maxOp - op.idCtr]) throw new RangeError(`Duplicate opId ${op.idCtr}@${actor}`)
      slots[change.maxOp - op.idCtr] = op
    }
    for (const {counter, pred, op} of change.succs) {
      const index = change.maxOp - counter
      if (!slots[index]) {
        const elem = op.keyStr === null && op.insert
        slots[index] = {
          idCtr: counter, objActor: op.objActor, objCtr: op.objCtr, keyActor: elem ? pred.actorNum : op.keyActor,
          keyCtr: elem ? op.idCtr : op.keyCtr, keyStr: op.keyStr, insert: false, action: 3, sizeTag: VALUE_TYPE.NULL,
          rawValue: null, chldActor: null, chldCtr: null, expand: false, markName: null, pred: null
        }
      }
      if (slots[index].pred) slots[index].pred.push(pred)
      else slots[index].pred = [pred]
    }
    const numOps = slots.length, startOp = change.maxOp - numOps + 1, used = new Set([change.actorNum])
    let expand = false
    for (let j = numOps - 1; j >= 0; j--) {
      const op = slots[j]
      if (!op) throw new RangeError(`Expected opId ${change.maxOp - j}@${actor}`)
      if (op.objCtr !== null) used.add(op.objActor)
      if (op.keyStr === null && op.keyCtr !== 0) used.add(op.keyActor)
      if (op.chldCtr) used.add(op.chldActor)
      if (op.pred) for (const pred of op.pred) used.add(pred.actorNum)
      if (op.expand) expand = true
    }
    used.delete(change.actorNum)
    const changeActors = [change.actorNum].concat([...used].sort((a, b) => (actorIds[a] < actorIds[b] ? -1 : 1)))
    const actorIndex = new Map(changeActors.map((actorNum, index) => [actorNum, index]))
    for (const encoder of encoders) encoder.reset()
    for (let j = numOps - 1; j >= 0; j--) {
      const op = slots[j]
      objActorE.appendValue(op.objCtr === null ? null : actorIndex.get(op.objActor))
      objCtrE.appendValue(op.objCtr)
      if (op.keyStr !== null) {
        keyActorE.appendValue(null)
        keyCtrE.appendValue(null)
      } else if (op.keyCtr === 0 && op.insert) {
        keyActorE.appendValue(null)
        keyCtrE.appendValue(0)
      } else if (op.keyCtr > 0) {
        keyActorE.appendValue(actorIndex.get(op.keyActor))
        keyCtrE.appendValue(op.keyCtr)
      } else {
        throw new RangeError(`Unexpected operation key: ${op.keyCtr}@${actorIds[op.keyActor]}`)
      }
      keyStrE.appendValue(op.keyStr)
      insertE.appendValue(op.insert)
      actionE.appendValue(op.action)
      valLenE.appendValue(op.sizeTag)
      if (op.rawValue) valRawE.appendRawBytes(op.rawValue)
      if (expand) expandE.appendValue(op.expand)
      markNameE.appendValue(op.markName)
      chldActorE.appendValue(op.chldCtr ? actorIndex.get(op.chldActor) : null)
      chldCtrE.appendValue(op.chldCtr || null)
      const pred = op.pred || []
      predNumE.appendValue(pred.length)
      if (pred.length > 1) pred.sort((a, b) => a.counter - b.counter || (actorIds[a.actorNum] < actorIds[b.actorNum] ? -1 : 1))
      for (const {actorNum, counter} of pred) {
        predActorE.appendValue(actorIndex.get(actorNum))
        predCtrE.appendValue(counter)
      }
    }
    const deps = change.depsIndex.map(index => {
      if (!(index >= 0 && index < i)) throw new RangeError(`No hash for index ${index} while processing index ${i}`)
      headSet.delete(hashes[index])
      return hashes[index]
    }).sort()
    const { hash, buffer } = encodeChangeContainer(
      {actor, seq: change.seq, startOp, time: change.time, message: change.message, deps},
      changeActors.map(actorNum => actorIds[actorNum]), change.extraBytes, opColumns
    )
    hashes.push(hash)
    headSet.add(hash)
    result.push({actor, seq: change.seq, deps, hash, numOps, bytes: buffer})
  }

  const actualHeads = [...headSet].sort()
  if (actualHeads.length !== heads.length || actualHeads.some((head, i) => head !== heads[i])) {
    throw new RangeError(`Mismatched heads hashes: expected ${heads.join(', ')}, got ${actualHeads.join(', ')}`)
  }
  return result
}

/**
 * DEFLATE-compresses the given column if it is large enough to make the compression worthwhile.
 */
function deflateColumn(column, cacheKey) {
  if (column.encoder.buffer.byteLength >= DEFLATE_MIN_SIZE) {
    const deflated = deflate(column.encoder.buffer, DEFLATED_COLUMNS.get(cacheKey))
    if (cacheKey !== undefined) DEFLATED_COLUMNS.set(cacheKey, deflated)
    column.encoder = {buffer: deflated.output}
    column.columnId |= COLUMN_TYPE_DEFLATE
  }
}

/**
 * Decompresses the given column if it is DEFLATE-compressed.
 */
function inflateColumn(column) {
  if ((column.columnId & COLUMN_TYPE_DEFLATE) !== 0) {
    column.buffer = inflateRaw(column.buffer)
    column.columnId ^= COLUMN_TYPE_DEFLATE
  }
}

export {
  COLUMN_TYPE, VALUE_TYPE, ACTIONS, OBJECT_TYPE, DOC_OPS_COLUMNS, CHANGE_COLUMNS, DOCUMENT_COLUMNS,
  encoderByColumnId, decoderByColumnId, makeDecoders, decodeValue, decodeColumns, decodeOps, encodeOp,
  encodeColumnInfo, decodeColumnInfo, encodeContainer, decodeContainerHeader, deflateColumn, inflateColumn,
  splitContainers, decompressChange, encodeChange, encodeChangeColumns, decodeChangeColumns, decodeChange, decodeChangeMeta, decodeChanges,
  encodeDocumentHeader, decodeDocumentHeader, documentChanges
}
