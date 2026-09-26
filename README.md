# dsh-proxy-router

**给 DSH 的「直连优先、代理兜底」取回能力。** 导入一份代理订阅，直连失败的目标自动改走代理，并记住下次直接走对的那条路。

解决的问题：一遍遍重试直连、一遍遍换镜像源。第一次失败就换路，第二次起零试错。

## 为什么不直接用环境变量代理

DSH 自带的 `dsh-http-proxy` 只提供**一条**路：启动时把 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` 装成 undici 全局 dispatcher，命中就全走代理、没配就全直连。

- 没有按主机判断：直连能通的站点也被塞进代理；
- 没有失败重试：第一次连不上就报错；
- 启动后改不了：运行中换不了代理；
- 代理一挂全挂：节点死了连直连站点也访问不了。

本插件补的就是这一层：**两条路 + 记忆 + 健康检查**。

## 工作原理

```
订阅链接 ──► mihomo 内核（本插件监督）──► 本地混合端口 http://127.0.0.1:<mixedPort>
                 │ proxy-provider：定时重新拉取订阅
                 │ url-test 组：按真实 204 探测挑最低延迟的健康节点，故障自动切换
                 ▼
          smartFetch（本插件）
            1. 查路由记忆（按主机，默认 30 分钟 TTL）
            2. 直连优先 → 失败则走代理重试
            3. 成功即记住该主机该走哪条路
                 ▲
                 └── 代理没有健康节点时，直连路径不受影响
```

节点选择与故障切换交给内核（这是 mihomo 的强项），直连/代理的选择留给插件（这是 harness 特有的需求）。传输层是纯 `node:http`/`node:https`/`node:tls` + CONNECT 隧道，**零第三方依赖**。

## 安装

```sh
dsh plugin --profile <你的profile> add dsh-proxy-router
# 或用 GitHub 源
dsh plugin --profile <你的profile> add github:Lequait/dsh-proxy-router
```

重启 harness 后，会话里会出现 `proxy_router` 工具。

## 你只需要一个订阅地址

其它都不用配。两种给法，任选其一：

**① 直接把链接交给 agent（推荐，零配置）**

```
proxy_router { action: "start", subscriptionUrl: "https://你的订阅链接" }
```

插件会记住它（存在 `<DSH_HOME>/cache/proxy-router/subscription.txt`），之后 `status` / `test` / `fetch` 都不用再给。

**② 写进插件配置**（想让内核随 harness 自动启动时用）

上面配置表里的 `subscriptionUrl` 填一行即可，并可把 `autoStart` 设为 `true`。

### 内核不用你操心

启动时会按顺序找 mihomo：**环境变量 `DSH_PROXY_CORE` → PATH → 常见安装目录 → 正在运行的内核进程 → Windows 注册表卸载项**。
你机器上正在跑的 Clash Verge 自带内核（`verge-mihomo.exe`）就是这样被自动找到的，与安装在哪个盘无关。
都没有时会**自动下载** mihomo（GitHub 直连失败会自动换镜像源）到 `<DSH_HOME>/cache/proxy-router/bin/`。
所以 `corePath` 和 `DSH_PROXY_CORE` 都是**可选的高级选项**，不是必填项。

## 配置（全部可选）

在 profile 的 `cordis.patch.yml` 里改 `proxy-router` 条目的 `config`：

```yaml
- id: proxy-router
  name: dsh-proxy-router
  config:
    subscriptionUrl: 'https://你的订阅链接'   # 必填，含 token，请自行保管
    corePath: ''            # 留空自动探测 mihomo / verge-mihomo
    autoStart: true         # 随 harness 启动内核
    mixedPort: 19097
    controllerPort: 19098
    directTimeoutMs: 8000
    proxyTimeoutMs: 12000
    healthUrl: 'http://cp.cloudflare.com/generate_204'
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `subscriptionUrl` | `''` | 订阅链接；支持 Clash YAML 与 base64 节点列表 |
| `corePath` | 自动探测→自动下载 | **通常不用填**；要强制指定内核路径时才填（或设 `DSH_PROXY_CORE`） |
| `autoStart` | `false` | 是否随 harness 启动内核 |
| `mixedPort` / `controllerPort` | 19097 / 19098 | 本地混合端口与控制器端口（避开 Clash Verge 的 7897/9097） |
| `directTimeoutMs` / `proxyTimeoutMs` | 8000 / 12000 | 两条路的超时预算 |
| `healthUrl` | cloudflare 204 | 节点健康探测目标 |

## 工具：`proxy_router`

| action | 作用 |
|---|---|
| `status` | 内核状态、当前选中节点、健康节点数、路由记忆条数 |
| `start` / `stop` | 启停本地内核 |
| `test` | 逐节点实测健康度，按延迟排序返回 |
| `fetch` | 按「直连优先 → 代理兜底」取回一个 URL（`force: true` 忽略记忆重新试） |
| `routes` / `forget` | 查看 / 清空按主机的路由记忆 |

## 测试

```sh
npm test
```

`test/selftest.mjs` 用真实的本地内核与真实传输验证四件事：直连失败 → 代理取回成功；第二次调用直接走对的那条路；直连可达的主机不绕代理；路由记忆持久化。
`test/router-real.mjs` 用真实订阅启动内核并统计节点健康度：

```powershell
$env:SUB_URL='https://你的订阅链接'; node test/router-real.mjs
```

## 边界与注意

- 订阅里的节点可能全是死的（被封锁或服务器下线）。此时插件如实报告「健康 0 个」，只有直连路径生效——**不会因为代理挂了而拖死 agent**。
- 订阅 URL 会写进生成的内核配置（`<DSH_HOME>/cache/proxy-router/config.yaml`），该文件含凭据，不要同步或提交。
- 本插件运行第三方内核进程（mihomo）。装插件就是跑第三方代码，请只装你信任的来源。
- 本插件目前**没有**接管内置 `web_fetch`：它提供的是独立工具与本地代理端口。要让内置抓取也走这套路由，需要额外注册 `ctx.web` 抓取提供方。

## 许可

MIT
