// Port of the DEFLATE compressor from fflate 0.8 (MIT License, Copyright (c) 2023 Arjun Barrett),
// producing byte-identical output to its deflateSync at the default level.
const LENGTH_EXTRA_BITS = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0])
const DISTANCE_EXTRA_BITS = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0])
const CODE_LENGTH_ORDER = new Uint8Array([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15])

function symbolIndex(extraBits, start) {
  const base = new Uint16Array(31)
  for (let i = 0; i < 31; i++) {
    start += 1 << (i === 0 ? 0 : extraBits[i - 1])
    base[i] = start
  }
  const index = new Int32Array(base[30])
  for (let i = 1; i < 30; i++) {
    for (let j = base[i]; j < base[i + 1]; j++) index[j] = ((j - base[i]) << 5) | i
  }
  return index
}

const LENGTH_INDEX = symbolIndex(LENGTH_EXTRA_BITS, 2)
LENGTH_INDEX[258] = 28
const DISTANCE_INDEX = symbolIndex(DISTANCE_EXTRA_BITS, 0)

const REVERSED = new Uint16Array(32768)
for (let i = 0; i < 32768; i++) {
  let x = ((i & 0xAAAA) >> 1) | ((i & 0x5555) << 1)
  x = ((x & 0xCCCC) >> 2) | ((x & 0x3333) << 2)
  x = ((x & 0xF0F0) >> 4) | ((x & 0x0F0F) << 4)
  REVERSED[i] = (((x & 0xFF00) >> 8) | ((x & 0x00FF) << 8)) >> 1
}

function huffmanCodes(lengths, maxBits) {
  const counts = new Uint16Array(maxBits), next = new Uint16Array(maxBits)
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) counts[lengths[i] - 1]++
  for (let i = 1; i < maxBits; i++) next[i] = (next[i - 1] + counts[i - 1]) << 1
  const codes = new Uint16Array(lengths.length)
  for (let i = 0; i < lengths.length; i++) {
    if (lengths[i]) codes[i] = REVERSED[next[lengths[i] - 1]++] >> (15 - lengths[i])
  }
  return codes
}

const FIXED_LENGTHS = new Uint8Array(288)
for (let i = 0; i < 288; i++) FIXED_LENGTHS[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8
const FIXED_DISTANCES = new Uint8Array(32).fill(5)
const FIXED_LENGTH_CODES = huffmanCodes(FIXED_LENGTHS, 9)
const FIXED_DISTANCE_CODES = huffmanCodes(FIXED_DISTANCES, 5)

function writeBits(out, pos, value) {
  value <<= pos & 7
  const o = (pos / 8) | 0
  out[o] |= value
  out[o + 1] |= value >> 8
}

function writeBits16(out, pos, value) {
  value <<= pos & 7
  const o = (pos / 8) | 0
  out[o] |= value
  out[o + 1] |= value >> 8
  out[o + 2] |= value >> 16
}

function treeDepths(node, depths, depth) {
  return node.s === -1
    ? Math.max(treeDepths(node.l, depths, depth + 1), treeDepths(node.r, depths, depth + 1))
    : (depths[node.s] = depth)
}

function codeLengths(freqs, maxBits) {
  const t = []
  for (let i = 0; i < freqs.length; i++) if (freqs[i]) t.push({s: i, f: freqs[i]})
  const s = t.length, t2 = t.slice()
  if (s === 0) return {t: new Uint8Array(0), l: 0}
  if (s === 1) {
    const v = new Uint8Array(t[0].s + 1)
    v[t[0].s] = 1
    return {t: v, l: 1}
  }
  t.sort((a, b) => a.f - b.f)
  t.push({s: -1, f: 25001})
  let l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2
  t[0] = {s: -1, f: l.f + r.f, l, r}
  while (i1 !== s - 1) {
    l = t[t[i0].f < t[i2].f ? i0++ : i2++]
    r = t[i0 !== i1 && t[i0].f < t[i2].f ? i0++ : i2++]
    t[i1++] = {s: -1, f: l.f + r.f, l, r}
  }
  let maxSym = t2[0].s
  for (let i = 1; i < s; i++) if (t2[i].s > maxSym) maxSym = t2[i].s
  const tr = new Uint16Array(maxSym + 1)
  let mbt = treeDepths(t[i1 - 1], tr, 0)
  if (mbt > maxBits) {
    let i = 0, dt = 0
    const lft = mbt - maxBits, cst = 1 << lft
    t2.sort((a, b) => tr[b.s] - tr[a.s] || a.f - b.f)
    for (; i < s; i++) {
      const sym = t2[i].s
      if (tr[sym] > maxBits) {
        dt += cst - (1 << (mbt - tr[sym]))
        tr[sym] = maxBits
      } else break
    }
    dt >>= lft
    while (dt > 0) {
      const sym = t2[i].s
      if (tr[sym] < maxBits) dt -= 1 << (maxBits - tr[sym]++ - 1)
      else i++
    }
    for (; i >= 0 && dt; i--) {
      const sym = t2[i].s
      if (tr[sym] === maxBits) {
        tr[sym]--
        dt++
      }
    }
    mbt = maxBits
  }
  return {t: new Uint8Array(tr), l: mbt}
}

function runLengths(c) {
  let s = c.length
  while (s && !c[--s]);
  const cl = new Uint16Array(++s)
  let cli = 0, cln = c[0], cls = 1
  for (let i = 1; i <= s; i++) {
    if (c[i] === cln && i !== s) {
      cls++
    } else {
      if (!cln && cls > 2) {
        for (; cls > 138; cls -= 138) cl[cli++] = 32754
        if (cls > 2) {
          cl[cli++] = cls > 10 ? ((cls - 11) << 5) | 28690 : ((cls - 3) << 5) | 12305
          cls = 0
        }
      } else if (cls > 3) {
        cl[cli++] = cln
        cls--
        for (; cls > 6; cls -= 6) cl[cli++] = 8304
        if (cls > 2) {
          cl[cli++] = ((cls - 3) << 5) | 8208
          cls = 0
        }
      }
      while (cls--) cl[cli++] = cln
      cls = 1
      cln = c[i]
    }
  }
  return {c: cl.subarray(0, cli), n: s}
}

function encodedLength(freqs, lengths) {
  let l = 0
  for (let i = 0; i < lengths.length; i++) l += freqs[i] * lengths[i]
  return l
}

function writeStoredBlock(out, pos, data) {
  const s = data.length, o = ((pos + 2 + 7) / 8) | 0
  out[o] = s & 255
  out[o + 1] = s >> 8
  out[o + 2] = out[o] ^ 255
  out[o + 3] = out[o + 1] ^ 255
  out.set(data, o + 4)
  return (o + 4 + s) * 8
}

function writeBlock(data, out, final, syms, lf, df, eb, li, bs, bl, p) {
  writeBits(out, p++, final)
  lf[256]++
  const {t: dlt, l: mlb} = codeLengths(lf, 15), {t: ddt, l: mdb} = codeLengths(df, 15)
  const {c: lclt, n: nlc} = runLengths(dlt), {c: lcdt, n: ndc} = runLengths(ddt)
  const lcfreq = new Uint16Array(19)
  for (let i = 0; i < lclt.length; i++) lcfreq[lclt[i] & 31]++
  for (let i = 0; i < lcdt.length; i++) lcfreq[lcdt[i] & 31]++
  const {t: lct, l: mlcb} = codeLengths(lcfreq, 7)
  let nlcc = 19
  while (nlcc > 4 && !lct[CODE_LENGTH_ORDER[nlcc - 1]]) nlcc--
  const flen = (bl + 5) << 3
  const ftlen = encodedLength(lf, FIXED_LENGTHS) + encodedLength(df, FIXED_DISTANCES) + eb
  const dtlen = encodedLength(lf, dlt) + encodedLength(df, ddt) + eb + 14 + 3 * nlcc +
    encodedLength(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18]
  if (bs >= 0 && flen <= ftlen && flen <= dtlen) return writeStoredBlock(out, p, data.subarray(bs, bs + bl))
  let lm, ll, dm, dl
  writeBits(out, p, 1 + (dtlen < ftlen))
  p += 2
  if (dtlen < ftlen) {
    lm = huffmanCodes(dlt, mlb)
    ll = dlt
    dm = huffmanCodes(ddt, mdb)
    dl = ddt
    const llm = huffmanCodes(lct, mlcb)
    writeBits(out, p, nlc - 257)
    writeBits(out, p + 5, ndc - 1)
    writeBits(out, p + 10, nlcc - 4)
    p += 14
    for (let i = 0; i < nlcc; i++) writeBits(out, p + 3 * i, lct[CODE_LENGTH_ORDER[i]])
    p += 3 * nlcc
    for (const clct of [lclt, lcdt]) {
      for (let i = 0; i < clct.length; i++) {
        const len = clct[i] & 31
        writeBits(out, p, llm[len])
        p += lct[len]
        if (len > 15) {
          writeBits(out, p, (clct[i] >> 5) & 127)
          p += clct[i] >> 12
        }
      }
    }
  } else {
    lm = FIXED_LENGTH_CODES
    ll = FIXED_LENGTHS
    dm = FIXED_DISTANCE_CODES
    dl = FIXED_DISTANCES
  }
  for (let i = 0; i < li; i++) {
    const sym = syms[i]
    if (sym > 255) {
      const len = (sym >> 18) & 31
      writeBits16(out, p, lm[len + 257])
      p += ll[len + 257]
      if (len > 7) {
        writeBits(out, p, (sym >> 23) & 31)
        p += LENGTH_EXTRA_BITS[len]
      }
      const dst = sym & 31
      writeBits16(out, p, dm[dst])
      p += dl[dst]
      if (dst > 3) {
        writeBits16(out, p, (sym >> 5) & 8191)
        p += DISTANCE_EXTRA_BITS[dst]
      }
    } else {
      writeBits16(out, p, lm[sym])
      p += ll[sym]
    }
  }
  writeBits16(out, p, lm[256])
  return p + ll[256]
}

function findMatch(data, prev, i, imod, pimod, dif, maxd, ml, maxn) {
  let l = 2, d = 0, chain = 128
  while (dif <= maxd && --chain && imod !== pimod) {
    if (data[i + l] === data[i + l - dif]) {
      let nl = 0
      while (nl < ml && data[i + nl] === data[i + nl - dif]) nl++
      if (nl > l) {
        l = nl
        d = dif
        if (nl > maxn) break
        const mmd = Math.min(dif, nl - 2)
        let md = 0
        for (let j = 0; j < mmd; j++) {
          const ti = i - dif + j & 32767, cd = ti - prev[ti] & 32767
          if (cd > md) {
            md = cd
            pimod = ti
          }
        }
      }
    }
    imod = pimod
    pimod = prev[imod]
    dif += imod - pimod & 32767
  }
  return d ? (l << 15) | d : 0
}

function insertHashes(data, prev, head, end, mask, shift1, shift2) {
  for (let j = 0; j < end; j++) {
    const hv = (data[j] ^ (data[j + 1] << shift1) ^ (data[j + 2] << shift2)) & mask
    prev[j & 32767] = head[hv]
    head[hv] = j & 32767
  }
}

function compressRange(z, end) {
  const {data, prev, head, syms, lf, df, mask, shift1, shift2} = z, s = data.length
  let {i, lc, eb, li, wi} = z
  for (; i < end; i++) {
    if (wi <= i && (lc > 7000 | li > 24576) & s - i > 423) break
    const hv = (data[i] ^ (data[i + 1] << shift1) ^ (data[i + 2] << shift2)) & mask
    const imod = i & 32767, pimod = head[hv]
    prev[imod] = pimod
    head[hv] = imod
    if (wi > i) continue
    const rem = s - i
    const dif = imod - pimod & 32767, k = i - dif
    const match = hv === ((data[k] ^ (data[k + 1] << shift1) ^ (data[k + 2] << shift2)) & mask)
      ? findMatch(data, prev, i, imod, pimod, dif, Math.min(32767, i), Math.min(258, rem), Math.min(128, rem) - 1) : 0
    if (match) {
      const l = match >> 15, d = match & 32767
      syms[li++] = 268435456 | (LENGTH_INDEX[l] << 18) | DISTANCE_INDEX[d]
      const lin = LENGTH_INDEX[l] & 31, din = DISTANCE_INDEX[d] & 31
      eb += LENGTH_EXTRA_BITS[lin] + DISTANCE_EXTRA_BITS[din]
      lf[257 + lin]++
      df[din]++
      wi = i + l
      lc++
    } else {
      syms[li++] = data[i]
      lf[data[i]]++
    }
  }
  Object.assign(z, {i, lc, eb, li, wi})
}

function compress(data, bits, checkpoints, previousOutput) {
  const s = data.length, mask = (1 << bits) - 1, shift1 = Math.ceil(bits / 3)
  const z = {
    data, mask, shift1, shift2: 2 * shift1, checkpoints,
    out: new Uint8Array(s + 5 * (1 + Math.ceil(s / 7000))),
    prev: new Uint16Array(32768), head: new Uint16Array(mask + 1),
    syms: new Int32Array(25000), lf: new Uint16Array(288), df: new Uint16Array(32),
    i: 0, pos: 0, lc: 0, eb: 0, li: 0, wi: 0, bs: 0
  }
  if (checkpoints.length > 0) {
    const {i, pos} = checkpoints[checkpoints.length - 1]
    z.out.set(previousOutput.subarray(0, (pos + 7) >> 3))
    if (pos & 7) z.out[pos >> 3] &= (1 << (pos & 7)) - 1
    insertHashes(data, z.prev, z.head, i, mask, shift1, z.shift2)
    Object.assign(z, {i, pos, wi: i, bs: i})
  }
  while (z.i + 2 < s) {
    compressRange(z, Math.min(z.i + 4096, s - 2))
    if (z.wi <= z.i && (z.lc > 7000 || z.li > 24576) && s - z.i > 423 && z.i + 2 < s) {
      z.pos = writeBlock(data, z.out, 0, z.syms, z.lf, z.df, z.eb, z.li, z.bs, z.i - z.bs, z.pos)
      checkpoints.push({i: z.i, pos: z.pos})
      Object.assign(z, {li: 0, lc: 0, eb: 0})
      z.bs = z.i
      z.lf.fill(0, 0, 286)
      z.df.fill(0, 0, 30)
    }
  }
  const {syms, lf} = z
  let {i, li} = z
  for (i = Math.max(i, z.wi); i < s; i++) {
    syms[li++] = data[i]
    lf[data[i]]++
  }
  const pos = writeBlock(data, z.out, 1, syms, lf, z.df, z.eb, li, z.bs, i - z.bs, z.pos)
  return {data, bits, checkpoints, output: z.out.slice(0, (pos + 7) >> 3)}
}

function deflate(data, previous) {
  const bits = Math.ceil(Math.max(8, Math.min(13, Math.log(data.length))) * 1.5)
  if (!previous || previous.bits !== bits) return compress(data, bits, [], null)
  const limit = Math.min(data.length, previous.data.length)
  let common = 0
  if (data.byteOffset % 4 === 0 && previous.data.byteOffset % 4 === 0) {
    const words = new Int32Array(data.buffer, data.byteOffset, limit >> 2)
    const previousWords = new Int32Array(previous.data.buffer, previous.data.byteOffset, limit >> 2)
    while (common < words.length && words[common] === previousWords[common]) common++
    common <<= 2
  }
  while (common < limit && previous.data[common] === data[common]) common++
  if (common === data.length && common === previous.data.length) return previous
  const checkpoints = previous.checkpoints.filter(({i}) => i + 258 <= common && i + 424 <= limit)
  return compress(data, bits, checkpoints, previous.output)
}

export { deflate }
