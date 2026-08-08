import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*test*.{js,ts}'],
    setupFiles: process.env.WASM_BACKEND_PATH ? ['./test/wasm.js'] : []
  }
})
