# Shannon 中文增强版

这是基于 [KeygraphHQ/shannon](https://github.com/KeygraphHQ/shannon) 修改的中文增强版。原版项目的英文说明、许可证和设计背景请看原仓库；本仓库主要说明这个 fork 新增了什么，以及新手如何把它跑起来。

> 只测试你自己拥有或已经获得明确授权的系统、源码和环境。

![Web 控制台](./docs/images/web-console.png)

## 这个版本更新了什么

### 更适合国内使用的 AI 配置

Web 页面里可以直接配置常见大模型接口，不需要手动改一堆环境变量：

- DeepSeek
- 通义千问 Qwen
- 智谱 GLM
- Moonshot Kimi
- 百川智能
- MiniMax
- 豆包 / 火山方舟
- 零一万物 Yi
- 硅基流动
- OpenAI / GPT
- OpenAI 兼容接口
- Anthropic

你可以在页面里填写 API Key、Base URL、小模型、中模型、大模型和推理强度。

### 新增中文 Web 控制台

现在可以直接打开本地 Web 页面完成这些操作：

- 上传代码包
- 选择扫描方式
- 配置 API
- 查看实时进度
- 查看日志
- 停止、重启、删除任务
- 下载报告包

默认地址：

```text
http://127.0.0.1:8787
```

### 三种扫描方式

![扫描流程](./docs/images/scan-modes.svg)

| 模式 | 适合场景 | 会做什么 |
| --- | --- | --- |
| 只上传代码进行源码审计 | 只想快速看代码风险 | 生成中文源码审计报告 |
| 已有 URL | 你已经搭好网站，或者有公网测试地址 | 调用原版 Shannon 检测流程 |
| 远程 Linux 部署 | 你有一台测试虚拟机，希望工具帮你部署目标 | 先 SSH 到 Linux 启动目标，再把 URL 交给原版 Shannon |

注意：后两种模式会调用原版 Shannon worker，所以运行本工具的电脑需要 Docker Desktop 正常启动。

## 新手快速开始

### 1. 准备环境

Windows 推荐准备：

- Node.js 18 或更高版本
- pnpm
- Docker Desktop
- 一台用于测试的 Linux 虚拟机，可选

检查 Node 和 pnpm：

```powershell
node -v
pnpm -v
```

安装依赖：

```powershell
pnpm install
```

构建项目：

```powershell
pnpm build
```

### 2. 启动 Web 控制台

在项目根目录运行：

```powershell
.\start-web.ps1
```

然后打开：

```text
http://127.0.0.1:8787
```

如果 PowerShell 阻止脚本执行，可以这样启动：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-web.ps1
```

### 3. 配置大模型 API

打开 Web 页面后，先在“AI 配置”里选择服务商，例如 DeepSeek，然后填写：

- API Key
- Base URL，通常选择服务商后会自动填
- small / medium / large 模型，通常选择服务商后会自动填

点击“保存配置”。

配置会写入本地 `.env` 文件。请不要把 `.env` 上传到 GitHub。

### 4. 上传代码并创建扫描

准备一个源码压缩包，支持：

- `.zip`
- `.tar`
- `.tar.gz`
- `.tgz`

然后选择扫描方式：

#### 模式一：只上传代码进行源码审计

适合第一次试用。只需要填写项目名称、上传代码包，然后开始扫描。

输出示例：

```text
source_code_audit_report.md
summary_report.md
task.log
```

#### 模式二：已有 URL

适合目标网站已经搭好，例如：

```text
http://192.168.3.200:21007
```

填写目标 URL，上传对应源码包，然后开始扫描。工具会调用原版 Shannon 检测流程。

#### 模式三：远程 Linux 部署

适合你有一台 Linux 测试机，希望工具自动上传代码并尝试启动目标。

需要填写：

- Linux IP
- SSH 端口，默认 22
- Linux 用户名
- Linux 密码
- 代码包

工具会先远程部署目标，部署成功后把识别到的 URL 交给原版 Shannon 检测。

## 报告在哪里

Web 页面里可以直接点击“下载”。

本地目录一般在：

```text
workspaces\<任务名>\deliverables\
```

常见文件：

```text
remote_deployment_diagnosis.md
target_url_diagnosis.md
source_code_audit_report.md
comprehensive_security_assessment_report.md
summary_report.md
task.log
workflow.log
```

实际文件会根据扫描方式不同而变化。

## Docker 常见问题

后两种模式依赖原版 Shannon，原版 Shannon 会启动 Docker worker。如果你看到类似错误：

```text
Docker Desktop 未启动或 Docker Engine 不可用
```

请先打开 Docker Desktop，等待它显示 Docker Engine running。

如果 Docker Desktop 打开了但仍然不可用，检查 WSL：

```powershell
wsl --status
```

如果提示未安装 WSL，可以用管理员 PowerShell 执行：

```powershell
wsl --install
```

然后重启电脑，再打开 Docker Desktop。

也可以检查 Docker：

```powershell
docker version
docker info
docker ps
```

## 常用命令

启动 Web：

```powershell
.\start-web.ps1
```

构建：

```powershell
pnpm build
```

停止原版 Shannon 容器：

```powershell
node apps/cli/dist/index.mjs stop --clean
```

查看原版帮助：

```powershell
node apps/cli/dist/index.mjs help
```

## 项目结构

```text
apps/web/                 中文 Web 控制台
apps/web/src/server.ts    Web 服务和任务流
apps/web/src/remote-deployer.ts
                           远程 Linux 原生部署
apps/web/src/original-shannon.ts
                           调用原版 Shannon 检测流程
scripts/start-shannon.ps1  PowerShell 启动脚本
start-web.ps1              一键启动 Web 控制台
中文使用说明.md             更偏实战的中文说明
```

## 安全提醒

这个工具用于授权安全测试。不要扫描未授权目标，不要把真实 API Key、生产数据库、客户数据、内部报告上传到公开仓库。

## License

本项目继承原版 Shannon 的 AGPL-3.0 许可证。原版项目请参考：

- [KeygraphHQ/shannon](https://github.com/KeygraphHQ/shannon)
- [LICENSE](./LICENSE)
