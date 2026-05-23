import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

interface OriginalShannonOptions {
  root: string;
  targetUrl: string;
  repoPath: string;
  workspaceName: string;
  outputPath: string;
  logPath: string;
  pipelineTesting: boolean;
}

function appendLog(logPath: string, text: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, text, 'utf8');
}

function readTail(filePath: string, maxBytes = 120_000): string {
  if (!fs.existsSync(filePath)) return '';
  const stat = fs.statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForProcess(proc: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code) => resolve(code ?? 1));
  });
}

async function waitForWorkflow(workflowLogPath: string, logPath: string, timeoutMs = 4 * 60 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastSize = 0;

  while (Date.now() < deadline) {
    const log = readTail(workflowLogPath);
    if (fs.existsSync(workflowLogPath)) {
      const size = fs.statSync(workflowLogPath).size;
      if (size !== lastSize) {
        lastSize = size;
        appendLog(logPath, `[shannon-original] Workflow log updated: ${size} bytes\n`);
      }
    }

    if (/Workflow COMPLETED|Pipeline completed successfully/i.test(log)) return;
    if (/Workflow FAILED|Pipeline failed|ERROR:/i.test(log)) {
      throw new Error('原版 Shannon 检测流程失败，请查看 workflow.log 和 task.log。');
    }

    await sleep(5000);
  }

  throw new Error('原版 Shannon 检测流程超时，已超过 4 小时。');
}

export async function runOriginalShannonScan(options: OriginalShannonOptions): Promise<void> {
  const cliPath = path.join(options.root, 'apps', 'cli', 'dist', 'index.mjs');
  if (!fs.existsSync(cliPath)) {
    throw new Error('原版 Shannon CLI 尚未构建，请先运行 pnpm build。');
  }

  const deliverablesDir = path.join(options.outputPath, 'deliverables');
  fs.mkdirSync(deliverablesDir, { recursive: true });

  const args = [
    cliPath,
    'start',
    '--url',
    options.targetUrl,
    '--repo',
    options.repoPath,
    '--workspace',
    options.workspaceName,
    '--output',
    deliverablesDir,
  ];
  if (options.pipelineTesting) args.push('--pipeline-testing');

  appendLog(options.logPath, `\n[shannon-original] Start original Shannon pipeline.\n`);
  appendLog(options.logPath, `[shannon-original] Target URL: ${options.targetUrl}\n`);
  appendLog(options.logPath, `[shannon-original] Repo path: ${options.repoPath}\n`);
  appendLog(options.logPath, `[shannon-original] Workspace: ${options.workspaceName}\n`);
  appendLog(options.logPath, `[shannon-original] Output: ${deliverablesDir}\n\n`);

  const proc = spawn(process.execPath, args, {
    cwd: options.root,
    env: {
      ...process.env,
      SHANNON_LOCAL: '1',
      MSYS_NO_PATHCONV: '1',
    },
    windowsHide: true,
  });

  proc.stdout?.on('data', (chunk: Buffer) => appendLog(options.logPath, chunk.toString()));
  proc.stderr?.on('data', (chunk: Buffer) => appendLog(options.logPath, chunk.toString()));

  const exitCode = await waitForProcess(proc);
  if (exitCode !== 0) {
    const log = readTail(options.logPath);
    if (/Docker Engine is not running|Docker CLI was not found|dockerDesktopLinuxEngine|daemon is running/i.test(log)) {
      throw new Error('Docker Desktop 未启动或 Docker Engine 不可用，原版 Shannon 无法启动检测 worker。请先启动 Docker Desktop，确认 Docker Engine running 后重试。');
    }
    throw new Error(`原版 Shannon 启动失败，退出码 ${exitCode}。请查看 task.log。`);
  }

  appendLog(options.logPath, '\n[shannon-original] Pipeline accepted by Shannon. Waiting for workflow completion...\n');
  await waitForWorkflow(path.join(options.outputPath, 'workflow.log'), options.logPath);
  appendLog(options.logPath, '[shannon-original] Original Shannon workflow completed.\n');
}
