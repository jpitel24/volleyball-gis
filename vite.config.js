import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    // Stamped at build time so the About page can show "Last updated …".
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
})
