// Port of the zlib-rs 0.6.8 deflate compressor (Copyright the zlib-rs contributors, zlib licence).

const WSIZE = 32768, WMASK = 32767, WINDOW_SIZE = 65536, MAX_DIST = 32506, MIN_LOOKAHEAD = 262
const LIT_BUFSIZE = 16384, RUN_LENGTH = 1024, HEAP_SIZE = 573, L_CODES = 286, D_CODES = 30, BL_CODES = 19

const EXTRA_LBITS = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0])
const EXTRA_DBITS = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13])
const EXTRA_BLBITS = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 7])
const BL_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15])

const LENGTH_CODE = new Uint8Array(256), BASE_LENGTH = new Uint8Array(29)
const DIST_CODE = new Uint8Array(512), BASE_DIST = new Uint16Array(30)
for (let code = 0, length = 0; code < 28; code++) {
  BASE_LENGTH[code] = length
  for (let n = 0; n < 1 << EXTRA_LBITS[code]; n++) LENGTH_CODE[length++] = code
}
LENGTH_CODE[255] = 28
BASE_LENGTH[28] = 255
for (let code = 0, dist = 0; code < 16; code++) {
  BASE_DIST[code] = dist
  for (let n = 0; n < 1 << EXTRA_DBITS[code]; n++) DIST_CODE[dist++] = code
}
for (let code = 16, dist = 256 >> 7; code < D_CODES; code++) {
  BASE_DIST[code] = dist << 7
  for (let n = 0; n < 1 << (EXTRA_DBITS[code] - 7); n++) DIST_CODE[256 + dist++] = code
}

function reverse(code, len) {
  let result = 0
  for (let i = 0; i < len; i++, code >>= 1) result = (result << 1) | (code & 1)
  return result
}

function genCodes(codes, lens, maxCode, blCount) {
  const nextCode = new Uint16Array(16)
  for (let bits = 1, code = 0; bits <= 15; bits++) {
    code = (code + blCount[bits - 1]) << 1
    nextCode[bits] = code
  }
  for (let n = 0; n <= maxCode; n++) {
    const len = lens[n]
    if (len !== 0) codes[n] = reverse(nextCode[len]++, len)
  }
}

const STATIC_LCODE = new Uint16Array(288), STATIC_LLEN = new Uint16Array(288)
const STATIC_DCODE = new Uint16Array(D_CODES), STATIC_DLEN = new Uint16Array(D_CODES).fill(5)
STATIC_LLEN.fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288)
genCodes(STATIC_LCODE, STATIC_LLEN, 287, new Uint16Array([0, 0, 0, 0, 0, 0, 0, 24, 152, 112, 0, 0, 0, 0, 0, 0]))
for (let n = 0; n < D_CODES; n++) STATIC_DCODE[n] = reverse(n, 5)

const L_DESC = {freq: new Uint16Array(HEAP_SIZE), len: new Uint16Array(HEAP_SIZE), maxCode: 0,
  staticLen: STATIC_LLEN, extra: EXTRA_LBITS, extraBase: 257, elems: L_CODES, maxLength: 15}
const D_DESC = {freq: new Uint16Array(2 * D_CODES + 1), len: new Uint16Array(2 * D_CODES + 1), maxCode: 0,
  staticLen: STATIC_DLEN, extra: EXTRA_DBITS, extraBase: 0, elems: D_CODES, maxLength: 15}
const BL_DESC = {freq: new Uint16Array(2 * BL_CODES + 1), len: new Uint16Array(2 * BL_CODES + 1), maxCode: 0,
  staticLen: null, extra: EXTRA_BLBITS, extraBase: 0, elems: BL_CODES, maxLength: 7}

const HEAP = new Uint32Array(HEAP_SIZE), DEPTH = new Uint8Array(HEAP_SIZE), BL_COUNT = new Uint16Array(16)
let heapLen = 0, heapMax = 0, optLen = 0, staticLen = 0

function pqdownheap(freq, k) {
  const v = HEAP[k], vVal = (freq[v] << 8) | DEPTH[v]
  for (let j = k << 1; j <= heapLen; j <<= 1) {
    let jVal = (freq[HEAP[j]] << 8) | DEPTH[HEAP[j]]
    if (j < heapLen) {
      const j1Val = (freq[HEAP[j + 1]] << 8) | DEPTH[HEAP[j + 1]]
      if (j1Val <= jVal) { j++; jVal = j1Val }
    }
    if (vVal <= jVal) break
    HEAP[k] = HEAP[j]
    k = j
  }
  HEAP[k] = v
}

function buildTree(desc) {
  const {freq, len: lens, staticLen: stree, elems, extra, extraBase, maxLength} = desc
  let maxCode = -1
  heapLen = 0
  heapMax = HEAP_SIZE
  for (let n = 0; n < elems; n++) {
    if (freq[n] > 0) {
      HEAP[++heapLen] = n
      maxCode = n
      DEPTH[n] = 0
    } else {
      lens[n] = 0
    }
  }
  while (heapLen < 2) {
    const node = maxCode < 2 ? ++maxCode : 0
    HEAP[++heapLen] = node
    freq[node] = 1
    DEPTH[node] = 0
    optLen--
    if (stree) staticLen -= stree[node]
  }
  desc.maxCode = maxCode
  for (let n = heapLen >> 1; n >= 1; n--) pqdownheap(freq, n)

  let node = elems
  do {
    const n = HEAP[1]
    HEAP[1] = HEAP[heapLen--]
    pqdownheap(freq, 1)
    const m = HEAP[1]
    HEAP[--heapMax] = n
    HEAP[--heapMax] = m
    freq[node] = freq[n] + freq[m]
    DEPTH[node] = Math.max(DEPTH[n], DEPTH[m]) + 1
    lens[n] = node
    lens[m] = node
    HEAP[1] = node++
    pqdownheap(freq, 1)
  } while (heapLen >= 2)
  HEAP[--heapMax] = HEAP[1]

  BL_COUNT.fill(0)
  lens[HEAP[heapMax]] = 0
  let overflow = 0
  for (let h = heapMax + 1; h < HEAP_SIZE; h++) {
    const n = HEAP[h]
    let bits = lens[lens[n]] + 1
    if (bits > maxLength) { bits = maxLength; overflow++ }
    lens[n] = bits
    if (n > maxCode) continue
    BL_COUNT[bits]++
    const xbits = n >= extraBase ? extra[n - extraBase] : 0
    const f = freq[n]
    optLen += f * (bits + xbits)
    if (stree) staticLen += f * (stree[n] + xbits)
  }
  if (overflow > 0) {
    do {
      let bits = maxLength - 1
      while (BL_COUNT[bits] === 0) bits--
      BL_COUNT[bits]--
      BL_COUNT[bits + 1] += 2
      BL_COUNT[maxLength]--
      overflow -= 2
    } while (overflow > 0)
    for (let bits = maxLength, h = HEAP_SIZE; bits >= 1; bits--) {
      let n = BL_COUNT[bits]
      while (n !== 0) {
        const m = HEAP[--h]
        if (m > maxCode) continue
        if (lens[m] !== bits) {
          optLen = (optLen + ((bits * freq[m]) & 0xffff) - ((lens[m] * freq[m]) & 0xffff)) >>> 0
          lens[m] = bits
        }
        n--
      }
    }
  }
  genCodes(freq, lens, maxCode, BL_COUNT)
}

function scanTree(desc) {
  const lens = desc.len, maxCode = desc.maxCode, blFreq = BL_DESC.freq
  let prevlen = -1, nextlen = lens[0], count = 0, maxCount = 7, minCount = 4
  if (nextlen === 0) { maxCount = 138; minCount = 3 }
  lens[maxCode + 1] = 0xffff
  for (let n = 0; n <= maxCode; n++) {
    const curlen = nextlen
    nextlen = lens[n + 1]
    if (++count < maxCount && curlen === nextlen) continue
    if (count < minCount) blFreq[curlen] += count
    else if (curlen !== 0) {
      if (curlen !== prevlen) blFreq[curlen]++
      blFreq[16]++
    } else if (count <= 10) blFreq[17]++
    else blFreq[18]++
    count = 0
    prevlen = curlen
    maxCount = nextlen === 0 ? 138 : curlen === nextlen ? 6 : 7
    minCount = nextlen === 0 || curlen === nextlen ? 3 : 4
  }
}

const EMPTY = new Uint8Array(0)
let out = EMPTY, outPos = 0, bitBuf = 0, bitCount = 0

function sendBits(value, length) {
  bitBuf |= value << bitCount
  bitCount += length
  while (bitCount >= 8) {
    out[outPos++] = bitBuf
    bitBuf >>>= 8
    bitCount -= 8
  }
}

function sendTree(desc) {
  const lens = desc.len, maxCode = desc.maxCode, blCode = BL_DESC.freq, blLen = BL_DESC.len
  let prevlen = -1, nextlen = lens[0], count = 0, maxCount = 7, minCount = 4
  if (nextlen === 0) { maxCount = 138; minCount = 3 }
  for (let n = 0; n <= maxCode; n++) {
    const curlen = nextlen
    nextlen = lens[n + 1]
    if (++count < maxCount && curlen === nextlen) continue
    if (count < minCount) {
      do sendBits(blCode[curlen], blLen[curlen]); while (--count !== 0)
    } else if (curlen !== 0) {
      if (curlen !== prevlen) {
        sendBits(blCode[curlen], blLen[curlen])
        count--
      }
      sendBits(blCode[16], blLen[16])
      sendBits(count - 3, 2)
    } else if (count <= 10) {
      sendBits(blCode[17], blLen[17])
      sendBits(count - 3, 3)
    } else {
      sendBits(blCode[18], blLen[18])
      sendBits(count - 11, 7)
    }
    count = 0
    prevlen = curlen
    maxCount = nextlen === 0 ? 138 : curlen === nextlen ? 6 : 7
    minCount = nextlen === 0 || curlen === nextlen ? 3 : 4
  }
}

const SYM_DIST = new Uint16Array(LIT_BUFSIZE), SYM_LC = new Uint8Array(LIT_BUFSIZE)
let symCount = 0

function initBlock() {
  L_DESC.freq.fill(0, 0, L_CODES)
  D_DESC.freq.fill(0, 0, D_CODES)
  BL_DESC.freq.fill(0, 0, BL_CODES)
  L_DESC.freq[256] = 1
  optLen = 0
  staticLen = 0
  symCount = 0
}

function compressBlock(lcode, llen, dcode, dlen) {
  const o = out
  let buf = bitBuf, count = bitCount, pos = outPos
  for (let i = 0; i < symCount; i++) {
    let dist = SYM_DIST[i]
    const lc = SYM_LC[i]
    if (dist === 0) {
      buf |= lcode[lc] << count
      count += llen[lc]
    } else {
      const code = LENGTH_CODE[lc]
      buf |= lcode[code + 257] << count
      count += llen[code + 257]
      if (count >= 16) {
        o[pos++] = buf
        o[pos++] = buf >>> 8
        buf >>>= 16
        count -= 16
      }
      buf |= (lc - BASE_LENGTH[code]) << count
      count += EXTRA_LBITS[code]
      if (count >= 16) {
        o[pos++] = buf
        o[pos++] = buf >>> 8
        buf >>>= 16
        count -= 16
      }
      dist--
      const d = dist < 256 ? DIST_CODE[dist] : DIST_CODE[256 + (dist >> 7)]
      buf |= dcode[d] << count
      count += dlen[d]
      if (count >= 16) {
        o[pos++] = buf
        o[pos++] = buf >>> 8
        buf >>>= 16
        count -= 16
      }
      buf |= (dist - BASE_DIST[d]) << count
      count += EXTRA_DBITS[d]
    }
    if (count >= 16) {
      o[pos++] = buf
      o[pos++] = buf >>> 8
      buf >>>= 16
      count -= 16
    }
  }
  bitBuf = buf
  bitCount = count
  outPos = pos
  sendBits(lcode[256], llen[256])
}

function alignBits() {
  if (bitCount > 0) out[outPos++] = bitBuf
  bitBuf = 0
  bitCount = 0
}

const WINDOW = new Uint8Array(WINDOW_SIZE), VIEW = new DataView(WINDOW.buffer)
const HEAD = new Int32Array(65536), PREV = new Int32Array(WSIZE)
let input = null, consumed = 0, strstart = 0, lookahead = 0, blockStart = 0, matchStart = 0, hashBase = WINDOW_SIZE
let nextLen = 0, nextStart = 0, nextStr = 0, nextOrg = 0

function flushBlock(last) {
  const storedLen = strstart - blockStart
  if (out.length - outPos < storedLen + 6 * symCount + 1024) {
    const bigger = new Uint8Array(2 * out.length + storedLen + 6 * symCount + 1024)
    bigger.set(out.subarray(0, outPos))
    out = bigger
  }
  let optLenb = 0, staticLenb = 0, maxBlindex = 0
  if (symCount === 0) {
    staticLen = 7
  } else {
    buildTree(L_DESC)
    buildTree(D_DESC)
    scanTree(L_DESC)
    scanTree(D_DESC)
    buildTree(BL_DESC)
    for (maxBlindex = BL_CODES - 1; maxBlindex >= 3; maxBlindex--) {
      if (BL_DESC.len[BL_ORDER[maxBlindex]] !== 0) break
    }
    optLen = (optLen + 3 * (maxBlindex + 1) + 14) >>> 0
    optLenb = ((optLen + 10) >>> 0) >>> 3
    staticLenb = ((staticLen + 10) >>> 0) >>> 3
    if (staticLenb <= optLenb) optLenb = staticLenb
  }
  if (storedLen + 4 <= optLenb && blockStart >= 0) {
    sendBits(last ? 1 : 0, 3)
    alignBits()
    out[outPos++] = storedLen
    out[outPos++] = storedLen >> 8
    out[outPos++] = ~storedLen
    out[outPos++] = ~storedLen >> 8
    out.set(WINDOW.subarray(blockStart, strstart), outPos)
    outPos += storedLen
  } else if (staticLenb === optLenb) {
    sendBits(last ? 3 : 2, 3)
    compressBlock(STATIC_LCODE, STATIC_LLEN, STATIC_DCODE, STATIC_DLEN)
  } else {
    sendBits(last ? 5 : 4, 3)
    const lcodes = L_DESC.maxCode + 1, dcodes = D_DESC.maxCode + 1
    sendBits(lcodes - 257, 5)
    sendBits(dcodes - 1, 5)
    sendBits(maxBlindex - 3, 4)
    for (let rank = 0; rank <= maxBlindex; rank++) sendBits(BL_DESC.len[BL_ORDER[rank]], 3)
    sendTree(L_DESC)
    sendTree(D_DESC)
    compressBlock(L_DESC.freq, L_DESC.len, D_DESC.freq, D_DESC.len)
  }
  initBlock()
  if (last) alignBits()
  blockStart = strstart
}

function quickInsert(s, base) {
  const w = WINDOW
  const h = Math.imul(w[s] | (w[s + 1] << 8) | (w[s + 2] << 16) | (w[s + 3] << 24), -1640531535) >>> 16
  const head = HEAD[h]
  if (head !== s + base) {
    PREV[s & WMASK] = head
    HEAD[h] = s + base
  }
  return head - base
}

function insertString(s, count, base) {
  const w = WINDOW
  for (let end = s + count; s < end; s++) {
    const h = Math.imul(w[s] | (w[s + 1] << 8) | (w[s + 2] << 16) | (w[s + 3] << 24), -1640531535) >>> 16
    const head = HEAD[h]
    if (head !== s + base) {
      PREV[s & WMASK] = head
      HEAD[h] = s + base
    }
  }
}

function fillWindow() {
  do {
    let more = WINDOW_SIZE - lookahead - strstart
    if (strstart >= WSIZE + MAX_DIST) {
      WINDOW.copyWithin(0, WSIZE, WINDOW_SIZE)
      matchStart = matchStart >= WSIZE ? matchStart - WSIZE : 0
      strstart -= WSIZE
      blockStart -= WSIZE
      hashBase += WSIZE
      more += WSIZE
    }
    if (consumed === input.length) break
    const n = Math.min(input.length - consumed, more)
    WINDOW.set(input.subarray(consumed, consumed + n), strstart + lookahead)
    consumed += n
    lookahead += n
    if (lookahead >= 3 && strstart >= 1) quickInsert(strstart - 1, hashBase)
  } while (lookahead < MIN_LOOKAHEAD && consumed !== input.length)
}

function longestMatch(scan, curMatch, lookahead, base) {
  const w = WINDOW, v = VIEW, limit = Math.max(scan - MAX_DIST, 0)
  const scan0 = v.getInt32(scan, true), scan4 = v.getInt32(scan + 4, true)
  let bestLen = 2, offset = 1, end0 = 0, end4 = 0, chain = 128, start = matchStart
  for (;;) {
    if (curMatch >= scan) break
    let len = 0
    if (bestLen < 8) {
      for (;;) {
        let x = v.getInt32(curMatch, true) ^ scan0, k = 0
        if (x === 0) {
          x = v.getInt32(curMatch + 4, true) ^ scan4
          if (x === 0) break
          k = 4
        }
        k += (31 - Math.clz32(x & -x)) >> 3
        if (k > bestLen) {
          len = k
          break
        }
        if (--chain > 0) {
          curMatch = PREV[curMatch & WMASK] - base
          if (curMatch > limit) continue
        }
        matchStart = start
        return bestLen
      }
    } else {
      for (;;) {
        if (v.getInt32(curMatch + offset, true) === end0 && v.getInt32(curMatch + offset + 4, true) === end4 &&
            v.getInt32(curMatch, true) === scan0 && v.getInt32(curMatch + 4, true) === scan4) break
        if (--chain > 0) {
          curMatch = PREV[curMatch & WMASK] - base
          if (curMatch > limit) continue
        }
        matchStart = start
        return bestLen
      }
    }
    if (len === 0) {
      len = 2
      while (len <= 254 && v.getInt32(curMatch + len, true) === v.getInt32(scan + len, true)) len += 4
      while (len < 258 && w[curMatch + len] === w[scan + len]) len++
    }
    if (len > bestLen) {
      start = curMatch
      if (len >= lookahead) {
        matchStart = start
        return lookahead
      }
      bestLen = len
      if (bestLen >= 128) break
      offset = bestLen >= 8 ? bestLen - 7 : bestLen >= 4 ? bestLen - 3 : bestLen - 1
      end0 = v.getInt32(scan + offset, true)
      end4 = v.getInt32(scan + offset + 4, true)
    }
    if (--chain > 0) {
      curMatch = PREV[curMatch & WMASK] - base
      if (curMatch > limit) continue
    }
    break
  }
  matchStart = start
  return bestLen
}

function insertMatch(str, len, org, lookahead, base) {
  if (len < 4 || lookahead <= len + 4) return
  if (len <= 256) {
    const from = Math.max(str + 1, org)
    insertString(from, str + len - from, base)
  } else {
    quickInsert(str + len - 1, base)
  }
}

function run() {
  const w = WINDOW, lfreq = L_DESC.freq, dfreq = D_DESC.freq, b = hashBase, stop = strstart + RUN_LENGTH
  let scan = strstart, look = lookahead, syms = symCount
  let nLen = nextLen, nStart = nextStart, nStr = nextStr, nOrg = nextOrg
  do {
    let curLen, curStart, curStr, curOrg
    if (nLen > 0) {
      curLen = nLen
      curStart = nStart
      curStr = nStr
      curOrg = nOrg
      nLen = 0
    } else {
      const head = look >= 4 ? quickInsert(scan, b) : 0, dist = scan - head
      curStr = scan
      curOrg = scan
      if (dist <= MAX_DIST && dist > 0 && head > 0) {
        curLen = longestMatch(scan, head, look, b)
        curStart = matchStart
        if (curLen < 4 || curStart >= curStr) curLen = 1
      } else {
        curStart = 0
        curLen = 1
      }
    }

    insertMatch(curStr, curLen, curOrg, look, b)

    if (look > MIN_LOOKAHEAD && curStr + curLen < WINDOW_SIZE - MIN_LOOKAHEAD) {
      const next = curStr + curLen, head = quickInsert(next, b), dist = next - head
      nStr = next
      nOrg = next
      if (dist <= MAX_DIST && dist > 0 && head > 0) {
        nLen = longestMatch(next, head, look, b)
        nStart = matchStart
        if (nLen < 4 || nStart >= nStr) {
          nLen = 1
        } else if (curLen > 1 && curLen <= 1 + nStart && curLen <= 1 + nStr && w[nStart - curLen + 1] === w[nStr - curLen + 1]) {
          const limit = Math.max(nStr - MAX_DIST, 0), org = nStr + 1
          let c = curLen, s = nStr, m = nStart, l = nLen, i = nStart - 1, j = nStr - 1
          while (w[i--] === w[j--] && c >= 1 && s > limit && l < 256 && m > 1) {
            s--
            m--
            l++
            c--
          }
          if ((c !== curLen) & (c <= 1) & (l !== 2)) {
            curLen = c
            nStr = s
            nStart = m
            nLen = l
            nOrg = org
          }
        }
      } else {
        nStart = 0
        nLen = 1
      }
    } else {
      nLen = 0
    }

    if (curLen < 4) {
      for (let k = 0; k < curLen; k++) {
        const c = w[scan + k]
        SYM_DIST[syms] = 0
        SYM_LC[syms++] = c
        lfreq[c]++
      }
    } else {
      const dist = curStr - curStart - 1, len = curLen - 3
      SYM_DIST[syms] = dist + 1
      SYM_LC[syms++] = len
      lfreq[LENGTH_CODE[len] + 257]++
      dfreq[dist < 256 ? DIST_CODE[dist] : DIST_CODE[256 + (dist >> 7)]]++
    }
    look -= curLen
    scan += curLen
  } while (syms < LIT_BUFSIZE - 1 && look >= MIN_LOOKAHEAD && scan < stop)
  strstart = scan
  lookahead = look
  symCount = syms
  nextLen = nLen
  nextStart = nStart
  nextStr = nStr
  nextOrg = nOrg
  return syms >= LIT_BUFSIZE - 1
}

function readNext(r) {
  r.pos += r.size
  if (r.stage === 0) {
    r.stage = 1
    if (r.cap - r.len < 32) return setRead(r, 32, true)
  }
  if (r.stage === 1 && r.len === r.cap && r.cap === r.startCap) {
    r.stage = 2
    return setRead(r, 32, true)
  }
  if (r.len === r.cap) r.cap = Math.max(2 * r.cap, r.len + 32, 8)
  r.stage = 1
  setRead(r, Math.min(r.cap - r.len, r.max), false)
}

function setRead(r, size, probe) {
  r.size = size
  r.probe = probe
  r.end = r.pos + size
}

function readDone(r, n) {
  if (r.probe) {
    if (r.cap - r.len < n) r.cap = Math.max(2 * r.cap, r.len + n, 8)
  } else if (r.size >= r.max && n === r.size) {
    r.max *= 2
  }
  r.len += n
  r.size = n
}

function startReads(vec) {
  const r = {len: vec.len, cap: vec.cap, startCap: vec.cap, max: 8192, stage: 0, pos: 0, size: 0, end: 0, probe: false}
  readNext(r)
  return r
}

function readFull(r, pos) {
  while (pos >= r.end) {
    readDone(r, r.size)
    readNext(r)
  }
}

function readPartial(r, pos) {
  if (pos > r.pos) {
    readDone(r, pos - r.pos)
    readNext(r)
  }
}

function readRest(r, vec, length) {
  for (;;) {
    const n = Math.min(length - r.pos, r.size)
    readDone(r, n)
    if (n === 0) break
    readNext(r)
  }
  vec.len = r.len
  vec.cap = r.cap
}

function equalBytes(a, b) {
  if (a.length !== b.length) return false
  let i = 0
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const aWords = new Int32Array(a.buffer, a.byteOffset, a.length >> 2)
    const bWords = new Int32Array(b.buffer, b.byteOffset, b.length >> 2)
    while (i < aWords.length && aWords[i] === bWords[i]) i++
    if (i < aWords.length) return false
    i <<= 2
  }
  while (i < a.length && a[i] === b[i]) i++
  return i === a.length
}

function reuse(previous, vec) {
  const r = startReads(vec), {flushes, tail, tailPos} = previous
  let finishing = false
  for (let i = 0; i <= flushes.length; i++) {
    if (i === tail && !finishing) {
      finishing = true
      readPartial(r, tailPos)
    }
    if (i === flushes.length) break
    const {pos, reentry, pending, late} = flushes[i]
    const again = pos >= r.end
    if (pending && again !== reentry) return false
    if (again) {
      readFull(r, pos)
      finishing = late
    }
  }
  readRest(r, vec, previous.output.length)
  return true
}

function deflate(data, vec, previous) {
  if (previous && equalBytes(data, previous.data) && reuse(previous, vec)) return previous
  const r = startReads(vec), flushes = []
  input = data
  out = new Uint8Array(data.length + 6 * Math.ceil(data.length / 16000) + 64)
  consumed = 0
  strstart = 0
  lookahead = 0
  blockStart = 0
  matchStart = 0
  nextLen = 0
  outPos = 0
  bitBuf = 0
  bitCount = 0
  if (hashBase > 0x40000000) {
    HEAD.fill(0)
    PREV.fill(0)
    hashBase = WINDOW_SIZE
  }
  initBlock()
  let finishing = false, tail = -1, tailPos = 0
  for (;;) {
    if (lookahead < MIN_LOOKAHEAD) {
      fillWindow()
      if (lookahead < MIN_LOOKAHEAD && tail < 0) {
        tail = flushes.length
        tailPos = outPos
        if (!finishing) {
          finishing = true
          readPartial(r, outPos)
        }
      }
      if (lookahead === 0) break
      nextLen = 0
    }
    if (run()) {
      flushBlock(false)
      const reentry = outPos >= r.end, late = consumed === data.length
      flushes.push({pos: outPos, reentry, pending: nextLen > 0, late})
      if (reentry) {
        readFull(r, outPos)
        nextLen = 0
        finishing = late
      }
    }
  }
  flushBlock(true)
  const output = out.slice(0, outPos)
  input = null
  out = EMPTY
  hashBase += WINDOW_SIZE
  readRest(r, vec, outPos)
  return {data, output, flushes, tail, tailPos}
}

function extendVec(vec, n) {
  if (vec.cap - vec.len < n) vec.cap = Math.max(2 * vec.cap, vec.len + n, 8)
  vec.len += n
}

export { deflate, extendVec }
