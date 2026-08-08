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
  const array = new Array(length)
  for (let i = 0; i < length; i++) array[i] = null
  return array
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
    let leftCode = left.charCodeAt(leftIndex++), rightCode = right.charCodeAt(rightIndex++)
    if (leftCode >= 0xd800 && leftCode <= 0xdbff) {
      const low = left.charCodeAt(leftIndex)
      if (low >= 0xdc00 && low <= 0xdfff) {
        leftCode = 0x10000 + ((leftCode - 0xd800) << 10) + low - 0xdc00
        leftIndex++
      } else {
        leftCode = 0xfffd
      }
    } else if (leftCode >= 0xdc00 && leftCode <= 0xdfff) {
      leftCode = 0xfffd
    }
    if (rightCode >= 0xd800 && rightCode <= 0xdbff) {
      const low = right.charCodeAt(rightIndex)
      if (low >= 0xdc00 && low <= 0xdfff) {
        rightCode = 0x10000 + ((rightCode - 0xd800) << 10) + low - 0xdc00
        rightIndex++
      } else {
        rightCode = 0xfffd
      }
    } else if (rightCode >= 0xdc00 && rightCode <= 0xdfff) {
      rightCode = 0xfffd
    }
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
  let result = ''
  for (let i = 0; i < string.length; i++) {
    const code = string.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = string.charCodeAt(i + 1)
      if (low >= 0xdc00 && low <= 0xdfff) {
        result += string[i] + string[i + 1]
        i++
      } else {
        result += '�'
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += '�'
    } else {
      result += string[i]
    }
  }
  return result
}

export {
  isObject, copyObject, parseOpId, equalBytes, createArrayOfNulls, compareUtf8, wellFormedString
}
