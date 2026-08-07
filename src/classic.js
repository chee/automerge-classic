const Automerge = require('./automerge')

function classicOptions(options) {
  if (options === undefined) return {textV2: false}
  if (typeof options === 'string') return {actorId: options, textV2: false}
  if (options === null || typeof options !== 'object') return options
  return Object.assign({}, options, {textV2: false})
}

const Classic = {}
Object.defineProperties(Classic, Object.getOwnPropertyDescriptors(Automerge))
Classic.init = options => Automerge.init(classicOptions(options))
Classic.from = (value, options) => Automerge.from(value, classicOptions(options))
Classic.load = (data, options) => Automerge.load(data, classicOptions(options))
Classic.clone = (doc, options) => Automerge.clone(doc, classicOptions(options))

module.exports = Classic
