import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

for (const name of ['add-pod.sh', 'diag-pod-deploy.sh', 'deploy-vipp-stack.mjs', 'provision-pool.mjs']) {
  test(`${name} cannot deploy, even with apply-looking arguments`, () => {
    const path = fileURLToPath(new URL(name, import.meta.url));
    for (const args of [[], ['--apply'], ['29', 'label', 'name'], ['pool-spec.json']]) {
      const result = spawnSync(name.endsWith('.sh') ? '/bin/bash' : process.execPath, [path, ...args], {
        cwd: '/tmp', encoding: 'utf8', env: {}, timeout: 5000,
      });
      assert.equal(result.status, 2);
      assert.match(result.stderr, /RETIRED/);
      assert.match(result.stderr, /No environment was loaded, key generated, or transaction sent/);
      assert.equal(result.stdout, '');
    }
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /--broadcast|--skip-simulation|--private-key|spawnSync|execSync|readFileSync|source \.\/\.env/);
  });
}
