const K = new Int32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
])

const W = new Int32Array(64), H = new Int32Array(8), tail = new Uint8Array(128)

function compress(bytes, offset) {
  for (let i = 0; i < 16; i++, offset += 4) {
    W[i] = bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]
  }
  for (let i = 16; i < 64; i++) {
    const a = W[i - 15], b = W[i - 2]
    W[i] = ((a >>> 7 | a << 25) ^ (a >>> 18 | a << 14) ^ a >>> 3) + W[i - 7] +
      ((b >>> 17 | b << 15) ^ (b >>> 19 | b << 13) ^ b >>> 10) + W[i - 16] | 0
  }
  let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
  for (let i = 0; i < 64; i++) {
    const t1 = h + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + (e & f ^ ~e & g) + K[i] + W[i] | 0
    const t2 = ((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + (a & b ^ a & c ^ b & c) | 0
    h = g; g = f; f = e; e = d + t1 | 0
    d = c; c = b; b = a; a = t1 + t2 | 0
  }
  H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
}

export function sha256(first, second) {
  H[0] = 0x6a09e667; H[1] = 0xbb67ae85; H[2] = 0x3c6ef372; H[3] = 0xa54ff53a
  H[4] = 0x510e527f; H[5] = 0x9b05688c; H[6] = 0x1f83d9ab; H[7] = 0x5be0cd19
  const length = first.byteLength + (second ? second.byteLength : 0)
  let pending = 0
  for (const bytes of second ? [first, second] : [first]) {
    let offset = 0
    if (pending > 0) {
      const take = Math.min(64 - pending, bytes.byteLength)
      tail.set(bytes.subarray(0, take), pending)
      pending += take
      offset = take
      if (pending < 64) continue
      compress(tail, 0)
      pending = 0
    }
    for (; offset + 64 <= bytes.byteLength; offset += 64) compress(bytes, offset)
    tail.set(bytes.subarray(offset), 0)
    pending = bytes.byteLength - offset
  }
  tail.fill(0, pending)
  tail[pending] = 0x80
  const end = pending < 56 ? 64 : 128, bits = length * 8, high = Math.floor(bits / 0x100000000)
  tail[end - 8] = high >>> 24
  tail[end - 7] = high >>> 16
  tail[end - 6] = high >>> 8
  tail[end - 5] = high
  tail[end - 4] = bits >>> 24
  tail[end - 3] = bits >>> 16
  tail[end - 2] = bits >>> 8
  tail[end - 1] = bits
  compress(tail, 0)
  if (end === 128) compress(tail, 64)
  const out = new Uint8Array(32)
  for (let i = 0; i < 8; i++) {
    out[4 * i] = H[i] >>> 24
    out[4 * i + 1] = H[i] >>> 16
    out[4 * i + 2] = H[i] >>> 8
    out[4 * i + 3] = H[i]
  }
  return out
}
