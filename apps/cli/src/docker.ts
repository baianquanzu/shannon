/**
 * Docker orchestration — compose lifecycle, network, image pull/build, worker spawning.
 *
 * Local mode: builds locally, uses docker-compose.yml from repo root, mounts prompts.
 * NPX mode: pulls from Docker Hub, uses bundled compose.yml.
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getMode } from './mode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const NPX_IMAGE_REPO = 'keygraph/shannon';
const DEV_IMAGE = 'shannon-worker';
const WINDOWS_DOCKER = 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe';

export function getWorkerImage(version: string): string {
  return getMode() === 'local' ? DEV_IMAGE : `${NPX_IMAGE_REPO}:${version}`;
}

function getComposeFile(): string {
  return getMode() === 'local'
    ? path.resolve('docker-compose.yml')
    : path.resolve(__dirname, '..', 'infra', 'compose.yml');
}

/** Generate an 8-char random hex suffix for container/queue names. */
export function randomSuffix(): string {
  return crypto.randomBytes(4).toString('hex');
}

/** Run a command silently, return true if it succeeds. */
function runQuiet(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Run a command and return stdout, or empty string on failure. */
function runOutput(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

export function getDockerCommand(): string {
  if (process.env.DOCKER_CLI) return process.env.DOCKER_CLI;
  if (runQuiet('docker', ['--version'])) return 'docker';
  if (os.platform() === 'win32' && runQuiet(WINDOWS_DOCKER, ['--version'])) return WINDOWS_DOCKER;
  return 'docker';
}

export function ensureDockerReady(): void {
  const docker = getDockerCommand();
  if (!runQuiet(docker, ['--version'])) {
    console.error('\nERROR: Docker CLI was not found.');
    console.error('Install Docker Desktop, then open a new terminal so PATH is refreshed.');
    process.exit(1);
  }

  if (runQuiet(docker, ['info'])) return;

  console.error('\nERROR: Docker Engine is not running or is not ready.');
  if (os.platform() === 'win32') {
    console.error('Open Docker Desktop and wait until it reports "Engine running".');
    console.error('If this is a fresh Windows install, enable WSL and VirtualMachinePlatform from an elevated PowerShell:');
    console.error('  dism /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart');
    console.error('  dism /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart');
    console.error('Then reboot, install a WSL distro if prompted, and start Docker Desktop again.');
  } else if (os.platform() === 'linux') {
    console.error('Start Docker and make sure your user can access the Docker socket without sudo.');
  } else {
    console.error('Start Docker Desktop and try again.');
  }
  process.exit(1);
}

/**
 * Check if Temporal is running and healthy.
 */
export function isTemporalReady(): boolean {
  const output = runOutput(getDockerCommand(), [
    'exec',
    'shannon-temporal',
    'temporal',
    'operator',
    'cluster',
    'health',
    '--address',
    'localhost:7233',
  ]);
  return output.includes('SERVING');
}

/**
 * Ensure Temporal is running via compose.
 */
export async function ensureInfra(): Promise<void> {
  if (isTemporalReady()) {
    return;
  }

  const composeFile = getComposeFile();
  console.log('Starting Shannon infrastructure...');
  execFileSync(getDockerCommand(), ['compose', '-f', composeFile, 'up', '-d'], { stdio: 'inherit' });

  console.log('Waiting for Temporal to be ready...');
  for (let i = 0; i < 30; i++) {
    if (isTemporalReady()) {
      console.log('Temporal is ready!');
      return;
    }
    await sleep(2000);
  }
  console.error('Timeout waiting for Temporal');
  process.exit(1);
}

/**
 * Build the worker image locally (local mode only).
 */
export function buildImage(noCache: boolean): void {
  console.log(`Building ${DEV_IMAGE}...`);
  const args = ['build'];
  if (noCache) args.push('--no-cache');
  args.push('-t', DEV_IMAGE, '.');
  execFileSync(getDockerCommand(), args, { stdio: 'inherit' });
  console.log(`Build complete: ${DEV_IMAGE}`);
}

/**
 * Ensure the worker image is available.
 * Local mode: auto-builds if missing. NPX mode: pulls from Docker Hub.
 */
export function ensureImage(version: string): void {
  const image = getWorkerImage(version);
  const exists = runQuiet(getDockerCommand(), ['image', 'inspect', image]);
  if (exists) return;

  if (getMode() === 'local') {
    console.log('Worker image not found, building...');
    buildImage(false);
  } else {
    console.log(`Pulling ${image}...`);
    try {
      execFileSync(getDockerCommand(), ['pull', image], { stdio: 'inherit' });
    } catch {
      console.error(`\nERROR: Failed to pull ${image}`);
      console.error('The image may not be available for your platform yet.');
      console.error('Check https://hub.docker.com/r/keygraph/shannon for available tags.');
      process.exit(1);
    }
    pruneOldImages(version);
  }
}

/**
 * Detect if --add-host is needed (Linux without Podman).
 * macOS has host.docker.internal built in.
 */
function addHostFlag(): string[] {
  if (os.platform() === 'linux') {
    const hasPodman = runQuiet('which', ['podman']);
    if (!hasPodman) {
      return ['--add-host', 'host.docker.internal:host-gateway'];
    }
  }
  return [];
}

export interface WorkerOptions {
  version: string;
  url: string;
  repo: { hostPath: string; containerPath: string };
  workspacesDir: string;
  taskQueue: string;
  containerName: string;
  envFlags: string[];
  config?: { hostPath: string; containerPath: string };
  credentials?: string;
  promptsDir?: string;
  outputDir?: string;
  workspace: string;
  pipelineTesting?: boolean;
  debug?: boolean;
}

/**
 * Spawn the worker container in detached mode and return the process.
 * When `opts.debug` is true, omits `--rm` so the container persists for log inspection.
 */
export function spawnWorker(opts: WorkerOptions): ChildProcess {
  const args = ['run', '-d'];
  if (!opts.debug) {
    args.push('--rm');
  }
  args.push('--name', opts.containerName, '--network', 'shannon-net');

  // Add host flag for Linux
  args.push(...addHostFlag());

  // UID remapping for Linux bind mounts
  if (os.platform() === 'linux' && process.getuid && process.getgid) {
    args.push('-e', `SHANNON_HOST_UID=${process.getuid()}`, '-e', `SHANNON_HOST_GID=${process.getgid()}`);
  }

  // Volume mounts
  args.push('-v', `${opts.workspacesDir}:/app/workspaces`);
  args.push('-v', `${opts.repo.hostPath}:${opts.repo.containerPath}:ro`);

  // Writable overlays: shadow .shannon/ inside the :ro repo with workspace-backed dirs
  const workspacePath = path.join(opts.workspacesDir, opts.workspace);
  args.push('-v', `${path.join(workspacePath, 'deliverables')}:${opts.repo.containerPath}/.shannon/deliverables`);
  args.push('-v', `${path.join(workspacePath, 'scratchpad')}:${opts.repo.containerPath}/.shannon/scratchpad`);
  args.push('-v', `${path.join(workspacePath, '.playwright-cli')}:${opts.repo.containerPath}/.shannon/.playwright-cli`);

  // Local mode: mount prompts for live editing
  if (opts.promptsDir) {
    args.push('-v', `${opts.promptsDir}:/app/apps/worker/prompts:ro`);
  }

  if (opts.config) {
    args.push('-v', `${opts.config.hostPath}:${opts.config.containerPath}:ro`);
  }

  // Output directory for deliverables copy
  if (opts.outputDir) {
    args.push('-v', `${opts.outputDir}:/app/output`);
  }

  // Mount credentials file to fixed container path
  if (opts.credentials) {
    args.push('-v', `${opts.credentials}:/app/credentials/google-sa-key.json:ro`);
  }

  // Environment
  args.push(...opts.envFlags);

  // Container settings
  args.push('--shm-size', '2gb', '--security-opt', 'seccomp=unconfined');

  // Image
  args.push(getWorkerImage(opts.version));

  // Worker command
  args.push('node', 'apps/worker/dist/temporal/worker.js', opts.url, opts.repo.containerPath);
  args.push('--task-queue', opts.taskQueue);
  if (opts.config) {
    args.push('--config', opts.config.containerPath);
  }
  if (opts.outputDir) {
    args.push('--output', '/app/output');
  }
  args.push('--workspace', opts.workspace);
  if (opts.pipelineTesting) {
    args.push('--pipeline-testing');
  }

  // Inherit stderr so `docker run` daemon errors surface to the user;
  // ignore stdin/stdout (the container ID is noise).
  return spawn(getDockerCommand(), args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    // Prevent MSYS/Git Bash from converting Unix paths on Windows
    ...(os.platform() === 'win32' && { env: { ...process.env, MSYS_NO_PATHCONV: '1' } }),
  });
}

/**
 * Stop all running shannon-worker-* containers.
 */
export function stopWorkers(): void {
  const workers = runOutput(getDockerCommand(), ['ps', '-q', '--filter', 'name=shannon-worker-']);
  if (!workers) return;

  const ids = workers.split('\n').filter(Boolean);
  console.log('Stopping worker containers...');
  execFileSync(getDockerCommand(), ['stop', ...ids], { stdio: 'inherit' });
}

/**
 * Tear down the compose stack.
 */
export function stopInfra(clean: boolean): void {
  const composeFile = getComposeFile();
  const args = ['compose', '-f', composeFile, 'down'];
  if (clean) args.push('-v');
  execFileSync(getDockerCommand(), args, { stdio: 'inherit' });
}

/**
 * Remove old keygraph/shannon images that don't match the current version.
 */
function pruneOldImages(currentVersion: string): void {
  const output = runOutput(getDockerCommand(), ['images', NPX_IMAGE_REPO, '--format', '{{.Tag}}']);
  if (!output) return;

  const currentTag = currentVersion;
  const stale = output.split('\n').filter((tag) => tag && tag !== currentTag);
  for (const tag of stale) {
    runQuiet(getDockerCommand(), ['rmi', `${NPX_IMAGE_REPO}:${tag}`]);
  }
}

/**
 * List running worker containers.
 */
export function listRunningWorkers(): string {
  return runOutput(getDockerCommand(), [
    'ps',
    '--filter',
    'name=shannon-worker-',
    '--format',
    'table {{.Names}}\t{{.Status}}\t{{.RunningFor}}',
  ]);
}
