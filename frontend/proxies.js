import { CHANGE, OBJECT_ID, PROXY_PATH, STATE } from './constants.js'
import { compareUtf8, isObject } from '../src/common.js'
import { Text } from './text.js'
import { Counter } from './counter.js'
function parseListIndex(key) {
  if (typeof key === 'string' && /^[0-9]+$/.test(key)) key = parseInt(key, 10)
  if (typeof key !== 'number') return key
  if (key < 0 || isNaN(key) || key === Infinity || key === -Infinity) {
    throw new RangeError('A list index must be positive, but you passed ' + key)
  }
  return key
}

function seqIndex(value) {
  const index = Math.trunc(Number(value))
  return index > 0 ? index : 0
}

function listMethods(context, listId, path) {
  const methods = {
    deleteAt(index, numDelete) {
      if (typeof numDelete === 'number') context.splice(path, seqIndex(index), Math.trunc(numDelete) || 0, [])
      else context.deleteListIndex(path, seqIndex(index))
      return this
    },

    fill(value, start, end) {
      const length = context.getObject(listId).length
      for (let index = parseListIndex(start || 0); index < Math.min(parseListIndex(end || length), length); index++) {
        context.setListIndex(path, index, value)
      }
      return this
    },

    indexOf(o, start = 0) {
      const id = isObject(o) ? o[OBJECT_ID] : undefined
      if (id) {
        const list = context.getObject(listId)
        for (let index = start; index < list.length; index++) {
          if (list[index][OBJECT_ID] === id) {
            return index
          }
        }
        return -1
      } else {
        return context.getObject(listId).indexOf(o, start)
      }
    },

    insertAt(index, ...values) {
      this.splice(index, 0, ...values)
      return this
    },

    pop() {
      const list = context.getObject(listId)
      if (list.length == 0) return
      const last = context.getObjectField(path, listId, list.length - 1)
      context.deleteListIndex(path, list.length - 1)
      return last
    },

    push(...values) {
      let list = context.getObject(listId)
      context.splice(path, list.length, 0, values)
      // need to getObject() again because the list object above may be immutable
      return context.getObject(listId).length
    },

    shift() {
      if (context.getObject(listId).length == 0) return
      const first = context.getObjectField(path, listId, 0)
      context.deleteListIndex(path, 0)
      return first
    },

    splice(start, deleteCount, ...values) {
      const list = context.getObject(listId)
      start = parseListIndex(start)
      if (typeof deleteCount !== 'number') deleteCount = list.length - start
      deleteCount = parseListIndex(deleteCount)
      const deleted = []
      for (let n = 0; n < deleteCount && start + n < list.length; n++) {
        deleted.push(context.getObjectField(path, listId, start + n))
      }
      context.splice(path, seqIndex(start), deleteCount, values)
      return deleted
    },

    unshift(...values) {
      context.splice(path, 0, 0, values)
      return context.getObject(listId).length
    }
  }

  for (let iterator of ['entries', 'keys', 'values']) {
    let list = context.getObject(listId)
    methods[iterator] = () => list[iterator]()
  }

  // Read-only methods that can delegate to the JavaScript built-in implementations
  for (let method of ['concat', 'every', 'filter', 'find', 'findIndex', 'forEach', 'includes',
                      'join', 'lastIndexOf', 'map', 'reduce', 'reduceRight',
                      'slice', 'some', 'toLocaleString', 'toString']) {
    methods[method] = (...args) => {
      const list = context.getObject(listId)
        .map((item, index) => context.getObjectField(path, listId, index))
      return list[method](...args)
    }
  }

  return methods
}

const MapHandler = {
  get (target, key) {
    const { context, objectId, path } = target
    if (key === OBJECT_ID) return objectId
    if (key === CHANGE) return context
    if (key === STATE) return {actorId: context.actorId}
    if (key === PROXY_PATH) return path
    return context.getObjectField(path, objectId, key)
  },

  set (target, key, value) {
    target.context.setMapKey(target.path, key, value)
    return true
  },

  deleteProperty (target, key) {
    target.context.deleteMapKey(target.path, key)
    return true
  },

  has (target, key) {
    const { context, objectId } = target
    return [OBJECT_ID, CHANGE].includes(key) || (key in context.getObject(objectId))
  },

  getOwnPropertyDescriptor (target, key) {
    const { context, objectId } = target
    if (key in context.getObject(objectId)) return {configurable: true, enumerable: true}
  },

  ownKeys (target) {
    const { context, objectId } = target
    return Object.keys(context.getObject(objectId)).sort(compareUtf8)
  }
}

const ListHandler = {
  get (target, key) {
    const [context, objectId, path] = target
    if (key === Symbol.iterator) return context.getObject(objectId)[Symbol.iterator]
    if (key === OBJECT_ID) return objectId
    if (key === CHANGE) return context
    if (key === PROXY_PATH) return path
    if (key === 'length') return context.getObject(objectId).length
    if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
      return context.getObjectField(path, objectId, parseListIndex(key))
    }
    return listMethods(context, objectId, path)[key]
  },

  set (target, key, value) {
    const [context, /* objectId */, path] = target
    const index = parseListIndex(key)
    if (typeof index !== 'number') throw new RangeError('list index must be a number')
    context.setListIndex(path, index, value)
    return true
  },

  deleteProperty (target, key) {
    const [context, objectId, path] = target
    const index = parseListIndex(key)
    if (context.getObject(objectId)[index] instanceof Counter) {
      throw new TypeError('Unsupported operation: deleting a counter from a list')
    }
    context.deleteListIndex(path, index)
    return true
  },

  has (target, key) {
    const [context, objectId, /* path */] = target
    if (typeof key === 'string' && /^[0-9]+$/.test(key)) {
      return parseListIndex(key) < context.getObject(objectId).length
    }
    return ['length', OBJECT_ID, CHANGE].includes(key)
  },

  getOwnPropertyDescriptor (target, key) {
    const [context, objectId, /* path */] = target
    const object = context.getObject(objectId)

    if (key === 'length') return {writable: true, value: object.length}
    if (key === OBJECT_ID) return {configurable: false, enumerable: false, value: objectId}

    if (typeof key === 'string' && /^[0-9]+$/.test(key) && parseListIndex(key) < object.length) {
      return {configurable: true, enumerable: true}
    }
  },

  ownKeys () {
    return ['length']
  }
}

/**
 * Instantiates a proxy object for the given `objectId`.
 * This function is added as a method to the context object by rootObjectProxy().
 * When it is called, `this` is the context object.
 */
function instantiateProxy(path, objectId) {
  const object = this.getObject(objectId)
  if (Array.isArray(object)) {
    return new Proxy([this, objectId, path], ListHandler)
  } else if (object instanceof Text) {
    return object.getWriteable(this, path)
  } else {
    return new Proxy({context: this, objectId, path}, MapHandler)
  }
}

function rootObjectProxy(context) {
  context.instantiateObject = instantiateProxy
  return new Proxy({context, objectId: '_root', path: []}, MapHandler)
}

export { rootObjectProxy }
