import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cspHeader, enterpriseSecurityHeaders } from './src/enterprise/security/headers'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 650,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
        },
      },
    },
  },
  preview: {
    headers: {
      ...enterpriseSecurityHeaders,
      'Content-Security-Policy': cspHeader,
    },
  },
  server: {
    headers: {
      ...enterpriseSecurityHeaders,
      'Content-Security-Policy': cspHeader,
    },
  },
})
