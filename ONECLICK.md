# Shannon One-Click GPT / DeepSeek Startup

中文用户请优先阅读 [中文使用说明.md](中文使用说明.md)。本版本默认让最终报告使用中文，并新增 `shannon monitor <workspace>` 中文 Web 监控端。

This build adds native startup support for GPT, DeepSeek, and other OpenAI-compatible APIs by starting a local Anthropic-compatible adapter automatically.

## Windows One-Click Script

Run from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-shannon.ps1 `
  -Provider openai `
  -ApiKey "YOUR_API_KEY" `
  -Url "http://host.docker.internal:8088" `
  -Repo "D:\codex\targets\v2" `
  -Output "D:\codex\reports\v2" `
  -Workspace "v2-local-scan" `
  -PipelineTesting
```

If OpenAI only works through v2rayN/Clash on this machine, pass the outbound proxy. For your current v2rayN setup:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-shannon.ps1 `
  -Provider openai `
  -ApiKey "YOUR_API_KEY" `
  -OutboundProxy "http://127.0.0.1:10809" `
  -Url "http://host.docker.internal:8088" `
  -Repo "D:\codex\targets\v2" `
  -Output "D:\codex\reports\v2" `
  -Workspace "v2-local-scan" `
  -PipelineTesting
```

DeepSeek example:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-shannon.ps1 `
  -Provider deepseek `
  -ApiKey "YOUR_DEEPSEEK_API_KEY" `
  -Url "http://host.docker.internal:8088" `
  -Repo "D:\codex\targets\v2" `
  -Output "D:\codex\reports\v2" `
  -Workspace "v2-deepseek-scan" `
  -PipelineTesting
```

## Environment Variables

You can also use `.env` or exported variables:

```env
SHANNON_AI_PROVIDER=openai
OPENAI_COMPAT_API_KEY=your-key
OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1
OPENAI_COMPAT_SMALL_MODEL=gpt-4o-mini
OPENAI_COMPAT_MEDIUM_MODEL=gpt-4o
OPENAI_COMPAT_LARGE_MODEL=gpt-4o
```

```env
SHANNON_AI_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-key
OPENAI_COMPAT_BASE_URL=https://api.deepseek.com/v1
OPENAI_COMPAT_SMALL_MODEL=deepseek-chat
OPENAI_COMPAT_MEDIUM_MODEL=deepseek-chat
OPENAI_COMPAT_LARGE_MODEL=deepseek-reasoner
```

## Docker Note

Shannon still needs Docker because the worker and Temporal infrastructure run in containers. On Windows, Docker Desktop requires WSL2 or Hyper-V features that must be enabled by an administrator. The script checks Docker and starts Docker Desktop when possible, but it cannot silently enable Windows virtualization features without elevated permissions and a reboot.
