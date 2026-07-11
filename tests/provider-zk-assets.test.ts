import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { preflightZkConfigAssets } from '../scripts/shared/midnight.js';

const temporaryDirectories: string[] = [];

function createZkAssetDirectory(circuitId: string, omittedExtension?: string) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dareu-zk-assets-'));
  temporaryDirectories.push(directory);
  fs.mkdirSync(path.join(directory, 'keys'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'zkir'), { recursive: true });

  for (const [subdirectory, extension] of [
    ['keys', '.prover'],
    ['keys', '.verifier'],
    ['zkir', '.bzkir'],
  ] as const) {
    if (extension === omittedExtension) continue;
    fs.writeFileSync(path.join(directory, subdirectory, `${circuitId}${extension}`), new Uint8Array([1]));
  }

  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('ZK asset provider preflight', () => {
  it('accepts a circuit only when prover, verifier, and bzkir files are readable', async () => {
    const directory = createZkAssetDirectory('register_asset');

    const provider = await preflightZkConfigAssets(directory, ['register_asset']);

    assert.equal(provider.directory, directory);
    assert.deepEqual(Array.from(await provider.getZKIR('register_asset')), [1]);
  });

  it('reports the circuit and asset directory before a missing IR reaches /check', async () => {
    const directory = createZkAssetDirectory('register_asset', '.bzkir');

    await assert.rejects(
      preflightZkConfigAssets(directory, ['register_asset']),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /ZK asset preflight failed for circuit "register_asset"/);
        assert.match(error.message, new RegExp(directory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(error.message, /zkir\/<circuit>\.bzkir/);
        return true;
      },
    );
  });

  it('rejects a wrong contract directory even when it contains a same-named circuit', async () => {
    const directory = createZkAssetDirectory('create_market');

    await assert.rejects(
      preflightZkConfigAssets(directory, ['deposit', 'create_market']),
      /ZK asset preflight failed for circuit "deposit"/,
    );
  });
});
