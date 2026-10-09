# codex-workbuddy-bridge

把 **OpenAI Codex CLI** 接到「只提供 `/v1/chat/completions`」的 OpenAI 兼容网关（例如
[workbuddy2api-panel](https://github.com/linguo2625469/workbuddy2api-panel)）上的一键安装脚本。

自带一个零依赖的本地转换层：**Responses API ⇄ chat completions**。

## 为什么需要这个桥

| 事实 | 说明 |
| --- | --- |
| Codex >= 0.14x 只会说 Responses API | 配 `wire_api = "chat"` 会直接启动失败：`wire_api = "chat" is no longer supported` |
| 这类网关只有 chat completions | workbuddy2api 的入站路由只有 `POST /v1/chat/completions`、`GET /v1/models`、`GET /status`、`GET /healthz`、`/panel/`（见 `internal/server/handler.go`） |
| 直接指过去会 404 | `ERROR: unexpected status 404 Not Found: 404 page not found, url: http://<网关>/v1/responses` |

所以在本机加一层转换：

~~~text
  Codex CLI  (wire_api = "responses")
      |
      |  POST /v1/responses   (SSE)
      v
  server.mjs  —— 127.0.0.1:8799   本机转换层，只用 Node 内置模块
      |
      |  POST /v1/chat/completions   (tools 原样透传)
      v
  你的网关  http://100.104.227.113:7863/v1
~~~

## 特性

- **零依赖**：只用 Node 内置模块（`node:http` + 全局 `fetch`），不装任何 npm 包
- **工具调用完整透传**：`tools` / `tool_choice` 原样转发；`function_call`、`custom_tool_call`（`apply_patch`）双向映射。
  这一点很关键：转换层一旦丢掉 `tools`，DeepSeek 系模型的原生工具标记就不会被解析成结构化 `tool_calls`，
  Codex 会看不到函数调用而「回合空转」
- **流式**：chat SSE 增量 → Responses 事件（`response.output_text.delta`、`response.function_call_arguments.delta`、
  `response.completed` ...）
- **自动生成 Codex 模型目录**：从网关 `/v1/models` 生成 `model_catalog_json`，消除
  `Model metadata for <model> not found` 警告
- **开机自启**：macOS 用 launchd（`RunAtLoad` + `KeepAlive`），Linux 用 `systemd --user`，也可以 `--no-service` 前台跑
- **幂等且安全**：重复执行没问题；改 `~/.codex/config.toml` 前自动生成带时间戳的备份，且只重写自己管的键，
  `mcp_servers` / `plugins` / `projects` 等其他内容一字不动

## 前置条件

- Node.js >= 18（推荐 20 / 22）
- Codex CLI：`npm install -g @openai/codex`
- 网关地址 + API Key，且网关的 `/v1/chat/completions` 能正常返回

## 快速开始

~~~bash
git clone https://github.com/gchan2/codex-workbuddy-bridge.git
cd codex-workbuddy-bridge
./install.sh --api-key <你的网关密钥>
~~~

不想克隆（脚本会自动从仓库下载组件）：

~~~bash
curl -fsSL https://raw.githubusercontent.com/gchan2/codex-workbuddy-bridge/main/install.sh | bash -s -- --api-key <密钥>
~~~

装完直接运行 `codex` 即可。

> 默认网关地址是作者的 `http://100.104.227.113:7863/v1`。**换成你自己的地址**：
> `./install.sh --base-url https://your-gateway.example.com/v1 --api-key <密钥>`

## 参数

| 参数 | 说明 |
| --- | --- |
| `--api-key KEY` | 网关密钥。优先级：本参数 > `--api-key-file` > 环境变量 `WORKBUDDY_API_KEY` > `~/.dsh/.credentials.yaml` > 交互式输入 |
| `--api-key-file FILE` | 从文件读密钥 |
| `--base-url URL` | 网关地址，默认 `http://100.104.227.113:7863/v1` |
| `--port PORT` | 本机桥端口，默认 `8799` |
| `--model MODEL` | 写进 config.toml 的模型，默认 `cn:deepseek-v4.1-flash` |
| `--codex-home DIR` | Codex 目录，默认 `$CODEX_HOME` 或 `~/.codex` |
| `--bridge-dir DIR` | 桥的安装目录，默认 `~/.local/share/codex-workbuddy-bridge` |
| `--no-service` | 不装服务，只生成 `start.sh`（自己前台/守护运行） |
| `--launchd` / `--systemd` | 强制指定服务后端 |
| `--no-catalog` | 不重新生成模型目录 |
| `--no-verify` | 跳过最后的真实 `codex exec` 冒烟测试 |
| `--dry-run` | 只打印将要写入的内容，不落盘 |

## 安装脚本做了什么

1. 检查 Node 版本、codex CLI、网关连通性、端口占用（`--port` 被占用会直接报错；已有桥在跑则复用）
2. 把 `server.mjs` 和两个辅助脚本装到 `--bridge-dir`
3. 从网关 `/v1/models` 生成 `<codex-home>/workbuddy-model-catalog.json`
4. 合并 `<codex-home>/config.toml`（先备份 `config.toml.bak-<时间戳>`）
5. 装并启动服务（launchd / systemd --user），等待 `/health` 通过
6. 跑一次真实的 `codex exec ... "Reply with exactly: BRIDGE-OK"` 验证链路

## 安装后 config.toml 的关键内容

~~~toml
model_provider = "workbuddy"
model = "cn:deepseek-v4.1-flash"
model_reasoning_effort = "high"
model_catalog_json = "/Users/you/.codex/workbuddy-model-catalog.json"
forced_login_method = "api"

[model_providers.workbuddy]
name = "workbuddy (gateway via local Responses/chat bridge)"
wire_api = "responses"
base_url = "http://127.0.0.1:8799/v1"
experimental_bearer_token = "<密钥>"
~~~

## 装完怎么用 / 怎么维护

~~~bash
curl -s http://127.0.0.1:8799/health      # {"ok":true,"upstream":"..."}
codex                                     # 正常使用

# macOS
launchctl kickstart -k gui/$(id -u)/com.$(whoami).codex-workbuddy-bridge   # 重启
launchctl bootout gui/$(id -u)/com.$(whoami).codex-workbuddy-bridge        # 停止
tail -f ~/.local/share/codex-workbuddy-bridge/bridge.err.log

# Linux
systemctl --user restart codex-workbuddy-bridge
journalctl --user -u codex-workbuddy-bridge -f
~~~

## 在其他机器上安装

- 桥是**本地进程**，每台机器都要跑一次 `install.sh`（可把密钥放到 `~/.dsh/.credentials.yaml` 或直接 `--api-key`）
- 每台机器都需要 Node >= 18 和 codex CLI
- 端口冲突用 `--port 8899` 换一个
- Linux 上如果希望退出登录后桥仍然活着：`loginctl enable-linger $USER`
- 想给多台机器统一配置，可以先 fork 本仓库、把上面的默认网关地址改成你自己的

## 卸载

~~~bash
./uninstall.sh                     # 停服务、删服务文件，保留桥文件和 config.toml
./uninstall.sh --restore-config    # 顺便把最近的 config.toml 备份恢复回去
./uninstall.sh --purge             # 再删掉桥目录和生成的模型目录
~~~

## 常见问题

**Q: `wire_api = "chat" is no longer supported`？**
Codex 已经不支持 chat 线协议，正是本仓库要解决的问题；用本桥 + `wire_api = "responses"`。

**Q: 直接填网关地址报 `404 page not found ... /v1/responses`？**
你的网关没实现 Responses API（上游维护者明确表示不会加）。保持指向 `http://127.0.0.1:<port>/v1`。

**Q: 提示 `Model metadata for <model> not found`？**
重新跑 `./install.sh --api-key <密钥>` 重新生成目录（或检查网关 `/v1/models` 是否可访问）。

**Q: 配了 `model_catalog_json` 之后内置 `gpt-*` 模型不见了？**
是的，自定义目录会取代内置模型列表；该目录只包含你网关的模型。想回内置列表就删掉 config 里那一行。

**Q: Codex 桌面版/GUI 里改了 provider 之后又连不上？**
Codex 应用会重写 `~/.codex/config.toml` 的顶层键。重跑一次 `install.sh` 把它改回来即可。

**Q: 密钥被写到哪里？**
优先放在 `~/.codex/config.toml`（`experimental_bearer_token`）和 macOS plist / Linux `bridge.env` 里，
三者都 `chmod 600`。**不要把密钥提交到公开仓库。**

**Q: 走了系统代理导致连不上本机/内网？**
plist 和 systemd 单元里都设置了 `NO_PROXY=127.0.0.1,localhost,::1`（按需加上你的网关内网 IP）。

## 限制

- 不做 Responses 的有状态语义（`store` / `previous_response_id` 一律当无状态对话处理）
- `reasoning` 类 item 会被丢弃（只透传 `reasoning_effort` / `reasoning_content` 的增量）
- 服务端工具（`web_search`）不转发；建议 `web_search = "disabled"`
- 依赖网关在声明 `tools` 时返回**结构化** `tool_calls`

## 目录结构

~~~text
codex-workbuddy-bridge/
├── install.sh                      # 安装
├── uninstall.sh                    # 卸载
├── bridge/server.mjs               # Responses ⇄ chat 转换层（Node，零依赖）
├── lib/gen_catalog.mjs             # 从网关 /v1/models 生成 codex 模型目录
├── lib/merge_config.mjs            # 幂等合并 ~/.codex/config.toml（自动备份）
└── templates/
    ├── com.codex-workbuddy-bridge.plist.template    # macOS launchd
    └── codex-workbuddy-bridge.service.template      # Linux systemd --user
~~~

## License

MIT
