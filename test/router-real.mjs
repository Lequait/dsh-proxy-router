import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRouter, createSmartFetch } from '../lib/core.mjs';

const SUB = process.env.SUB_URL;
if (!SUB) { console.error('用法：SUB_URL=<订阅链接> node test/router-real.mjs'); process.exit(1); }
const RUN = path.join(process.env.DSH_HOME || os.tmpdir(), 'proxy-router-selftest', 'router-real');
const router = await startRouter({ coreExe: process.env.DSH_PROXY_CORE || undefined, dir: RUN, subUrl: SUB, mixedPort: 19094, controllerPort: 19095, secret: 'realcore', concurrency: 10 });
console.log('router up:', router.version, router.proxyUrl, 'pid', router.pid);
await new Promise((r) => setTimeout(r, 4000));   // 等 provider 首次拉取
const st = await router.status();
console.log('status:', JSON.stringify({ selected: st.selected, total: st.total, tested: st.tested, healthyCount: st.healthy.length, top: st.healthy.slice(0, 5) }));

// 关键性质：代理没有健康节点时，直连优先策略仍能保证 harness 正常工作
const sf = createSmartFetch({ proxy: router.proxyUrl, stateFile: RUN + '/state.json', directTimeoutMs: 6000, proxyTimeoutMs: 8000 });
const ok = await sf.fetch('http://cp.cloudflare.com/generate_204');
console.log('smartFetch with dead proxy ->', JSON.stringify({ ok: ok.ok, route: ok.route, status: ok.status, tried: ok.tried }));
const hostlist = await router.api('/providers/proxies').then((p) => Object.keys(p.providers || {})).catch(() => []);
console.log('providers:', JSON.stringify(hostlist));
router.stop();
fs.appendFileSync(path.join(RUN, 'result.txt'), JSON.stringify({ selected: st.selected, total: st.total, tested: st.tested, healthy: st.healthy.length, smartFallbackRoute: ok.route }) + '\n');
