import {defineConfig} from 'vite'

const targets = {
  esm: {entry: 'src/automerge.js', fileName: () => 'automerge.js'}
}

export default defineConfig(({mode}) => ({
  build: {
    outDir: 'dist',
    minify: 'terser',
    emptyOutDir: mode === 'esm',
    sourcemap: true,
    target: ['chrome87', 'edge88', 'firefox78', 'safari14'],
    lib: {formats: ['es'], ...targets[mode]}
  }
}))
