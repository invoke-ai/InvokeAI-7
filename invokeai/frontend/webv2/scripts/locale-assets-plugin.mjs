import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Keep source locales readable while serving compact JSON at their existing URLs. */
export const localeAssetsPlugin = ({ projectRoot }) => ({
  apply: 'build',
  name: 'invokeai-locale-assets',
  async generateBundle() {
    const directory = resolve(projectRoot, 'public/locales');
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        continue;
      }
      const source = await readFile(resolve(directory, entry.name), 'utf8');
      let parsed;
      try {
        parsed = JSON.parse(source);
      } catch (error) {
        throw new Error(`Invalid locale JSON: ${entry.name}`, { cause: error });
      }
      // Vite copies public files before generateBundle; this replaces only the emitted locale copy.
      this.emitFile({ type: 'asset', fileName: `locales/${entry.name}`, source: JSON.stringify(parsed) });
    }
  },
});
