// Myers' diff algorithm, ported from the Rust implementation in
// automerge/rust/automerge/src/text_diff (itself derived from the `similar`
// crate) so that updateText() generates exactly the same splice operations as
// the Rust implementation.

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter(undefined, {granularity: 'grapheme'}) : null

/**
 * Splits a string into extended grapheme clusters, matching the segmentation
 * used by the Rust implementation.
 */
function graphemes(string) {
  if (segmenter) {
    const result = []
    for (const item of segmenter.segment(string)) result.push(item.segment)
    return result
  }
  return [...string]
}

function commonPrefixLen(old, oldStart, oldEnd, next, newStart, newEnd, eq) {
  const max = Math.min(oldEnd - oldStart, newEnd - newStart)
  let length = 0
  while (length < max && eq(old[oldStart + length], next[newStart + length])) length++
  return length
}

function commonSuffixLen(old, oldStart, oldEnd, next, newStart, newEnd, eq) {
  const max = Math.min(oldEnd - oldStart, newEnd - newStart)
  let length = 0
  while (length < max && eq(old[oldEnd - length - 1], next[newEnd - length - 1])) length++
  return length
}

function maxD(len1, len2) {
  return Math.ceil((len1 + len2) / 2) + 1
}

function makeV(max) {
  return {offset: max, v: new Array(2 * max).fill(0)}
}

function findMiddleSnake(old, oldStart, oldEnd, next, newStart, newEnd, vf, vb, eq) {
  const n = oldEnd - oldStart, m = newEnd - newStart
  const delta = n - m
  const odd = (delta & 1) === 1
  vf.v[1 + vf.offset] = 0
  vb.v[1 + vb.offset] = 0
  const dMax = maxD(n, m)
  for (let d = 0; d < dMax; d++) {
    for (let k = d; k >= -d; k -= 2) {
      let x
      if (k === -d || (k !== d && vf.v[k - 1 + vf.offset] < vf.v[k + 1 + vf.offset])) {
        x = vf.v[k + 1 + vf.offset]
      } else {
        x = vf.v[k - 1 + vf.offset] + 1
      }
      const y = x - k
      const x0 = x, y0 = y
      if (x < n && y < m) {
        x += commonPrefixLen(old, oldStart + x, oldEnd, next, newStart + y, newEnd, eq)
      }
      vf.v[k + vf.offset] = x
      if (odd && Math.abs(k - delta) <= d - 1) {
        if (vf.v[k + vf.offset] + vb.v[-(k - delta) + vb.offset] >= n) {
          return [x0 + oldStart, y0 + newStart]
        }
      }
    }
    for (let k = d; k >= -d; k -= 2) {
      let x
      if (k === -d || (k !== d && vb.v[k - 1 + vb.offset] < vb.v[k + 1 + vb.offset])) {
        x = vb.v[k + 1 + vb.offset]
      } else {
        x = vb.v[k - 1 + vb.offset] + 1
      }
      let y = x - k
      if (x < n && y < m) {
        const advance = commonSuffixLen(old, oldStart, oldStart + n - x, next, newStart, newStart + m - y, eq)
        x += advance
        y += advance
      }
      vb.v[k + vb.offset] = x
      if (!odd && Math.abs(k - delta) <= d) {
        if (vb.v[k + vb.offset] + vf.v[-(k - delta) + vf.offset] >= n) {
          return [n - x + oldStart, m - y + newStart]
        }
      }
    }
  }
  return null
}

function conquer(hook, old, oldStart, oldEnd, next, newStart, newEnd, vf, vb, eq) {
  const prefixLen = commonPrefixLen(old, oldStart, oldEnd, next, newStart, newEnd, eq)
  if (prefixLen > 0) hook.equal(oldStart, newStart, prefixLen)
  oldStart += prefixLen
  newStart += prefixLen

  const suffixLen = commonSuffixLen(old, oldStart, oldEnd, next, newStart, newEnd, eq)
  const suffixOld = oldEnd - suffixLen, suffixNew = newEnd - suffixLen
  oldEnd -= suffixLen
  newEnd -= suffixLen

  if (oldStart >= oldEnd && newStart >= newEnd) {
    // Do nothing
  } else if (newStart >= newEnd) {
    hook.delete(oldStart, oldEnd - oldStart, newStart)
  } else if (oldStart >= oldEnd) {
    hook.insert(oldStart, newStart, newEnd - newStart)
  } else {
    const snake = findMiddleSnake(old, oldStart, oldEnd, next, newStart, newEnd, vf, vb, eq)
    if (snake) {
      const [xStart, yStart] = snake
      conquer(hook, old, oldStart, xStart, next, newStart, yStart, vf, vb, eq)
      conquer(hook, old, xStart, oldEnd, next, yStart, newEnd, vf, vb, eq)
    } else {
      hook.delete(oldStart, oldEnd - oldStart, newStart)
      hook.insert(oldStart, newStart, newEnd - newStart)
    }
  }

  if (suffixLen > 0) hook.equal(suffixOld, suffixNew, suffixLen)
}

/**
 * Diffs the grapheme arrays `old` and `next`, calling `hook.equal(oldIndex,
 * newIndex, len)`, `hook.delete(oldIndex, oldLen, newIndex)`, and
 * `hook.insert(oldIndex, newIndex, newLen)` with the edits in document order.
 */
function myersDiff(hook, old, next, eq = (left, right) => left === right) {
  const max = maxD(old.length, next.length)
  const vf = makeV(max), vb = makeV(max)
  conquer(hook, old, 0, old.length, next, 0, next.length, vf, vb, eq)
  if (hook.finish) hook.finish()
}

/**
 * Wraps a diff hook, combining runs of deletions and insertions into maximal
 * blocks and turning a deletion followed by an insertion into a single
 * `replace(oldIndex, oldLen, newIndex, newLen)` call. Ported from the same
 * Rust code (originally the `similar` crate).
 */
function replaceHook(hook) {
  let del = null, ins = null, eq = null
  function flushEq() {
    if (eq) {
      hook.equal(eq[0], eq[1], eq[2])
      eq = null
    }
  }
  function flushDelIns() {
    if (del) {
      if (ins) {
        hook.replace(del[0], del[1], ins[1], ins[2])
        ins = null
      } else {
        hook.delete(del[0], del[1], del[2])
      }
      del = null
    } else if (ins) {
      hook.insert(ins[0], ins[1], ins[2])
      ins = null
    }
  }
  return {
    equal(oldIndex, newIndex, len) {
      flushDelIns()
      eq = eq ? [eq[0], eq[1], eq[2] + len] : [oldIndex, newIndex, len]
    },
    delete(oldIndex, oldLen, newIndex) {
      flushEq()
      del = del ? [del[0], del[1] + oldLen, del[2]] : [oldIndex, oldLen, newIndex]
    },
    insert(oldIndex, newIndex, newLen) {
      flushEq()
      ins = ins ? [ins[0], ins[1], ins[2] + newLen] : [oldIndex, newIndex, newLen]
    },
    finish() {
      flushEq()
      flushDelIns()
    }
  }
}

module.exports = { myersDiff, graphemes, replaceHook }
