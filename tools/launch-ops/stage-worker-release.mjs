#!/usr/bin/env node
// Build an immutable release, without reading/copying .env, state or key files.
// This is NOT deployment: no service file is installed and nothing is started.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync, chmodSync, lstatSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const id = opt('id');
if (!/^[a-z0-9][a-z0-9_-]{5,63}$/.test(id || '')) throw new Error('--id requires a reviewed commit/release identifier');
if (!opt('source') || !opt('node-source')) throw new Error('--source and --node-source are required');
const source = resolve(opt('source'));
const nodeSource = resolve(opt('node-source'));
const target = `/opt/kami-lease/releases/${id}`;
const runtime = '/opt/kami-lease/runtime/node-v22.23.4/bin/node';
const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const files = readdirSync(source).filter((name) => (name.endsWith('.mjs') && !name.endsWith('.test.mjs')) || name === 'package.json' || name === 'package-lock.json' || name === 'renter-pod-lease-policy.json');
if (!files.includes('package-lock.json') || !files.includes('renter-pod-worker.mjs')) throw new Error('reviewed worker and lockfile are required');
for (const name of files) if (!lstatSync(join(source, name)).isFile()) throw new Error('release input must be a regular file');
const version = execFileSync(nodeSource, ['--version'], { encoding: 'utf8' }).trim();
if (version !== 'v22.23.4') throw new Error('runtime must be the reviewed Node v22.23.4');
const manifest = { id, nodeVersion: version, nodeSha256: sha(nodeSource), sourceFiles: Object.fromEntries(files.map((name) => [name, sha(join(source, name))])) };
console.log(JSON.stringify({ target, runtime, nodeVersion: version, nodeSha256: manifest.nodeSha256, sourceFileCount: files.length, apply: args.includes('--apply') }, null, 2));
if (!args.includes('--apply')) { console.log('DRY RUN: no filesystem or service changes.'); process.exit(0); }
if (process.getuid() !== 0) throw new Error('root required for staging');
if (existsSync(target)) throw new Error('release directory already exists; never overwrite a release');
if (existsSync(runtime) && sha(runtime) !== manifest.nodeSha256) throw new Error('versioned runtime exists with different bytes');
for (const dir of ['/opt/kami-lease', '/opt/kami-lease/runtime', dirname(dirname(runtime)), dirname(runtime), '/opt/kami-lease/releases']) {
  if (existsSync(dir)) {
    const s = lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022)) throw new Error('installation parent must be a real, root-owned, non-writable directory');
  } else mkdirSync(dir, { mode: 0o755 });
}
if (!existsSync(runtime)) { copyFileSync(nodeSource, runtime); chmodSync(runtime, 0o755); }
mkdirSync(target, { mode: 0o755 });
for (const name of files) { copyFileSync(join(source, name), join(target, name)); chmodSync(join(target, name), 0o644); }
// Use the verified Node binary to run npm's CLI, never a PATH-selected node.
const npmCli = resolve(dirname(nodeSource), '../lib/node_modules/npm/bin/npm-cli.js');
execFileSync(runtime, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--workspaces=false', '--registry=https://registry.npmjs.org'], { cwd: target, stdio: 'inherit' });
execFileSync(runtime, [npmCli, 'audit', '--omit=dev', '--workspaces=false', '--audit-level=low'], { cwd: target, stdio: 'inherit' });
for (const [name, expected] of Object.entries(manifest.sourceFiles)) if (sha(join(target, name)) !== expected) throw new Error('release changed while staging');
execFileSync(runtime, ['--check', join(target, 'renter-pod-worker.mjs')]);
writeFileSync(join(target, 'RELEASE-MANIFEST.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o644 });
console.log('Release staged. No services/env/state touched. Compare manifest with reviewed source before installation.');
