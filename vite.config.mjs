import {defineConfig} from 'vite'

const targets = {
  umd: {entry: 'src/automerge.js', name: 'Automerge', formats: ['umd'], fileName: () => 'automerge.js'},
  esm: {entry: 'src/automerge.mjs', formats: ['es'], fileName: () => 'automerge.mjs'},
  classic: {entry: 'src/classic.mjs', formats: ['es'], fileName: () => 'classic.mjs'}
}

export default defineConfig(({mode}) => ({
  build: {
    outDir: 'dist',
    emptyOutDir: mode === 'umd',
    sourcemap: true,
    target: ['chrome87', 'edge88', 'firefox78', 'safari14'],
    lib: targets[mode]
  }
}))
