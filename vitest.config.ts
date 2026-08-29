import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    css: false,
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'],
    server: {
      deps: {
        // Inline the SDK packages so `vi.mock` reaches the modules *they*
        // import. These used to be `file:` deps, which Vitest processed as
        // source, so mocking `nostr-tools/nip46` also intercepted the copy
        // Nip46Signer imports. Published packages are externalized by
        // default, which silently bypasses the mock and lets the NIP-46
        // handshake open a real WebSocket.
        // `vesta` ships TypeScript source, so it has to be inlined for
        // Vitest to transform it rather than hand it to Node as-is.
        inline: [/@nostr-wot\//, 'vesta'],
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Dedupe React across the symlinked SDK packages — without these,
      // `@nostr-wot/data/react` (loaded as raw TS via file: deps) imports
      // its own copy of React from nostr-wot-sdk/node_modules, breaking
      // hooks because the contexts/dispatchers are different instances.
      react: path.resolve(__dirname, './node_modules/react'),
      'react-dom': path.resolve(__dirname, './node_modules/react-dom'),
    },
  },
});
