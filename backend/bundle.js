const pako = require('pako')
const { parseOpId } = require('../src/common')
const {
  hexStringToBytes, bytesToHexString,
  Encoder, Decoder, RLEEncoder, RLEDecoder, DeltaEncoder, DeltaDecoder, BooleanEncoder
} = require('./encoding')
const {
  COLUMN_TYPE, CHANGE_COLUMNS,
  encodeOperationAction, encodeValue,
  decodeColumns, decodeOps, encodeColumnInfo, decodeColumnInfo,
  encodeContainer, decodeContainerHeader, encodeChange, decodeChangeColumns, decodeChangeMeta
} = require('./columnar')

const CHUNK_TYPE_BUNDLE = 3

const BUNDLE_CHANGE_COLUMNS = [
  {columnName: 'actor', columnId: 0x01},
  {columnName: 'seq', columnId: 0x03},
  {columnName: 'startOp', columnId: 0x13},
  {columnName: 'maxOp', columnId: 0x23},
  {columnName: 'time', columnId: 0x33},
  {columnName: 'message', columnId: 0x45},
  {columnName: 'depsNum', columnId: 0x50},
  {columnName: 'depsIndex', columnId: 0x53},
  {columnName: 'extraLen', columnId: 0x60},
  {columnName: 'extraRaw', columnId: 0x67}
]

const BUNDLE_OPS_COLUMNS = [
  {columnName: 'objActor', columnId: 0x01},
  {columnName: 'objCtr', columnId: 0x03},
  {columnName: 'keyActor', columnId: 0x11},
  {columnName: 'keyCtr', columnId: 0x13},
  {columnName: 'keyStr', columnId: 0x15},
  {columnName: 'idActor', columnId: 0x21},
  {columnName: 'idCtr', columnId: 0x23},
  {columnName: 'insert', columnId: 0x34},
  {columnName: 'action', columnId: 0x42},
  {columnName: 'valLen', columnId: 0x56},
  {columnName: 'valRaw', columnId: 0x57},
  {columnName: 'chldActor', columnId: 0x61},
  {columnName: 'chldCtr', columnId: 0x63},
  {columnName: 'predNum', columnId: 0x70},
  {columnName: 'predActor', columnId: 0x71},
  {columnName: 'predCtr', columnId: 0x73},
  {columnName: 'expand', columnId: 0x94},
  {columnName: 'markName', columnId: 0xa5},
  {columnName: 'idCtrInverse', columnId: 0xb3}
]

function column(columnName, columnId, encoder) {
  return {columnName, columnId, encoder}
}

function appendColumns(encoder, columns) {
  const encoded = columns.map(col => {
    const buffer = col.encoder.buffer
    if (buffer.byteLength < 256) return col
    return Object.assign({}, col, {columnId: col.columnId | 8, encoder: {buffer: pako.deflateRaw(buffer)}})
  })
  encodeColumnInfo(encoder, encoded)
  for (const col of encoded) encoder.appendRawBytes(col.encoder.buffer)
}

function readColumns(decoder, spec) {
  const validIds = new Set(spec.map(col => col.columnId))
  const columns = decodeColumnInfo(decoder)
  for (const col of columns) {
    const compressed = (col.columnId & 8) !== 0
    const columnId = compressed ? col.columnId ^ 8 : col.columnId
    if (!validIds.has(columnId)) throw new RangeError(`Unexpected bundle column: ${col.columnId}`)
    const buffer = decoder.readRawBytes(col.bufferLen)
    col.columnId = columnId
    col.buffer = compressed ? pako.inflateRaw(buffer) : buffer
    col.bufferLen = col.buffer.byteLength
  }
  return columns
}

function actorOrderForChanges(changes) {
  const actors = [], seen = new Set(), after = new Map(), indegree = new Map()
  for (const change of changes) {
    const actorIds = change.actorIds
    for (const actor of actorIds) {
      if (!seen.has(actor)) {
        actors.push(actor)
        seen.add(actor)
        after.set(actor, new Set())
        indegree.set(actor, 0)
      }
    }
    for (let index = 1; index + 1 < actorIds.length; index++) {
      const left = actorIds[index], right = actorIds[index + 1]
      if (!after.get(left).has(right)) {
        after.get(left).add(right)
        indegree.set(right, indegree.get(right) + 1)
      }
    }
  }
  const rank = new Map(actors.map((actor, index) => [actor, index]))
  const available = actors.filter(actor => indegree.get(actor) === 0)
  const ordered = []
  while (available.length > 0) {
    available.sort((left, right) => rank.get(left) - rank.get(right))
    const actor = available.shift()
    ordered.push(actor)
    for (const next of after.get(actor)) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) available.push(next)
    }
  }
  if (ordered.length !== actors.length) throw new RangeError('Actor ordering is inconsistent')
  return ordered
}

function decodeBundleInput(changeBuffers) {
  const encodedChanges = changeBuffers.map(buffer => decodeChangeColumns(buffer))
  const actors = actorOrderForChanges(encodedChanges)
  const changes = encodedChanges.map(change => {
    change.ops = decodeOps(decodeColumns(change.columns, change.actorIds, CHANGE_COLUMNS), false)
    delete change.actorIds
    delete change.columns
    return change
  })
  return {actors, changes}
}

function encodeChangeColumns(changes, actors) {
  const actor = new RLEEncoder('uint')
  const seq = new DeltaEncoder()
  const startOp = new DeltaEncoder()
  const maxOp = new DeltaEncoder()
  const time = new DeltaEncoder()
  const message = new RLEEncoder('utf8')
  const depsNum = new RLEEncoder('uint')
  const depsIndex = new DeltaEncoder()
  const extraLen = new RLEEncoder('uint')
  const extraRaw = new Encoder()
  const selected = new Map(changes.map((change, index) => [change.hash, index]))
  const actorIndex = new Map(actors.map((actor, index) => [actor, index]))
  const seen = new Map(), external = [], externalIndex = new Map()

  for (let index = 0; index < changes.length; index++) {
    const change = changes[index]
    seen.set(change.hash, index)
    actor.appendValue(actorIndex.get(change.actor))
    seq.appendValue(change.seq)
    startOp.appendValue(change.startOp)
    maxOp.appendValue(change.startOp + change.ops.length - 1)
    time.appendValue(change.time)
    message.appendValue(change.message || null)
    depsNum.appendValue(change.deps.length)
    for (const dep of change.deps) {
      if (seen.has(dep)) {
        depsIndex.appendValue(seen.get(dep))
      } else {
        if (selected.has(dep)) throw new RangeError('Bundle changes must be in topological order')
        if (!externalIndex.has(dep)) {
          externalIndex.set(dep, external.length)
          external.push(dep)
        }
        depsIndex.appendValue(changes.length + externalIndex.get(dep))
      }
    }
    const extra = change.extraBytes || new Uint8Array(0)
    extraLen.appendValue(extra.byteLength)
    extraRaw.appendRawBytes(extra)
  }

  let messageEncoder = message
  if (changes.length > 0 && message.buffer.byteLength === 0) {
    messageEncoder = new Encoder()
    messageEncoder.appendInt53(0)
    messageEncoder.appendUint53(changes.length)
  }

  return {
    external,
    columns: [
      column('actor', 0x01, actor),
      column('seq', 0x03, seq),
      column('startOp', 0x13, startOp),
      column('maxOp', 0x23, maxOp),
      column('time', 0x33, time),
      column('message', 0x45, messageEncoder),
      column('depsNum', 0x50, depsNum),
      column('depsIndex', 0x53, depsIndex),
      column('extraLen', 0x60, extraLen),
      column('extraRaw', 0x67, extraRaw)
    ]
  }
}

function parseBundleOpId(opId, actorIndex) {
  const id = parseOpId(opId)
  id.actorNum = actorIndex.get(id.actorId)
  if (id.actorNum === undefined) throw new RangeError('missing actorId')
  return id
}

function encodeBundleOps(changes, actors) {
  const actorIndex = new Map(actors.map((actor, index) => [actor, index]))
  const columns = {
    objActor: new RLEEncoder('uint'),
    objCtr: new DeltaEncoder(),
    keyActor: new RLEEncoder('uint'),
    keyCtr: new DeltaEncoder(),
    keyStr: new RLEEncoder('utf8'),
    idActor: new RLEEncoder('uint'),
    idCtr: new DeltaEncoder(),
    insert: new BooleanEncoder(),
    action: new RLEEncoder('uint'),
    valLen: new RLEEncoder('uint'),
    valRaw: new Encoder(),
    predNum: new RLEEncoder('uint'),
    predActor: new RLEEncoder('uint'),
    predCtr: new DeltaEncoder(),
    markName: new RLEEncoder('utf8')
  }
  if (changes.some(change => change.ops.some(op => !!op.expand))) columns.expand = new BooleanEncoder()

  for (const change of changes) {
    const changeActor = actorIndex.get(change.actor)
    for (let opIndex = 0; opIndex < change.ops.length; opIndex++) {
      const op = change.ops[opIndex]
      if (op.obj === '_root') {
        columns.objActor.appendValue(null)
        columns.objCtr.appendValue(null)
      } else {
        const obj = parseBundleOpId(op.obj, actorIndex)
        if (!(obj.counter > 0)) throw new RangeError(`Unexpected objectId reference: ${JSON.stringify(obj)}`)
        columns.objActor.appendValue(obj.actorNum)
        columns.objCtr.appendValue(obj.counter)
      }
      if (op.key !== undefined) {
        columns.keyActor.appendValue(null)
        columns.keyCtr.appendValue(null)
        columns.keyStr.appendValue(op.key)
      } else if (op.elemId === '_head' && op.insert) {
        columns.keyActor.appendValue(null)
        columns.keyCtr.appendValue(0)
        columns.keyStr.appendValue(null)
      } else if (op.elemId) {
        const elemId = parseBundleOpId(op.elemId, actorIndex)
        if (!(elemId.counter > 0)) throw new RangeError(`Unexpected operation key: ${JSON.stringify(op)}`)
        columns.keyActor.appendValue(elemId.actorNum)
        columns.keyCtr.appendValue(elemId.counter)
        columns.keyStr.appendValue(null)
      } else {
        throw new RangeError(`Unexpected operation key: ${JSON.stringify(op)}`)
      }
      const counter = change.startOp + opIndex
      columns.idActor.appendValue(changeActor)
      columns.idCtr.appendValue(counter)
      columns.insert.appendValue(!!op.insert)
      encodeOperationAction(op, columns)
      encodeValue(op, columns)
      columns.predNum.appendValue(op.pred.length)
      for (const pred of op.pred) {
        const id = parseBundleOpId(pred, actorIndex)
        columns.predActor.appendValue(id.actorNum)
        columns.predCtr.appendValue(id.counter)
      }
      if (columns.expand) columns.expand.appendValue(!!op.expand)
      const markName = op.markName === undefined ? op.name : op.markName
      columns.markName.appendValue(markName === undefined ? null : markName)
    }
  }

  return BUNDLE_OPS_COLUMNS
    .filter(spec => columns[spec.columnName])
    .map(spec => column(spec.columnName, spec.columnId, columns[spec.columnName]))
}

function encodeBundle(changeBuffers) {
  if (!Array.isArray(changeBuffers)) throw new TypeError('encodeBundle() changes must be an array')
  const {actors, changes} = decodeBundleInput(changeBuffers)
  const {external, columns: changeColumns} = encodeChangeColumns(changes, actors)
  const opColumns = encodeBundleOps(changes, actors)

  return encodeContainer(CHUNK_TYPE_BUNDLE, encoder => {
    encoder.appendUint53(external.length)
    for (const dep of external) encoder.appendRawBytes(hexStringToBytes(dep))
    encoder.appendUint53(actors.length)
    for (const actor of actors) encoder.appendPrefixedBytes(hexStringToBytes(actor))
    appendColumns(encoder, changeColumns)
    appendColumns(encoder, opColumns)
  }).bytes
}

function decoderFor(columns, columnId) {
  const column = columns.find(col => col.columnId === columnId)
  const buffer = column ? column.buffer : new Uint8Array(0)
  if ((columnId & 7) === COLUMN_TYPE.INT_DELTA) return new DeltaDecoder(buffer)
  if ((columnId & 7) === COLUMN_TYPE.STRING_RLE) return new RLEDecoder('utf8', buffer)
  if ((columnId & 7) === COLUMN_TYPE.VALUE_RAW) return new Decoder(buffer)
  return new RLEDecoder('uint', buffer)
}

function required(decoder, name) {
  const value = decoder.readValue()
  if (value === null) throw new RangeError(`Missing bundle ${name}`)
  return value
}

function decodeChangeRows(columns, actors) {
  const actor = decoderFor(columns, 0x01)
  const seq = decoderFor(columns, 0x03)
  const startOp = decoderFor(columns, 0x13)
  const maxOp = decoderFor(columns, 0x23)
  const time = decoderFor(columns, 0x33)
  const message = decoderFor(columns, 0x45)
  const depsNum = decoderFor(columns, 0x50)
  const depsIndex = decoderFor(columns, 0x53)
  const extraLen = decoderFor(columns, 0x60)
  const extraRaw = decoderFor(columns, 0x67)
  const changes = []

  while (!actor.done) {
    const actorIndex = required(actor, 'actor')
    if (actorIndex >= actors.length) throw new RangeError(`No bundle actor index ${actorIndex}`)
    const depCount = required(depsNum, 'dependency count')
    const extraCount = required(extraLen, 'extra byte count')
    const deps = []
    for (let index = 0; index < depCount; index++) deps.push(required(depsIndex, 'dependency'))
    changes.push({
      actor: actors[actorIndex],
      seq: required(seq, 'sequence'),
      startOp: required(startOp, 'start operation'),
      maxOp: required(maxOp, 'maximum operation'),
      time: required(time, 'timestamp'),
      message: message.readValue() || '',
      deps,
      extraBytes: extraRaw.readRawBytes(extraCount),
      ops: []
    })
  }

  for (const decoder of [seq, startOp, maxOp, time, message, depsNum, depsIndex, extraLen, extraRaw]) {
    if (!decoder.done) throw new RangeError('Bundle change columns have different lengths')
  }
  return changes
}

function addOpsToChanges(changes, ops) {
  const changesByActor = new Map()
  for (const change of changes) {
    if (!changesByActor.has(change.actor)) changesByActor.set(change.actor, [])
    changesByActor.get(change.actor).push(change)
    change.ops = new Array(change.maxOp - change.startOp + 1)
  }
  for (const actorChanges of changesByActor.values()) actorChanges.sort((left, right) => left.startOp - right.startOp)

  for (const op of ops) {
    const id = parseOpId(op.id)
    const actorChanges = changesByActor.get(id.actorId) || []
    let left = 0, right = actorChanges.length
    while (left < right) {
      const middle = (left + right) >>> 1
      if (actorChanges[middle].maxOp < id.counter) left = middle + 1; else right = middle
    }
    const change = actorChanges[left]
    if (!change || id.counter < change.startOp) throw new RangeError(`Operation ${op.id} is outside bundle changes`)
    const index = id.counter - change.startOp
    if (change.ops[index]) throw new RangeError(`Duplicate bundle operation ${op.id}`)
    delete op.id
    change.ops[index] = op
  }

  for (const change of changes) {
    if (change.ops.includes(undefined)) throw new RangeError('Bundle is missing operations')
  }
}

function setOperationCounters(changes, ops, actors) {
  const hasInverse = ops.some(op => op.idCtrInverse !== null)
  if (!hasInverse) {
    if (ops.some(op => op.idCtr === null)) throw new RangeError('Bundle is missing operation counters')
    return
  }
  if (ops.some(op => op.idCtrInverse === null)) throw new RangeError('Bundle inverse operation counters are incomplete')
  const actorIndex = new Map(actors.map((actor, index) => [actor, index]))
  const ordered = changes.slice().sort((left, right) =>
    actorIndex.get(left.actor) - actorIndex.get(right.actor) || left.seq - right.seq)
  const counters = new Array(ops.length)
  let index = 0
  for (const change of ordered) {
    for (let counter = change.startOp; counter <= change.maxOp; counter++) {
      if (index >= ops.length) throw new RangeError('Bundle inverse operation counters have the wrong length')
      const position = ops[index].idCtrInverse
      if (!Number.isInteger(position) || position < 0 || position >= ops.length || counters[position] !== undefined) {
        throw new RangeError('Bundle inverse operation counters are invalid')
      }
      counters[position] = counter
      index++
    }
  }
  if (index !== ops.length || counters.includes(undefined)) {
    throw new RangeError('Bundle inverse operation counters have the wrong length')
  }
  for (let position = 0; position < ops.length; position++) ops[position].idCtr = counters[position]
}

function reconstructChanges(changeRows, external, actors) {
  const changes = [], changeBytes = []
  for (let index = 0; index < changeRows.length; index++) {
    const row = changeRows[index]
    const deps = row.deps.map(dep => {
      if (dep < changeRows.length) {
        if (dep >= index) throw new RangeError('Bundle dependency is not in topological order')
        return changes[dep].hash
      }
      const hash = external[dep - changeRows.length]
      if (!hash) throw new RangeError(`No bundle dependency index ${dep}`)
      return hash
    }).sort()
    const change = {
      actor: row.actor,
      seq: row.seq,
      startOp: row.startOp,
      time: row.time,
      message: row.message,
      deps,
      ops: row.ops
    }
    if (row.extraBytes.byteLength > 0) change.extraBytes = row.extraBytes
    const bytes = encodeChange(change, actors)
    change.hash = decodeChangeMeta(bytes, true).hash
    changeBytes.push(bytes)
    changes.push(change)
  }
  return {changes, changeBytes}
}

function decodeBundle(buffer) {
  const container = new Decoder(buffer)
  const header = decodeContainerHeader(container, true)
  if (!container.done) throw new RangeError('Encoded bundle has trailing data')
  if (header.chunkType !== CHUNK_TYPE_BUNDLE) throw new RangeError(`Unexpected chunk type: ${header.chunkType}`)
  const decoder = new Decoder(header.chunkData)
  const external = [], numExternal = decoder.readUint53()
  for (let index = 0; index < numExternal; index++) {
    external.push(bytesToHexString(decoder.readRawBytes(32)))
  }
  const actors = [], numActors = decoder.readUint53()
  for (let index = 0; index < numActors; index++) {
    actors.push(bytesToHexString(decoder.readPrefixedBytes()))
  }
  const changeColumns = readColumns(decoder, BUNDLE_CHANGE_COLUMNS)
  const changeRows = decodeChangeRows(changeColumns, actors)
  const opColumns = readColumns(decoder, BUNDLE_OPS_COLUMNS)
  if (!decoder.done) throw new RangeError('Encoded bundle has trailing data')
  const opRows = decodeColumns(opColumns, actors, BUNDLE_OPS_COLUMNS)
  setOperationCounters(changeRows, opRows, actors)
  const ops = decodeOps(opRows, 'bundle')
  addOpsToChanges(changeRows, ops)
  const {changes, changeBytes} = reconstructChanges(changeRows, external, actors)
  return {changes, changeBytes, rawChanges: changeBytes, deps: external, actors}
}

module.exports = {
  CHUNK_TYPE_BUNDLE, BUNDLE_CHANGE_COLUMNS, BUNDLE_OPS_COLUMNS,
  encodeBundle, decodeBundle
}
