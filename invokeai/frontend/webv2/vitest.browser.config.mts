import { playwright } from '@vitest/browser-playwright';
import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';

import viteConfig from './vite.config.mts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    define: {
      __CANVAS_GOLDEN_UPDATE__: JSON.stringify(process.env.CANVAS_GOLDEN_UPDATE === '1'),
    },
    // Dependencies reached by browser tests must be prebundled into the initial
    // graph. Late optimization reloads invalidate active Vitest suites, and
    // React-bound dependencies can also leave two React instances in the graph
    // and produce invalid-hook failures.
    optimizeDeps: {
      include: [
        '@chakra-ui/react',
        '@chakra-ui/react/theme',
        '@dnd-kit/core',
        '@tanstack/react-query',
        '@tanstack/react-virtual',
        'i18next-http-backend',
        'react-hook-tanstack-virtual',
        'tinykeys',
      ],
    },
    test: {
      browser: {
        enabled: true,
        headless: true,
        instances: [{ browser: 'chromium' }],
        provider: playwright(),
      },
      include: ['src/**/*.browser.test.{ts,tsx}'],
    },
  })
);
