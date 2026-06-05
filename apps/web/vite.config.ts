import { vitePlugin as remix } from '@remix-run/dev'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [remix()],
  server: {
    port: parseInt(process.env.VITE_PORT || '4000', 10),
  },
})
