const {
  Decoder, RLEEncoder, RLEDecoder, DeltaEncoder, DeltaDecoder, BooleanEncoder, BooleanDecoder
} = require('./encoding')

const DEFAULT_SLAB_ROWS = 1024
const DEFAULT_SLAB_BYTES = 64 * 1024
const TYPES = ['int', 'uint', 'string', 'boolean', 'delta', 'raw']
const VALID_COLUMNS = new WeakSet()

function checkType(type) {
  if (!TYPES.includes(type)) throw new RangeError(`unsupported column type: ${type}`)
  return type
}

function checkCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a nonnegative safe integer`)
  return value
}

function checkLimit(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

function normalizeOptions(options) {
  let slabRows, slabBytes
  if (options === undefined) options = {}
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object')
  }
  for (let key of Object.keys(options)) {
    if (key !== 'slabRows' && key !== 'slabBytes') throw new RangeError(`unsupported column option: ${key}`)
  }
  slabRows = options.slabRows === undefined ? DEFAULT_SLAB_ROWS : options.slabRows
  slabBytes = options.slabBytes === undefined ? DEFAULT_SLAB_BYTES : options.slabBytes
  return {
    slabRows: checkLimit(slabRows, 'slabRows'),
    slabBytes: checkLimit(slabBytes, 'slabBytes')
  }
}

function checkValue(type, value) {
  if (value === null && type !== 'boolean' && type !== 'raw') return value
  if (type === 'string') {
    if (typeof value !== 'string') throw new TypeError('string column values must be strings or null')
  } else if (type === 'boolean') {
    if (value !== true && value !== false) throw new TypeError('boolean column values must be booleans')
  } else if (type === 'raw') {
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new RangeError('raw column values must be bytes')
  } else {
    if (!Number.isSafeInteger(value)) throw new RangeError(`${type} column values must be safe integers or null`)
    if (type === 'uint' && value < 0) throw new RangeError('uint column values must be nonnegative')
  }
  return value
}

function checkValues(type, values) {
  if (!Array.isArray(values)) throw new TypeError('values must be an array')
  for (let value of values) checkValue(type, value)
  return values
}

function encoderFor(type) {
  if (type === 'int') return new RLEEncoder('int')
  if (type === 'uint') return new RLEEncoder('uint')
  if (type === 'string') return new RLEEncoder('utf8')
  if (type === 'boolean') return new BooleanEncoder()
  if (type === 'delta') return new DeltaEncoder()
  return checkType(type)
}

function decoderFor(type, data) {
  if (type === 'int') return new RLEDecoder('int', data)
  if (type === 'uint') return new RLEDecoder('uint', data)
  if (type === 'string') return new RLEDecoder('utf8', data)
  if (type === 'boolean') return new BooleanDecoder(data)
  if (type === 'delta') return new DeltaDecoder(data)
  if (type === 'raw') {
    const decoder = new Decoder(data)
    decoder.readValue = decoder.readByte
    decoder.skipValues = decoder.skip
    return decoder
  }
  return checkType(type)
}

function encodeValues(type, values) {
  if (type === 'raw') return Uint8Array.from(values)
  const encoder = encoderFor(type)
  for (let value of values) encoder.appendValue(value)
  return encoder.buffer
}

function equalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false
  for (let index = 0; index < left.byteLength; index++) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function decodeValues(type, data, rows, canonical) {
  if (type === 'raw') {
    if (data.byteLength !== rows) throw new RangeError('encoded row count does not match logical length')
    return Array.from(data)
  }
  const decoder = decoderFor(type, data), values = []
  for (let index = 0; index < rows; index++) {
    if (type === 'boolean' && decoder.done) throw new RangeError('encoded row count does not match logical length')
    values.push(decoder.readValue())
  }
  if (!decoder.done) throw new RangeError('encoded row count does not match logical length')
  if (canonical && !equalBytes(data, encodeValues(type, values))) {
    throw new RangeError('column data is not canonically encoded')
  }
  return values
}

function splitValues(type, values, options, output) {
  const data = encodeValues(type, values)
  if (data.byteLength <= options.slabBytes || values.length <= 1) {
    output.push({rows: values.length, data})
  } else {
    const middle = Math.floor(values.length / 2)
    splitValues(type, values.slice(0, middle), options, output)
    splitValues(type, values.slice(middle), options, output)
  }
}

function encodeSlabs(type, values, options) {
  const slabs = []
  for (let start = 0; start < values.length; start += options.slabRows) {
    splitValues(type, values.slice(start, start + options.slabRows), options, slabs)
  }
  return slabs
}

function addStarts(slabs) {
  let start = 0
  return slabs.map(slab => {
    const result = {start, rows: slab.rows, data: slab.data}
    start += slab.rows
    return result
  })
}

function makeColumn(type, slabs, options) {
  const withStarts = addStarts(slabs)
  const length = withStarts.length === 0 ? 0 : withStarts[withStarts.length - 1].start + withStarts[withStarts.length - 1].rows
  const column = {type, length, slabRows: options.slabRows, slabBytes: options.slabBytes, slabs: withStarts}
  VALID_COLUMNS.add(column)
  return column
}

function checkColumn(column) {
  let start = 0
  if (VALID_COLUMNS.has(column)) return column
  if (column === null || typeof column !== 'object' || Array.isArray(column)) throw new TypeError('column must be an object')
  checkType(column.type)
  checkCount(column.length, 'column length')
  checkLimit(column.slabRows, 'slabRows')
  checkLimit(column.slabBytes, 'slabBytes')
  if (!Array.isArray(column.slabs)) throw new TypeError('column slabs must be an array')
  for (let slab of column.slabs) {
    if (slab === null || typeof slab !== 'object' || Array.isArray(slab)) throw new TypeError('slab must be an object')
    if (slab.start !== start) throw new RangeError('slab starts must be contiguous')
    checkLimit(slab.rows, 'slab rows')
    if (!(slab.data instanceof Uint8Array)) throw new TypeError('slab data must be a Uint8Array')
    start += slab.rows
  }
  if (start !== column.length) throw new RangeError('slab rows do not match column length')
  return column
}

function createColumn(type, values, options) {
  if (values === undefined) values = []
  checkType(type)
  checkValues(type, values)
  const normalized = normalizeOptions(options)
  return makeColumn(type, encodeSlabs(type, values, normalized), normalized)
}

function loadSlabs(type, slabs, length, options) {
  let total = 0
  if (!Array.isArray(slabs)) throw new TypeError('slabs must be an array')
  const loaded = slabs.map(slab => {
    let rows, data
    if (slab === null || typeof slab !== 'object' || Array.isArray(slab)) throw new TypeError('slab must be an object')
    rows = checkLimit(slab.rows, 'slab rows')
    data = slab.data
    if (!(data instanceof Uint8Array)) throw new TypeError('slab data must be a Uint8Array')
    decodeValues(type, data, rows, true)
    total += rows
    return {rows, data}
  })
  if (length !== undefined && checkCount(length, 'column length') !== total) {
    throw new RangeError('slab rows do not match column length')
  }
  return makeColumn(type, loaded, options)
}

function loadSaved(saved, overrides) {
  let options
  if (saved === null || typeof saved !== 'object' || Array.isArray(saved)) throw new TypeError('saved column must be an object')
  checkType(saved.type)
  options = normalizeOptions(overrides === undefined ? {
    slabRows: saved.slabRows,
    slabBytes: saved.slabBytes
  } : overrides)
  return loadSlabs(saved.type, saved.slabs, saved.length, options)
}

function loadColumn(type, source, length, options) {
  let normalized
  if (typeof type !== 'string') {
    if (source !== undefined && (source === null || typeof source !== 'object' || Array.isArray(source))) {
      throw new TypeError('options must be an object')
    }
    return loadSaved(type, source)
  }
  checkType(type)
  if (source instanceof Uint8Array) {
    checkCount(length, 'column length')
    normalized = normalizeOptions(options)
    decodeValues(type, source, length, true)
    if (length === 0) return makeColumn(type, [], normalized)
    return makeColumn(type, [{rows: length, data: source}], normalized)
  }
  if (Array.isArray(source)) {
    if (length !== undefined && typeof length === 'object') {
      options = length
      length = undefined
    }
    normalized = normalizeOptions(options)
    return loadSlabs(type, source, length, normalized)
  }
  throw new TypeError('column source must be a Uint8Array or an array of slabs')
}

function findSlab(column, row) {
  let low = 0, high = column.slabs.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const slab = column.slabs[middle]
    if (row < slab.start) {
      high = middle
    } else if (row >= slab.start + slab.rows) {
      low = middle + 1
    } else {
      return middle
    }
  }
  return low
}

function checkIndex(column, index, allowEnd) {
  checkCount(index, 'index')
  if (index > column.length || (!allowEnd && index === column.length)) throw new RangeError('index out of bounds')
  return index
}

function slabValues(column, slab) {
  return decodeValues(column.type, slab.data, slab.rows, false)
}

function get(column, index) {
  checkColumn(column)
  checkIndex(column, index, false)
  const slab = column.slabs[findSlab(column, index)]
  const decoder = decoderFor(column.type, slab.data)
  decoder.skipValues(index - slab.start)
  return decoder.readValue()
}

function *range(column, start, end) {
  let slabIndex
  if (start === undefined) start = 0
  checkColumn(column)
  checkIndex(column, start, true)
  if (end === undefined) end = column.length
  checkIndex(column, end, true)
  if (end < start) throw new RangeError('range end precedes start')
  if (start === end) return
  slabIndex = findSlab(column, start)
  while (slabIndex < column.slabs.length) {
    const slab = column.slabs[slabIndex]
    const values = slabValues(column, slab)
    const from = Math.max(start, slab.start) - slab.start
    const to = Math.min(end, slab.start + slab.rows) - slab.start
    for (let index = from; index < to; index++) yield values[index]
    if (slab.start + slab.rows >= end) return
    slabIndex++
  }
}

function clone(column) {
  checkColumn(column)
  return makeColumn(column.type, column.slabs, column)
}

function splice(column, index, deleteCount, inserted = []) {
  let end, leftIndex, rightIndex, leftSlab, rightSlab, leftValues, rightValues
  let prefix, suffix, middle, options
  checkColumn(column)
  checkIndex(column, index, true)
  checkCount(deleteCount, 'deleteCount')
  if (deleteCount > column.length - index) throw new RangeError('deleteCount out of bounds')
  checkValues(column.type, inserted)
  if (deleteCount === 0 && inserted.length === 0) return clone(column)
  end = index + deleteCount
  leftIndex = index < column.length ? findSlab(column, index) : column.slabs.length
  rightIndex = end < column.length ? findSlab(column, end) : column.slabs.length
  leftSlab = leftIndex < column.slabs.length ? column.slabs[leftIndex] : undefined
  rightSlab = rightIndex < column.slabs.length ? column.slabs[rightIndex] : undefined
  prefix = column.slabs.slice(0, leftIndex)
  suffix = column.slabs.slice(rightIndex + (rightSlab && end > rightSlab.start ? 1 : 0))
  middle = []
  if (leftSlab && leftSlab.start < index) {
    leftValues = slabValues(column, leftSlab)
    middle.push(...leftValues.slice(0, index - leftSlab.start))
  }
  middle.push(...inserted)
  if (rightSlab && end > rightSlab.start) {
    rightValues = rightSlab === leftSlab && leftValues ? leftValues : slabValues(column, rightSlab)
    middle.push(...rightValues.slice(end - rightSlab.start))
  }
  options = {slabRows: column.slabRows, slabBytes: column.slabBytes}
  return makeColumn(column.type, prefix.concat(encodeSlabs(column.type, middle, options), suffix), options)
}

function append(column, values) {
  checkColumn(column)
  return splice(column, column.length, 0, values)
}

function toBuffer(column) {
  checkColumn(column)
  if (column.slabs.length === 1) return column.slabs[0].data
  return encodeValues(column.type, Array.from(range(column)))
}

function decoder(column) {
  checkColumn(column)
  return decoderFor(column.type, toBuffer(column))
}

function save(column) {
  checkColumn(column)
  return {
    type: column.type,
    length: column.length,
    slabRows: column.slabRows,
    slabBytes: column.slabBytes,
    slabs: column.slabs.map(slab => ({rows: slab.rows, data: slab.data}))
  }
}

module.exports = {
  DEFAULT_SLAB_ROWS, DEFAULT_SLAB_BYTES,
  createColumn, loadColumn, clone, get, range, values: range, splice, append, save, toBuffer, decoder
}
