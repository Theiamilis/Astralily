import { defineConfig } from 'vite'
import path from 'path'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('.', import.meta.url))
const cubismCorePath = path.resolve(projectRoot, '../CubismSdkForWeb-5-r.5/Core/live2dcubismcore.min.js')

function live2dCoreAsset() {
  return {
    name: 'live2d-cubism-core-asset',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/live2d/live2dcubismcore.min.js') {
          next()
          return
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
          response.statusCode = 405
          response.end()
          return
        }

        response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
        response.setHeader('Cache-Control', 'no-cache')
        response.end(request.method === 'HEAD' ? undefined : readFileSync(cubismCorePath))
      })
    },
    closeBundle() {
      const destination = path.resolve(projectRoot, 'dist/live2d/live2dcubismcore.min.js')
      mkdirSync(path.dirname(destination), { recursive: true })
      copyFileSync(cubismCorePath, destination)
    },
  }
}


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

export default defineConfig({
  plugins: [
    figmaAssetResolver(),
    live2dCoreAsset(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
      '@framework': path.resolve(__dirname, '../CubismSdkForWeb-5-r.5/Framework/src'),
    },
  },
  server: {
    host: true,
    port: 5231,
  },

  build: {
    rollupOptions: {
      input: {
        app: path.resolve(projectRoot, 'index.html'),
        live2dStage: path.resolve(projectRoot, 'live2d-stage.html'),
      },
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
