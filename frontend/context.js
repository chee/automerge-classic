import { CACHE, CONFLICTS, ELEM_IDS, OBJECT_ID, OPTIONS, STATE } from './constants.js'
import { interpretPatch, lamportCompare } from './apply_patch.js'
import { Text } from './text.js'
import { Counter, getWriteableCounter } from './counter.js'
import { Float64, Int, Uint } from './numbers.js'
import { compareUtf8, createArrayOfNulls, equalBytes, isObject, parseOpId, wellFormedString } from '../src/common.js'
import { isImmutableString } from '../src/immutable_string.js'
/**
 * An instance of this class is passed to `rootObjectProxy()`. The methods are
 * called by proxy object mutation functions to query the current object state
 * and to apply the requested changes.
 */
class Context {
  constructor (doc, actorId, applyPatch) {
    if (!actorId) {
      throw new Error('Actor ID must be initialized with setActorId() before making a change')
    }
    this.actorId = actorId
    this.nextOpNum = doc[STATE].maxOp + 1
    this.cache = doc[CACHE]
    this.updated = {}
    this.ops = []
    this.textV2 = !!(doc[OPTIONS] && doc[OPTIONS].textV2)
    this.applyPatch = applyPatch || ((patch, object, updated) => interpretPatch(patch, object, updated, this.textV2))
  }

  /**
   * Adds an operation object to the list of changes made in the current context.
   */
  addOp(operation) {
    this.ops.push(operation)

    if (operation.action === 'set' && operation.values) {
      this.nextOpNum += operation.values.length
    } else if (operation.action === 'del' && operation.multiOp) {
      this.nextOpNum += operation.multiOp
    } else {
      this.nextOpNum += 1
    }
  }

  /**
   * Returns the operation ID of the next operation to be added to the context.
   */
  nextOpId() {
    return `${this.nextOpNum}@${this.actorId}`
  }

  /**
   * Takes a value and returns an object describing the value (in the format used by patches).
   */
  getValueDescription(value, hydrate = false) {
    if (!['object', 'boolean', 'number', 'string'].includes(typeof value)) {
      throw new TypeError(`Unsupported type of value: ${typeof value}`)
    }
    if (typeof value === 'string') value = wellFormedString(value)

    if (isObject(value)) {
      if (isImmutableString(value)) {
        return {type: 'value', value: wellFormedString(value.val)}
      } else if (ArrayBuffer.isView(value)) {
        return {type: 'value', value: new Uint8Array(value.buffer, value.byteOffset, value.byteLength)}
      } else if (value instanceof Date) {
        // Date object, represented as milliseconds since epoch
        return {type: 'value', value: value.getTime(), datatype: 'timestamp'}

      } else if (value instanceof Int) {
        return {type: 'value', value: value.value, datatype: 'int'}
      } else if (value instanceof Uint) {
        return {type: 'value', value: value.value, datatype: 'uint'}
      } else if (value instanceof Float64) {
        return {type: 'value', value: value.value, datatype: 'float64'}
      } else if (value instanceof Counter) {
        // Counter object
        return {type: 'value', value: value.value, datatype: 'counter'}

      } else {
        // Nested object (map, list, text, or table)
        const objectId = value[OBJECT_ID], object = this.getObject(objectId)
        if (object instanceof Text) return {objectId, type: 'text', edits: []}
        if (Array.isArray(object)) return {objectId, type: 'list', edits: []}
        return {objectId, type: 'map', props: {}}
      }
    } else if (typeof value === 'number') {
      if (Number.isInteger(value) && value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER && (value > 0 || !hydrate)) {
        return {type: 'value', value, datatype: 'int'}
      } else {
        return {type: 'value', value, datatype: 'float64'}
      }
    } else {
      // Primitive value (string, boolean, or null)
      return {type: 'value', value}
    }
  }

  /**
   * Builds the values structure describing a single property in a patch. Finds all the values of
   * property `key` of `object` (there might be multiple values in the case of a conflict), and
   * returns an object that maps operation IDs to descriptions of values.
   */
  getValuesDescriptions(path, object, key) {
    if (object instanceof Text) {
      // Text objects don't support conflicts
      const value = object.get(key)
      const elemId = object.getElemId(key)
      return value ? {[elemId]: this.getValueDescription(value)} : {}
    } else {
      // Map or list objects
      const conflicts = object[CONFLICTS][key], values = {}
      if (!conflicts) {
        throw new RangeError(`No children at key ${key} of path ${JSON.stringify(path)}`)
      }
      for (let opId of Object.keys(conflicts)) {
        values[opId] = this.getValueDescription(conflicts[opId])
      }
      return values
    }
  }

  /**
   * Recurses along `path` into the patch object `patch`, creating nodes along the way as needed
   * by mutating the patch object. Returns the subpatch at the given path.
   */
  getSubpatch(patch, path) {
    if (path.length == 0) return patch
    let subpatch = patch, object = this.getObject('_root')

    for (let pathElem of path) {
      let values = this.getValuesDescriptions(path, object, pathElem.key)
      if (subpatch.props) {
        if (!subpatch.props[pathElem.key]) {
          subpatch.props[pathElem.key] = values
        }
      } else if (subpatch.edits) {
        for (const opId of Object.keys(values)) {
          subpatch.edits.push({action: 'update', index: pathElem.key, opId, value: values[opId]})
        }
      }

      const nextOpId = Object.keys(values).find(opId => values[opId].objectId === pathElem.objectId)
      if (!nextOpId) {
        throw new RangeError(`Cannot find path object with objectId ${pathElem.objectId}`)
      }

      subpatch = values[nextOpId]
      object = object instanceof Text ? object.get(pathElem.key) : object[CONFLICTS][pathElem.key][nextOpId]
    }

    return subpatch
  }

  /**
   * Returns an object (not proxied) from the cache or updated set, as appropriate.
   */
  getObject(objectId) {
    const object = this.updated[objectId] || this.cache[objectId]
    if (!object) throw new RangeError(`Target object does not exist: ${objectId}`)
    return object
  }

  /**
   * Returns the value associated with the property named `key` on the object
   * at path `path`. If the value is an object, returns a proxy for it.
   */
  getObjectField(path, objectId, key) {
    if (!['string', 'number'].includes(typeof key)) return
    const object = this.getObject(objectId)

    if (object[key] instanceof Counter) {
      return getWriteableCounter(object[key].value, this, path, objectId, key)

    } else if (isObject(object[key]) && object[key][OBJECT_ID] && !ArrayBuffer.isView(object[key])) {
      const childId = object[key][OBJECT_ID]
      const subpath = path.concat([{key, objectId: childId}])
      // The instantiateObject function is added to the context object by rootObjectProxy()
      return this.instantiateObject(subpath, childId)

    } else {
      return object[key]
    }
  }

  /**
   * Recursively creates Automerge versions of all the objects and nested objects in `value`,
   * constructing a patch and operations that describe the object tree. The new object is
   * assigned to the property `key` in the object with ID `obj`. If the object is a list or
   * text, `key` must be set to the list index being updated, and `elemId` must be set to the
   * elemId of the element being updated. If `insert` is true, we insert a new list element
   * (or text character) at index `key`, and `elemId` must be the elemId of the immediate
   * predecessor element (or the string '_head' if inserting at index 0). If the assignment
   * overwrites a previous value at this key/element, `pred` must be set to the array of the
   * prior operations we are overwriting (empty array if there is no existing value).
   */
  createNestedObjects(obj, key, value, insert, pred, elemId) {
    if (value[OBJECT_ID]) {
      throw new RangeError('Cannot create a reference to an existing document object')
    }
    const objectId = this.nextOpId()
    const action = value instanceof Text ? 'makeText' : Array.isArray(value) ? 'makeList' : 'makeMap'
    this.addOp(elemId ? {action, obj, elemId, insert, pred} : {action, obj, key, insert, pred})

    const subpatch = action === 'makeMap'
      ? {objectId, type: 'map', props: {}}
      : {objectId, type: action === 'makeText' ? 'text' : 'list', edits: []}
    this.breadthFirst(() => this.queue.push(() => {
      if (subpatch.edits) return this.insertListItems(subpatch, 0, [...value], true)
      for (let nested of Object.keys(value).sort(compareUtf8)) {
        const opId = this.nextOpId()
        subpatch.props[nested] = {[opId]: this.setValue(objectId, nested, value[nested], false, [])}
      }
    }))
    return subpatch
  }

  breadthFirst(callback) {
    if (this.queue) return callback()
    this.queue = []
    try {
      callback()
      this.hydrating = true
      for (let i = 0; i < this.queue.length; i++) this.queue[i]()
    } finally {
      this.queue = null
      this.hydrating = false
    }
  }

  /**
   * Records an assignment to a particular key in a map, or a particular index in a list.
   * `objectId` is the ID of the object being modified, `key` is the property name or list
   * index being updated, and `value` is the new value being assigned. If `insert` is true,
   * a new list element is inserted at index `key`, and `value` is assigned to that new list
   * element. `pred` is an array of opIds for previous values of the property being assigned,
   * which are overwritten by this operation. If the object being modified is a list or text,
   * `elemId` is the element ID of the list element being updated (if insert=false), or the
   * element ID of the list element immediately preceding the insertion (if insert=true).
   *
   * Returns a patch describing the new value. The return value is of the form
   * `{objectId, type, props}` if `value` is an object, or `{value, datatype}` if it is a
   * primitive value. For string, number, boolean, or null the datatype is omitted.
   */
  setValue(objectId, key, value, insert, pred, elemId, stringValue = false) {
    if (typeof value === 'string') value = wellFormedString(value)
    if (typeof value === 'string' && this.textV2 && !stringValue) value = new Text(value)
    if (isObject(value) && !isScalarObject(value)) {
      // Nested object (map, list, text, or table)
      return this.createNestedObjects(objectId, key, value, insert, pred, elemId)
    }
    // Date or counter object, or primitive value (number, string, boolean, or null)
    const description = this.getValueDescription(value, insert || this.hydrating)
    const op = {action: 'set', obj: objectId, insert, value: description.value, pred}
    if (elemId) op.elemId = elemId; else op.key = key
    if (description.datatype) op.datatype = description.datatype
    this.addOp(op)
    return description
  }

  /**
   * Constructs a new patch, calls `callback` with the subpatch at the location `path`,
   * and then immediately applies the patch to the document.
   */
  applyAtPath(path, callback) {
    let diff = {objectId: '_root', type: 'map', props: {}}
    this.breadthFirst(() => callback(this.getSubpatch(diff, path)))
    this.applyPatch(diff, this.cache._root, this.updated)
  }

  /**
   * Updates the map object at path `path`, setting the property with name
   * `key` to `value`.
   */
  setMapKey(path, key, value) {
    this.setMapKeys(path, [[key, value]])
  }

  setMapKeys(path, entries, hydrate = false) {
    const objectId = pathObjectId(path)
    const object = this.getObject(objectId)

    // If the assigned field value is the same as the existing value, and
    // the assignment does not resolve a conflict, do nothing
    const changed = []
    for (const [key, value] of entries) {
      if (typeof key !== 'string') {
        throw new RangeError(`The key of a map entry must be a string, not ${typeof key}`)
      }
      const action = assignment(object, key, value, this.textV2)
      if (action) changed.push([key, value, action])
    }
    if (changed.length === 0) return
    this.applyAtPath(path, subpatch => {
      this.hydrating = hydrate
      for (const [key, value, action] of changed) {
        const pred = getPred(object, key)
        if (action === 'resolve') {
          const win = winner(pred)
          this.addOp({action: 'del', obj: objectId, key, insert: false, pred: pred.filter(id => id !== win)})
          subpatch.props[key] = {[win]: this.getValueDescription(object[key])}
          continue
        }
        const opId = this.nextOpId()
        subpatch.props[key] = {[opId]: this.setValue(objectId, key, value, false, pred)}
      }
    })
  }

  /**
   * Updates the map object at path `path`, deleting the property `key`.
   */
  deleteMapKey(path, key) {
    const objectId = pathObjectId(path)
    const object = this.getObject(objectId)

    if (object[key] !== undefined) {
      const pred = getPred(object, key)
      this.addOp({action: 'del', obj: objectId, key, insert: false, pred})
      this.applyAtPath(path, subpatch => {
        subpatch.props[key] = {}
      })
    }
  }

  /**
   * Inserts a sequence of new list elements `values` into a list, starting at position `index`.
   * `newObject` is true if we are creating a new list object, and false if we are updating an
   * existing one. `subpatch` is the patch for the list object being modified. Mutates
   * `subpatch` to reflect the sequence of values.
   */
  insertListItems(subpatch, index, values, newObject) {
    const list = newObject ? [] : this.getObject(subpatch.objectId)
    if (index < 0 || index > list.length) {
      throw new RangeError(`List index ${index} is out of bounds for list of length ${list.length}`)
    }
    if (values.length === 0) return

    let elemId = getElemId(list, index, true)
    const stringValues = subpatch.type === 'text' || !this.textV2
    const allPrimitive = values.length > 1 && values.every(v => stringValues && typeof v === 'string' ||
      typeof v === 'number' || typeof v === 'boolean' || v === null || isScalarObject(v))
    const descriptions = allPrimitive ? values.map(v => this.getValueDescription(v, true)) : []
    const datatype = allPrimitive && descriptions[0].datatype

    if (allPrimitive && descriptions.every(d => d.datatype === datatype)) {
      const values = descriptions.map(d => d.value)
      const op = {action: 'set', obj: subpatch.objectId, elemId, insert: true, values, pred: []}
      const edit = {action: 'multi-insert', elemId: this.nextOpId(), index, values}
      if (datatype) {
        op.datatype = datatype
        edit.datatype = datatype
      }
      this.addOp(op)
      subpatch.edits.push(edit)
    } else {
      for (let offset = 0; offset < values.length; offset++) {
        let nextElemId = this.nextOpId()
        const valuePatch = this.setValue(subpatch.objectId, index + offset, values[offset], true, [], elemId, subpatch.type === 'text')
        elemId = nextElemId
        subpatch.edits.push({action: 'insert', index: index + offset, elemId, opId: elemId, value: valuePatch})
      }
    }
  }

  /**
   * Updates the list object at path `path`, replacing the current value at
   * position `index` with the new value `value`.
   */
  setListIndex(path, index, value) {
    const objectId = pathObjectId(path)
    const list = this.getObject(objectId)

    // Assignment past the end of the list => insert nulls followed by new value
    if (index >= list.length) {
      const insertions = createArrayOfNulls(index - list.length)
      insertions.push(value)
      return this.splice(path, list.length, 0, insertions)
    }

    // If the assigned list element value is the same as the existing value, and
    // the assignment does not resolve a conflict, do nothing
    const action = assignment(list, index, value, this.textV2)
    if (action) {
      this.applyAtPath(path, subpatch => {
        const pred = getPred(list, index), elemId = getElemId(list, index)
        if (action === 'resolve') {
          const win = winner(pred)
          this.addOp({action: 'del', obj: objectId, elemId, insert: false, pred: pred.filter(id => id !== win)})
          subpatch.edits.push({action: 'update', index, opId: win, value: this.getValueDescription(list[index])})
          return
        }
        const opId = this.nextOpId()
        const valuePatch = this.setValue(objectId, index, value, false, pred, elemId)
        subpatch.edits.push({action: 'update', index, opId, value: valuePatch})
      })
    }
  }

  /**
   * Updates the list object at path `path`, deleting `deletions` list elements starting from
   * list index `start`, and inserting the list of new elements `insertions` at that position.
   */
  splice(path, start, deletions, insertions) {
    const objectId = pathObjectId(path)
    const list = this.getObject(objectId)
    if (start < 0 || deletions < 0 || start > list.length - deletions) {
      throw new RangeError(`${deletions} deletions starting at index ${start} are out of bounds for list of length ${list.length}`)
    }
    if (deletions === 0 && insertions.length === 0) return

    this.applyAtPath(path, subpatch => {
      if (deletions > 0) {
        let op, lastElemParsed, lastPredParsed
        for (let i = 0; i < deletions; i++) {
          // Any sequences of deletions with consecutive elemId and pred values get combined into a
          // single multiOp; any others become individual deletion operations. This optimisation only
          // kicks in if the user deletes a sequence of elements at once (in a single call to splice);
          // it might be nice to also detect such runs of deletions in the case where the user deletes
          // a sequence of list elements one by one.
          const thisElem = getElemId(list, start + i), thisElemParsed = parseOpId(thisElem)
          const thisPred = getPred(list, start + i)
          const thisPredParsed = (thisPred.length === 1) ? parseOpId(thisPred[0]) : undefined

          if (op && lastElemParsed && lastPredParsed && thisPredParsed &&
              lastElemParsed.actorId === thisElemParsed.actorId && lastElemParsed.counter + 1 === thisElemParsed.counter &&
              lastPredParsed.actorId === thisPredParsed.actorId && lastPredParsed.counter + 1 === thisPredParsed.counter) {
            op.multiOp = (op.multiOp || 1) + 1
          } else {
            if (op) this.addOp(op)
            op = {action: 'del', obj: objectId, elemId: thisElem, insert: false, pred: thisPred}
          }
          lastElemParsed = thisElemParsed
          lastPredParsed = thisPredParsed
        }
        this.addOp(op)
        subpatch.edits.push({action: 'remove', index: start, count: deletions})
      }
      if (insertions.length > 0) this.insertListItems(subpatch, start, insertions, false)
    })
  }

  /**
   * Adds the integer `delta` to the value of the counter located at property
   * `key` in the object at path `path`.
   */
  increment(path, key, delta) {
    const objectId = pathObjectId(path)
    const object = this.getObject(objectId)
    if (!(object[key] instanceof Counter)) {
      throw new TypeError('Only counter values can be incremented')
    }

    // TODO what if there is a conflicting value on the same key as the counter?
    const isList = Array.isArray(object)
    const pred = getPred(object, key)

    if (isList) {
      this.addOp({action: 'inc', obj: objectId, elemId: getElemId(object, key), value: delta, insert: false, pred})
    } else {
      this.addOp({action: 'inc', obj: objectId, key, value: delta, insert: false, pred})
    }

    // The updated counter value is recorded in the local state under the
    // operation ID of the operation that created the counter, not under the
    // increment's own ID: further increments must again use the counter's
    // creation operation as their pred, matching the Rust implementation,
    // and reload resolution attributes increments to the counter operation
    // they extend. Conflicting values that are not counters are overwritten
    // by the increment, as in the Rust implementation.
    const conflicts = (object[CONFLICTS] && object[CONFLICTS][key]) || {[pred[0]]: object[key]}
    const values = {}
    for (const [opId, conflict] of Object.entries(conflicts)) {
      if (conflict instanceof Counter) values[opId] = {value: conflict.value + delta, datatype: 'counter'}
    }
    this.applyAtPath(path, subpatch => {
      if (isList) {
        for (const opId of Object.keys(values)) {
          subpatch.edits.push({action: 'update', index: key, opId, value: values[opId]})
        }
      } else {
        subpatch.props[key] = values
      }
    })
  }
}

function pathObjectId(path) {
  return path.length === 0 ? '_root' : path[path.length - 1].objectId
}

function isScalarObject(value) {
  return isImmutableString(value) || ArrayBuffer.isView(value) || value instanceof Date || value instanceof Counter ||
    value instanceof Int || value instanceof Uint || value instanceof Float64
}

function assignment(object, key, value, textV2) {
  if (value === undefined || (textV2 && typeof value === 'string') || !sameValue(object[key], value)) return 'set'
  return getPred(object, key).length > 1 ? 'resolve' : null
}

function winner(opIds) {
  return opIds.reduce((a, b) => (lamportCompare(a, b) > 0 ? a : b))
}

function sameValue(a, b) {
  if (a === b) return true
  if (isImmutableString(a) && isImmutableString(b)) return a.val === b.val
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime()
  if (a instanceof Counter && b instanceof Counter) return a.value === b.value
  return a instanceof Uint8Array && b instanceof Uint8Array && equalBytes(a, b)
}

function getPred(object, key) {
  if (object instanceof Text) {
    return object.elems[key].pred
  } else if (object[CONFLICTS]) {
    return object[CONFLICTS][key] ? Object.keys(object[CONFLICTS][key]) : []
  } else {
    return []
  }
}

function getElemId(list, index, insert = false) {
  if (insert) {
    if (index === 0) return '_head'
    index -= 1
  }
  if (list[ELEM_IDS]) return list[ELEM_IDS][index]
  if (list.getElemId) return list.getElemId(index)
  throw new RangeError(`Cannot find elemId at list index ${index}`)
}

export {
  Context
}
