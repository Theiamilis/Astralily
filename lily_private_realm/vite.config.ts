import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@framework': path.resolve(
        __dirname,
        '../CubismSdkForWeb-5-r.5/Framework/src'
      ),
    },
  },
  server: {
    host: true,
    port: 5230,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/static': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'index.html'),
        'live2d-stage': path.resolve(__dirname, 'live2d-stage.html'),
      },
    },
  },
})
