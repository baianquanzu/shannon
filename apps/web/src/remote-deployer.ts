import fs from 'node:fs';
import path from 'node:path';
import { Client, type SFTPWrapper } from 'ssh2';

export interface RemoteLinuxConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface RemoteDeployResult {
  targetUrl: string;
  stack: string;
  mode: string;
  remoteDir: string;
  healthOk: boolean;
  healthStatus: string;
  runtimeLog: string;
}

interface RemoteDeployOptions {
  taskId: string;
  repoPath: string;
  uploadPath: string;
  fileName: string;
  logPath: string;
  config: RemoteLinuxConfig;
}

interface NativePlan {
  stack: string;
  command: string;
  checks: number[];
}

interface RemoteBaseChoice {
  path: string;
  availableKb: number;
}

function appendLog(logPath: string, text: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, text);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function connect(config: RemoteLinuxConfig, logPath: string): Promise<Client> {
  appendLog(logPath, `[remote-deploy] Connect Linux: ${config.username}@${config.host}:${config.port}\n`);
  return new Promise((resolve, reject) => {
    const client = new Client();
    client
      .on('ready', () => resolve(client))
      .on('error', reject)
      .connect({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        readyTimeout: 20_000,
      });
  });
}

function exec(client: Client, command: string, logPath: string): Promise<string> {
  appendLog(logPath, `\n$ ${command}\n`);
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) {
        reject(error);
        return;
      }
      let stdout = '';
      let stderr = '';
      stream
        .on('close', (code: number | undefined) => {
          if (code === 0) resolve(stdout + stderr);
          else reject(new Error(stderr || stdout || `remote command exited with ${code}`));
        })
        .on('data', (chunk: Buffer) => {
          const text = chunk.toString();
          stdout += text;
          appendLog(logPath, text);
        });
      stream.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        appendLog(logPath, text);
      });
    });
  });
}

function sftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((error, wrapper) => {
      if (error) reject(error);
      else resolve(wrapper);
    });
  });
}

function upload(wrapper: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    wrapper.fastPut(localPath, remotePath, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function remoteArchiveName(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'source.tar.gz';
  if (lower.endsWith('.tgz')) return 'source.tgz';
  if (lower.endsWith('.tar')) return 'source.tar';
  return 'source.zip';
}

function parseDf(output: string): RemoteBaseChoice[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 6 && /^\d+$/.test(parts[3] || ''))
    .map((parts) => ({ path: parts.slice(5).join(' '), availableKb: Number(parts[3]) }))
    .filter((item) => item.path && Number.isFinite(item.availableKb));
}

async function chooseRemoteBase(client: Client, options: RemoteDeployOptions): Promise<string> {
  const archiveBytes = fs.statSync(options.uploadPath).size;
  const requiredKb = Math.ceil((archiveBytes * 3) / 1024) + 512 * 1024;
  const roots = ['/tmp', '/var/tmp', '/root', '/home'].join(' ');

  await exec(client, 'rm -rf /tmp/shannon-auto /var/tmp/shannon-auto /root/shannon-auto /home/shannon-auto 2>/dev/null || true', options.logPath).catch(() => undefined);
  const df = await exec(client, `df -Pk ${roots} 2>/dev/null || true`, options.logPath);
  const choices = parseDf(df).sort((a, b) => b.availableKb - a.availableKb);
  const enough = choices.find((item) => item.availableKb >= requiredKb) ?? choices[0];
  if (!enough) {
    throw new Error('无法检测远程 Linux 可用磁盘空间，请手动检查 df -h。');
  }

  appendLog(
    options.logPath,
    `[remote-deploy] Need about ${requiredKb} KB. Selected ${enough.path} with ${enough.availableKb} KB available.\n`,
  );
  if (enough.availableKb < requiredKb) {
    appendLog(options.logPath, '[remote-deploy] Warning: selected partition may still be tight; continuing with best available path.\n');
  }

  return `${enough.path.replace(/\/$/, '')}/shannon-auto/${options.taskId}`;
}

function extractionCommand(remoteArchive: string, remoteRepo: string): string {
  if (remoteArchive.endsWith('.zip')) {
    return `python3 - <<'PY'
import os, zipfile
base=${JSON.stringify(remoteRepo)}
archive=${JSON.stringify(remoteArchive)}
os.makedirs(base, exist_ok=True)
with zipfile.ZipFile(archive) as z:
    for item in z.infolist():
        dest=os.path.abspath(os.path.join(base, item.filename))
        if not dest.startswith(os.path.abspath(base)+os.sep) and dest != os.path.abspath(base):
            raise SystemExit("unsafe zip path: "+item.filename)
    z.extractall(base)
PY`;
  }
  return `tar -xf ${shellQuote(remoteArchive)} -C ${shellQuote(remoteRepo)}`;
}

function hasFile(repoPath: string, fileName: string): boolean {
  return fs.existsSync(path.join(repoPath, fileName));
}

function nativePlan(repoPath: string): NativePlan {
  if (hasFile(repoPath, 'cms')) {
    return {
      stack: 'Linux CMS Binary',
      checks: [21007, 21017, 8080, 8000, 80],
      command: 'chmod +x ./cms && nohup ./cms > shannon-runtime.log 2>&1 & echo $! > shannon.pid',
    };
  }

  if (hasFile(repoPath, 'package.json')) {
    const manager = hasFile(repoPath, 'pnpm-lock.yaml') ? 'pnpm' : hasFile(repoPath, 'yarn.lock') ? 'yarn' : 'npm';
    const install = manager === 'pnpm' ? 'corepack enable || npm i -g pnpm; pnpm install' : manager === 'yarn' ? 'corepack enable || npm i -g yarn; yarn install' : 'npm install';
    return {
      stack: 'Node.js',
      checks: [3000, 5173, 8080, 8000],
      command: `${install}; (npm run build || true); HOST=0.0.0.0 PORT=3000 nohup ${manager} run start > shannon-runtime.log 2>&1 & echo $! > shannon.pid`,
    };
  }

  if (hasFile(repoPath, 'requirements.txt') || hasFile(repoPath, 'pyproject.toml') || hasFile(repoPath, 'manage.py') || hasFile(repoPath, 'app.py') || hasFile(repoPath, 'main.py')) {
    const command = hasFile(repoPath, 'manage.py')
      ? 'python3 -m pip install -r requirements.txt || true; python3 manage.py migrate || true; nohup python3 manage.py runserver 0.0.0.0:8000 > shannon-runtime.log 2>&1 & echo $! > shannon.pid'
      : hasFile(repoPath, 'main.py')
        ? 'python3 -m pip install -r requirements.txt || true; python3 -m pip install uvicorn fastapi || true; nohup python3 -m uvicorn main:app --host 0.0.0.0 --port 8000 > shannon-runtime.log 2>&1 & echo $! > shannon.pid'
        : hasFile(repoPath, 'app.py')
          ? 'python3 -m pip install -r requirements.txt || true; nohup python3 app.py > shannon-runtime.log 2>&1 & echo $! > shannon.pid'
          : 'nohup python3 -m http.server 8000 --bind 0.0.0.0 > shannon-runtime.log 2>&1 & echo $! > shannon.pid';
    return { stack: 'Python', checks: [8000, 5000], command };
  }

  if (hasFile(repoPath, 'composer.json') || hasFile(repoPath, 'index.php')) {
    return {
      stack: 'PHP',
      checks: [8000, 80],
      command: 'if [ -f composer.json ] && command -v composer >/dev/null 2>&1; then composer install --no-interaction || true; fi; nohup php -S 0.0.0.0:8000 > shannon-runtime.log 2>&1 & echo $! > shannon.pid',
    };
  }

  if (hasFile(repoPath, 'go.mod')) {
    return {
      stack: 'Go',
      checks: [8080, 8000],
      command: 'nohup go run ./... > shannon-runtime.log 2>&1 & echo $! > shannon.pid',
    };
  }

  if (hasFile(repoPath, 'pom.xml') || hasFile(repoPath, 'build.gradle') || hasFile(repoPath, 'build.gradle.kts')) {
    const command = hasFile(repoPath, 'pom.xml')
      ? 'nohup mvn spring-boot:run -Dspring-boot.run.jvmArguments="-Dserver.address=0.0.0.0" > shannon-runtime.log 2>&1 & echo $! > shannon.pid'
      : 'nohup sh -lc "./gradlew bootRun || gradle bootRun" > shannon-runtime.log 2>&1 & echo $! > shannon.pid';
    return { stack: 'Java', checks: [8080], command };
  }

  return {
    stack: 'Static',
    checks: [8000, 8080],
    command: 'nohup python3 -m http.server 8000 --bind 0.0.0.0 > shannon-runtime.log 2>&1 & echo $! > shannon.pid',
  };
}

async function detectPort(client: Client, ports: number[], logPath: string): Promise<number> {
  const output = await exec(
    client,
    `python3 - <<'PY'
import socket
for port in ${JSON.stringify(ports)}:
    s=socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", int(port)))
        print(port)
        raise SystemExit(0)
    except Exception:
        pass
    finally:
        s.close()
raise SystemExit(1)
PY`,
    logPath,
  );
  const port = Number(output.trim().split(/\s+/).find((value) => /^\d+$/.test(value)));
  if (!port) throw new Error(`Remote process started, but none of these ports are open: ${ports.join(', ')}`);
  return port;
}

async function probeRemoteHttp(client: Client, url: string, logPath: string): Promise<{ ok: boolean; status: string }> {
  appendLog(logPath, `[remote-deploy] Probe remote HTTP: ${url}\n`);
  let last = '';
  for (let i = 0; i < 8; i++) {
    const output = await exec(
      client,
      `python3 - <<'PY'
import urllib.error, urllib.request
try:
    r=urllib.request.urlopen(${JSON.stringify(url)}, timeout=2)
    print(r.status)
except urllib.error.HTTPError as e:
    print(e.code)
except Exception as e:
    print(type(e).__name__ + ": " + str(e))
PY`,
      logPath,
    ).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
    last = output.trim().split(/\r?\n/).pop() || output.trim();
    if (/^[1-4]\d\d$/.test(last)) return { ok: true, status: last };
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  appendLog(logPath, `[remote-deploy] HTTP is reachable but not healthy enough for a green check. Last status: ${last || 'unknown'}\n`);
  return { ok: false, status: last || 'unknown' };
}

async function readRemoteRuntimeLog(client: Client, remoteRepo: string, logPath: string): Promise<string> {
  const output = await exec(
    client,
    `cd ${shellQuote(remoteRepo)} && if [ -f shannon-runtime.log ]; then tail -n 160 shannon-runtime.log; else echo "shannon-runtime.log not found"; fi`,
    logPath,
  ).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
  return output.slice(-12_000);
}

async function killPorts(client: Client, ports: number[], logPath: string): Promise<void> {
  const portList = ports.map((port) => String(port)).join(' ');
  await exec(
    client,
    `for port in ${portList}; do ` +
      `if command -v fuser >/dev/null 2>&1; then fuser -k "$port/tcp" 2>/dev/null || true; fi; ` +
      `if command -v ss >/dev/null 2>&1; then ss -ltnp "sport = :$port" 2>/dev/null | awk -F'pid=' 'NF>1{split($2,a,\",\"); print a[1]}' | xargs -r kill -9 2>/dev/null || true; fi; ` +
      `done`,
    logPath,
  ).catch(() => undefined);
}

export async function remoteDeploy(options: RemoteDeployOptions): Promise<RemoteDeployResult> {
  const client = await connect(options.config, options.logPath);
  const archiveName = remoteArchiveName(options.fileName);

  try {
    const remoteBase = await chooseRemoteBase(client, options);
    const remoteRepo = `${remoteBase}/repo`;
    const remoteArchive = `${remoteBase}/${archiveName}`;
    await exec(client, `rm -rf ${shellQuote(remoteBase)} && mkdir -p ${shellQuote(remoteRepo)}`, options.logPath);
    const transfer = await sftp(client);
    appendLog(options.logPath, `[remote-deploy] Upload source archive to ${remoteArchive}\n`);
    await upload(transfer, options.uploadPath, remoteArchive);
    await exec(client, extractionCommand(remoteArchive, remoteRepo), options.logPath);

    const plan = nativePlan(options.repoPath);
    appendLog(options.logPath, `[remote-deploy] Native Linux deployment. Stack: ${plan.stack}\n`);
    await exec(client, `cd ${shellQuote(remoteRepo)} && if [ -f shannon.pid ]; then kill $(cat shannon.pid) 2>/dev/null || true; fi`, options.logPath).catch(() => undefined);
    await killPorts(client, plan.checks, options.logPath);
    await exec(client, `cd ${shellQuote(remoteRepo)} && ${plan.command}`, options.logPath);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const port = await detectPort(client, plan.checks, options.logPath);
    const health = await probeRemoteHttp(client, `http://127.0.0.1:${port}`, options.logPath);
    const runtimeLog = await readRemoteRuntimeLog(client, remoteRepo, options.logPath);
    return {
      targetUrl: `http://${options.config.host}:${port}`,
      stack: plan.stack,
      mode: 'remote-native',
      remoteDir: remoteBase,
      healthOk: health.ok,
      healthStatus: health.status,
      runtimeLog,
    };
  } finally {
    client.end();
  }
}
