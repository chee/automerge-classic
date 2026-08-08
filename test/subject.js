const module_ = process.env.TEST_DIST === '1'
  ? await import('../dist/automerge.js')
  : await import('../src/automerge.js')

export default module_.default
