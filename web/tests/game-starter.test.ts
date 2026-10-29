import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { STARTER_FILES, STARTER_INSTRUCTIONS, STARTER_NAME } from '../src/game-starter.js';
import { validateSourceFiles } from '../server/build-runner.js';
import { assemblePreview } from '../server/preview.js';

test('playable starter is a self-contained supported bundle with keyboard and touch controls', () => {
  const files = Object.fromEntries(STARTER_FILES.map(file => [file.path, file.content]));
  validateSourceFiles(files);
  assert.ok(STARTER_NAME && STARTER_INSTRUCTIONS.length === 3);
  assert.ok(Buffer.byteLength(JSON.stringify(files)) < 100000);
  const assembled = assemblePreview(files);
  assert.match(assembled, /<canvas/);
  assert.match(assembled, /data-direction="up"/);
  assert.match(assembled, /id="interact"/);
  assert.match(assembled, /PixelVillage/);
  assert.ok(!assembled.includes('src="game.js"'));
  assert.ok(!assembled.includes('href="style.css"'));
  assert.ok(!/https?:\/\//.test(assembled));
});

test('artifact gameplay tests execute real movement, collision, quest completion and reset', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pixel-starter-'));
  try {
    for (const file of STARTER_FILES) await writeFile(join(directory, file.path), file.content);
    const environment = {...process.env};
    delete environment.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'game.test.js'], {cwd: directory, env: environment, encoding: 'utf8', timeout: 10000});
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /# pass 3/);
    assert.match(result.stdout, /# fail 0/);
  } finally { await rm(directory, {recursive: true, force: true}); }
});
