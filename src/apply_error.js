import * as Frontend from '../frontend/index.js'
import { OBJECT_IDS, PATCH_OBJECTS, RAW_OBJECT_IDS } from '../backend/index.js'
import { isObject } from './common.js'

const RAW_VALUE = Symbol.for('_am_raw_value_')
const nodes = new WeakSet()

function node(id, raw, data, fresh) {
  const result = {id, raw, list: Array.isArray(data), data}
  nodes.add(result)
  fresh.add(result)
  return result
}

function record(value) {
  return isObject(value) && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)
}

function copied(data) {
  return Array.isArray(data) ? Array.from(data) : Object.assign({}, data)
}

export function rawObjectIds(patches) {
  return patches.some(patch => patch.action === 'insert' && patch.values.some(value => record(value) && RAW_OBJECT_IDS.has(value)) ||
    patch.action === 'put' && record(patch.value) && RAW_OBJECT_IDS.has(patch.value))
}

function incrementError(old) {
  if (!isObject(old)) {
    try {
      Reflect.get(old, RAW_VALUE)
    } catch (error) {
      return `unable to get property Symbol(_am_raw_value_): JsValue(${error.name}: ${error.message}\n${error.stack})`
    }
  }
  return old instanceof Frontend.Counter && typeof old.value === 'number' ? null : 'cannot increment a non-numeric value'
}

function listError(data, patch, prop, created) {
  const index = typeof prop === 'number'
  if (!index && patch.action !== 'insert') return null
  if (patch.action === 'put') data[prop] = created(patch.value)
  else if (patch.action === 'del') data.splice(prop, patch.length || 1)
  else if (patch.action === 'insert') data.splice(prop, 0, ...patch.values.map(created))
  else if (patch.action === 'inc') return incrementError(data[prop])
  return null
}

function mapError(data, patch, prop, created) {
  if (typeof prop === 'number') return null
  if (patch.action === 'put') data[prop] = created(patch.value)
  else if (patch.action === 'del') delete data[prop]
  else if (patch.action === 'inc') return incrementError(data[prop])
  return null
}

export function wasmApply(start, patches) {
  const fresh = new WeakSet()
  const root = nodes.has(start) ? node(start.id, start.raw, copied(start.data), fresh) : node('_root', null, copied(start), fresh)
  function unwrap(value) {
    if (nodes.has(value)) return fresh.has(value) ? value : node(value.id, null, copied(value.data), fresh)
    const id = record(value) && Frontend.getObjectId(value)
    return id ? node(id, null, copied(value), fresh) : root
  }
  function created(value) {
    return record(value) ? node(OBJECT_IDS.get(value) || null, RAW_OBJECT_IDS.get(value) || null, Array.isArray(value) ? [] : {}, fresh) : value
  }
  for (const patch of patches) {
    const path = patch.action === 'mark' ? patch.path : patch.path.slice(0, -1), prop = patch.path[patch.path.length - 1]
    let current = root
    for (const key of path) {
      const value = current.data[key]
      if (!isObject(value)) {
        current = null
        break
      }
      if (nodes.has(value) && value.raw !== null) return {error: `invalid obj id \`${value.raw}\``, root: null}
      const next = unwrap(value)
      if (next !== root) current.data[key] = next
      current = next
    }
    const target = PATCH_OBJECTS.get(patch)
    if (!current || current.id !== null && target !== undefined && current.id !== target) continue
    const error = (current.list ? listError : mapError)(current.data, patch, prop, created)
    if (error !== null) return {error, root: null}
  }
  return {error: null, root}
}

function kind(value) {
  if (typeof value === 'string') return 'text'
  if (value instanceof Frontend.Counter) return typeof value.value === 'number' ? 'counter' : 'object'
  return isObject(value) ? 'object' : 'scalar'
}

export function sameShape(shadow, value) {
  if (!nodes.has(shadow)) return record(shadow) ? shadow === value : kind(shadow) === kind(value)
  if (shadow.raw !== null || !record(value) || Array.isArray(value) !== shadow.list) return false
  if (shadow.id !== null && shadow.id !== Frontend.getObjectId(value)) return false
  if (shadow.list) return shadow.data.length === value.length && shadow.data.every((item, i) => sameShape(item, value[i]))
  const keys = Object.keys(shadow.data)
  return keys.length === Object.keys(value).length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key) && sameShape(shadow.data[key], value[key]))
}
