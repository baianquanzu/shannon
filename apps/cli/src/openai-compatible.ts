import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { getShannonHome } from './home.js';

const DEFAULT_PORT = '8082';
const CLAWGATE_VERSION = 'v1.3.2';

type ProviderName = 'openai' | 'deepseek' | 'openai-compatible';

interface ProxyConfig {
  provider: ProviderName;
  apiKey: string;
  baseUrl: string;
  port: string;
  reason?: string;
  smallModel?: string;
  midModel?: string;
  bigModel?: string;
}

function providerFromEnv(): ProviderName | undefined {
  const raw = process.env.SHANNON_AI_PROVIDER?.toLowerCase();
  if (raw === 'deepseek') return 'deepseek';
  if (raw === 'openai-compatible' || raw === 'openai_compatible' || raw === 'custom') return 'openai-compatible';
  if (raw === 'openai' || process.env.OPENAI_COMPAT_API_KEY || process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.DEEPSEEK_API_KEY) return 'deepseek';
  return undefined;
}

function defaultBaseUrl(provider: ProviderName): string {
  if (provider === 'deepseek') return 'https://api.deepseek.com/v1';
  return 'https://api.openai.com/v1';
}

function defaultModels(provider: ProviderName): Pick<ProxyConfig, 'smallModel' | 'midModel' | 'bigModel'> {
  if (provider === 'deepseek') {
    return {
      smallModel: 'deepseek-chat',
      midModel: 'deepseek-chat',
      bigModel: 'deepseek-reasoner',
    };
  }
  return {};
}

function readProxyConfig(): ProxyConfig | undefined {
  const provider = providerFromEnv();
  if (!provider) return undefined;

  const apiKey =
    process.env.OPENAI_COMPAT_API_KEY ||
    (provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined) ||
    process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error(
      `SHANNON_AI_PROVIDER=${provider} requires OPENAI_COMPAT_API_KEY` +
        (provider === 'deepseek' ? ' or DEEPSEEK_API_KEY' : ' or OPENAI_API_KEY'),
    );
  }

  const defaults = defaultModels(provider);
  const config: ProxyConfig = {
    provider,
    apiKey,
    baseUrl: process.env.OPENAI_COMPAT_BASE_URL || defaultBaseUrl(provider),
    port: process.env.SHANNON_OPENAI_PROXY_PORT || DEFAULT_PORT,
  };
  const reason = process.env.OPENAI_COMPAT_REASON || process.env.REASONING_EFFORT;
  const smallModel = process.env.OPENAI_COMPAT_SMALL_MODEL || defaults.smallModel;
  const midModel = process.env.OPENAI_COMPAT_MEDIUM_MODEL || defaults.midModel;
  const bigModel = process.env.OPENAI_COMPAT_LARGE_MODEL || defaults.bigModel;

  if (reason) config.reason = reason;
  if (smallModel) config.smallModel = smallModel;
  if (midModel) config.midModel = midModel;
  if (bigModel) config.bigModel = bigModel;

  return config;
}

function proxyBaseUrlForWorker(port: string): string {
  if (process.env.SHANNON_OPENAI_PROXY_PUBLIC_URL) return process.env.SHANNON_OPENAI_PROXY_PUBLIC_URL;
  if (os.platform() === 'win32' || os.platform() === 'darwin') return `http://host.docker.internal:${port}`;
  return `http://host.docker.internal:${port}`;
}

function assetName(): string {
  if (os.platform() === 'win32') return 'clawgate-windows-amd64.exe';
  if (os.platform() === 'darwin') return os.arch() === 'arm64' ? 'clawgate-darwin-arm64' : 'clawgate-darwin-amd64';
  return os.arch() === 'arm64' ? 'clawgate-linux-arm64' : 'clawgate-linux-amd64';
}

function binaryPath(): string {
  if (process.env.SHHANNON_CLAWGATE_PATH) return process.env.SHHANNON_CLAWGATE_PATH;
  if (process.env.SHANNON_CLAWGATE_PATH) return process.env.SHANNON_CLAWGATE_PATH;
  const binDir = path.join(getShannonHome(), 'bin');
  return path.join(binDir, os.platform() === 'win32' ? 'clawgate.exe' : 'clawgate');
}

function downloadClawgate(targetPath: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const url = `https://github.com/goclawgate/clawgate/releases/download/${CLAWGATE_VERSION}/${assetName()}`;
  console.log(`Downloading OpenAI-compatible adapter (${CLAWGATE_VERSION})...`);

  if (os.platform() === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Invoke-WebRequest -Uri '${url}' -OutFile '${targetPath.replace(/'/g, "''")}'`,
    ]);
  } else {
    execFileSync('curl', ['-L', '-o', targetPath, url], { stdio: 'inherit' });
    fs.chmodSync(targetPath, 0o755);
  }
}

function isProxyHealthy(port: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      res.resume();
      resolve((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 500);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function spawnProxy(bin: string, config: ProxyConfig): ChildProcess {
  const args = ['--mode=api', '--host=0.0.0.0', `--port=${config.port}`, `--baseUrl=${config.baseUrl}`];
  if (config.reason) args.push(`--reason=${config.reason}`);
  if (config.smallModel) args.push(`--smallModel=${config.smallModel}`);
  if (config.midModel) args.push(`--midModel=${config.midModel}`);
  if (config.bigModel) args.push(`--bigModel=${config.bigModel}`);

  const logDir = path.join(getShannonHome(), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const out = fs.openSync(path.join(logDir, 'openai-compatible-proxy.log'), 'a');
  const err = fs.openSync(path.join(logDir, 'openai-compatible-proxy.err.log'), 'a');

  return spawn(bin, args, {
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      AUTH_MODE: 'api',
      OPENAI_API_KEY: config.apiKey,
      OPENAI_BASE_URL: config.baseUrl,
      HOST: '0.0.0.0',
      PORT: config.port,
    },
    windowsHide: true,
  });
}

export async function configureOpenAICompatibleProvider(): Promise<void> {
  const config = readProxyConfig();
  if (!config) return;

  process.env.ANTHROPIC_BASE_URL = proxyBaseUrlForWorker(config.port);
  process.env.ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN || 'shannon-openai-compatible';
  process.env.ANTHROPIC_SMALL_MODEL = process.env.ANTHROPIC_SMALL_MODEL || 'claude-3-haiku-20240307';
  process.env.ANTHROPIC_MEDIUM_MODEL = process.env.ANTHROPIC_MEDIUM_MODEL || 'claude-3-5-sonnet-20241022';
  process.env.ANTHROPIC_LARGE_MODEL = process.env.ANTHROPIC_LARGE_MODEL || 'claude-3-5-sonnet-20241022';

  if (await isProxyHealthy(config.port)) {
    console.log(`OpenAI-compatible adapter already running on port ${config.port}`);
    return;
  }

  const bin = binaryPath();
  if (!fs.existsSync(bin)) {
    downloadClawgate(bin);
  }

  spawnProxy(bin, config).unref();

  for (let i = 0; i < 20; i++) {
    if (await isProxyHealthy(config.port)) {
      console.log(`OpenAI-compatible adapter ready on port ${config.port} (${config.provider})`);
      return;
    }
    await sleep(500);
  }

  throw new Error(`OpenAI-compatible adapter did not become healthy on port ${config.port}`);
}
