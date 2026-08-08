const {execFileSync} = require('child_process')
const path = require('path')

const REPS = Number(process.env.BENCH_REPS || 5)
const bench = path.join(__dirname, 'bench.js')

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const workloads = process.argv.slice(2)
const all = {}
for (const impl of ['classic', 'modern']) {
  for (let rep = 0; rep < REPS; rep++) {
    const out = execFileSync('node', ['--expose-gc', bench, impl], {encoding: 'utf8', maxBuffer: 1 << 24})
    for (const [name, ms] of Object.entries(JSON.parse(out))) {
      if (workloads.length && !workloads.includes(name)) continue
      ;((all[name] ||= {})[impl] ||= []).push(ms)
    }
    process.stderr.write(`${impl} rep ${rep + 1}/${REPS}\n`)
  }
}

const rows = Object.entries(all).map(([name, byImpl]) => {
  const c = median(byImpl.classic), m = median(byImpl.modern)
  return {name, classic: c, modern: m, ratio: c / m}
})

const w = Math.max(...rows.map(r => r.name.length))
console.log(`${'workload'.padEnd(w)} | classic ms | modern ms | ratio`)
console.log(`${'-'.repeat(w)} | ---------: | --------: | ----:`)
for (const r of rows) {
  console.log(`${r.name.padEnd(w)} | ${r.classic.toFixed(1).padStart(10)} | ${r.modern.toFixed(1).padStart(9)} | ${r.ratio.toFixed(2)}x`)
}
require('fs').writeFileSync('/tmp/bench-raw.json', JSON.stringify(all, null, 2))
