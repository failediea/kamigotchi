#!/usr/bin/env node
// Read-only, secret-safe evidence. Never prints env values, keys or raw state.
import { readFileSync, existsSync, readdirSync, statSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = process.argv.find((v) => v.startsWith('--root='))?.slice(7) || '/root/kamigotchi/tools';
const units = ['kami-renter-pod-v16-musu', 'kami-renter-pod-v16-vipp', 'kami-renter-pod-v15-musu', 'kami-renter-pod-v15-vipp', 'kami-lease-bot-v13-musu', 'kami-lease-bot-v13-vipp'];
const summary = { observedAt: new Date().toISOString(), units: [], workers: [] };
for (const unit of units) {
  const raw = execFileSync('systemctl', ['show', unit, '--property=Id,MainPID,User,Group,ActiveState,SubState,WorkingDirectory,ActiveEnterTimestamp'], { encoding: 'utf8' });
  const properties = Object.fromEntries(raw.trim().split('\n').map((line) => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
  properties.User ||= 'root';
  properties.Group ||= 'root';
  if (Number(properties.MainPID) > 0) {
    try {
      properties.runningExecutable = readlinkSync(`/proc/${properties.MainPID}/exe`);
      properties.runningNodeVersion = execFileSync(`/proc/${properties.MainPID}/exe`, ['--version'], { encoding: 'utf8' }).trim();
    } catch { properties.runningExecutable = 'unavailable'; }
  }
  summary.units.push(properties);
}
for (const name of ['vault-kit-v16-musu', 'vault-kit-v16-vipp', 'vault-kit-v15-musu', 'vault-kit-v15-vipp', 'vault-kit']) {
  const directory = join(root, name);
  if (!existsSync(directory)) continue;
  const row = { name, files: {}, states: [] };
  for (const file of ['renter-pod-worker.mjs', 'ops-bot.mjs', 'tile-eligibility.mjs']) {
    const path = join(directory, file);
    if (existsSync(path)) row.files[file] = createHash('sha256').update(readFileSync(path)).digest('hex');
  }
  const statePaths = readdirSync(directory).filter((v) => /(?:state|reservation|heartbeat).*\.json$/.test(v)).map((v) => join(directory, v));
  const envPath = join(directory, '.env');
  if (existsSync(envPath)) {
    const configured = readFileSync(envPath, 'utf8').match(/^WORKER_STATE_FILE=(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '');
    if (configured?.startsWith('/') && !statePaths.includes(configured) && existsSync(configured)) statePaths.push(configured);
  }
  for (const path of statePaths) {
    const file = path;
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      const jobs = Object.values(value.jobs || {});
      row.states.push({
        file, mode: (statSync(path).mode & 0o777).toString(8), bytes: statSync(path).size,
        jobs: jobs.length, unfinished: jobs.filter((job) => !job.returned).map((job) => ({ tokenIndex: job.tokenIndex, finalized: job.finalized === true, returned: job.returned === true, strategyStarted: job.strategyStarted === true, hasError: !!job.error })),
        reservationCount: Object.keys(value.reservations || {}).length,
        pendingTxCount: Object.keys(value.pendingTxs || {}).length,
      });
    } catch { row.states.push({ file, readError: true }); }
  }
  summary.workers.push(row);
}
console.log(JSON.stringify(summary, null, 2));
