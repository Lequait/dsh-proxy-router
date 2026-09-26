# dsh-proxy-router

**Direct-first fetching with automatic proxy fallback for DeepSeek Harness.** Import a subscription; targets that fail direct are retried through the proxy, and the route that worked is remembered per host.

It exists to stop the retry-the-mirror loop: fail once, switch route once, and go straight down the working path next time.

## Why not just an environment proxy

DSH's built-in `dsh-http-proxy` offers exactly one route: it installs `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` as undici's global dispatcher at launch. Everything matching goes through the proxy; nothing is decided per host, nothing is retried, nothing can change at runtime, and when the proxy dies every request dies with it.

This plugin adds the missing layer: **two routes + memory + health checks**.

## How it works

```
subscription URL --+--> mihomo core (supervised) --> local mixed port http://127.0.0.1:<mixedPort>
                    |      proxy-provider: refreshes the subscription
                    |      url-test group: picks the lowest-latency healthy node, fails over
                    v
          smartFetch (this plugin)
            1. consult per-host routing memory (30 min TTL by default)
            2. try direct -> on failure retry through the proxy
            3. remember which route worked for that host
                    ^
                    +-- with zero healthy nodes, the direct path still works
```

Node selection and failover belong to the core; choosing direct vs proxy belongs to the plugin. Transports are plain `node:http` / `node:https` / `node:tls` with a CONNECT tunnel - **no third-party dependencies**.

## Install

```sh
dsh plugin --profile <your-profile> add dsh-proxy-router
dsh plugin --profile <your-profile> add github:Lequait/dsh-proxy-router
```

Restart the harness; the `proxy_router` tool then appears in the session.

## Configuration

Edit the `proxy-router` entry's `config` in your profile's `cordis.patch.yml`:

```yaml
- id: proxy-router
  name: dsh-proxy-router
  config:
    subscriptionUrl: 'https://your-subscription-url'
    corePath: ''            # empty = auto-detect mihomo / verge-mihomo
    autoStart: true
    mixedPort: 19097
    controllerPort: 19098
```

| Field | Default | Meaning |
|---|---|---|
| `subscriptionUrl` | `''` | Subscription link; Clash YAML and base64 node lists both supported |
| `corePath` | auto-detect | Path to mihomo / verge-mihomo, or set `DSH_PROXY_CORE` |
| `autoStart` | `false` | Start the core with the harness |
| `mixedPort` / `controllerPort` | 19097 / 19098 | Local mixed port and controller port |
| `directTimeoutMs` / `proxyTimeoutMs` | 8000 / 12000 | Timeout budget per route |
| `healthUrl` | cloudflare 204 | Node health-check target |

## The `proxy_router` tool

Actions: `status`, `start`, `stop`, `test`, `fetch` (direct-first with `force` to ignore memory), `routes`, `forget`.

## Test

```sh
npm test
```

`test/selftest.mjs` proves, over real transports and a real local core: a direct failure falls back to the proxy and succeeds; the second call takes the learned route directly; reachable hosts stay direct; the routing memory persists.

## Limits

- The subscription's nodes may all be dead (blocked or offline). The plugin then reports `0 healthy` and only the direct path is used - it never lets a dead proxy take the agent down.
- The subscription URL is written into the generated core config at `<DSH_HOME>/cache/proxy-router/config.yaml`, which holds credentials. Do not sync or commit that directory.
- The plugin runs a third-party core process (mihomo). Installing a plugin runs third-party code with your permissions.
- The built-in `web_fetch` is **not** hijacked: this plugin ships its own tool and local proxy port. Routing the built-in fetcher needs a `ctx.web` fetch provider, which is a separate step.

## License

MIT
