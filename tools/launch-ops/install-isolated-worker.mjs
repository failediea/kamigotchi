#!/usr/bin/env node
// Deliberately stages only: never stops/starts a worker or broadcasts a tx.
// Apply requires an already-stopped unit AND a fresh successful chain preflight.
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync, statSync, lstatSync, readdirSync, realpathSync, chownSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertIdleState, parseWorkerEnv, renderWorkerDropin, renderWorkerEnv } from './worker-service-layout.mjs';

const args = process.argv.slice(2);
const option = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const stack = option('stack');
if (!/^v1[56]-(musu|vipp)$/.test(stack || '')) throw new Error('--stack=v16-musu|v16-vipp|v15-musu|v15-vipp required');
const apply = args.includes('--apply');
const source = resolve(option('source') || `/root/kamigotchi/tools/vault-kit-${stack}`);
const releaseDir = option('release');
const nodeBin = option('node') || '/opt/kami-lease/runtime/node-v22.23.4/bin/node';
const dropin = renderWorkerDropin({ stack, releaseDir, nodeBin });
const unit = `kami-renter-pod-${stack}.service`;
const stateDir = `/var/lib/kami-lease/${stack}`;
const envFile = `/etc/kami-lease/${stack}.env`;
const dropinFile = `/etc/systemd/system/${unit}.d/90-isolated-worker.conf`;
const envText = readFileSync(join(source, '.env'), 'utf8');
const env = parseWorkerEnv(envText);
for (const key of ['YOMINET_RPC', 'MARKET_ADDRESS', 'RENTER_POD_FACTORY']) if (!env[key]) throw new Error(`missing ${key}`);
if (stack.startsWith('v15-') && env.TERMINAL_GAS_RETURN_MODE !== 'skip') throw new Error('v15 requires TERMINAL_GAS_RETURN_MODE=skip; its sealed factory rejects terminal returnGas');
const oldState = resolve(source, env.WORKER_STATE_FILE || 'renter-pod-worker-state.json');
const state = JSON.parse(readFileSync(oldState, 'utf8'));
assertIdleState(state);
const oldReservations = env.RESERVATION_STATE_FILE ? resolve(source, env.RESERVATION_STATE_FILE) : oldState.replace(/\.json$/i, '') + '.reservations.json';
const oldJournal = oldReservations.replace(/\.json$/i, '') + '.journal';
const oldHalt = env.WORKER_HALT_FILE ? resolve(source, env.WORKER_HALT_FILE) : join(dirname(oldState), 'HALT');
const files = [[oldState, 'renter-pod-worker-state.json'], [oldReservations, 'renter-pod-worker-state.reservations.json'], [oldJournal, 'renter-pod-worker-state.reservations.journal'], [oldHalt, 'HALT']].filter(([path]) => existsSync(path));
const plan = { unit, source, releaseDir, nodeBin, stateDir, envFile, dropinFile, copiedFiles: files.map(([, name]) => name), apply };
console.log(JSON.stringify(plan, null, 2));
if (!apply) { console.log('DRY RUN only. No files, users or services changed.'); process.exit(0); }
if (process.getuid() !== 0) throw new Error('root required for installation');
const assertStopped = () => {
  const active = execFileSync('systemctl', ['show', unit, '--property=ActiveState', '--value'], { encoding: 'utf8' }).trim();
  if (active !== 'inactive') throw new Error('stop the source worker before installation (failed/auto-restart is not stopped)');
};
assertStopped();
for (const path of [stateDir, envFile, dropinFile]) if (existsSync(path)) throw new Error(`destination already exists; reconcile without overwriting: ${path}`);
function assertRootOwned(path, recursive = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) throw new Error(`release/runtime is not immutable root-owned code: ${path}`);
  if (recursive && stat.isDirectory()) for (const name of readdirSync(path)) assertRootOwned(join(path, name), true);
}
if (realpathSync(releaseDir) !== releaseDir || realpathSync(nodeBin) !== nodeBin) throw new Error('release/runtime paths must not be symlinks');
for (const path of ['/opt/kami-lease', '/opt/kami-lease/runtime', dirname(releaseDir), dirname(nodeBin), dirname(dirname(nodeBin))]) assertRootOwned(path);
assertRootOwned(releaseDir, true);
assertRootOwned(nodeBin);
const version = execFileSync(nodeBin, ['--version'], { encoding: 'utf8' }).trim();
if (version !== 'v22.23.4') throw new Error('this rollout was reviewed for Node v22.23.4');
execFileSync(nodeBin, ['--check', join(releaseDir, 'renter-pod-worker.mjs')]);
const { readQuoteStore } = await import(pathToFileURL(join(releaseDir, 'renter-pod-quote-store.mjs')));
const loadedStore = readQuoteStore(oldReservations, { journalFile: oldJournal });
const keyPreservation = { embeddedEntries: Object.keys(state.reservations || {}).length, separateEntries: Object.keys(loadedStore.reservations).length, attestedSeparateEntries: Object.values(loadedStore.reservations).filter((r) => !!r.attestedDigest).length, journalPresent: existsSync(oldJournal) };
console.log(JSON.stringify({ keyPreservation }, null, 2));

// Chain is the authority; stale empty JSON is NOT evidence of an idle market.
const { Contract, FetchRequest, JsonRpcProvider, ZeroAddress } = await import(pathToFileURL(join(releaseDir, 'node_modules/ethers/lib.esm/index.js')));
const req = new FetchRequest(env.YOMINET_RPC); req.timeout = 15000;
const provider = new JsonRpcProvider(req);
try {
  const [network, block] = await Promise.all([provider.getNetwork(), provider.getBlock('latest')]);
  if (network.chainId !== 428962654539583n || !block || Math.abs(Date.now() / 1000 - block.timestamp) > 300) throw new Error('wrong or stale chain');
  const market = new Contract(env.MARKET_ADDRESS, ['function numListings() view returns(uint256)', 'function tokenIndices(uint256) view returns(uint32)', 'function leaseRenter(uint32) view returns(address)'], provider);
  const factory = new Contract(env.RENTER_POD_FACTORY, ['function requests(uint32) view returns(address renter,address pod,uint256 gasBudget,uint32 termSecs,uint64 requestedAt,uint8 stage)'], provider);
  const count = Number(await market.numListings());
  if (!Number.isSafeInteger(count) || count > 500) throw new Error('market exceeds bounded migration preflight');
  const tokens = new Set([...Object.values(state.jobs), ...Object.values(state.retiredJobs || {})].map((job) => Number(job.tokenIndex)));
  for (let i = 0; i < count; i++) tokens.add(Number(await market.tokenIndices(i)));
  for (const token of tokens) {
    if (!Number.isSafeInteger(token) || token < 0) throw new Error('unknown job token index');
    const [renter, request] = await Promise.all([market.leaseRenter(token), factory.requests(token)]);
    if (renter !== ZeroAddress || Number(request.stage) !== 0) throw new Error(`on-chain lease/request is not idle: ${token}`);
  }
  console.log(`Fresh chain gate passed at block ${block.number}; ${tokens.size} tokens checked.`);
} catch {
  // ethers errors can embed authenticated RPC URLs; never dump them here.
  throw new Error('Live chain preflight failed: unavailable RPC, wrong/stale chain, or non-idle request. No installation performed.');
} finally { provider.destroy(); }

// Hash every source before copying. Old state/env/unit are never overwritten.
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const snapshots = files.map(([path, name]) => ({ path, name, hash: digest(path) }));
assertStopped();
const user = `kami-${stack}`;
try { execFileSync('id', ['-u', user], { stdio: 'ignore' }); }
catch { execFileSync('useradd', ['--system', '--user-group', '--no-create-home', '--home-dir', stateDir, '--shell', '/usr/sbin/nologin', user]); }
const uid = Number(execFileSync('id', ['-u', user], { encoding: 'utf8' }).trim());
const gid = Number(execFileSync('id', ['-g', user], { encoding: 'utf8' }).trim());
if (!uid || !gid) throw new Error('service account must not be root');
mkdirSync(stateDir, { recursive: true, mode: 0o700 }); chownSync(stateDir, uid, gid); chmodSync(stateDir, 0o700);
for (const entry of snapshots) {
  if (digest(entry.path) !== entry.hash) throw new Error('source changed during migration; leave service stopped');
  const target = join(stateDir, entry.name);
  copyFileSync(entry.path, target); chmodSync(target, 0o600); chownSync(target, uid, gid);
  if (digest(target) !== entry.hash) throw new Error('state copy verification failed; leave service stopped');
}
assertStopped();
for (const entry of snapshots) if (digest(entry.path) !== entry.hash) throw new Error('source changed after copying; leave service stopped');
if (readFileSync(join(source, '.env'), 'utf8') !== envText) throw new Error('source env changed during migration; leave service stopped');
mkdirSync(dirname(envFile), { recursive: true, mode: 0o700 });
writeFileSync(envFile, renderWorkerEnv(envText, stateDir), { flag: 'wx', mode: 0o600 });
mkdirSync(dirname(dropinFile), { recursive: true, mode: 0o755 });
writeFileSync(dropinFile, dropin, { flag: 'wx', mode: 0o644 });
writeFileSync(join(stateDir, 'migration-receipt.json'), JSON.stringify({ at: new Date().toISOString(), unit, source, releaseDir, nodeBin, keyPreservation, files: snapshots }, null, 2), { flag: 'wx', mode: 0o600 });
execFileSync('systemctl', ['daemon-reload']);
console.log('Installed, still stopped. Verify configuration, then start ONE worker and inspect its actual UID, executable, heartbeat and reservations before starting the other. No transaction was broadcast by this installer.');
