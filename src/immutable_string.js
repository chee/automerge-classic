const IMMUTABLE_STRING = Symbol.for('_am_immutableString')

class ImmutableString {
  constructor(value) {
    if (typeof value !== 'string') throw new TypeError('ImmutableString value must be a string')
    this.val = value
    Object.defineProperty(this, IMMUTABLE_STRING, {value: true})
    Object.freeze(this)
  }

  toString() {
    return this.val
  }

  valueOf() {
    return this.val
  }

  toJSON() {
    return this.val
  }
}

function isImmutableString(value) {
  return typeof value === 'object' && value !== null &&
    Object.prototype.hasOwnProperty.call(value, IMMUTABLE_STRING)
}

module.exports = {ImmutableString, isImmutableString}
