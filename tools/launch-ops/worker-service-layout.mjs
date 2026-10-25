import { isAbsolute } from 'node:path';

export function parseWorkerEnv(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$/);
    if (match) env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return env;
}

export function assertIdleState(state) {
  if (!state || typeof state !== 'object' || !state.jobs || typeof state.jobs !== 'object') throw new Error('worker state schema is unknown');
  if ([...Object.values(state.jobs), ...Object.values(state.retiredJobs || {})].some((job) => job.returned !== true)) throw new Error('unfinished custody job: do not migrate');
  if (Object.keys(state.pendingTxs || {}).length) throw new Error('pending transaction: do not migrate');
  if (Object.keys(state.ingestRetry || {}).length) throw new Error('parked ingest event: do not migrate');
}

export function renderWorkerEnv(text, stateDir) {
  if (!isAbsolute(stateDir) || /[\r\n\0]/.test(stateDir)) throw new Error('invalid state directory');
  const managed = new Set(['WORKER_STATE_FILE', 'RESERVATION_STATE_FILE', 'WORKER_HALT_FILE', 'OPERATOR_RESERVATION_HOST']);
  const lines = text.split(/\r?\n/).filter((line) => !managed.has(line.trim().match(/^(?:export\s+)?([A-Z_]+)\s*=/)?.[1]))
    .map((line) => line.replace(/^(\s*)export\s+([A-Z][A-Z0-9_]*\s*=)/, '$1$2')); // systemd EnvironmentFile does not accept shell export
  return [...lines, `WORKER_STATE_FILE=${stateDir}/renter-pod-worker-state.json`, `RESERVATION_STATE_FILE=${stateDir}/renter-pod-worker-state.reservations.json`, `WORKER_HALT_FILE=${stateDir}/HALT`, 'OPERATOR_RESERVATION_HOST=127.0.0.1', ''].join('\n');
}

export function renderWorkerDropin({ stack, releaseDir, nodeBin }) {
  if (!/^v1[56]-(musu|vipp)$/.test(stack)) throw new Error('unsupported stack');
  for (const path of [releaseDir, nodeBin]) if (!/^\/opt\/kami-lease\/[a-zA-Z0-9_./-]+$/.test(path) || path.includes('/../')) throw new Error('unsafe installation path');
  return `[Unit]
Description=Kami lease ${stack} isolated worker

[Service]
User=kami-${stack}
Group=kami-${stack}
WorkingDirectory=${releaseDir}
ExecStart=
ExecStart=${nodeBin} renter-pod-worker.mjs
EnvironmentFile=
EnvironmentFile=/etc/kami-lease/${stack}.env
UMask=0077
StateDirectory=kami-lease/${stack}
StateDirectoryMode=0700
ReadWritePaths=/var/lib/kami-lease/${stack}
NoNewPrivileges=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectSystem=strict
ProtectHome=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
AmbientCapabilities=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
Restart=always
RestartSec=10
TimeoutStopSec=30
LimitNOFILE=4096
TasksMax=128
`;
}
