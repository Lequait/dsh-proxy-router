/**
 * dsh-proxy-router —— 把订阅链接变成一个「直连优先、代理兜底」的取回能力。
 *
 * 为什么需要它：DSH 自带的 dsh-http-proxy 只会把启动环境里的 HTTP(S)_PROXY 装成全局
 * dispatcher——要么全走代理、要么全直连，没有健康判断也没有失败重试；而 web_fetch 的
 * 内置抓取提供方还禁止跨源重定向（GitHub Releases 这类镜像跳转会被它直接掐断）。
 *
 * 本插件做三件事：
 *   1. 订阅 → 本地 mihomo 内核（proxy-provider + url-test 组），内核自己做节点健康检查与故障切换；
 *   2. 取回时有路由记忆：直连成功就继续直连，直连失败自动改走代理并记住该主机（默认 30 分钟）；
 *   3. 代理没有健康节点时不阻塞任何事——直连优先策略保证 harness 照常工作。
 *
 * 设计约束（照 DSH 的实际接口来，不发明 API）：
 *   - 只暴露一个 ctx.tools 工具 proxy_router，避免工具表膨胀；
 *   - 不 import 任何 @deepseek-ai/* 包（link: 安装的插件解析不到 harness 的 node_modules）；
 *   - 不在 apply() 里做网络/进程动作，默认 autoStart=false，避免拖慢或拖挂启动。
 */
import os from 'node:os';
import path from 'node:path';
import { startRouter, detectCore, createSmartFetch, parseSubscription, directFetch } from './lib/core.mjs';

export const name = 'proxy-router';
export const inject = ['tools'];

const DEFAULTS = {
  subscriptionUrl: '',
  corePath: '',
  autoStart: false,
  mixedPort: 19097,
  controllerPort: 19098,
  secret: 'dsh-proxy-router',
  directTimeoutMs: 8000,
  proxyTimeoutMs: 12000,
  healthUrl: 'http://cp.cloudflare.com/generate_204',
  stateFile: '',
};

export function apply(ctx, config) {
  const cfg = Object.assign({}, DEFAULTS, config || {});
  const base = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const runDir = cfg.stateFile ? path.dirname(cfg.stateFile) : path.join(base, 'cache', 'proxy-router');
  const stateFile = cfg.stateFile || path.join(runDir, 'routes.json');
  const log = (msg) => { try { if (ctx.logger && ctx.logger.info) ctx.logger.info(msg); else console.error('[proxy-router] ' + msg); } catch (e) { console.error('[proxy-router] ' + msg); } };

  let router = null;
  let starting = null;
  const smart = createSmartFetch({
    proxy: null, stateFile: stateFile,
    directTimeoutMs: cfg.directTimeoutMs, proxyTimeoutMs: cfg.proxyTimeoutMs,
  });

  async function ensureRouter() {
    if (router) return router;
    if (starting) return starting;
    if (!cfg.subscriptionUrl) throw new Error('未配置 subscriptionUrl（在插件配置里填订阅链接，或直接调用 action=start 前先配置）');
    if (!cfg.corePath && !detectCore()) throw new Error('找不到 mihomo 内核：请设置 corePath（例如 G:\\Clash Verge\\verge-mihomo.exe）');
    starting = startRouter({
      coreExe: cfg.corePath || undefined, dir: runDir, subUrl: cfg.subscriptionUrl,
      mixedPort: cfg.mixedPort, controllerPort: cfg.controllerPort, secret: cfg.secret,
      healthUrl: cfg.healthUrl, concurrency: 8,
    }).then((r) => { router = r; smart.setProxy(r.proxyUrl); starting = null; log('内核已启动 ' + r.version + ' ' + r.proxyUrl + ' pid=' + r.pid); return r; })
      .catch((e) => { starting = null; throw e; });
    return starting;
  }

  async function statusPayload() {
    const payload = { running: !!router, proxy: router ? router.proxyUrl : null, subscriptionConfigured: !!cfg.subscriptionUrl, routes: smart.state() };
    if (router) {
      const st = await router.status();
      payload.core = { version: st.version, pid: router.pid, selected: st.selected, nodes: st.total, tested: st.tested, healthy: st.healthy.slice(0, 10), healthyCount: st.healthy.length };
    }
    return payload;
  }

  const PARAMS = {
    type: 'object',
    additionalProperties: false,
    properties: {
      action: { type: 'string', description: 'status=状态 | start=启动内核 | stop=停止 | test=实测节点健康 | fetch=按直连优先取回一个 URL | routes=查看路由记忆 | forget=清空路由记忆' },
      url: { type: 'string', description: 'action=fetch 时取回的 URL' },
      force: { type: 'boolean', description: 'action=fetch 时忽略已学到的路由，强制重新直连优先' },
    },
    required: ['action'],
  };

  ctx.tools.register({
    name: 'proxy_router',
    description: '通过本地代理订阅取回网络资源：直连优先，直连失败自动改走代理并记住该主机。action=status 查看状态，start/stop 管理本地内核，test 实测节点健康，fetch 取回 URL，routes 查看/忘记路由记忆。',
    parameters: PARAMS,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          detail: { type: 'string' },
          data: { type: 'string' },
        },
        required: ['ok', 'action', 'detail'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value.detail) + (value.data ? '\n\n' + value.data : '') }],
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args) {
      const action = String((args && args.action) || 'status');
      try {
        if (action === 'start') {
          const r = await ensureRouter();
          const data = await statusPayload();
          return { ok: true, action: action, detail: '内核已启动：' + r.version + ' @ ' + r.proxyUrl + '（pid ' + r.pid + '）', data: JSON.stringify(data, null, 1) };
        }
        if (action === 'stop') {
          if (!router) return { ok: true, action: action, detail: '内核未在运行' };
          router.stop(); router = null; smart.setProxy(null);
          return { ok: true, action: action, detail: '内核已停止' };
        }
        if (action === 'test') {
          const r = await ensureRouter();
          const st = await r.status();
          return { ok: st.healthy.length > 0, action: action, detail: '测试 ' + st.tested + ' 个节点，健康 ' + st.healthy.length + ' 个，当前选择 ' + st.selected, data: JSON.stringify(st.healthy.slice(0, 20), null, 1) };
        }
        if (action === 'routes') {
          return { ok: true, action: action, detail: '路由记忆（' + Object.keys(smart.state()).length + ' 台主机）', data: JSON.stringify(smart.state(), null, 1) };
        }
        if (action === 'forget') {
          const n = Object.keys(smart.state()).length;
          const file = stateFile;
          try { const fsm = await import('node:fs/promises'); await fsm.rm(file, { force: true }); } catch (e) {}
          return { ok: true, action: action, detail: '已清空 ' + n + ' 条路由记忆（重启插件后生效）' };
        }
        if (action === 'fetch') {
          if (!args.url) return { ok: false, action: action, detail: 'action=fetch 需要 url 参数' };
          const r = await smart.fetch(String(args.url), { force: !!args.force });
          const detail = r.ok
            ? '取回成功：' + r.status + '，经 ' + r.route + '（' + r.ms + 'ms，尝试 ' + r.tried.join('→') + '）'
            : '两条路都失败：' + r.error;
          return { ok: r.ok, action: action, detail: detail, data: JSON.stringify({ route: r.route, status: r.status, ms: r.ms, tried: r.tried, learnedFrom: r.learnedFrom || null }) };
        }
        if (action === 'status') {
          const data = await statusPayload();
          return { ok: true, action: action, detail: '内核' + (router ? '运行中' : '未启动') + '，订阅' + (cfg.subscriptionUrl ? '已配置' : '未配置') + '，路由记忆 ' + Object.keys(smart.state()).length + ' 条', data: JSON.stringify(data, null, 1) };
        }
        return { ok: false, action: action, detail: '未知 action：' + action };
      } catch (e) {
        return { ok: false, action: action, detail: '执行失败：' + (e && e.message ? e.message : String(e)) };
      }
    },
  });

  ctx.effect(() => () => { if (router) { try { router.stop(); } catch (e) {} router = null; } });

  if (cfg.autoStart && cfg.subscriptionUrl) {
    ensureRouter().catch((e) => log('自动启动失败：' + (e && e.message ? e.message : String(e))));
  } else {
    log('已挂载（autoStart=' + String(cfg.autoStart) + '，订阅' + (cfg.subscriptionUrl ? '已配置' : '未配置') + '）');
  }
}
