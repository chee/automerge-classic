const Automerge = require('./automerge')

function classicOptions(options) {
  if (options === undefined) return {textV2: false}
  if (typeof options === 'string') return {actorId: options, textV2: false}
  if (options === null || typeof options !== 'object') return options
  return Object.assign({}, options, {textV2: false})
}

const overrides = {
  init: options => Automerge.init(classicOptions(options)),
  from: (value, options) => Automerge.from(value, classicOptions(options)),
  load: (data, options) => Automerge.load(data, classicOptions(options)),
  clone: (doc, options) => Automerge.clone(doc, classicOptions(options))
}

const Classic = Object.defineProperties({}, Object.assign(
  {},
  Object.getOwnPropertyDescriptors(Automerge),
  Object.getOwnPropertyDescriptors(overrides)
))

module.exports = Classic
