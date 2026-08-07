const { isObject, copyObject, parseOpId, compareUtf8 } = require('../src/common')
const { OBJECT_ID, CONFLICTS, ELEM_IDS, NEW_KEYS } = require('./constants')
const { Text, instantiateText } = require('./text')
const { instantiateTable } = require('./table')
const { Counter } = require('./counter')
const { ImmutableString } = require('../src/immutable_string')

/**
 * Reconstructs the value from the patch object `patch`.
 */
function getValue(patch, object, updated, textV2) {
  if (patch.objectId) {
    // If the objectId of the existing object does not match the objectId in the patch,
    // that means the patch is replacing the object with a new one made from scratch
    if (object && object[OBJECT_ID] !== patch.objectId) {
      object = undefined
    }
    return interpretPatch(patch, object, updated, textV2)
  } else if (patch.datatype === 'timestamp') {
    // Timestamp: value is milliseconds since 1970 epoch
    return new Date(patch.value)
  } else if (patch.datatype === 'counter') {
    return new Counter(patch.value)
  } else {
    // Primitive value (int, uint, float64, string, boolean, or null)
    return patch.value
  }
}

/**
 * Compares two strings, interpreted as Lamport timestamps of the form
 * 'counter@actorId'. Returns 1 if ts1 is greater, or -1 if ts2 is greater.
 */
function lamportCompare(ts1, ts2) {
  const regex = /^(\d+)@(.*)$/
  const time1 = regex.test(ts1) ? parseOpId(ts1) : {counter: 0, actorId: ts1}
  const time2 = regex.test(ts2) ? parseOpId(ts2) : {counter: 0, actorId: ts2}
  if (time1.counter < time2.counter) return -1
  if (time1.counter > time2.counter) return  1
  if (time1.actorId < time2.actorId) return -1
  if (time1.actorId > time2.actorId) return  1
  return 0
}

/**
 * `props` is an object of the form:
 * `{key1: {opId1: {...}, opId2: {...}}, key2: {opId3: {...}}}`
 * where the outer object is a mapping from property names to inner objects,
 * and the inner objects are a mapping from operation ID to sub-patch.
 * This function interprets that structure and updates the objects `object` and
 * `conflicts` to reflect it. For each key, the greatest opId (by Lamport TS
 * order) is chosen as the default resolution; that op's value is assigned
 * to `object[key]`. Moreover, all the opIds and values are packed into a
 * conflicts object of the form `{opId1: value1, opId2: value2}` and assigned
 * to `conflicts[key]`. If there is no conflict, the conflicts object contains
 * just a single opId-value mapping.
 */
function applyProperties(props, object, conflicts, updated, textV2) {
  if (!props) return

  // Keys are applied in UTF-8 order and conflicting values are kept in
  // ascending opId order, so that the key enumeration order of the updated
  // object and of getConflicts() matches the Rust implementation.
  for (let key of Object.keys(props).sort(compareUtf8)) {
    const values = {}, opIds = Object.keys(props[key]).sort(lamportCompare)
    for (let opId of opIds) {
      const subpatch = props[key][opId]
      if (conflicts[key] && conflicts[key][opId]) {
        values[opId] = getValue(subpatch, conflicts[key][opId], updated, textV2)
      } else {
        values[opId] = getValue(subpatch, undefined, updated, textV2)
      }
      if (textV2 && typeof values[opId] === 'string') values[opId] = new ImmutableString(values[opId])
    }

    if (opIds.length === 0) {
      delete object[key]
      delete conflicts[key]
    } else {
      const value = values[opIds[opIds.length - 1]]
      if (object[NEW_KEYS] && !Object.prototype.hasOwnProperty.call(object, key)) object[NEW_KEYS].add(key)
      object[key] = textV2 && value instanceof Text ? value.toJSON() : value
      conflicts[key] = values
    }
  }
}

/**
 * Creates a writable copy of an immutable map object. If `originalObject`
 * is undefined, creates an empty object with ID `objectId`.
 */
function cloneMapObject(originalObject, objectId) {
  const object    = copyObject(originalObject)
  const conflicts = copyObject(originalObject ? originalObject[CONFLICTS] : undefined)
  Object.defineProperty(object, OBJECT_ID, {value: objectId})
  Object.defineProperty(object, CONFLICTS, {value: conflicts})
  Object.defineProperty(object, NEW_KEYS,  {value: new Set()})
  return object
}

/**
 * Updates the map object `obj` according to the modifications described in
 * `patch`, or creates a new object if `obj` is undefined. Mutates `updated`
 * to map the objectId to the new object, and returns the new object.
 */
function updateMapObject(patch, obj, updated, textV2) {
  const objectId = patch.objectId
  if (!updated[objectId]) {
    updated[objectId] = cloneMapObject(obj, objectId)
  }

  const object = updated[objectId]
  applyProperties(patch.props, object, object[CONFLICTS], updated, textV2)
  return object
}

/**
 * Updates the table object `obj` according to the modifications described in
 * `patch`, or creates a new object if `obj` is undefined. Mutates `updated`
 * to map the objectId to the new object, and returns the new object.
 */
function updateTableObject(patch, obj, updated, textV2) {
  const objectId = patch.objectId
  if (!updated[objectId]) {
    updated[objectId] = obj ? obj._clone() : instantiateTable(objectId)
  }

  const object = updated[objectId]

  for (let key of Object.keys(patch.props || {})) {
    const opIds = Object.keys(patch.props[key])

    if (opIds.length === 0) {
      object.remove(key)
    } else if (opIds.length === 1) {
      const subpatch = patch.props[key][opIds[0]]
      object._set(key, getValue(subpatch, object.byId(key), updated, textV2), opIds[0])
    } else {
      throw new RangeError('Conflicts are not supported on properties of a table')
    }
  }
  return object
}

/**
 * Creates a writable copy of an immutable list object. If `originalList` is
 * undefined, creates an empty list with ID `objectId`.
 */
function cloneListObject(originalList, objectId) {
  const list = originalList ? originalList.slice() : [] // slice() makes a shallow clone
  const conflicts = (originalList && originalList[CONFLICTS]) ? originalList[CONFLICTS].slice() : []
  const elemIds = (originalList && originalList[ELEM_IDS]) ? originalList[ELEM_IDS].slice() : []
  Object.defineProperty(list, OBJECT_ID, {value: objectId})
  Object.defineProperty(list, CONFLICTS, {value: conflicts})
  Object.defineProperty(list, ELEM_IDS,  {value: elemIds})
  return list
}

/**
 * Updates the list object `obj` according to the modifications described in
 * `patch`, or creates a new object if `obj` is undefined. Mutates `updated`
 * to map the objectId to the new object, and returns the new object.
 */
function updateListObject(patch, obj, updated, textV2) {
  const objectId = patch.objectId
  if (!updated[objectId]) {
    updated[objectId] = cloneListObject(obj, objectId)
  }

  const list = updated[objectId], conflicts = list[CONFLICTS], elemIds = list[ELEM_IDS]
  for (let i = 0; i < patch.edits.length; i++) {
    const edit = patch.edits[i]

    if (edit.action === 'insert' || edit.action === 'update') {
      const oldValue = conflicts[edit.index] && conflicts[edit.index][edit.opId]
      let lastValue = getValue(edit.value, oldValue, updated, textV2)
      if (textV2 && typeof lastValue === 'string') lastValue = new ImmutableString(lastValue)
      let values = {[edit.opId]: lastValue}

      // Successive updates for the same index are an indication of a conflict on that list element.
      // Edits are sorted in increasing order by Lamport timestamp, so the last value (with the
      // greatest timestamp) is the default resolution of the conflict.
      while (i < patch.edits.length - 1 && patch.edits[i + 1].index === edit.index &&
             patch.edits[i + 1].action === 'update') {
        i++
        const conflict = patch.edits[i]
        const oldValue2 = conflicts[conflict.index] && conflicts[conflict.index][conflict.opId]
        lastValue = getValue(conflict.value, oldValue2, updated, textV2)
        if (textV2 && typeof lastValue === 'string') lastValue = new ImmutableString(lastValue)
        values[conflict.opId] = lastValue
      }

      if (edit.action === 'insert') {
        list.splice(edit.index, 0, textV2 && lastValue instanceof Text ? lastValue.toJSON() : lastValue)
        conflicts.splice(edit.index, 0, values)
        elemIds.splice(edit.index, 0, edit.elemId)
      } else {
        list[edit.index] = textV2 && lastValue instanceof Text ? lastValue.toJSON() : lastValue
        conflicts[edit.index] = values
      }

    } else if (edit.action === 'multi-insert') {
      const startElemId = parseOpId(edit.elemId), newElems = [], newValues = [], newConflicts = []
      const datatype = edit.datatype
      edit.values.forEach((value, index) => {
        const elemId = `${startElemId.counter + index}@${startElemId.actorId}`
        value = getValue({ value, datatype }, undefined, updated, textV2)
        const scalar = textV2 && typeof value === 'string' ? new ImmutableString(value) : value
        newValues.push(scalar)
        newConflicts.push({[elemId]: {value: scalar, datatype, type: 'value'}})
        newElems.push(elemId)
      })
      list.splice(edit.index, 0, ...newValues)
      conflicts.splice(edit.index, 0, ...newConflicts)
      elemIds.splice(edit.index, 0, ...newElems)

    } else if (edit.action === 'remove') {
      list.splice(edit.index, edit.count)
      conflicts.splice(edit.index, edit.count)
      elemIds.splice(edit.index, edit.count)
    }
  }
  return list
}

/**
 * Updates the text object `obj` according to the modifications described in
 * `patch`, or creates a new object if `obj` is undefined. Mutates `updated`
 * to map the objectId to the new object, and returns the new object.
 */
function updateTextObject(patch, obj, updated, textV2) {
  const objectId = patch.objectId
  let elems
  if (updated[objectId]) {
    elems = updated[objectId].elems
  } else if (obj) {
    elems = obj.elems.slice()
  } else {
    elems = []
  }

  for (const edit of patch.edits) {
    if (edit.action === 'insert') {
      const value = getValue(edit.value, undefined, updated, textV2)
      const elem = {elemId: edit.elemId, pred: [edit.opId], value}
      elems.splice(edit.index, 0, elem)

    } else if (edit.action === 'multi-insert') {
      const startElemId = parseOpId(edit.elemId)
      const datatype = edit.datatype
      const newElems = edit.values.map((value, index) => {
        value = getValue({ datatype, value }, undefined, updated, textV2)
        const elemId = `${startElemId.counter + index}@${startElemId.actorId}`
        return {elemId, pred: [elemId], value}
      })
      elems.splice(edit.index, 0, ...newElems)

    } else if (edit.action === 'update') {
      const elemId = elems[edit.index].elemId
      const value = getValue(edit.value, elems[edit.index].value, updated, textV2)
      elems[edit.index] = {elemId, pred: [edit.opId], value}

    } else if (edit.action === 'remove') {
      elems.splice(edit.index, edit.count)
    }
  }

  updated[objectId] = instantiateText(objectId, elems)
  return updated[objectId]
}

/**
 * Applies the patch object `patch` to the read-only document object `obj`.
 * Clones a writable copy of `obj` and places it in `updated` (indexed by
 * objectId), if that has not already been done. Returns the updated object.
 */
function interpretPatch(patch, obj, updated, textV2 = false) {
  // Return original object if it already exists and isn't being modified
  if (isObject(obj) && (!patch.props || Object.keys(patch.props).length === 0) &&
      (!patch.edits || patch.edits.length === 0) && !updated[patch.objectId]) {
    return obj
  }

  if (patch.type === 'map') {
    return updateMapObject(patch, obj, updated, textV2)
  } else if (patch.type === 'table') {
    return updateTableObject(patch, obj, updated, textV2)
  } else if (patch.type === 'list') {
    return updateListObject(patch, obj, updated, textV2)
  } else if (patch.type === 'text') {
    return updateTextObject(patch, obj, updated, textV2)
  } else {
    throw new TypeError(`Unknown object type: ${patch.type}`)
  }
}

/**
 * Creates a writable copy of the immutable document root object `root`.
 */
function cloneRootObject(root) {
  if (root[OBJECT_ID] !== '_root') {
    throw new RangeError(`Not the root object: ${root[OBJECT_ID]}`)
  }
  return cloneMapObject(root, '_root')
}

/**
 * Moves the keys added to the map object `object` since it was cloned to the
 * end of its enumeration order, sorted by UTF-8 encoding. This matches the
 * Rust implementation, where each apply appends its new keys in sorted order
 * while existing keys keep their position.
 */
function reorderNewKeys(object) {
  const newKeys = object[NEW_KEYS]
  if (!newKeys || newKeys.size === 0) return
  const keys = [...newKeys].filter(key => Object.prototype.hasOwnProperty.call(object, key)).sort(compareUtf8)
  for (const key of keys) {
    const value = object[key]
    delete object[key]
    object[key] = value
  }
  newKeys.clear()
}

module.exports = {
  interpretPatch, cloneRootObject, lamportCompare, reorderNewKeys
}
