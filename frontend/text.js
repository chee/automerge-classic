import { OBJECT_ID } from './constants.js'
import { isObject } from '../src/common.js'
const strings = new WeakMap(), offsets = new WeakMap(), widths = new WeakMap()
const CHUNK_SIZE = 256
class Text {
  constructor (text) {
    if (typeof text === 'string') text = [...text]
    if (text === undefined) text = []
    if (!Array.isArray(text)) {
      throw new TypeError(`Unsupported initial value for Text: ${text}`)
    }
    return instantiateText(undefined, [text.map(value => ({value}))]) // eslint-disable-line
  }

  get length () {
    if (this.chunks.length === 1) return this.chunks[0].length
    return chunkStarts(this.chunks)[this.chunks.length]
  }

  get elems () {
    return this.chunks.length === 1 ? this.chunks[0] : [].concat(...this.chunks)
  }

  get (index) {
    const value = elemAt(this.chunks, index).value
    if (this.context && isObject(value)) {
      const objectId = value[OBJECT_ID]
      const path = this.path.concat([{key: index, objectId}])
      return this.context.instantiateObject(path, objectId)
    } else {
      return value
    }
  }

  getElemId (index) {
    return elemAt(this.chunks, index).elemId
  }

  /**
   * Iterates over the text elements character by character, including any
   * inline objects.
   */
  [Symbol.iterator] () {
    let chunks = this.chunks, chunk = 0, index = -1
    return {
      next () {
        index += 1
        while (chunk < chunks.length && index >= chunks[chunk].length) {
          chunk += 1
          index = 0
        }
        if (chunk < chunks.length) {
          return {done: false, value: chunks[chunk][index].value}
        } else {
          return {done: true}
        }
      }
    }
  }

  /**
   * Returns the content of the Text object as a simple string, ignoring any
   * non-character elements.
   */
  toString() {
    // Concatting to a string is faster than creating an array and then
    // .join()ing for small (<100KB) arrays.
    // https://jsperf.com/join-vs-loop-w-type-test
    let str = ''
    for (const value of this) {
      if (typeof value === 'string') str += value
    }
    return str
  }

  /**
   * Returns the content of the Text object as a sequence of strings,
   * interleaved with non-character elements.
   *
   * For example, the value ['a', 'b', {x: 3}, 'c', 'd'] has spans:
   * => ['ab', {x: 3}, 'cd']
   */
  toSpans() {
    let spans = []
    let chars = ''
    for (const value of this) {
      if (typeof value === 'string') {
        chars += value
      } else {
        if (chars.length > 0) {
          spans.push(chars)
          chars = ''
        }
        spans.push(value)
      }
    }
    if (chars.length > 0) {
      spans.push(chars)
    }
    return spans
  }

  /**
   * Returns the content of the Text object as a simple string, so that the
   * JSON serialization of an Automerge document represents text nicely.
   */
  toJSON() {
    let str = strings.get(this.chunks)
    if (str !== undefined) return str
    str = ''
    for (const chunk of this.chunks) {
      let part = strings.get(chunk)
      if (part === undefined) {
        part = ''
        for (const {value} of chunk) part += typeof value === 'string' ? value : '\ufffc'
        strings.set(chunk, part)
      }
      str += part
    }
    strings.set(this.chunks, str)
    return str
  }

  /**
   * Returns a writeable instance of this object. This instance is returned when
   * the text object is accessed within a change callback. `context` is the
   * proxy context that keeps track of the mutations.
   */
  getWriteable(context, path) {
    if (!this[OBJECT_ID]) {
      throw new RangeError('getWriteable() requires the objectId to be set')
    }

    const instance = instantiateText(this[OBJECT_ID], this.chunks)
    instance.context = context
    instance.path = path
    return instance
  }

  /**
   * Updates the list item at position `index` to a new value `value`.
   */
  set (index, value) {
    if (this.context) {
      this.context.setListIndex(this.path, index, value)
    } else {
      localElems(this)[index].value = value
    }
    return this
  }

  /**
   * Inserts new list items `values` starting at position `index`.
   */
  insertAt(index, ...values) {
    if (this.context) {
      this.context.splice(this.path, index, 0, values)
    } else {
      localElems(this).splice(index, 0, ...values.map(value => ({value})))
    }
    return this
  }

  /**
   * Deletes `numDelete` list items starting at position `index`.
   * if `numDelete` is not given, one item is deleted.
   */
  deleteAt(index, numDelete = 1) {
    if (this.context) {
      this.context.splice(this.path, index, numDelete, [])
    } else {
      localElems(this).splice(index, numDelete)
    }
    return this
  }
}

// Read-only methods that can delegate to the JavaScript built-in array
for (let method of ['concat', 'every', 'filter', 'find', 'findIndex', 'forEach', 'includes',
                    'indexOf', 'join', 'lastIndexOf', 'map', 'reduce', 'reduceRight',
                    'slice', 'some', 'toLocaleString']) {
  Text.prototype[method] = function (...args) {
    return [...this][method](...args)
  }
}

function localElems(text) {
  if (text[OBJECT_ID]) {
    throw new TypeError('Automerge.Text object cannot be modified outside of a change block')
  }
  strings.delete(text.chunks)
  strings.delete(text.chunks[0])
  widths.delete(text.chunks[0])
  return text.chunks[0]
}

function chunkStarts(chunks) {
  let starts = offsets.get(chunks)
  if (starts) return starts
  starts = [0]
  for (const chunk of chunks) starts.push(starts[starts.length - 1] + chunk.length)
  offsets.set(chunks, starts)
  return starts
}

function elemWidth(elem) {
  return typeof elem.value === 'string' ? elem.value.length : 1
}

function textOffset(text, index) {
  const string = strings.get(text.chunks)
  if (string !== undefined && string.length === text.length) return index
  let offset = 0
  for (const chunk of text.chunks) {
    let width = widths.get(chunk)
    if (width === undefined) {
      width = chunk.reduce((total, elem) => total + elemWidth(elem), 0)
      widths.set(chunk, width)
    }
    if (index <= chunk.length) {
      if (width === chunk.length) return offset + index
      for (let i = 0; i < index; i++) offset += elemWidth(chunk[i])
      return offset
    }
    offset += width
    index -= chunk.length
  }
  return offset
}

function elemAt(chunks, index) {
  if (chunks.length === 1) return chunks[0][index]
  const starts = chunkStarts(chunks)
  let low = 0, high = chunks.length - 1
  while (low < high) {
    const mid = (low + high + 1) >> 1
    if (starts[mid] <= index) low = mid
    else high = mid - 1
  }
  return chunks[low] && chunks[low][index - starts[low]]
}

function spliceChunks(chunks, index, deleteCount, elems) {
  let first = 0
  while (first < chunks.length - 1 && index > chunks[first].length) {
    index -= chunks[first].length
    first++
  }
  let last = first, covered = chunks.length > 0 ? chunks[first].length : 0
  while (last < chunks.length - 1 && covered < index + deleteCount) covered += chunks[++last].length
  let merged = [].concat(...chunks.slice(first, last + 1))
  merged = merged.slice(0, index).concat(elems, merged.slice(index + deleteCount))
  if (merged.length < CHUNK_SIZE / 2 && last < chunks.length - 1) merged = merged.concat(chunks[++last])
  const pieces = []
  if (merged.length <= 2 * CHUNK_SIZE) {
    if (merged.length > 0) pieces.push(merged)
  } else {
    for (let i = 0; i < merged.length; i += CHUNK_SIZE) pieces.push(merged.slice(i, i + CHUNK_SIZE))
  }
  return chunks.slice(0, first).concat(pieces, chunks.slice(last + 1))
}

function instantiateText(objectId, chunks) {
  const instance = Object.create(Text.prototype)
  instance[OBJECT_ID] = objectId
  instance.chunks = chunks
  return instance
}

export { Text, instantiateText, elemAt, spliceChunks, strings, textOffset }
