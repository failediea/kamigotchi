import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIdleState, renderWorkerDropin, renderWorkerEnv, parseWorkerEnv } from './worker-service-layout.mjs';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('migration refuses unknown, unfinished, retired or pending state', () => {
  for (const state of [{}, { jobs: { x: {} } }, { jobs: {}, retiredJobs: { x: { returned: false } } }, { jobs: {}, pendingTxs: { x: {} } }, { jobs: {}, ingestRetry: { event: {} } }]) assert.throws(() => assertIdleState(state));
  assertIdleState({ jobs: { x: { returned: true } }, reservations: { signed: { operatorPrivateKey: 'preserve' } } });
});

test('new environment preserves secrets but removes EVERY old mutable-path override', () => {
  const old = "KEEPER_PRIVATE_KEY='fixture-not-a-real-key'\r\nWORKER_STATE_FILE=/old\r\nWORKER_STATE_FILE=/other\nOPERATOR_RESERVATION_HOST=0.0.0.0\n";
  const env = parseWorkerEnv(renderWorkerEnv(old, '/var/lib/kami-lease/v16-musu'));
  assert.equal(env.KEEPER_PRIVATE_KEY, 'fixture-not-a-real-key');
  assert.equal(env.WORKER_STATE_FILE, '/var/lib/kami-lease/v16-musu/renter-pod-worker-state.json');
  assert.equal(env.OPERATOR_RESERVATION_HOST, '127.0.0.1');
  assert.equal((renderWorkerEnv(old, '/safe').match(/WORKER_STATE_FILE=/g) || []).length, 1);
});

test('non-root drop-in limits write access and clears old environment/start command', () => {
  const text = renderWorkerDropin({ stack: 'v16-musu', releaseDir: '/opt/kami-lease/releases/reviewed', nodeBin: '/opt/kami-lease/runtime/node-v22.23.4/bin/node' });
  for (const expected of ['User=kami-v16-musu', 'ProtectHome=yes', 'ProtectSystem=strict', 'NoNewPrivileges=yes', 'ExecStart=\n', 'EnvironmentFile=\n', 'UMask=0077']) assert.ok(text.includes(expected));
  assert.ok(!text.includes('MemoryDenyWriteExecute')); // V8 uses JIT memory
  assert.throws(() => renderWorkerDropin({ stack: 'v16-musu', releaseDir: '/opt/kami-lease/../root', nodeBin: '/bin/node' }));
});

test('installer dry-run resolves relative state/key paths against source and changes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kami-isolate-'));
  try {
    const text = 'YOMINET_RPC=https://rpc.invalid\nMARKET_ADDRESS=public\nRENTER_POD_FACTORY=public\nWORKER_STATE_FILE=./state.json\nRESERVATION_STATE_FILE=quotes.json\nWORKER_HALT_FILE=HALT\n';
    writeFileSync(join(dir, '.env'), text);
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ jobs: {} }));
    writeFileSync(join(dir, 'quotes.json'), '{}');
    writeFileSync(join(dir, 'quotes.journal'), 'preserve signed entries');
    writeFileSync(join(dir, 'HALT'), 'keep halted');
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('./install-isolated-worker.mjs', import.meta.url)), '--stack=v16-musu', `--source=${dir}`, '--release=/opt/kami-lease/releases/testfixture'], { encoding: 'utf8' });
    assert.match(out, /DRY RUN only/);
    assert.match(out, /renter-pod-worker-state.reservations.journal/);
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), text);
    assert.equal(readFileSync(join(dir, 'quotes.journal'), 'utf8'), 'preserve signed entries');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('release dry-run does not read or copy secret/state files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kami-release-'));
  try {
    for (const file of ['package.json', 'package-lock.json']) writeFileSync(join(dir, file), '{}');
    writeFileSync(join(dir, 'renter-pod-worker.mjs'), '// reviewed fixture');
    writeFileSync(join(dir, '.env'), 'SECRET_SENTINEL'); chmodSync(join(dir, '.env'), 0);
    writeFileSync(join(dir, 'renter-pod-worker-state.json'), 'SECRET_STATE_SENTINEL');
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('./stage-worker-release.mjs', import.meta.url)), '--id=testfixture', `--source=${dir}`, `--node-source=${process.execPath}`], { encoding: 'utf8' });
    assert.match(out, /DRY RUN/);
    assert.match(out, /"sourceFileCount": 3/);
    assert.doesNotMatch(out, /SECRET/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
