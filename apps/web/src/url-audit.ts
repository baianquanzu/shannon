import fs from 'node:fs';
import path from 'node:path';

interface UrlAuditOptions {
  targetUrl: string;
  workspacePath: string;
  projectName: string;
  logPath: string;
}

interface ProbeResult {
  path: string;
  url: string;
  status: string;
  contentType: string;
  title: string;
  error: string;
}

function appendLog(logPath: string, text: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, text, 'utf8');
}

function writeMarkdown(filePath: string, text: string): void {
  fs.writeFileSync(filePath, `\uFEFF${text}`, 'utf8');
}

function normalizeBaseUrl(input: string): URL {
  const value = input.trim();
  return new URL(value.endsWith('/') ? value : `${value}/`);
}

function titleFromHtml(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return '';
  return match[1].replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function fetchWithTimeout(url: URL, method = 'GET'): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    return await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Shannon-Web-NoDocker-Audit/1.0' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function probePath(base: URL, probePath: string): Promise<ProbeResult> {
  const url = new URL(probePath.replace(/^\//, ''), base);
  try {
    const response = await fetchWithTimeout(url);
    const contentType = response.headers.get('content-type') || '';
    let title = '';
    if (contentType.includes('text/html')) {
      title = titleFromHtml((await response.text()).slice(0, 200_000));
    }
    return { path: probePath, url: response.url, status: String(response.status), contentType, title, error: '' };
  } catch (error) {
    return { path: probePath, url: url.toString(), status: 'unreachable', contentType: '', title: '', error: error instanceof Error ? error.message : String(error) };
  }
}

function headerRows(headers: Headers): string {
  const names = [
    'server',
    'x-powered-by',
    'set-cookie',
    'content-security-policy',
    'x-frame-options',
    'x-content-type-options',
    'referrer-policy',
    'strict-transport-security',
  ];
  return names.map((name) => `| ${name} | ${(headers.get(name) || '').replace(/\|/g, '\\|') || '未设置'} |`).join('\n');
}

function securityHeaderFindings(headers: Headers, isHttps: boolean): string[] {
  const findings: string[] = [];
  if (!headers.get('content-security-policy')) findings.push('未发现 Content-Security-Policy，前端 XSS 防护面偏弱。');
  if (!headers.get('x-frame-options')) findings.push('未发现 X-Frame-Options，可能存在被 iframe 嵌套的点击劫持风险。');
  if (!headers.get('x-content-type-options')) findings.push('未发现 X-Content-Type-Options，浏览器可能进行 MIME 嗅探。');
  if (!headers.get('referrer-policy')) findings.push('未发现 Referrer-Policy，外跳时可能泄露来源路径。');
  if (isHttps && !headers.get('strict-transport-security')) findings.push('HTTPS 目标未发现 HSTS。');
  const cookie = headers.get('set-cookie') || '';
  if (cookie && !/httponly/i.test(cookie)) findings.push('Set-Cookie 中未明显包含 HttpOnly。');
  if (cookie && !/samesite/i.test(cookie)) findings.push('Set-Cookie 中未明显包含 SameSite。');
  return findings;
}

export async function runUrlAudit(options: UrlAuditOptions): Promise<void> {
  const deliverables = path.join(options.workspacePath, 'deliverables');
  fs.mkdirSync(deliverables, { recursive: true });
  appendLog(options.logPath, `[url-audit] 开始 URL 动态检测: ${options.targetUrl}\n`);

  const base = normalizeBaseUrl(options.targetUrl);
  let rootStatus = 'unreachable';
  let finalUrl = base.toString();
  let headersTable = '| 响应头 | 值 |\n| --- | --- |\n';
  let headerFindings: string[] = ['目标不可访问，无法检查安全响应头。'];

  try {
    const root = await fetchWithTimeout(base);
    rootStatus = String(root.status);
    finalUrl = root.url;
    headersTable += headerRows(root.headers);
    headerFindings = securityHeaderFindings(root.headers, base.protocol === 'https:');
  } catch (error) {
    appendLog(options.logPath, `[url-audit] 首页探测失败: ${error instanceof Error ? error.message : String(error)}\n`);
  }

  const probePaths = ['/', '/robots.txt', '/sitemap.xml', '/admin', '/login', '/backend', '/api', '/install'];
  const probes: ProbeResult[] = [];
  for (const item of probePaths) {
    const result = await probePath(base, item);
    probes.push(result);
    appendLog(options.logPath, `[url-audit] ${item} -> ${result.status}${result.title ? ` (${result.title})` : ''}${result.error ? ` ${result.error}` : ''}\n`);
  }

  const probeTable = probes
    .map((item) => `| ${item.path} | ${item.status} | ${item.contentType || '-'} | ${(item.title || item.error || '-').replace(/\|/g, '\\|')} |`)
    .join('\n');

  const interesting = probes.filter((item) => ['200', '401', '403'].includes(item.status) && item.path !== '/');
  const report = `# URL 动态检测报告

项目：${options.projectName}

## 目标概览

- 输入 URL：${options.targetUrl}
- 最终 URL：${finalUrl}
- 首页状态：${rootStatus}

## 关键路径探测

| 路径 | 状态 | Content-Type | 标题/错误 |
| --- | --- | --- | --- |
${probeTable}

## 响应头检查

${headersTable}

## 风险提示

${headerFindings.length ? headerFindings.map((item) => `- ${item}`).join('\n') : '- 未发现明显安全响应头缺失。'}
${interesting.length ? `\n## 值得人工复核的入口\n\n${interesting.map((item) => `- ${item.path}：HTTP ${item.status}${item.title ? `，标题：${item.title}` : ''}`).join('\n')}` : ''}

## 说明

当前动态检测为无容器模式下的轻量 URL 检测，重点确认目标是否可访问、常见入口是否暴露、安全响应头是否缺失。它不会进行破坏性利用，也不会替代完整人工渗透测试。
`;

  writeMarkdown(path.join(deliverables, 'dynamic_url_audit_report.md'), report);
  appendLog(options.logPath, '[url-audit] URL 动态检测报告已生成。\n');
}
