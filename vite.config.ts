import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  build: {
    outDir: 'web-dist',
  },
  server: {
    // 1420 is currently in a Windows excluded TCP range on some developer machines.
    port: 3001,
    strictPort: true,
  },
})
