import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { runOriginalShannonScan } from './original-shannon.js';
import { remoteDeploy, type RemoteLinuxConfig } from './remote-deployer.js';
import { runSourceAudit } from './source-audit.js';

type Provider =
  | 'deepseek'
  | 'qwen'
  | 'zhipu'
  | 'moonshot'
  | 'baichuan'
  | 'minimax'
  | 'doubao'
  | 'yi'
  | 'siliconflow'
  | 'openai'
  | 'openai-compatible'
  | 'anthropic';
type TaskStatus = 'queued' | 'auditing' | 'deploying' | 'starting' | 'testing' | 'running' | 'completed' | 'failed';
type ScanMode = 'source-only' | 'manual-url' | 'remote-linux';

interface Settings {
  provider: Provider;
  apiKeyConfigured: boolean;
  baseUrl: string;
  smallModel: string;
  mediumModel: string;
  largeModel: string;
  reason: string;
}

interface SettingsInput {
  provider?: Provider;
  apiKey?: string;
  baseUrl?: string;
  smallModel?: string;
  mediumModel?: string;
  largeModel?: string;
  reason?: string;
}

interface ProviderPreset {
  baseUrl: string;
  smallModel: string;
  mediumModel: string;
  largeModel: string;
  reason: string;
}

interface TaskRecord {
  id: string;
  name: string;
  targetUrl: string;
  detectedUrl?: string;
  scanMode: ScanMode;
  remoteHost?: string;
  remoteUsername?: string;
  deployStack?: string;
  deployMode?: string;
  workspace: string;
  repoPath: string;
  uploadPath: string;
  outputPath: string;
  status: TaskStatus;
  pipelineTesting: boolean;
  createdAt: string;
  updatedAt: string;
  exitCode?: number;
  error?: string;
}

interface CreateTaskOptions {
  targetUrl?: string;
  projectName: string;
  fileName: string;
  scanMode: ScanMode;
  remoteConfig?: RemoteLinuxConfig;
  pipelineTesting: boolean;
  body: Buffer;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..', '..');
const dataDir = path.join(root, 'web-data');
const uploadsDir = path.join(dataDir, 'uploads');
const reportsDir = path.join(dataDir, 'reports');
const tasksFile = path.join(dataDir, 'tasks.json');
const envFile = path.join(root, '.env');

const providerPresets: Record<Provider, ProviderPreset> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', smallModel: 'deepseek-chat', mediumModel: 'deepseek-chat', largeModel: 'deepseek-reasoner', reason: 'medium' },
  qwen: { baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', smallModel: 'qwen-turbo', mediumModel: 'qwen-plus', largeModel: 'qwen-max', reason: 'medium' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', smallModel: 'glm-4-flash', mediumModel: 'glm-4-plus', largeModel: 'glm-4-plus', reason: 'medium' },
  moonshot: { baseUrl: 'https://api.moonshot.cn/v1', smallModel: 'moonshot-v1-8k', mediumModel: 'moonshot-v1-32k', largeModel: 'moonshot-v1-128k', reason: 'medium' },
  baichuan: { baseUrl: 'https://api.baichuan-ai.com/v1', smallModel: 'Baichuan4-Turbo', mediumModel: 'Baichuan4', largeModel: 'Baichuan4', reason: 'medium' },
  minimax: { baseUrl: 'https://api.minimax.chat/v1', smallModel: 'abab6.5s-chat', mediumModel: 'abab6.5g-chat', largeModel: 'abab6.5g-chat', reason: 'medium' },
  doubao: { baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', smallModel: 'doubao-1-5-lite-32k', mediumModel: 'doubao-1-5-pro-32k', largeModel: 'doubao-1-5-pro-256k', reason: 'medium' },
  yi: { baseUrl: 'https://api.lingyiwanwu.com/v1', smallModel: 'yi-lightning', mediumModel: 'yi-large', largeModel: 'yi-large', reason: 'medium' },
  siliconflow: { baseUrl: 'https://api.siliconflow.cn/v1', smallModel: 'Qwen/Qwen2.5-7B-Instruct', mediumModel: 'Qwen/Qwen2.5-32B-Instruct', largeModel: 'deepseek-ai/DeepSeek-R1', reason: 'medium' },
  openai: { baseUrl: 'https://api.openai.com/v1', smallModel: 'gpt-4o-mini', mediumModel: 'gpt-4o', largeModel: 'gpt-4o', reason: 'medium' },
  'openai-compatible': { baseUrl: 'https://api.example.com/v1', smallModel: '', mediumModel: '', largeModel: '', reason: 'medium' },
  anthropic: { baseUrl: 'https://api.anthropic.com', smallModel: 'claude-3-5-haiku-latest', mediumModel: 'claude-3-5-sonnet-latest', largeModel: 'claude-3-5-sonnet-latest', reason: 'medium' },
};

function ensureDirs(): void {
  for (const dir of [dataDir, uploadsDir, reportsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(tasksFile)) fs.writeFileSync(tasksFile, '[]\n');
}

function loadDotEnvIntoProcess(): void {
  const values = parseEnv();
  for (const [key, value] of Object.entries(values)) {
    if (!process.env[key]) process.env[key] = value;
  }
}

function readTasks(): TaskRecord[] {
  ensureDirs();
  try {
    return JSON.parse(fs.readFileSync(tasksFile, 'utf8')) as TaskRecord[];
  } catch {
    return [];
  }
}

function saveTasks(tasks: TaskRecord[]): void {
  ensureDirs();
  fs.writeFileSync(tasksFile, `${JSON.stringify(tasks, null, 2)}\n`);
}

function updateTask(id: string, patch: Partial<TaskRecord>): TaskRecord | undefined {
  const tasks = readTasks();
  const index = tasks.findIndex((task) => task.id === id);
  if (index < 0) return undefined;
  const current = tasks[index];
  if (!current) return undefined;
  const next: TaskRecord = { ...current, ...patch, updatedAt: new Date().toISOString() };
  tasks[index] = next;
  saveTasks(tasks);
  return next;
}

function removeTask(id: string): TaskRecord | undefined {
  const tasks = readTasks();
  const task = tasks.find((item) => item.id === id);
  saveTasks(tasks.filter((item) => item.id !== id));
  return task;
}

function parseEnv(): Record<string, string> {
  if (!fs.existsSync(envFile)) return {};
  const values: Record<string, string> = {};
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const [name, ...rest] = line.split('=');
    if (!name) continue;
    values[name.trim()] = rest.join('=').trim().replace(/^["']|["']$/g, '');
  }
  return values;
}

function writeEnv(updates: Record<string, string>): void {
  const current = parseEnv();
  const merged = { ...current, ...updates };
  const order = [
    'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    'SHANNON_AI_PROVIDER',
    'DEEPSEEK_API_KEY',
    'OPENAI_COMPAT_API_KEY',
    'OPENAI_COMPAT_BASE_URL',
    'OPENAI_COMPAT_SMALL_MODEL',
    'OPENAI_COMPAT_MEDIUM_MODEL',
    'OPENAI_COMPAT_LARGE_MODEL',
    'OPENAI_COMPAT_REASON',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_BASE_URL',
  ];
  const keys = [...order, ...Object.keys(merged).filter((key) => !order.includes(key))];
  const lines = keys.filter((key) => merged[key] !== undefined).map((key) => `${key}=${merged[key] ?? ''}`);
  fs.writeFileSync(envFile, `${lines.join('\n')}\n`);
}

function readSettings(): Settings {
  const env = parseEnv();
  const rawProvider = env.SHANNON_AI_PROVIDER || 'deepseek';
  const provider: Provider = rawProvider in providerPresets ? (rawProvider as Provider) : 'deepseek';
  const preset = providerPresets[provider];
  const key = env.OPENAI_COMPAT_API_KEY || env.DEEPSEEK_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY || '';
  return {
    provider,
    apiKeyConfigured: key.length > 0,
    baseUrl: env.OPENAI_COMPAT_BASE_URL || preset.baseUrl,
    smallModel: env.OPENAI_COMPAT_SMALL_MODEL || preset.smallModel,
    mediumModel: env.OPENAI_COMPAT_MEDIUM_MODEL || preset.mediumModel,
    largeModel: env.OPENAI_COMPAT_LARGE_MODEL || preset.largeModel,
    reason: env.OPENAI_COMPAT_REASON || preset.reason,
  };
}

function saveSettings(input: SettingsInput): Settings {
  const provider: Provider = input.provider && input.provider in providerPresets ? input.provider : 'deepseek';
  const preset = providerPresets[provider];
  const updates: Record<string, string> = {
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
    SHANNON_AI_PROVIDER: provider,
    OPENAI_COMPAT_BASE_URL: input.baseUrl || preset.baseUrl,
    OPENAI_COMPAT_SMALL_MODEL: input.smallModel || preset.smallModel,
    OPENAI_COMPAT_MEDIUM_MODEL: input.mediumModel || preset.mediumModel,
    OPENAI_COMPAT_LARGE_MODEL: input.largeModel || preset.largeModel,
    OPENAI_COMPAT_REASON: input.reason || preset.reason,
  };
  if (input.apiKey?.trim()) {
    updates.OPENAI_COMPAT_API_KEY = input.apiKey.trim();
    if (provider === 'deepseek') updates.DEEPSEEK_API_KEY = input.apiKey.trim();
    if (provider === 'anthropic') updates.ANTHROPIC_API_KEY = input.apiKey.trim();
  }
  writeEnv(updates);
  return readSettings();
}

function json(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function text(res: http.ServerResponse, status: number, value: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type });
  res.end(value);
}

function readBody(req: http.IncomingMessage, maxBytes = 600 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('涓婁紶鏂囦欢瓒呰繃闄愬埗'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeName(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
  return cleaned || fallback;
}

function assertInside(base: string, target: string): void {
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`鍘嬬缉鍖呭寘鍚笉瀹夊叏璺緞: ${target}`);
  }
}

function extractZip(zipPath: string, targetDir: string): void {
  const archive = new AdmZip(zipPath);
  for (const entry of archive.getEntries()) {
    const destination = path.resolve(targetDir, entry.entryName);
    assertInside(targetDir, destination);
    if (entry.isDirectory) {
      fs.mkdirSync(destination, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, entry.getData());
  }
}

function extractTar(archivePath: string, targetDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xf', archivePath, '-C', targetDir], { cwd: root });
    let stderr = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `tar exited with ${code}`));
    });
  });
}

async function extractUpload(uploadPath: string, repoPath: string, fileName: string): Promise<void> {
  fs.mkdirSync(repoPath, { recursive: true });
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) {
    extractZip(uploadPath, repoPath);
    return;
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')) {
    await extractTar(uploadPath, repoPath);
    return;
  }
  throw new Error('Only .zip, .tar, .tar.gz and .tgz archives are supported');
}

function getWorkspacePath(task: TaskRecord): string {
  return path.join(root, 'workspaces', task.workspace);
}

function deletePath(targetPath: string): void {
  if (!targetPath) return;
  const resolved = path.resolve(targetPath);
  const allowedRoots = [path.resolve(dataDir), path.resolve(path.join(root, 'workspaces'))];
  if (!allowedRoots.some((allowed) => resolved === allowed || resolved.startsWith(`${allowed}${path.sep}`))) {
    throw new Error(`鎷掔粷鍒犻櫎闈炰换鍔＄洰褰? ${targetPath}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
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

function statusFromLog(log: string, fallback: TaskStatus): TaskStatus {
  if (/Workflow COMPLETED|COMPLETED/i.test(log)) return 'completed';
  if (/Workflow FAILED|FAILED|API Error|Insufficient Balance/i.test(log)) return 'failed';
  if (/\[PHASE\]|Starting|Workflow/i.test(log)) return 'running';
  return fallback;
}

function listFiles(dir: string): { name: string; size: number; mtime: string }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isFile())
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, mtime: stat.mtime.toISOString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function progressForStatus(status: TaskStatus): { percent: number; stage: string; message: string } {
  switch (status) {
    case 'queued':
      return { percent: 5, stage: '排队中', message: '任务已创建，正在准备处理。' };
    case 'deploying':
      return { percent: 35, stage: '远程部署', message: '正在上传代码、释放端口并启动目标服务。' };
    case 'starting':
      return { percent: 45, stage: '目标探测', message: '正在检查目标 URL 可达性。' };
    case 'testing':
      return { percent: 60, stage: '动态检测', message: '正在对目标 URL 做轻量动态检测。' };
    case 'auditing':
      return { percent: 82, stage: '源码审计', message: '正在分析代码结构并生成中文报告。' };
    case 'running':
      return { percent: 70, stage: '运行中', message: '任务正在执行。' };
    case 'completed':
      return { percent: 100, stage: '已完成', message: '报告已生成，可以下载。' };
    case 'failed':
      return { percent: 100, stage: '失败', message: '任务失败，请查看日志中的错误信息。' };
  }
}

function friendlyErrorMessage(error: string): string {
  if (!error) return '任务失败，请查看日志中的错误信息。';
  if (/All configured authentication methods failed|Authentication failed|Permission denied/i.test(error)) {
    return 'SSH 登录失败：请检查 Linux 用户名、密码，以及目标机是否允许该用户通过密码登录。';
  }
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|readyTimeout|Timed out/i.test(error)) {
    return '无法连接远程 Linux：请检查 IP、SSH 端口、防火墙和虚拟机网络。';
  }
  if (/No space left on device/i.test(error)) {
    return '远程 Linux 磁盘空间不足：请清理空间后重试。';
  }
  if (/Docker Desktop 未启动|Docker Engine is not running|Docker CLI was not found|dockerDesktopLinuxEngine|daemon is running/i.test(error)) {
    return 'Docker Desktop 未启动或 Docker Engine 不可用：后两种模式会调用原版 Shannon 检测 worker，请先启动 Docker Desktop，确认 Docker Engine running 后重试。';
  }
  return `任务失败：${error}`;
}

function writeSummaryReport(task: TaskRecord): void {
  const deliverables = path.join(getWorkspacePath(task), 'deliverables');
  fs.mkdirSync(deliverables, { recursive: true });
  const files = listFiles(deliverables).filter((file) => file.name !== 'summary_report.md');
  const progress = progressForStatus(task.status);
  const report = `# 任务总览报告

项目：${task.name}

## 任务状态

- 当前状态：${progress.stage}
- 扫描方式：${task.scanMode}
- 目标地址：${task.detectedUrl || task.targetUrl || '无'}
- 远程主机：${task.remoteHost || '无'}
- 部署类型：${task.deployStack || '无'}
- 更新时间：${task.updatedAt}

## 已生成报告

${files.length ? files.map((file) => `- ${file.name}`).join('\n') : '- 暂无'}

## 使用建议

1. 先阅读本总览，再看部署诊断或 URL 诊断。
2. 源码审计报告中的风险线索需要结合调用链人工复核。
3. 如果远程服务启动异常，优先查看 \`remote_deployment_diagnosis.md\` 中的运行日志。
4. 如果需要看目标 URL 的访问面，查看 \`dynamic_url_audit_report.md\`。
`;
  fs.writeFileSync(path.join(deliverables, 'summary_report.md'), `\uFEFF${report}`, 'utf8');
}

async function probeHttp(url: string): Promise<{ ok: boolean; status: string; finalUrl: string; error: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timer);
    return { ok: response.status < 500, status: String(response.status), finalUrl: response.url, error: '' };
  } catch (error) {
    return { ok: false, status: 'unreachable', finalUrl: url, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runTask(task: TaskRecord, remoteConfig?: RemoteLinuxConfig): Promise<void> {
  try {
    if (task.scanMode === 'source-only') {
      updateTask(task.id, { status: 'auditing' });
      runSourceAudit({
        repoPath: task.repoPath,
        workspacePath: getWorkspacePath(task),
        projectName: task.name,
        logPath: path.join(path.dirname(task.uploadPath), 'task.log'),
      });
      const completed = updateTask(task.id, { status: 'completed' }) ?? { ...task, status: 'completed' as const };
      writeSummaryReport(completed);
      return;
    }

    if (task.scanMode === 'remote-linux') {
      if (!remoteConfig) throw new Error('缂哄皯 Linux 杩炴帴淇℃伅');
      updateTask(task.id, { status: 'deploying' });
      const deployLogPath = path.join(path.dirname(task.uploadPath), 'task.log');
      const result = await remoteDeploy({
        taskId: task.id,
        repoPath: task.repoPath,
        uploadPath: task.uploadPath,
        fileName: path.basename(task.uploadPath),
        logPath: deployLogPath,
        config: remoteConfig,
      });
      const updated = updateTask(task.id, {
        targetUrl: result.targetUrl,
        detectedUrl: result.targetUrl,
        deployStack: result.stack,
        deployMode: result.mode,
      });
      const deployedTask = updated ?? { ...task, targetUrl: result.targetUrl, detectedUrl: result.targetUrl, deployStack: result.stack, deployMode: result.mode };
      writeRemoteDeploymentReport(deployedTask, result);
      updateTask(task.id, { status: 'testing' });
      await runOriginalShannonScan({
        root,
        targetUrl: result.targetUrl,
        repoPath: task.repoPath,
        workspaceName: task.workspace,
        outputPath: getWorkspacePath(deployedTask),
        logPath: deployLogPath,
        pipelineTesting: task.pipelineTesting,
      });
      const completed = updateTask(task.id, { status: 'completed' }) ?? { ...deployedTask, status: 'completed' as const };
      writeSummaryReport(completed);
      return;
    }

    if (task.scanMode === 'manual-url') {
      const logPath = path.join(path.dirname(task.uploadPath), 'task.log');
      updateTask(task.id, { status: 'starting' });
      fs.appendFileSync(logPath, `[manual-url] Probe target URL: ${task.targetUrl}\n`, 'utf8');
      const probe = await probeHttp(task.targetUrl);
      fs.appendFileSync(logPath, `[manual-url] HTTP status: ${probe.status}${probe.error ? `, error: ${probe.error}` : ''}\n`, 'utf8');
      const updated = updateTask(task.id, { detectedUrl: probe.finalUrl });
      writeManualUrlReport(updated ?? task, probe);
      updateTask(task.id, { status: 'testing' });
      await runOriginalShannonScan({
        root,
        targetUrl: probe.finalUrl || task.targetUrl,
        repoPath: task.repoPath,
        workspaceName: task.workspace,
        outputPath: getWorkspacePath(updated ?? task),
        logPath,
        pipelineTesting: task.pipelineTesting,
      });
      const completed = updateTask(task.id, { status: 'completed' }) ?? { ...(updated ?? task), status: 'completed' as const };
      writeSummaryReport(completed);
      return;
    }

    throw new Error('Unsupported scan mode');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const logPath = path.join(path.dirname(task.uploadPath), 'task.log');
    fs.appendFileSync(logPath, `\n[error] ${friendlyErrorMessage(message)}\n[error-detail] ${message}\n`, 'utf8');
    updateTask(task.id, { status: 'failed', error: message });
  }
}

async function createTask(options: CreateTaskOptions): Promise<TaskRecord> {
  const id = crypto.randomUUID();
  const taskName = safeName(options.projectName, `scan-${id.slice(0, 8)}`);
  const fileName = safeName(options.fileName, 'source.zip');
  const taskDir = path.join(uploadsDir, id);
  const uploadPath = path.join(taskDir, fileName);
  const repoPath = path.join(taskDir, 'repo');
  const outputPath = path.join(reportsDir, id);
  const workspace = `${taskName}-${id.slice(0, 8)}`;
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(outputPath, { recursive: true });
  fs.writeFileSync(uploadPath, options.body);
  await extractUpload(uploadPath, repoPath, fileName);

  const now = new Date().toISOString();
  const task: TaskRecord = {
    id,
    name: taskName,
    targetUrl: options.targetUrl || '',
    workspace,
    repoPath,
    uploadPath,
    outputPath,
    scanMode: options.scanMode,
    ...(options.remoteConfig ? { remoteHost: options.remoteConfig.host, remoteUsername: options.remoteConfig.username } : {}),
    status: 'queued',
    pipelineTesting: options.pipelineTesting,
    createdAt: now,
    updatedAt: now,
  };
  const tasks = readTasks();
  tasks.unshift(task);
  saveTasks(tasks);
  void runTask(task, options.remoteConfig);
  return task;
}

function taskView(
  task: TaskRecord,
): TaskRecord & { liveStatus: TaskStatus; progress: { percent: number; stage: string; message: string }; files: { name: string; size: number; mtime: string }[] } {
  const workflowLog = readTail(path.join(getWorkspacePath(task), 'workflow.log'));
  const liveStatus = statusFromLog(workflowLog, task.status);
  if (liveStatus === 'completed') writeSummaryReport({ ...task, status: 'completed' });
  const progress = progressForStatus(liveStatus);
  if (liveStatus === 'failed') progress.message = friendlyErrorMessage(task.error || '');
  return { ...task, liveStatus, progress, files: listFiles(path.join(getWorkspacePath(task), 'deliverables')) };
}

function buildDownload(task: TaskRecord): Buffer {
  writeSummaryReport(task);
  const zip = new AdmZip();
  const deliverables = path.join(getWorkspacePath(task), 'deliverables');
  if (fs.existsSync(deliverables)) zip.addLocalFolder(deliverables, 'deliverables');
  const taskLog = path.join(path.dirname(task.uploadPath), 'task.log');
  const workflowLog = path.join(getWorkspacePath(task), 'workflow.log');
  if (fs.existsSync(taskLog)) zip.addLocalFile(taskLog, '', 'task.log');
  if (fs.existsSync(workflowLog)) zip.addLocalFile(workflowLog, '', 'workflow.log');
  return zip.toBuffer();
}

function writeRemoteDeploymentReport(
  task: TaskRecord,
  result: { targetUrl: string; stack: string; mode: string; remoteDir: string; healthOk: boolean; healthStatus: string; runtimeLog: string },
): void {
  const workspacePath = getWorkspacePath(task);
  const deliverables = path.join(workspacePath, 'deliverables');
  fs.mkdirSync(deliverables, { recursive: true });
  const report = `# 远程 Linux 部署诊断报告

项目：${task.name}

## 部署结果

- 目标地址：${result.targetUrl}
- 识别类型：${result.stack}
- 部署模式：${result.mode}
- 远程目录：${result.remoteDir}
- HTTP 状态：${result.healthStatus}
- 健康判断：${result.healthOk ? '通过' : '未通过，服务端口已打开，但页面返回异常状态'}

## 说明

当前任务已经在远程 Linux 上启动目标程序。若 HTTP 状态为 500，通常说明程序本身还缺少数据库、配置文件、安装初始化或外部依赖；这不代表上传和启动失败。远程部署完成后，平台会把目标 URL 继续交给原版 Shannon 检测流程。

## 运行日志片段

\`\`\`text
${result.runtimeLog || '未读取到运行日志。'}
\`\`\`
`;
  fs.writeFileSync(path.join(deliverables, 'remote_deployment_diagnosis.md'), `\uFEFF${report}`, 'utf8');
}

function writeManualUrlReport(task: TaskRecord, probe: { ok: boolean; status: string; finalUrl: string; error: string }): void {
  const workspacePath = getWorkspacePath(task);
  const deliverables = path.join(workspacePath, 'deliverables');
  fs.mkdirSync(deliverables, { recursive: true });
  const report = `# 已有 URL 目标诊断报告

项目：${task.name}

## 目标信息

- 输入 URL：${task.targetUrl}
- 最终 URL：${probe.finalUrl}
- HTTP 状态：${probe.status}
- 可达性：${probe.ok ? '可访问' : '不可访问或返回服务端异常'}

${probe.error ? `## 错误信息\n\n\`\`\`text\n${probe.error}\n\`\`\`\n` : ''}
## 说明

当前 Web 版本不再走本机容器部署流程。URL 模式会保留目标可达性信息，并继续生成源码审计报告。需要动态验证时，请确保目标站点已经由你自行或远程 Linux 模式启动。
`;
  fs.writeFileSync(path.join(deliverables, 'target_url_diagnosis.md'), `\uFEFF${report}`, 'utf8');
}

function stopTask(task: TaskRecord): TaskRecord {
  return updateTask(task.id, { status: 'failed', error: '用户手动停止任务' }) ?? task;
}

function deleteTask(task: TaskRecord): void {
  stopTask(task);
  removeTask(task.id);
  deletePath(path.dirname(task.uploadPath));
  deletePath(task.outputPath);
  deletePath(getWorkspacePath(task));
}

function restartTask(task: TaskRecord, remotePassword?: string): TaskRecord {
  stopTask(task);
  deletePath(task.outputPath);
  deletePath(getWorkspacePath(task));
  fs.mkdirSync(task.outputPath, { recursive: true });
  fs.mkdirSync(getWorkspacePath(task), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(task.uploadPath), 'task.log'), `[system] Restart task at ${new Date().toISOString()}\n`);

  const resetPatch: Partial<TaskRecord> = {
    status: 'queued',
    targetUrl: task.scanMode === 'remote-linux' ? '' : task.targetUrl,
    error: '',
    deployStack: '',
    deployMode: '',
    detectedUrl: '',
  };
  const updated = updateTask(task.id, resetPatch) ?? task;

  if (updated.scanMode === 'remote-linux') {
    if (!updated.remoteHost || !updated.remoteUsername || !remotePassword) {
      throw new Error('杩滅▼ Linux 浠诲姟閲嶅惎闇€瑕侀噸鏂拌緭鍏?SSH 瀵嗙爜');
    }
    void runTask(updated, {
      host: updated.remoteHost,
      port: 22,
      username: updated.remoteUsername,
      password: remotePassword,
    });
  } else {
    void runTask(updated);
  }

  return updated;
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Shannon Web 管理端</title>
  <style>
    :root { font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; color: #172033; background: #f4f6f8; }
    body { margin: 0; }
    header { background: #17324d; color: #fff; padding: 18px 28px; }
    main { padding: 22px 28px; display: grid; gap: 18px; max-width: 1180px; margin: 0 auto; }
    h1 { margin: 0; font-size: 22px; }
    h2 { margin: 0 0 12px; font-size: 17px; }
    section { background: #fff; border: 1px solid #d9e0ea; border-radius: 6px; padding: 16px; }
    label { display: grid; gap: 6px; color: #42526b; font-size: 13px; }
    input, select { height: 36px; border: 1px solid #ccd5e1; border-radius: 4px; padding: 0 10px; font-size: 14px; }
    input[type=file] { padding: 7px 10px; height: auto; }
    button { height: 36px; border: 0; border-radius: 4px; background: #0b64c0; color: #fff; padding: 0 14px; cursor: pointer; }
    button.secondary { background: #475467; }
    button.danger { background: #b42318; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid #e6ebf2; padding: 8px; text-align: left; vertical-align: top; }
    pre { min-height: 260px; max-height: 520px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: #101828; color: #d1fadf; padding: 14px; border-radius: 6px; }
    .hint { color: #667085; font-size: 13px; }
    .status { font-weight: 700; }
    .progress { width: 100%; height: 12px; background: #e6ebf2; border-radius: 999px; overflow: hidden; }
    .progress > span { display: block; height: 100%; width: 0%; background: #0b64c0; transition: width .25s ease; }
    .progress.failed > span { background: #b42318; }
    .progress.done > span { background: #09845a; }
    .progressMeta { margin: 8px 0 12px; color: #42526b; font-size: 13px; }
    @media (max-width: 760px) { main { padding: 14px; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header><h1>Shannon Web 管理端</h1></header>
  <main>
    <section>
      <h2>AI 接口配置</h2>
      <div class="grid">
        <label>模型平台
          <select id="provider">
            <option value="deepseek">DeepSeek</option>
            <option value="qwen">通义千问 / 阿里云百炼</option>
            <option value="zhipu">智谱 GLM</option>
            <option value="moonshot">Moonshot / Kimi</option>
            <option value="baichuan">百川智能</option>
            <option value="minimax">MiniMax</option>
            <option value="doubao">豆包 / 火山方舟</option>
            <option value="yi">零一万物 Yi</option>
            <option value="siliconflow">硅基流动</option>
            <option value="openai">OpenAI / GPT</option>
            <option value="openai-compatible">OpenAI 兼容接口</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label>API Key
          <input id="apiKey" type="password" placeholder="留空表示保留原 Key" />
        </label>
        <label>Base URL <input id="baseUrl" /></label>
        <label>推理强度 <input id="reason" value="medium" /></label>
        <label>小模型 <input id="smallModel" /></label>
        <label>中模型 <input id="mediumModel" /></label>
        <label>大模型 <input id="largeModel" /></label>
      </div>
      <p class="hint" id="settingsHint"></p>
      <button id="saveSettings">保存配置</button>
    </section>

    <section>
      <h2>上传代码并创建扫描</h2>
      <div class="grid">
        <label>项目名称 <input id="projectName" placeholder="例如 cms-v3344" /></label>
        <label>扫描方式
          <select id="scanModeKind">
            <option value="source-only">只上传代码进行源码审计</option>
            <option value="manual-url">我已经搭建好了环境或有公网 URL</option>
            <option value="remote-linux">输入 Linux 虚拟机信息并远程部署</option>
          </select>
        </label>
        <label>目标 URL <input id="targetUrl" placeholder="仅 URL 模式必填，例如 http://example.com" /></label>
        <label>Linux IP <input id="linuxHost" placeholder="例如 192.168.3.200" /></label>
        <label>Linux SSH 端口 <input id="linuxPort" value="22" /></label>
        <label>Linux 用户名 <input id="linuxUser" placeholder="root" /></label>
        <label>Linux 密码 <input id="linuxPassword" type="password" autocomplete="new-password" spellcheck="false" placeholder="仅本次任务使用，不保存" /></label>
        <label>代码包 <input id="sourceFile" type="file" accept=".zip,.tar,.gz,.tgz" /></label>
        <label>审计强度
          <select id="scanMode">
            <option value="standard">标准模式</option>
            <option value="quick">快速测试模式</option>
          </select>
        </label>
      </div>
      <p class="hint">远程部署采用 Linux 原生最低运行标准，不用 Docker 搭目标站；URL 模式和远程模式会继续调用原版 Shannon 检测流程，因此运行检测端本机需要可用的 Docker。</p>
      <button id="createTask">开始扫描</button>
    </section>

    <section>
      <div class="row"><h2 style="margin-right:auto">任务列表</h2><button class="secondary" id="refreshTasks">刷新</button></div>
      <table><thead><tr><th>项目</th><th>目标</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="tasks"></tbody></table>
    </section>

    <section>
      <div class="row"><h2 style="margin-right:auto">实时进度</h2><span class="hint" id="currentTask">未选择任务</span></div>
      <div class="progress" id="progressBar"><span></span></div>
      <div class="progressMeta" id="progressMeta">等待选择任务。</div>
      <pre id="logs">请选择一个任务查看日志。</pre>
    </section>
  </main>
  <script>
    let selectedTask = "";
    const $ = (id) => document.getElementById(id);
    const providerPresets = ${JSON.stringify(providerPresets)};

    async function api(path, options) {
      const res = await fetch(path, options);
      if (!res.ok) throw new Error(await res.text());
      const type = res.headers.get("content-type") || "";
      return type.includes("application/json") ? res.json() : res.text();
    }

    async function loadSettings() {
      const s = await api("/api/settings");
      $("provider").value = s.provider;
      $("baseUrl").value = s.baseUrl;
      $("smallModel").value = s.smallModel;
      $("mediumModel").value = s.mediumModel;
      $("largeModel").value = s.largeModel;
      $("reason").value = s.reason;
      $("settingsHint").textContent = s.apiKeyConfigured ? "当前已配置 API Key。" : "当前还没有配置 API Key。";
    }

    function applyProviderPreset() {
      const p = providerPresets[$("provider").value];
      if (!p) return;
      $("baseUrl").value = p.baseUrl || "";
      $("smallModel").value = p.smallModel || "";
      $("mediumModel").value = p.mediumModel || "";
      $("largeModel").value = p.largeModel || "";
      $("reason").value = p.reason || "medium";
    }

    async function saveSettings() {
      await api("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: $("provider").value,
          apiKey: $("apiKey").value,
          baseUrl: $("baseUrl").value,
          smallModel: $("smallModel").value,
          mediumModel: $("mediumModel").value,
          largeModel: $("largeModel").value,
          reason: $("reason").value,
        })
      });
      $("apiKey").value = "";
      await loadSettings();
      alert("配置已保存");
    }

    async function createTask() {
      const file = $("sourceFile").files[0];
      if (!file) return alert("请先选择代码包");
      const scanModeKind = $("scanModeKind").value;
      const targetUrl = $("targetUrl").value.trim();
      if (scanModeKind === "manual-url" && !targetUrl) return alert("URL 模式请填写目标 URL");
      if (scanModeKind === "remote-linux" && (!$("linuxHost").value.trim() || !$("linuxUser").value.trim() || !$("linuxPassword").value)) {
        return alert("远程部署模式请填写 Linux IP、用户名和密码");
      }
      const task = await api("/api/tasks", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-target-url": encodeURIComponent(targetUrl),
          "x-project-name": encodeURIComponent($("projectName").value || "scan"),
          "x-scan-mode": scanModeKind,
          "x-linux-host": encodeURIComponent($("linuxHost").value.trim()),
          "x-linux-port": encodeURIComponent($("linuxPort").value.trim() || "22"),
          "x-linux-user": encodeURIComponent($("linuxUser").value.trim()),
          "x-linux-password": encodeURIComponent($("linuxPassword").value),
          "x-pipeline-testing": $("scanMode").value === "quick" ? "1" : "0"
        },
        body: await file.arrayBuffer()
      });
      $("linuxPassword").value = "";
      selectedTask = task.id;
      await refreshTasks();
      await loadLogs();
    }

    async function refreshTasks() {
      const tasks = await api("/api/tasks");
      $("tasks").innerHTML = tasks.map((task) => '<tr>' +
        '<td>' + escapeHtml(task.name) + '<br><span class="hint">' + task.id.slice(0, 8) + '</span></td>' +
        '<td>' + escapeHtml(task.detectedUrl || task.targetUrl || modeLabel(task.scanMode)) + '<br><span class="hint">' + escapeHtml(task.scanMode || '') + (task.remoteHost ? ' / ' + escapeHtml(task.remoteHost) : '') + (task.deployStack ? ' / ' + escapeHtml(task.deployStack) : '') + '</span></td>' +
        '<td class="status">' + escapeHtml((task.progress && task.progress.stage) || task.liveStatus || task.status) + '<br><span class="hint">' + ((task.progress && task.progress.percent) || 0) + '%</span></td>' +
        '<td>' + new Date(task.createdAt).toLocaleString() + '</td>' +
        '<td class="row"><button onclick="selectTask(\\'' + task.id + '\\')">查看</button><button class="secondary" onclick="downloadTask(\\'' + task.id + '\\')">下载</button><button class="secondary" onclick="restartTask(\\'' + task.id + '\\', \\'' + (task.scanMode || '') + '\\')">重启</button><button class="secondary" onclick="stopTask(\\'' + task.id + '\\')">停止</button><button class="danger" onclick="deleteTask(\\'' + task.id + '\\')">删除</button></td>' +
      '</tr>').join("");
    }

    function selectTask(id) { selectedTask = id; loadLogs(); }
    function downloadTask(id) { window.location.href = "/api/tasks/" + id + "/download"; }

    async function restartTask(id, scanMode) {
      if (!confirm("确定重启这个任务吗？")) return;
      const headers = {};
      if (scanMode === "remote-linux") {
        const password = prompt("请输入远程 Linux SSH 密码，用于本次重启：");
        if (!password) return;
        headers["x-linux-password"] = encodeURIComponent(password);
      }
      await api("/api/tasks/" + id + "/restart", { method: "POST", headers });
      selectedTask = id;
      await refreshTasks();
      await loadLogs();
    }

    async function stopTask(id) {
      if (!confirm("确定停止这个任务吗？")) return;
      await api("/api/tasks/" + id + "/stop", { method: "POST" });
      await refreshTasks();
      if (selectedTask === id) await loadLogs();
    }

    async function deleteTask(id) {
      if (!confirm("确定删除这个任务及本地上传、报告和 workspace 数据吗？")) return;
      await api("/api/tasks/" + id, { method: "DELETE" });
      if (selectedTask === id) {
        selectedTask = "";
        $("currentTask").textContent = "未选择任务";
        $("logs").textContent = "请选择一个任务查看日志。";
      }
      await refreshTasks();
    }

    function modeLabel(mode) {
      if (mode === "source-only") return "纯源码审计";
      if (mode === "remote-linux") return "远程部署中";
      return "未填写";
    }

    async function loadLogs() {
      if (!selectedTask) return;
      const data = await api("/api/tasks/" + selectedTask + "/logs");
      const progress = data.progress || { percent: 0, stage: data.status || "未知", message: "" };
      $("currentTask").textContent = data.name + " / " + progress.stage;
      $("progressBar").className = "progress" + (data.status === "failed" ? " failed" : data.status === "completed" ? " done" : "");
      $("progressBar").querySelector("span").style.width = progress.percent + "%";
      $("progressMeta").textContent = progress.percent + "% - " + progress.message + (data.files && data.files.length ? " 已生成 " + data.files.length + " 个报告文件。" : "");
      $("logs").textContent = data.log || "暂无日志";
      $("logs").scrollTop = $("logs").scrollHeight;
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
    }

    $("saveSettings").onclick = () => saveSettings().catch((err) => alert(err.message));
    $("provider").onchange = applyProviderPreset;
    $("createTask").onclick = () => createTask().catch((err) => alert(err.message));
    $("refreshTasks").onclick = () => refreshTasks().catch((err) => alert(err.message));
    setInterval(() => { refreshTasks(); loadLogs(); }, 1000);
    loadSettings().then(refreshTasks).catch((err) => alert(err.message));
  </script>
</body>
</html>`;
}
function routeTaskId(pathname: string): { id: string; action: 'logs' | 'download' | 'stop' | 'restart' | 'delete' } | undefined {
  const actionMatch = /^\/api\/tasks\/([^/]+)\/(logs|download|stop|restart)$/.exec(pathname);
  if (
    actionMatch?.[1] &&
    (actionMatch[2] === 'logs' || actionMatch[2] === 'download' || actionMatch[2] === 'stop' || actionMatch[2] === 'restart')
  ) {
    return { id: actionMatch[1], action: actionMatch[2] };
  }
  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (taskMatch?.[1]) return { id: taskMatch[1], action: 'delete' };
  return undefined;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    text(res, 200, htmlPage(), 'text/html; charset=utf-8');
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'GET') {
    json(res, 200, readSettings());
    return;
  }

  if (url.pathname === '/api/settings' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8')) as SettingsInput;
    json(res, 200, saveSettings(body));
    return;
  }

  if (url.pathname === '/api/tasks' && req.method === 'GET') {
    json(res, 200, readTasks().map(taskView));
    return;
  }

  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    const fileName = decodeURIComponent(String(req.headers['x-file-name'] || 'source.zip'));
    const targetUrl = decodeURIComponent(String(req.headers['x-target-url'] || ''));
    const projectName = decodeURIComponent(String(req.headers['x-project-name'] || 'scan'));
    const rawMode = String(req.headers['x-scan-mode'] || 'source-only');
    const scanMode: ScanMode = rawMode === 'manual-url' || rawMode === 'remote-linux' ? rawMode : 'source-only';
    const linuxHost = decodeURIComponent(String(req.headers['x-linux-host'] || ''));
    const linuxPort = Number(decodeURIComponent(String(req.headers['x-linux-port'] || '22')));
    const linuxUser = decodeURIComponent(String(req.headers['x-linux-user'] || ''));
    const linuxPassword = decodeURIComponent(String(req.headers['x-linux-password'] || ''));
    const pipelineTesting = String(req.headers['x-pipeline-testing'] || '0') === '1';
    if (scanMode === 'manual-url' && !targetUrl) throw new Error('URL 妯″紡涓嬬洰鏍?URL 涓嶈兘涓虹┖');
    let remoteConfig: RemoteLinuxConfig | undefined;
    if (scanMode === 'remote-linux') {
      if (!linuxHost || !linuxUser || !linuxPassword) throw new Error('Remote Linux mode requires Linux IP, username and password');
      remoteConfig = { host: linuxHost, port: Number.isInteger(linuxPort) ? linuxPort : 22, username: linuxUser, password: linuxPassword };
    }
    const body = await readBody(req);
    const task = await createTask({
      targetUrl,
      projectName,
      fileName,
      scanMode,
      ...(remoteConfig ? { remoteConfig } : {}),
      pipelineTesting,
      body,
    });
    json(res, 200, taskView(task));
    return;
  }

  const taskRoute = routeTaskId(url.pathname);
  if (taskRoute) {
    const task = readTasks().find((item) => item.id === taskRoute.id);
    if (!task) {
      json(res, 404, { error: 'Task not found' });
      return;
    }

    if (taskRoute.action === 'logs') {
      const taskLog = readTail(path.join(path.dirname(task.uploadPath), 'task.log'));
      const workflowLog = readTail(path.join(getWorkspacePath(task), 'workflow.log'));
      const view = taskView(task);
      json(res, 200, {
        id: task.id,
        name: task.name,
        status: view.liveStatus,
        progress: view.progress,
        files: view.files,
        log: `${taskLog}\n\n${workflowLog}`.trim(),
      });
      return;
    }

    if (taskRoute.action === 'stop' && req.method === 'POST') {
      json(res, 200, taskView(stopTask(task)));
      return;
    }

    if (taskRoute.action === 'restart' && req.method === 'POST') {
      const remotePassword = decodeURIComponent(String(req.headers['x-linux-password'] || ''));
      json(res, 200, taskView(restartTask(task, remotePassword || undefined)));
      return;
    }

    if (taskRoute.action === 'delete' && req.method === 'DELETE') {
      deleteTask(task);
      json(res, 200, { ok: true });
      return;
    }

    if (taskRoute.action === 'download') {
      const archive = buildDownload(task);
      res.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${task.name}-report.zip"`,
      });
      res.end(archive);
      return;
    }

    json(res, 405, { error: 'Method not allowed' });
    return;
  }

  json(res, 404, { error: 'Not found' });
}

function main(): void {
  ensureDirs();
  loadDotEnvIntoProcess();
  const port = Number(process.env.SHANNON_WEB_PORT || '8787');
  const host = process.env.SHANNON_WEB_HOST || '127.0.0.1';
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: message });
    });
  });
  server.listen(port, host, () => {
    console.log(`Shannon Web 绠＄悊绔凡鍚姩: http://${host}:${port}`);
  });
}

main();


