# openai-anthropic-bridge

**一个零依赖的本地协议转换代理，两个方向都能翻：**
1. **正向桥**——让只支持 OpenAI 接口的工具（如 WorkBuddy/CodeBuddy），直接用上只支持 Anthropic 协议的网关/中转站；
2. **反向桥**——让只支持 Anthropic 接口的工具（如 Claude Code），直接用上任何 OpenAI 兼容后端（DeepSeek/Kimi/GLM/Ollama/vLLM/one-api...）。

开箱即用、进程自愈、开机自启、一键安装一键卸载。

A zero-dependency local proxy translating **both ways**: OpenAI-only clients (e.g. WorkBuddy) can use Anthropic-protocol gateways, **and** Anthropic-only clients (e.g. Claude Code) can use any OpenAI-compatible backend. Self-healing, auto-start, one-command install & uninstall.

```
【正向桥 3456】OpenAI客户端 → Anthropic网关           【反向桥 4567】Anthropic客户端 → OpenAI后端

WorkBuddy等                      Anthropic协议网关       Claude Code等                 DeepSeek/Ollama/one-api等
POST /v1/chat/completions ──►  ──► POST /v1/messages   POST /v1/messages ──►       ──► POST /v1/chat/completions
choices[] 响应 ◄──  双向翻译  ◄── content[] 响应        content[]/SSE事件 ◄──  双向翻译  ◄── chunks/choices[]
        127.0.0.1:3456 (server.mjs)                            127.0.0.1:4567 (server.mjs 同进程)
                    watchdog.mjs 每60s自愈(双端口)
```

## 为什么需要它

大量 AI 网关/中转站（Claude Code 兼容类、Anthropic Messages 协议）**不支持 OpenAI Chat Completions**（`/v1/chat/completions` 直接 404）；而很多客户端工具的自定义模型**只支持 OpenAI 协议**。两边永远握不上手，你看到的报错通常是：

- WorkBuddy：**「接口地址或模型名称不正确」**（地址和模型名其实都没填错！）
- 或通用的「网络连接失败，请检查 VPN 代理」

以 WorkBuddy 为例（从其 app.asar 逆向确认）：自定义模型地址会被强制拼成 `<地址>/chat/completions`；`useCustomProtocol` 复选框只是"不自动拼路径"，**并不是**切换 Anthropic 协议；供应商列表里也没有 Anthropic 类型。所以唯一的办法就是中间加一层翻译——就是本项目。

## 快速开始

要求：Node ≥ 18（无需 npm install，零依赖）。

```bash
git clone <本仓库>
cd openai-anthropic-bridge
node install.mjs
# 交互式回答: 网关地址 / API Key / 模型名称
# 安装器会: 测试连通 → 写 config.json → 启动桥+看门狗 → 注册开机自启 → 自动写入 WorkBuddy 配置
```

脚本式（CI/自动化）：

```bash
node install.mjs --upstream https://gw.example.com --key sk-xxx --model my-model --yes
```

装完在 WorkBuddy 里：**重启 WorkBuddy → 模型列表选你配置的模型名**。其他 OpenAI 协议客户端同理，接口地址填 `http://127.0.0.1:3456/v1`，Key 任意非空（代理只监听本机回环）。

## 反向桥：让 Claude Code 用上 OpenAI 后端

安装时回答"启用反向桥"，或脚本式：

```bash
node install.mjs --upstream ... --key ... --model ... \
  --openai-backend http://127.0.0.1:11434/v1 \   # 任意 OpenAI 兼容后端(含 /v1)
  --anthropic-port 4567 \
  --model-map '{"claude-sonnet-5":"qwen3-max"}'  # 可选: 客户端模型名 → 后端模型名
```

Claude Code 侧接入（任选）：

```bash
# 方式一: 环境变量
export ANTHROPIC_BASE_URL=http://127.0.0.1:4567
export ANTHROPIC_AUTH_TOKEN=sk-anonymous
claude
```

或在 Claude Code 设置里添加模型供应商：协议选 **Anthropic**，地址填 `http://127.0.0.1:4567`，Key 任意非空。

反向桥做了这些 Claude Code 专属兼容：
- **完整 SSE 事件序列**：`message_start → content_block_start/delta/stop → message_delta → message_stop`
- **thinking 块**：后端 `reasoning_content` → Anthropic `thinking` 块（带占位 signature，非 Anthropic 后端无人验签）
- **工具调用**：`tools`/`tool_choice`/`tool_use`/`tool_result` 全双向，流式 `input_json_delta` 增量
- **count_tokens 桩**：`/v1/messages/count_tokens` 返回 chars/4 估算（上下文预算够用）
- **cache_control 剥离**：Claude Code 发的缓存标记不会漏给 OpenAI 后端
- **system 数组形态** + **modelMap 模型名映射**

## 支持的翻译（全部有回归测试覆盖）

| 能力 | 说明 |
|---|---|
| 非流式 | `choices[].message` / `finish_reason` / `usage` 完整映射（双向） |
| 流式 SSE | Anthropic 事件流 ↔ OpenAI chunk 流（role → content → finish_reason → usage → `[DONE]`） |
| 思考过程 | Anthropic `thinking` 块 ↔ `delta.reasoning_content`（DeepSeek 风格），双向含流式 |
| 工具调用 | `tools`/`tool_choice` 定义互转；`tool_use` ↔ `tool_calls`；流式增量 arguments 拼接；并行多工具(index) |
| 工具结果 | `role:"tool"` + `tool_call_id` ↔ `tool_result` 块，多轮回环 |
| 消息系统 | system(字符串/块数组) 合并；图片 data-URL 转 base64 块；连续同角色消息自动合并 |
| Claude Code 兼容 | count_tokens 桩 / cache_control 剥离 / modelMap / Anthropic 风格错误体 |
| 模型列表 | `GET /v1/models` 透传网关列表 |

## 测试

```bash
node test.mjs 3456           # 正向桥 15 例(活链: 需要真实上游)
node test-anthropic.mjs 4567 # 反向桥 26 例(A1/A2/A6 活链 + A3-A5 内置mock确定性)
```

## 自愈架构

```
开机登录 → 启动文件夹拉起 watchdog.mjs（任务管理器可见、可禁用）
             └─ 每 60s 检查已启用端口的 /health（正向3456 + 反向4567，全部通过才算健康）
                  └─ 任一端口挂了 → 自动拉起 server.mjs（读 config.json 同时起两个方向）→ guard.log 记录
```

- 桥本体已加固：客户端中途断开（点"停止生成"）、流异常、未捕获异常均不会杀进程
- 看门狗与配置同源（`config.json`），改端口/上游只需重跑 `node install.mjs`
- 日志 `guard.log` 超 200KB 自动清空

## 卸载

```bash
node uninstall.mjs        # 停进程 + 删自启 + (可选)清 WorkBuddy 条目
# 然后删除整个目录即彻底清除（config.json 含 key，已被 .gitignore 忽略）
```

## 已知限制（如实）

- 不透传 `cache_control`/prompt caching 字段（反向方向直接剥离；Anthropic 缓存优化不可用）
- `response_format`(json mode) 被忽略（降级为普通文本）
- 流式下 `prompt_tokens` 依赖上游报数，部分网关只报 0；反向 count_tokens 是 chars/4 估算
- `n>1`、`logprobs` 忽略；反向桥历史消息里的 thinking 块按设计丢弃
- 仅监听 127.0.0.1，不做鉴权（本机回环内使用，不要改绑 0.0.0.0）

## FAQ

**Q: 报「接口地址或模型名称不正确」怎么办？**
先 `curl http://127.0.0.1:3456/health`。不通=代理没跑（`node install.mjs` 重装）；通=检查客户端接口地址末尾要有 `/v1`。

**Q: WorkBuddy 的 `useCustomProtocol` 要勾吗？**
不要。它只是"地址原样使用不拼 `/chat/completions`"，不是 Anthropic 协议开关。

**Q: 能转发图片吗？**
OpenAI `image_url` 的 data-URL 会转成 Anthropic base64 块；http(s) 图片链接暂不支持（自动降级为占位文本）。

**Q: 安全性？**
Key 只存在本地 `config.json`（已 gitignore）；代理只监听 127.0.0.1，局域网不可见。

## License

MIT
