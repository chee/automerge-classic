function defaultFactory() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

let factory = defaultFactory

function makeUuid() {
  return factory()
}

makeUuid.setFactory = newFactory => { factory = newFactory }
makeUuid.reset = () => { factory = defaultFactory }

export default makeUuid
