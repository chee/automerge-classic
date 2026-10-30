function isObject(obj) {
  return typeof obj === 'object' && obj !== null
}

/**
 * Returns a shallow copy of the object `obj`. Faster than `Object.assign({}, obj)`.
 * https://jsperf.com/cloning-large-objects/1
 */
function copyObject(obj) {
  if (!isObject(obj)) return {}
  let copy = {}
  for (let key of Object.keys(obj)) {
    copy[key] = obj[key]
  }
  return copy
}

/**
 * Takes a string in the form that is used to identify operations (a counter concatenated
 * with an actor ID, separated by an `@` sign) and returns an object `{counter, actorId}`.
 */
function parseOpId(opId) {
  const match = /^(\d+)@(.*)$/.exec(opId || '')
  if (!match) {
    throw new RangeError(`Not a valid opId: ${opId}`)
  }
  return {counter: parseInt(match[1], 10), actorId: match[2]}
}

/**
 * Returns true if the two byte arrays contain the same data, false if not.
 */
function equalBytes(array1, array2) {
  if (!(array1 instanceof Uint8Array) || !(array2 instanceof Uint8Array)) {
    throw new TypeError('equalBytes can only compare Uint8Arrays')
  }
  if (array1.byteLength !== array2.byteLength) return false
  for (let i = 0; i < array1.byteLength; i++) {
    if (array1[i] !== array2[i]) return false
  }
  return true
}

/**
 * Creates an array containing the value `null` repeated `length` times.
 */
function createArrayOfNulls(length) {
  return new Array(length).fill(null)
}

/**
 * Compares two strings by the UTF-8 encoding of their content, matching the
 * key ordering used by the Rust implementation. Unpaired surrogates compare
 * as the replacement character U+FFFD.
 */
function compareUtf8(left, right) {
  if (left === right) return 0
  let leftIndex = 0, rightIndex = 0
  while (leftIndex < left.length && rightIndex < right.length) {
    let leftCode = left.codePointAt(leftIndex), rightCode = right.codePointAt(rightIndex)
    leftIndex += leftCode > 0xffff ? 2 : 1
    rightIndex += rightCode > 0xffff ? 2 : 1
    if (leftCode >= 0xd800 && leftCode <= 0xdfff) leftCode = 0xfffd
    if (rightCode >= 0xd800 && rightCode <= 0xdfff) rightCode = 0xfffd
    if (leftCode < rightCode) return -1
    if (leftCode > rightCode) return 1
  }
  if (leftIndex < left.length) return 1
  if (rightIndex < right.length) return -1
  return 0
}

/**
 * Returns `string` with unpaired surrogates replaced by U+FFFD, matching how
 * the Rust implementation stores strings as UTF-8. The document encoders
 * already perform this replacement on the wire; applying it to in-memory
 * values keeps a live document identical to its saved-and-reloaded form.
 */
function wellFormedString(string) {
  if (string.isWellFormed && string.isWellFormed()) return string
  if (string.toWellFormed) return string.toWellFormed()
  return string.replace(/([\ud800-\udbff][\udc00-\udfff])|[\ud800-\udfff]/g, (match, pair) => pair || '\ufffd')
}

const I64_MIN = -(2n ** 63n), I64_MAX = 2n ** 63n - 1n, U64_MAX = 2n ** 64n - 1n

function safeInt(value) {
  return typeof value === 'bigint' && value >= -Number.MAX_SAFE_INTEGER && value <= Number.MAX_SAFE_INTEGER ? Number(value) : value
}

function exportInt(value) {
  return typeof value === 'number' && value >= -Number.MAX_SAFE_INTEGER && value < Number.MAX_SAFE_INTEGER ? value : BigInt(value)
}

function addInt(a, b) {
  if (typeof a === 'number' && typeof b === 'number' && Number.isSafeInteger(a + b)) return a + b
  return safeInt(BigInt.asIntN(64, BigInt(a) + BigInt(b)))
}

function truncateInt(value) {
  if (Number.isSafeInteger(value)) return value
  if (Number.isNaN(value)) return 0
  if (value >= 2 ** 63) return I64_MAX
  if (value <= -(2 ** 63)) return I64_MIN
  return safeInt(BigInt(Math.trunc(value)))
}

const untransacted = new WeakSet()

function beforeTransaction(error) {
  if (isObject(error)) untransacted.add(error)
  return error
}

function importBigInt(value, max, nested) {
  if (value > max) throw beforeTransaction(new RangeError(nested ? 'invalid value' : `bignum ${value} larger than max ${max}`))
  if (value < I64_MIN) throw beforeTransaction(new RangeError(nested ? 'invalid value' : `bignum ${value} smaller than min ${I64_MIN}`))
  return value > I64_MAX ? value : safeInt(value)
}

class PanicError extends Error {}
Object.defineProperty(PanicError.prototype, 'name', {value: 'PanicError'})

export {
  isObject, copyObject, parseOpId, equalBytes, createArrayOfNulls, compareUtf8, wellFormedString, PanicError,
  I64_MAX, U64_MAX, safeInt, exportInt, addInt, truncateInt, importBigInt, untransacted, beforeTransaction
}
