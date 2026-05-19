import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { getWorkspacesDir } from '../home.js';

interface MonitorArgs {
  workspace: string;
  port: number;
  host: string;
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function readText(filePath: string, maxBytes = 64_000): string {
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

function resolveWorkspace(workspaceId: string): string {
  const workspacesDir = getWorkspacesDir();
  const directPath = path.join(workspacesDir, workspaceId);
  if (fs.existsSync(directPath)) return directPath;

  const resumeBase = workspaceId.replace(/_resume_\d+$/, '');
  if (resumeBase !== workspaceId) {
    const resumePath = path.join(workspacesDir, resumeBase);
    if (fs.existsSync(resumePath)) return resumePath;
  }

  const namedBase = workspaceId.replace(/_shannon-\d+$/, '');
  if (namedBase !== workspaceId) {
    const namedPath = path.join(workspacesDir, namedBase);
    if (fs.existsSync(namedPath)) return namedPath;
  }

  console.error(`ERROR: Workspace not found: ${workspaceId}`);
  console.error(`Checked under: ${workspacesDir}`);
  process.exit(1);
}

function listDeliverables(workspacePath: string): { name: string; size: number; mtime: string }[] {
  const dir = path.join(workspacePath, 'deliverables');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.md') || name.endsWith('.json'))
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, size: stat.size, mtime: stat.mtime.toLocaleString() };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function readSession(workspacePath: string): Record<string, unknown> | null {
  const filePath = path.join(workspacePath, 'session.json');
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function statusFromLog(log: string): string {
  if (/Workflow COMPLETED/.test(log)) return '已完成';
  if (/Workflow FAILED/.test(log)) return '失败';
  if (/\[PHASE\] Starting: reporting/.test(log)) return '正在生成报告';
  if (/\[PHASE\] Starting: vulnerability-exploitation/.test(log)) return '正在漏洞利用验证';
  if (/\[PHASE\] Starting: vulnerability-analysis/.test(log)) return '正在漏洞分析';
  if (/\[PHASE\] Starting: recon/.test(log)) return '正在探测';
  return '运行中或等待启动';
}

function renderPage(workspaceId: string, workspacePath: string): string {
  const log = readText(path.join(workspacePath, 'workflow.log'), 48_000);
  const session = readSession(workspacePath);
  const deliverables = listDeliverables(workspacePath);
  const reportPath = path.join(workspacePath, 'deliverables', 'comprehensive_security_assessment_report.md');
  const report = readText(reportPath, 40_000);
  const status = statusFromLog(log);
  const target = ((session?.session as Record<string, unknown> | undefined)?.webUrl as string | undefined) ?? '未知';

  const deliverableRows = deliverables
    .map(
      (file) =>
        `<tr><td><a href="/file/${encodeURIComponent(file.name)}">${escapeHtml(file.name)}</a></td><td>${file.size}</td><td>${escapeHtml(file.mtime)}</td></tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="5" />
  <title>Shannon 监控端 - ${escapeHtml(workspaceId)}</title>
  <style>
    :root { color-scheme: light; font-family: "Microsoft YaHei", "PingFang SC", Arial, sans-serif; }
    body { margin: 0; background: #f5f7fb; color: #172033; }
    header { background: #18324a; color: #fff; padding: 18px 28px; }
    main { padding: 22px 28px; display: grid; gap: 18px; }
    h1 { font-size: 22px; margin: 0 0 6px; }
    h2 { font-size: 16px; margin: 0 0 10px; }
    .grid { display: grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap: 12px; }
    .box { background: #fff; border: 1px solid #d9e0ea; border-radius: 6px; padding: 14px; }
    .label { color: #667085; font-size: 12px; margin-bottom: 6px; }
    .value { font-weight: 700; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid #e6ebf2; text-align: left; padding: 8px; }
    a { color: #0b64c0; }
    pre { margin: 0; white-space: pre-wrap; word-break: break-word; max-height: 520px; overflow: auto; background: #101828; color: #d1fadf; padding: 14px; border-radius: 6px; }
    .report { background: #fff; color: #172033; border: 1px solid #d9e0ea; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } main { padding: 14px; } }
  </style>
</head>
<body>
  <header>
    <h1>Shannon 中文监控端</h1>
    <div>每 5 秒自动刷新。Workspace: ${escapeHtml(workspaceId)}</div>
  </header>
  <main>
    <section class="grid">
      <div class="box"><div class="label">当前状态</div><div class="value">${escapeHtml(status)}</div></div>
      <div class="box"><div class="label">目标地址</div><div class="value">${escapeHtml(target)}</div></div>
      <div class="box"><div class="label">工作目录</div><div class="value">${escapeHtml(workspacePath)}</div></div>
      <div class="box"><div class="label">主报告</div><div class="value">${fs.existsSync(reportPath) ? '已生成' : '未生成'}</div></div>
    </section>
    <section class="box">
      <h2>报告文件</h2>
      <table><thead><tr><th>文件名</th><th>大小(Byte)</th><th>更新时间</th></tr></thead><tbody>${deliverableRows || '<tr><td colspan="3">暂无报告文件</td></tr>'}</tbody></table>
    </section>
    <section class="box">
      <h2>运行日志尾部</h2>
      <pre>${escapeHtml(log || '暂无日志')}</pre>
    </section>
    <section class="box">
      <h2>主报告预览</h2>
      <pre class="report">${escapeHtml(report || '主报告尚未生成')}</pre>
    </section>
  </main>
</body>
</html>`;
}

export function monitor(args: MonitorArgs): void {
  const workspacePath = resolveWorkspace(args.workspace);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${args.host}:${args.port}`);
    if (url.pathname.startsWith('/file/')) {
      const fileName = decodeURIComponent(url.pathname.slice('/file/'.length));
      const filePath = path.join(workspacePath, 'deliverables', path.basename(fileName));
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('文件不存在');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(fs.readFileSync(filePath, 'utf8'));
      return;
    }

    if (url.pathname === '/api/status') {
      const log = readText(path.join(workspacePath, 'workflow.log'), 48_000);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ workspace: args.workspace, workspacePath, status: statusFromLog(log), deliverables: listDeliverables(workspacePath) }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderPage(args.workspace, workspacePath));
  });

  server.listen(args.port, args.host, () => {
    console.log(`Shannon 中文监控端已启动: http://${args.host}:${args.port}`);
    console.log(`Workspace: ${workspacePath}`);
    console.log('按 Ctrl+C 停止监控端。');
  });
}
