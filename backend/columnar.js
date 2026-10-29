import { inflateSync as inflateRaw } from 'fflate'
import { deflate, extendVec } from './deflate.js'
import { copyObject, equalBytes, parseOpId, safeInt } from '../src/common.js'
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
  } else if (typeof op.value === 'bigint') {
    const typeTag = NUMBER_TYPES.get(op.datatype) || VALUE_TYPE.LEB128_INT
    const high32 = Number(op.value >> 32n), low32 = Number(op.value & 0xffffffffn)
    const numBytes = typeTag === VALUE_TYPE.LEB128_UINT ? columns.valRaw.appendUint64(high32, low32) : columns.valRaw.appendInt64(high32, low32)
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

function readInt64({high32, low32}) {
  const value = high32 * 0x100000000 + low32
  return Number.isSafeInteger(value) ? value : safeInt((BigInt(high32) << 32n) + BigInt(low32))
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
  if (type === VALUE_TYPE.LEB128_UINT) return {value: readInt64(new Decoder(bytes).readUint64()), datatype: 'uint'}
  if (type === VALUE_TYPE.LEB128_INT) return {value: readInt64(new Decoder(bytes).readInt64()), datatype: 'int'}
  if (type === VALUE_TYPE.IEEE754) {
    if (bytes.byteLength !== 8) throw new RangeError(`Invalid length for floating point number: ${bytes.byteLength}`)
    return {value: new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, true), datatype: 'float64'}
  }
  if (type === VALUE_TYPE.COUNTER) return {value: readInt64(new Decoder(bytes).readInt64()), datatype: 'counter'}
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
  decoded.buffer = (bytes.byteLength > DEFLATE_MIN_SIZE) ? recodeChange(bytes, CHUNK_TYPE_DEFLATE, data => deflate(data, {len: 0, cap: 0}).output) : bytes
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
      if (typeof op.value === 'bigint') throw new RangeError(`Error: ${op.value} can't be represented as a JavaScript number`)
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
  const vec = {len: 0, cap: 0}
  changesColumns.concat(opsColumns).forEach((column, index) => deflateColumn(column, index, vec))

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

const NO_SUCC = Object.freeze([]), NO_BYTES = new Uint8Array(0)
const ASCII_BYTES = Array.from({length: 128}, (_, byte) => new Uint8Array([byte]))

function columnReader(buf, type, at = 0, end = buf.byteLength) {
  return {buf, at, end, count: 0, literal: false, value: type === COLUMN_TYPE.BOOLEAN, absolute: 0, type}
}

function readUleb(reader) {
  const buf = reader.buf
  let byte = buf[reader.at++]
  if (byte < 0x80) return byte
  let result = byte & 0x7f, scale = 0x80
  do {
    byte = buf[reader.at++]
    result += (byte & 0x7f) * scale
    scale *= 0x80
  } while (byte & 0x80)
  return result
}

function readSleb(reader) {
  const buf = reader.buf
  let byte = buf[reader.at++]
  if (byte < 0x80) return byte & 0x40 ? byte - 0x80 : byte
  let result = byte & 0x7f, scale = 0x80
  do {
    byte = buf[reader.at++]
    result += (byte & 0x7f) * scale
    scale *= 0x80
  } while (byte & 0x80)
  return byte & 0x40 ? result - scale : result
}

function readRaw(reader) {
  if (reader.type === COLUMN_TYPE.STRING_RLE) {
    const length = readUleb(reader)
    reader.at += length
    return utf8ToString(reader.buf.subarray(reader.at - length, reader.at))
  }
  return reader.type === COLUMN_TYPE.INT_DELTA ? readSleb(reader) : readUleb(reader)
}

function readNext(reader) {
  const boolean = reader.type === COLUMN_TYPE.BOOLEAN
  while (reader.count === 0) {
    if (reader.at >= reader.end) return boolean ? false : null
    if (boolean) {
      reader.count = readUleb(reader) || 0
      reader.value = !reader.value
    } else {
      const count = readSleb(reader) || 0
      reader.literal = count < 0
      if (count > 0) {
        reader.count = count
        reader.value = readRaw(reader)
      } else if (count < 0) {
        reader.count = -count
      } else {
        reader.count = readUleb(reader) || 0
        reader.value = null
      }
    }
  }
  reader.count--
  if (boolean) return reader.value
  const value = reader.literal ? readRaw(reader) : reader.value
  return reader.type === COLUMN_TYPE.INT_DELTA && value !== null ? (reader.absolute += value) : value
}

let lastActorBytes = NO_BYTES, lastActorHex = ''

function readActorHex(reader) {
  const length = readUleb(reader), bytes = reader.buf.subarray(reader.at, reader.at + length)
  reader.at += length
  if (!equalBytes(bytes, lastActorBytes)) {
    lastActorBytes = bytes.slice()
    lastActorHex = bytesToHexString(bytes)
  }
  return lastActorHex
}

function changeColumnReaders(buffer, columnSpecs) {
  if (buffer[8] === CHUNK_TYPE_DEFLATE) buffer = recodeChange(buffer, CHUNK_TYPE_CHANGE, inflateRaw)
  const reader = {buf: buffer, at: 9}
  readUleb(reader)
  const numDeps = readUleb(reader)
  reader.at += 32 * numDeps
  const actorIds = [readActorHex(reader)]
  readUleb(reader)
  const startOp = readUleb(reader)
  readSleb(reader)
  const messageLength = readUleb(reader)
  reader.at += messageLength
  for (let n = readUleb(reader); n > 0; n--) actorIds.push(readActorHex(reader))
  const info = []
  for (let n = readUleb(reader); n > 0; n--) info.push(readUleb(reader), readUleb(reader))
  const readers = columnSpecs.map(({columnId}) => columnReader(NO_BYTES, columnId & 7))
  for (let i = 0, start = reader.at; i < info.length; start += info[i + 1], i += 2) {
    const index = columnSpecs.findIndex(({columnId}) => columnId === (info[i] & ~COLUMN_TYPE_DEFLATE))
    if (index < 0) continue
    if (info[i] & COLUMN_TYPE_DEFLATE) {
      readers[index] = columnReader(inflateRaw(buffer.subarray(start, start + info[i + 1])), info[i] & 7)
    } else {
      readers[index] = columnReader(buffer, info[i] & 7, start, start + info[i + 1])
    }
  }
  return {startOp, actorIds, readers}
}

function documentRows(buffers) {
  const decoders = buffers.map((buf, index) => decoderByColumnId(DOC_OPS_COLUMNS[index].columnId, buf))
  const [objActorD, objCtrD, keyActorD, keyCtrD, keyStrD, idActorD, idCtrD, insertD, actionD, valLenD, valRawD,
    chldActorD, chldCtrD, succNumD, succActorD, succCtrD, expandD, markNameD] = decoders
  const rows = []
  while (!actionD.done) {
    const objActor = objActorD.readValue(), objCtr = objCtrD.readValue(), keyActor = keyActorD.readValue(), keyCtr = keyCtrD.readValue()
    const keyStr = keyStrD.readValue(), idActor = idActorD.readValue(), idCtr = idCtrD.readValue(), insert = insertD.readValue()
    const action = actionD.readValue(), valLen = valLenD.readValue(), rawLength = valLen >>> 4
    const value = rawLength === 0 ? NO_BYTES : valLen === (16 | VALUE_TYPE.UTF8) && valRawD.buf[valRawD.offset] < 0x80
      ? ASCII_BYTES[valRawD.buf[valRawD.offset++]] : valRawD.readRawBytes(rawLength)
    const chldActor = chldActorD.readValue(), chldCtr = chldCtrD.readValue(), count = succNumD.readValue() || 0
    let actors = NO_SUCC, counters = NO_SUCC
    if (count > 0) {
      actors = []
      counters = []
      for (let i = 0; i < count; i++) {
        actors.push(succActorD.readValue())
        counters.push(succCtrD.readValue())
      }
    }
    rows.push([objActor, objCtr, keyActor, keyCtr, keyStr, idActor, idCtr, insert, action, valLen, value,
      chldActor, chldCtr, count, actors, counters, expandD.readValue(), markNameD.readValue()])
  }
  return rows
}

const RLE_EMPTY = 0, RLE_LONE = 1, RLE_REPEAT = 2, RLE_LITERAL = 3, RLE_NULLS = 4
const CHANGE_OP_COLUMNS = CHANGE_COLUMNS.filter(({columnName}) => columnName !== 'idActor' && columnName !== 'idCtr')

function changeWriter(columnId) {
  return {columnId, type: columnId & 7, buf: new Uint8Array(64), offset: 0, state: RLE_EMPTY, last: false, count: 0, literal: [], literals: 0, absolute: 0}
}

function resetWriter(writer) {
  writer.offset = 0
  writer.state = RLE_EMPTY
  writer.last = false
  writer.count = 0
  writer.literals = 0
  writer.absolute = 0
}

function reserve(writer, length) {
  if (writer.offset + length > writer.buf.byteLength) {
    const buf = new Uint8Array(Math.max(2 * writer.buf.byteLength, writer.offset + length))
    buf.set(writer.buf.subarray(0, writer.offset))
    writer.buf = buf
  }
}

function putUleb(writer, value) {
  reserve(writer, 10)
  const buf = writer.buf
  if (value < 0x80) {
    buf[writer.offset++] = value
    return
  }
  while (value > 0x7f) {
    buf[writer.offset++] = value % 0x80 | 0x80
    value = Math.floor(value / 0x80)
  }
  buf[writer.offset++] = value
}

function putSleb(writer, value) {
  reserve(writer, 10)
  const buf = writer.buf
  if (value >= -0x40 && value < 0x40) {
    buf[writer.offset++] = value & 0x7f
    return
  }
  for (;;) {
    const byte = (value % 0x80 + 0x80) % 0x80
    value = (value - byte) / 0x80
    if (value === 0 && !(byte & 0x40) || value === -1 && byte & 0x40) {
      buf[writer.offset++] = byte
      return
    }
    buf[writer.offset++] = byte | 0x80
  }
}

function ulebLength(value) {
  let length = 1
  for (; value > 0x7f; value = Math.floor(value / 0x80)) length++
  return length
}

function putBytes(writer, bytes) {
  reserve(writer, bytes.byteLength)
  if (bytes.byteLength === 1) writer.buf[writer.offset] = bytes[0]
  else writer.buf.set(bytes, writer.offset)
  writer.offset += bytes.byteLength
}

function putPrefixed(writer, bytes) {
  putUleb(writer, bytes.byteLength)
  putBytes(writer, bytes)
}

function rleRaw(writer, value) {
  if (writer.type === COLUMN_TYPE.STRING_RLE) putPrefixed(writer, stringToUtf8(value))
  else if (writer.type === COLUMN_TYPE.INT_DELTA) putSleb(writer, value)
  else putUleb(writer, value)
}

function rleFlush(writer) {
  const state = writer.state
  if (state === RLE_LONE) {
    putSleb(writer, -1)
    rleRaw(writer, writer.last)
  } else if (state === RLE_REPEAT) {
    putSleb(writer, writer.count)
    rleRaw(writer, writer.last)
  } else if (state === RLE_LITERAL) {
    putSleb(writer, -writer.literals)
    for (let i = 0; i < writer.literals; i++) rleRaw(writer, writer.literal[i])
  } else if (state === RLE_NULLS) {
    putSleb(writer, 0)
    putUleb(writer, writer.count)
  }
  writer.state = RLE_EMPTY
}

function rleAppend(writer, value) {
  const state = writer.state, open = state === RLE_LONE || state === RLE_LITERAL
  if (value === null ? state === RLE_NULLS : state === RLE_REPEAT && value === writer.last) {
    writer.count++
  } else if (open && value === writer.last) {
    if (state === RLE_LITERAL) rleFlush(writer)
    writer.state = RLE_REPEAT
    writer.count = 2
  } else if (open && value !== null) {
    if (state === RLE_LONE) writer.literals = 0
    writer.literal[writer.literals++] = writer.last
    writer.state = RLE_LITERAL
    writer.last = value
  } else {
    if (state === RLE_LITERAL) writer.literal[writer.literals++] = writer.last
    rleFlush(writer)
    writer.state = value === null ? RLE_NULLS : RLE_LONE
    writer.last = value
    writer.count = 1
  }
}

function deltaAppend(writer, value) {
  if (value === null) {
    rleAppend(writer, null)
  } else {
    rleAppend(writer, value - writer.absolute)
    writer.absolute = value
  }
}

function booleanAppend(writer, value) {
  if (value === writer.last) {
    writer.count++
  } else {
    putUleb(writer, writer.count)
    writer.last = value
    writer.count = 1
  }
}

function writerFinish(writer) {
  if (writer.type === COLUMN_TYPE.BOOLEAN) {
    if (writer.count > 0) putUleb(writer, writer.count)
    writer.count = 0
  } else if (writer.type !== COLUMN_TYPE.VALUE_RAW) {
    if (writer.state === RLE_LITERAL) writer.literal[writer.literals++] = writer.last
    if (writer.state !== RLE_NULLS || writer.offset > 0) rleFlush(writer)
  }
}

function documentChanges(buffer, rows, header = decodeDocumentHeader(buffer)) {
  const { changesColumns, opsColumns, actorIds, heads } = header
  if (!changesColumns.every(column => DOCUMENT_COLUMNS.some(spec => spec.columnId === column.columnId)) ||
      !opsColumns.every(column => DOC_OPS_COLUMNS.some(spec => spec.columnId === column.columnId))) {
    return decodeDocument(buffer).map(change => ({
      actor: change.actor, seq: change.seq, deps: change.deps, hash: change.hash,
      numOps: change.ops.length, bytes: encodeChange(change)
    }))
  }

  const [actorR, seqR, maxOpR, timeR, messageR, depsNumR, depsIndexR, extraLenR, extraRawR] =
    makeDecoders(changesColumns, DOCUMENT_COLUMNS).map(({columnId, decoder}) => columnReader(decoder.buf, columnId & 7))
  const changes = [], changesByActor = []
  while (actorR.count > 0 || actorR.at < actorR.end) {
    const actorNum = readNext(actorR), seq = readNext(seqR), maxOp = readNext(maxOpR)
    if (actorNum !== null && !actorIds[actorNum]) throw new RangeError(`No actor index ${actorNum}`)
    const time = readNext(timeR), message = readNext(messageR), depsIndex = []
    for (let i = readNext(depsNumR) || 0; i > 0; i--) depsIndex.push(readNext(depsIndexR))
    const sizeTag = readNext(extraLenR), extraLength = sizeTag >> 4
    if (extraRawR.at + extraLength > extraRawR.end) throw new RangeError('subarray exceeds buffer size')
    const { value: extraBytes, datatype } = decodeValue(sizeTag, extraRawR.buf.subarray(extraRawR.at, extraRawR.at + extraLength))
    extraRawR.at += extraLength
    if (datatype !== VALUE_TYPE.BYTES) throw new RangeError(`Bad datatype for extra bytes: ${VALUE_TYPE.BYTES}`)
    const actorChanges = changesByActor[actorNum] || (changesByActor[actorNum] = [])
    if (seq !== actorChanges.length + 1) {
      throw new RangeError(`Expected seq = ${actorChanges.length + 1}, got ${seq}`)
    }
    if (seq > 1 && actorChanges[seq - 2].maxOp > maxOp) throw new RangeError('maxOp must increase monotonically per actor')
    const change = {actorNum, seq, maxOp, time, message, depsIndex, extraBytes}
    actorChanges.push(change)
    changes.push(change)
  }

  if (changes.some(change => !Number.isInteger(change.maxOp) || !Number.isInteger(change.time))) {
    throw new RangeError('value is not an integer')
  }
  const ops = opIndex(rows || documentRows(makeDecoders(opsColumns, DOC_OPS_COLUMNS).map(column => column.decoder.buf)),
    actorIds, changesByActor)
  const encoder = changeEncoder(actorIds), lastMaxOp = new Array(actorIds.length).fill(0)
  const hashes = [], hashBytes = new Map(), headSet = new Set(), result = []
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i], actorNum = change.actorNum, maxOp = change.maxOp
    const startOp = firstOp(ops, actorNum, lastMaxOp[actorNum] + 1, maxOp)
    lastMaxOp[actorNum] = maxOp
    encodeChangeOps(encoder, ops, actorNum, startOp, maxOp, i + 1)
    for (const index of change.depsIndex) {
      if (!(index >= 0 && index < i)) throw new RangeError(`No hash for index ${index} while processing index ${i}`)
      headSet.delete(hashes[index])
    }
    const deps = change.depsIndex.map(index => hashes[index]).sort()
    const {hash, bytes} = writeChangeChunk(encoder, change, startOp, deps.map(dep => hashBytes.get(dep)))
    const hex = bytesToHexString(hash)
    hashes.push(hex)
    hashBytes.set(hex, hash)
    headSet.add(hex)
    result.push({
      actor: actorIds[actorNum], seq: change.seq, deps, hash: hex, numOps: maxOp - startOp + 1,
      bytes: bytes.byteLength > DEFLATE_MIN_SIZE ? recodeChange(bytes, CHUNK_TYPE_DEFLATE, data => deflate(data, {len: 0, cap: 0}).output) : bytes
    })
  }

  const actualHeads = [...headSet].sort()
  if (actualHeads.length !== heads.length || actualHeads.some((head, i) => head !== heads[i])) {
    throw new RangeError(`Mismatched heads hashes: expected ${heads.join(', ')}, got ${actualHeads.join(', ')}`)
  }
  return result
}

function opSlots(table, actorIds, actor, counter) {
  if (!(actor < actorIds.length)) throw new RangeError(`No actor index ${actor}`)
  if (!(counter > 0 && counter < table[actor].length)) {
    throw new RangeError(`Operation ID ${counter}@${actorIds[actor]} outside of allowed range`)
  }
  return table[actor]
}

function addPreds(ops, r, row) {
  const succActors = row[14], succCtrs = row[15], actorIds = ops.actorIds
  for (let i = 0; i < row[13]; i++) {
    const succActor = succActors[i], succCtr = succCtrs[i]
    if (i > 0 && (succCtrs[i - 1] > succCtr || succCtrs[i - 1] === succCtr && actorIds[succActors[i - 1]] >= actorIds[succActor])) {
      throw new RangeError('operation IDs are not in ascending order')
    }
    const preds = opSlots(ops.predAt, actorIds, succActor, succCtr)
    ops.predRow.push(r)
    ops.predNext.push(preds[succCtr])
    preds[succCtr] = ops.predRow.length - 1
  }
}

function opIndex(rows, actorIds, changesByActor) {
  let maxCounter = rows.length
  for (let r = 0; r < rows.length; r++) maxCounter += rows[r][13]
  const ops = {rows, actorIds, rowAt: [], predAt: [], predRow: [0], predNext: [0]}
  for (let actor = 0; actor < actorIds.length; actor++) {
    const actorChanges = changesByActor[actor], size = actorChanges ? actorChanges[actorChanges.length - 1].maxOp + 1 : 1
    if (size > maxCounter + 1) throw new RangeError(`Operation ID ${size - 1}@${actorIds[actor]} outside of allowed range`)
    ops.rowAt.push(new Int32Array(size))
    ops.predAt.push(new Int32Array(size))
  }
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r], idActor = row[5], idCtr = row[6]
    if (row[8] === 3) throw new RangeError('document should not contain del operations')
    if (!!row[12] !== (row[11] !== null)) throw new RangeError(`Mismatched child columns: ${row[12]} and ${row[11]}`)
    const slots = ops.rowAt[idActor]
    if (!(slots && idCtr > 0 && idCtr < slots.length)) opSlots(ops.rowAt, actorIds, idActor, idCtr)
    if (slots[idCtr]) throw new RangeError(`Duplicate opId ${idCtr}@${actorIds[idActor]}`)
    slots[idCtr] = r + 1
    if (row[13] > 0) addPreds(ops, r, row)
  }
  return ops
}

function firstOp(ops, actorNum, startOp, maxOp) {
  const slots = ops.rowAt[actorNum], predSlots = ops.predAt[actorNum]
  while (startOp <= maxOp && !slots[startOp] && !predSlots[startOp]) startOp++
  for (let counter = startOp; counter <= maxOp; counter++) {
    if (!slots[counter] && !predSlots[counter]) throw new RangeError(`Expected opId ${counter}@${ops.actorIds[actorNum]}`)
  }
  return startOp
}

function deletedRow(ops, slot) {
  while (ops.predNext[slot]) slot = ops.predNext[slot]
  return ops.rows[ops.predRow[slot]]
}

function changeEncoder(actorIds) {
  const writers = CHANGE_OP_COLUMNS.map(({columnId}) => changeWriter(columnId))
  return {
    actorIds, actorBytes: actorIds.map(hexStringToBytes), stamp: new Int32Array(actorIds.length),
    localOf: new Int32Array(actorIds.length), others: [], current: 0, expand: false, head: changeWriter(0), writers,
    columns: Object.fromEntries(CHANGE_OP_COLUMNS.map(({columnName}, index) => [columnName, writers[index]])),
    output: new Uint8Array(0), outputUsed: 0
  }
}

function useActor(encoder, actor) {
  if (!(actor < encoder.actorIds.length)) throw new RangeError(`No actor index ${actor}`)
  if (encoder.stamp[actor] !== encoder.current) {
    encoder.stamp[actor] = encoder.current
    encoder.others.push(actor)
  }
}

function useOpActors(encoder, ops, slots, predSlots, counter) {
  const r = slots[counter] - 1
  if (r >= 0) {
    const row = ops.rows[r]
    if (row[1] !== null) useActor(encoder, row[0])
    if (row[4] === null && row[3] !== 0) useActor(encoder, row[2])
    if (row[12]) useActor(encoder, row[11])
    if (row[8] === 7 && row[16]) encoder.expand = true
  } else {
    const row = deletedRow(ops, predSlots[counter])
    if (row[1] !== null) useActor(encoder, row[0])
    if (row[4] === null) useActor(encoder, row[7] ? row[5] : row[2])
  }
  for (let k = predSlots[counter]; k; k = ops.predNext[k]) useActor(encoder, ops.rows[ops.predRow[k]][5])
}

function encodeChangeOps(encoder, ops, actorNum, startOp, maxOp, current) {
  const slots = ops.rowAt[actorNum], predSlots = ops.predAt[actorNum], {actorIds, localOf, writers} = encoder
  encoder.current = current
  encoder.stamp[actorNum] = current
  encoder.others = []
  encoder.expand = false
  for (let counter = startOp; counter <= maxOp; counter++) useOpActors(encoder, ops, slots, predSlots, counter)
  encoder.others.sort((a, b) => (actorIds[a] < actorIds[b] ? -1 : 1))
  localOf[actorNum] = 0
  for (let k = 0; k < encoder.others.length; k++) localOf[encoder.others[k]] = k + 1
  for (let w = 0; w < writers.length; w++) resetWriter(writers[w])
  for (let counter = startOp; counter <= maxOp; counter++) encodeChangeOp(encoder, ops, slots, predSlots, counter)
}

function encodeChangeOp(encoder, ops, slots, predSlots, counter) {
  const {objActor: objActorW, objCtr: objCtrW, keyActor: keyActorW, keyCtr: keyCtrW, keyStr: keyStrW, insert: insertW,
    action: actionW, valLen: valLenW, valRaw: valRawW, chldActor: chldActorW, chldCtr: chldCtrW, predNum: predNumW,
    predActor: predActorW, predCtr: predCtrW, expand: expandW, markName: markNameW} = encoder.columns
  const localOf = encoder.localOf, r = slots[counter] - 1
  let objActor, objCtr, keyActor, keyCtr, keyStr, insert = false, action = 3, valLen = VALUE_TYPE.NULL,
    valRaw = null, chldActor = null, chldCtr = null, expand = false, markName = null
  if (r >= 0) {
    const row = ops.rows[r]
    objActor = row[0]; objCtr = row[1]; keyActor = row[2]; keyCtr = row[3]; keyStr = row[4]
    insert = row[7]; action = row[8]; valLen = row[9]; valRaw = row[10]; chldActor = row[11]; chldCtr = row[12]
    if (action === 7) {
      expand = !!row[16]
      markName = row[17]
    }
  } else {
    const row = deletedRow(ops, predSlots[counter]), elem = row[4] === null && row[7]
    objActor = row[0]; objCtr = row[1]; keyStr = row[4]
    keyActor = elem ? row[5] : row[2]
    keyCtr = elem ? row[6] : row[3]
  }
  rleAppend(objActorW, objCtr === null ? null : localOf[objActor])
  rleAppend(objCtrW, objCtr)
  if (keyStr !== null) {
    rleAppend(keyActorW, null)
    deltaAppend(keyCtrW, null)
  } else if (keyCtr === 0 && insert) {
    rleAppend(keyActorW, null)
    deltaAppend(keyCtrW, 0)
  } else if (keyCtr > 0) {
    rleAppend(keyActorW, localOf[keyActor])
    deltaAppend(keyCtrW, keyCtr)
  } else {
    throw new RangeError(`Unexpected operation key: ${keyCtr}@${encoder.actorIds[keyActor]}`)
  }
  rleAppend(keyStrW, keyStr)
  booleanAppend(insertW, insert)
  rleAppend(actionW, action)
  rleAppend(valLenW, valLen)
  if (valRaw) putBytes(valRawW, valRaw)
  if (encoder.expand) booleanAppend(expandW, expand)
  rleAppend(markNameW, markName)
  rleAppend(chldActorW, chldCtr ? localOf[chldActor] : null)
  deltaAppend(chldCtrW, chldCtr || null)
  const preds = []
  for (let k = predSlots[counter]; k; k = ops.predNext[k]) preds.push(ops.rows[ops.predRow[k]])
  if (preds.length > 1) preds.sort((a, b) => a[6] - b[6] || (encoder.actorIds[a[5]] < encoder.actorIds[b[5]] ? -1 : 1))
  rleAppend(predNumW, preds.length)
  for (let k = 0; k < preds.length; k++) {
    rleAppend(predActorW, localOf[preds[k][5]])
    deltaAppend(predCtrW, preds[k][6])
  }
}

function copyWriter(output, at, writer) {
  const buf = writer.buf
  for (let j = 0; j < writer.offset; j++) output[at + j] = buf[j]
  return at + writer.offset
}

function writeChangeChunk(encoder, change, startOp, deps) {
  const {head, writers, others, actorBytes} = encoder
  head.offset = 0
  putUleb(head, deps.length)
  for (let k = 0; k < deps.length; k++) putBytes(head, deps[k])
  putPrefixed(head, actorBytes[change.actorNum])
  putUleb(head, change.seq)
  putUleb(head, startOp)
  putSleb(head, change.time)
  putPrefixed(head, change.message ? stringToUtf8(change.message) : NO_BYTES)
  putUleb(head, others.length)
  for (let k = 0; k < others.length; k++) putPrefixed(head, actorBytes[others[k]])
  let numColumns = 0, bodyLength = change.extraBytes.byteLength
  for (let w = 0; w < writers.length; w++) {
    writerFinish(writers[w])
    if (writers[w].offset > 0) numColumns++
  }
  putUleb(head, numColumns)
  for (let w = 0; w < writers.length; w++) {
    if (writers[w].offset > 0) {
      putUleb(head, writers[w].columnId)
      putUleb(head, writers[w].offset)
      bodyLength += writers[w].offset
    }
  }
  bodyLength += head.offset
  const total = 9 + ulebLength(bodyLength) + bodyLength
  if (encoder.outputUsed + total > encoder.output.byteLength) {
    encoder.output = new Uint8Array(Math.max(total, 1 << 18))
    encoder.outputUsed = 0
  }
  const output = encoder.output, start = encoder.outputUsed
  output.set(MAGIC_BYTES, start)
  output[start + 8] = CHUNK_TYPE_CHANGE
  let at = start + 9
  for (let length = bodyLength; ; length = Math.floor(length / 128)) {
    if (length < 128) {
      output[at++] = length
      break
    }
    output[at++] = length % 128 | 0x80
  }
  at = copyWriter(output, at, head)
  for (let w = 0; w < writers.length; w++) at = copyWriter(output, at, writers[w])
  output.set(change.extraBytes, at)
  encoder.outputUsed = start + total
  const hash = sha256(output.subarray(start + 8, start + total))
  for (let j = 0; j < 4; j++) output[start + 4 + j] = hash[j]
  return {hash, bytes: output.subarray(start, start + total)}
}

/**
 * DEFLATE-compresses the given column if it is large enough to make the compression worthwhile.
 */
function deflateColumn(column, cacheKey, vec) {
  if (column.encoder.buffer.byteLength >= DEFLATE_MIN_SIZE) {
    const deflated = deflate(column.encoder.buffer, vec, DEFLATED_COLUMNS.get(cacheKey))
    if (cacheKey !== undefined) DEFLATED_COLUMNS.set(cacheKey, deflated)
    column.encoder = {buffer: deflated.output}
    column.columnId |= COLUMN_TYPE_DEFLATE
  } else {
    extendVec(vec, column.encoder.buffer.byteLength)
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
  encodeDocumentHeader, decodeDocumentHeader, documentChanges, documentRows, columnReader, readNext, changeColumnReaders, NO_SUCC, NO_BYTES
}
