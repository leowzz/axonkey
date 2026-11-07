import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  envPrefix: ['VITE_', 'TENCENT_RUM_ID'],
  clearScreen: false,
  build: {
    outDir: 'web-dist',
  },
  server: {
    // 1420 is currently in a Windows excluded TCP range on some developer machines.
    port: 3001,
    strictPort: true,
    watch: {
      // Tauri watches Rust sources; Vite must not watch locked compiler outputs.
      ignored: [/[\\/]src-tauri(?:[\\/]|$)/],
    },
    proxy: { '/api': { target: 'https://relay.wleo.cn', changeOrigin: true } },
  },
})
