import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react-swc'
import path from "path"

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  // Use root .env file for all environment variables
  envDir: '..',
  resolve: {
    alias: {
      "@/components": path.resolve(__dirname, "./src/shared/components"),
      "@/hooks": path.resolve(__dirname, "./src/shared/hooks"),
      "@/services": path.resolve(__dirname, "./src/shared/services"),
      "@/utils": path.resolve(__dirname, "./src/shared/utils"),
      "@": path.resolve(__dirname, "./src"),
    },
  },
  define: {
    global: 'globalThis',
    'process.env': 'import.meta.env',
    ...(mode === 'production' ? { 'import.meta.env.VITE_MOCK_MODE': JSON.stringify('false') } : {}),
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-query': ['@tanstack/react-query'],
          'vendor-auth': ['amazon-cognito-identity-js', 'libsodium-wrappers-sumo'],
          'vendor-ui': [
            '@radix-ui/react-alert-dialog', '@radix-ui/react-checkbox',
            '@radix-ui/react-dialog', '@radix-ui/react-label',
            '@radix-ui/react-popover', '@radix-ui/react-progress',
            '@radix-ui/react-scroll-area', '@radix-ui/react-select',
            '@radix-ui/react-separator', '@radix-ui/react-slot',
            '@radix-ui/react-tabs', '@radix-ui/react-toast',
            '@radix-ui/react-tooltip',
          ],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
        },
      },
    },
  },
  optimizeDeps: {
    include: ['amazon-cognito-identity-js']
  },
  test: {
    globals: true,
    environment: 'jsdom',
    css: true,
    include: ['src/**/*.test.{js,ts,tsx}'],
    exclude: ['**/node_modules/**'],
  },
}))
