# Shannon 中文增强版

这是基于 Shannon Lite 改造的中文增强版，面向国内安全测试、代码审计和授权渗透测试场景。原版项目请看：

[KeygraphHQ/shannon](https://github.com/KeygraphHQ/shannon)

本仓库重点不再重复原版英文说明，而是说明这个 fork 做了哪些增强、怎么接入常见大模型、怎么用中文监控端和中文报告。

## 这个版本更新了什么

### 1. 大模型接口更适合国内使用

原版 Shannon 主要围绕 Claude/Anthropic 生态设计。这个版本补了一层更容易落地的启动和适配方式，方便接入：

- OpenAI / GPT 接口
- DeepSeek 接口
- 其他 OpenAI-Compatible 接口，例如自建代理、转发网关、中转 API
- 可配置 `BaseUrl`
- 可分别指定 small / medium / large 模型
- 支持通过 `-OutboundProxy` 配置本机代理

常见用法：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-shannon.ps1 `
  -Provider deepseek `
  -ApiKey "你的DeepSeekKey" `
  -Url "http://127.0.0.1:8088" `
  -Repo "D:\your\target\repo" `
  -Workspace "cms-scan" `
  -Output "D:\reports\cms-scan" `
  -Monitor
```

GPT / OpenAI：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-shannon.ps1 `
  -Provider openai `
  -ApiKey "你的OpenAIKey" `
  -Url "http://127.0.0.1:8088" `
  -Repo "D:\your\target\repo" `
  -Workspace "gpt-scan" `
  -Monitor
```

OpenAI-Compatible：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-shannon.ps1 `
  -Provider openai-compatible `
  -ApiKey "你的Key" `
  -BaseUrl "https://api.example.com/v1" `
  -SmallModel "deepseek-chat" `
  -MediumModel "deepseek-chat" `
  -LargeModel "deepseek-reasoner" `
  -Url "http://127.0.0.1:8088" `
  -Repo "D:\your\target\repo" `
  -Workspace "compat-scan" `
  -Monitor
```

### 2. 中文安全报告

报告生成提示词已经改成中文导向，输出会更适合国内安全人员、开发人员和甲方阅读。

报告会重点区分：

- 已验证可利用的问题
- 因环境阻断暂未打通但代码存在风险的问题
- 误报或当前部署不可利用的问题
- 优先修复顺序
- 复现证据、路径、Payload、命令和代码位置

主报告路径：

```text
workspaces\<workspace>\deliverables\comprehensive_security_assessment_report.md
```

如果启动时传了 `-Output`，报告也会复制到指定目录。

### 3. 新增中文 Web 监控端

这个版本新增了本地 Web 监控端，用于更方便地查看扫描状态和报告产物。

启动扫描时加 `-Monitor`：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-shannon.ps1 `
  -Provider deepseek `
  -ApiKey "你的Key" `
  -Url "http://127.0.0.1:8088" `
  -Repo "D:\your\target\repo" `
  -Workspace "cms-scan" `
  -Monitor
```

然后打开：

```text
http://127.0.0.1:8787
```

也可以单独启动监控端：

```powershell
node apps/cli/dist/index.mjs monitor cms-scan
```

指定端口：

```powershell
node apps/cli/dist/index.mjs monitor cms-scan --port 8899
```

监控端目前会显示：

- 当前运行状态
- 目标地址
- 工作区路径
- 主报告是否已生成
- 报告文件列表
- 运行日志尾部
- 主报告预览

### 4. 中文使用文档

更详细、更偏实战的中文说明放在这里：

[中文使用说明.md](./中文使用说明.md)

里面包含：

- Docker / Node / pnpm 准备工作
- DeepSeek 启动方式
- GPT 启动方式
- OpenAI-Compatible 启动方式
- 代理配置
- 报告目录说明
- 常见命令
- 授权测试注意事项

## 安装和构建

需要先安装：

- Docker Desktop
- Node.js 18+
- pnpm

安装依赖：

```powershell
pnpm install
```

构建：

```powershell
pnpm build
```

## 常用命令

查看帮助：

```powershell
node apps/cli/dist/index.mjs help
```

查看工作区：

```powershell
node apps/cli/dist/index.mjs workspaces
```

查看日志：

```powershell
node apps/cli/dist/index.mjs logs cms-scan
```

打开中文监控端：

```powershell
node apps/cli/dist/index.mjs monitor cms-scan
```

停止容器：

```powershell
node apps/cli/dist/index.mjs stop --clean
```

## 使用提醒

请只扫描你自己拥有或已获得明确授权的系统、源码和测试环境。

AI 自动化渗透测试可能会修改测试环境中的数据，例如后台配置、广告代码、统计代码、缓存文件或临时文件。测试结束后请检查目标环境是否残留测试 payload。

如果报告中出现“环境阻断”，通常表示代码层面存在风险，但当前部署条件让利用链没有完全打通，例如缺少扩展、权限不足、网络阻断或运行配置不同。

## License

本项目继承原版 Shannon Lite 的 AGPL-3.0 许可证。原版版权、许可和免责声明请参考：

- [原版 Shannon 仓库](https://github.com/KeygraphHQ/shannon)
- [LICENSE](./LICENSE)
