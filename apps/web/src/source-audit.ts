import fs from 'node:fs';
import path from 'node:path';
import { planForRepo } from './stack-detector.js';

interface SourceAuditOptions {
  repoPath: string;
  workspacePath: string;
  projectName: string;
  logPath: string;
}

interface FileStat {
  totalFiles: number;
  totalBytes: number;
  extensions: Map<string, number>;
  interesting: string[];
}

function appendLog(logPath: string, text: string): void {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, text, 'utf8');
}

function writeMarkdown(filePath: string, text: string): void {
  fs.writeFileSync(filePath, `\uFEFF${text}`, 'utf8');
}

function walk(dir: string, root: string, stat: FileStat): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'vendor', 'dist', 'build', '.next', '.turbo'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, root, stat);
      continue;
    }
    const file = fs.statSync(full);
    stat.totalFiles++;
    stat.totalBytes += file.size;
    const ext = path.extname(entry.name).toLowerCase() || '(无扩展名)';
    stat.extensions.set(ext, (stat.extensions.get(ext) || 0) + 1);
    const rel = path.relative(root, full);
    if (/package\.json|requirements\.txt|composer\.json|pom\.xml|go\.mod|\.env/i.test(rel)) {
      stat.interesting.push(rel);
    }
  }
}

function detectRiskHints(repoPath: string): string[] {
  const hints: string[] = [];
  const patterns = [
    { name: '疑似 SQL 拼接', re: /\b(select|insert|update|delete)\b[\s\S]{0,80}\+|query\s*\([^)]*\+/i },
    { name: '疑似命令执行', re: /\b(exec|system|passthru|shell_exec|child_process|Runtime\.getRuntime)\b/i },
    { name: '疑似 SSRF 或外联请求', re: /\b(fetch|axios|request|http\.get|urllib|requests\.get|curl_exec)\b/i },
    { name: '疑似未净化 HTML 输出', re: /\binnerHTML|dangerouslySetInnerHTML|v-html|html_safe|raw\s*\(/i },
    { name: '疑似硬编码密钥', re: /\b(api[_-]?key|secret|password|token)\b\s*[:=]\s*['"][^'"]{8,}/i },
  ];

  let scanned = 0;
  function visit(dir: string): void {
    if (scanned > 800) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'vendor', 'dist', 'build'].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!/\.(js|ts|jsx|tsx|py|php|go|java|cs|rb|vue|html)$/i.test(entry.name)) continue;
      scanned++;
      const text = fs.readFileSync(full, 'utf8').slice(0, 200_000);
      for (const pattern of patterns) {
        if (pattern.re.test(text)) {
          hints.push(`${pattern.name}: ${path.relative(repoPath, full)}`);
        }
      }
    }
  }
  visit(repoPath);
  return [...new Set(hints)].slice(0, 80);
}

export function runSourceAudit(options: SourceAuditOptions): void {
  appendLog(options.logPath, '[source-audit] 开始源码审计。\n');
  const workspaceDeliverables = path.join(options.workspacePath, 'deliverables');
  fs.mkdirSync(workspaceDeliverables, { recursive: true });
  const workflowLog = path.join(options.workspacePath, 'workflow.log');
  fs.writeFileSync(workflowLog, `[PHASE] Starting: source-code-audit\nProject: ${options.projectName}\n`, 'utf8');

  const stat: FileStat = { totalFiles: 0, totalBytes: 0, extensions: new Map(), interesting: [] };
  walk(options.repoPath, options.repoPath, stat);
  const plan = planForRepo(options.repoPath);
  const hints = detectRiskHints(options.repoPath);
  const extTable = [...stat.extensions.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([ext, count]) => `| ${ext} | ${count} |`)
    .join('\n');

  const report = `# 源码审计报告

项目：${options.projectName}

> 当前报告侧重代码结构、技术栈和风险线索识别；不会尝试登录、支付、短信、对象存储等复杂外部能力。结果适合快速判断下一步人工复核和 AI 深度审计重点。

## 概览

- 识别技术栈：${plan.stack}
- 文件数量：${stat.totalFiles}
- 代码包大小：${stat.totalBytes} bytes

## 文件类型分布

| 类型 | 数量 |
| --- | ---: |
${extTable || '| 暂无 | 0 |'}

## 关键配置文件

${stat.interesting.length ? stat.interesting.map((file) => `- ${file}`).join('\n') : '- 未发现常见配置文件'}

## 风险线索

${hints.length ? hints.map((hint) => `- ${hint}`).join('\n') : '- 未发现明显高风险关键词线索'}

## 建议

1. 优先人工复核登录、鉴权、文件上传、外部 URL 请求、SQL 查询、模板渲染相关代码。
2. 如果目标程序能够稳定启动，再使用“已有 URL”或“远程 Linux”补充动态验证证据。
3. 当前线索是静态规则命中，不等同于确认漏洞，需要结合调用链和上下文确认。
`;

  writeMarkdown(path.join(workspaceDeliverables, 'source_code_audit_report.md'), report);
  fs.appendFileSync(workflowLog, '[PHASE] Completed: source-code-audit\nWorkflow COMPLETED\n', 'utf8');
  appendLog(options.logPath, '[source-audit] 源码审计报告已生成。\n');
}
