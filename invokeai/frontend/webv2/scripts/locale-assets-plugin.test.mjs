import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { build } from 'vite';

import { localeAssetsPlugin } from './locale-assets-plugin.mjs';

const createFixture = async (context) => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'invokeai-locale-build-'));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(resolve(projectRoot, 'public/locales'), { recursive: true });
  await writeFile(
    resolve(projectRoot, 'index.html'),
    '<html><body><script type="module" src="/main.js"></script></body></html>'
  );
  await writeFile(resolve(projectRoot, 'main.js'), 'document.body.dataset.ready = "true";');
  return projectRoot;
};

const buildFixture = (projectRoot) =>
  build({
    root: projectRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [localeAssetsPlugin({ projectRoot })],
  });

test('production locale assets replace public copies without changing Unicode, values, or source files', async (context) => {
  const projectRoot = await createFixture(context);
  const translations = {
    settings: { title: '設定 🎨', description: 'Réglages — العربية', escaped: 'Line one\n"Line two"\\' },
    list: ['中文', '{{count}} settings', ''],
    enabled: true,
    count: 42,
    optional: null,
  };
  const formatted = `${JSON.stringify(translations, null, 2)}\n`;
  await writeFile(resolve(projectRoot, 'public/locales/en.json'), formatted);
  await writeFile(resolve(projectRoot, 'public/locales/ja.json'), formatted);
  await writeFile(resolve(projectRoot, 'public/keep.txt'), '  Keep public whitespace.\n');

  await buildFixture(projectRoot);

  for (const language of ['en', 'ja']) {
    const built = await readFile(resolve(projectRoot, `dist/locales/${language}.json`), 'utf8');
    assert.deepEqual(JSON.parse(built), translations);
    assert.equal(built, JSON.stringify(translations));
    assert.ok(Buffer.byteLength(built) < Buffer.byteLength(formatted));
    assert.equal(await readFile(resolve(projectRoot, `public/locales/${language}.json`), 'utf8'), formatted);
  }
  assert.equal(await readFile(resolve(projectRoot, 'dist/keep.txt'), 'utf8'), '  Keep public whitespace.\n');
});

test('invalid locale JSON fails the production build with the failing filename', async (context) => {
  const projectRoot = await createFixture(context);
  await writeFile(resolve(projectRoot, 'public/locales/broken.json'), '{ invalid');

  await assert.rejects(buildFixture(projectRoot), /Invalid locale JSON: broken\.json/);
});
