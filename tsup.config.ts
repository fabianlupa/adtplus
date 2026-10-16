import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'cli/index': 'src/cli/index.ts',
    'mcp/server': 'src/mcp/server.ts',
    'daemon/server': 'src/daemon/server.ts',
    'git/main': 'src/git/main.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  clean: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
