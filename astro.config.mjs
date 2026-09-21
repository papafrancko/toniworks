// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://www.toniworks.dk',
  trailingSlash: 'never',
  build: { format: 'file' },
  prefetch: { prefetchAll: false, defaultStrategy: 'hover' },
  devToolbar: { enabled: false },
});
