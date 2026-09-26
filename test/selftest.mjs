// selftest.mjs — 用真实传输验证：直连失败 -> 代理兜底 -> 学习后代理优先
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRouter, createSmartFetch, directFetch, proxyFetch } from '../lib/core.mjs';

const RUN = path.join(process.env.DSH_HOME || os.tmpdir(), 'proxy-router-selftest');
fs.rmSync(path.join(RUN, 'state.json'), { force: true });   // 测试必须自隔离
const results = [];
const check = (name, ok, detail) => { results.push((ok ? 'PASS  ' : 'FAIL  ') + name + '  ' + detail); return ok; };

// 本地测试服务器：只有经代理（mihomo hosts 映射）才能到达
const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('router-ok'); });
await new Promise((r) => server.listen(18999, '127.0.0.1', r));

// 一个把 proxy-only.test 解析到 127.0.0.1 的内核，充当中转代理
const proxyCore = await startRouter({
  coreExe: process.env.DSH_PROXY_CORE || undefined, dir: RUN + '/proxycore', mixedPort: 19093, controllerPort: 19091, secret: 'testcore',
  inlineNodesText: '  - {name: DIRECTPLACEHOLDER, type: socks5, server: 127.0.0.1, port: 1}',
  extraYaml: 'hosts:\n  proxy-only.test: 127.0.0.1\n',
});
const PROXY = proxyCore.proxyUrl;
console.log('proxy core up:', proxyCore.version, PROXY, 'pid', proxyCore.pid);

// 1) 直连随机域名：应失败
let directErr = null;
try { await directFetch('http://proxy-only.test:18999/', { timeoutMs: 4000 }); } catch (e) { directErr = e.code || e.message; }
check('direct to fake host fails', !!directErr, 'error=' + directErr);

// 2) 同一个 URL 经代理：应成功
const viaProxy = await proxyFetch('http://proxy-only.test:18999/', PROXY, { timeoutMs: 8000 }).catch((e) => ({ error: e.code || e.message }));
check('same URL via proxy succeeds', viaProxy.status === 200, JSON.stringify(viaProxy));

// 3) smartFetch：直连失败自动切代理
const sf = createSmartFetch({ proxy: PROXY, stateFile: RUN + '/state.json', directTimeoutMs: 4000, proxyTimeoutMs: 8000 });
const r1 = await sf.fetch('http://proxy-only.test:18999/');
check('smartFetch falls back to proxy', r1.ok && r1.route === 'proxy' && r1.tried.length === 2, JSON.stringify({ ok: r1.ok, route: r1.route, tried: r1.tried, ms: r1.ms }));

// 4) 第二次：学到该主机需要代理，直接走代理
const r2 = await sf.fetch('http://proxy-only.test:18999/');
check('smartFetch learns proxy-first', r2.ok && r2.tried.length === 1 && r2.tried[0] === 'proxy', JSON.stringify({ route: r2.route, tried: r2.tried, learnedFrom: r2.learnedFrom }));

// 5) 正常站点仍走直连，不浪费代理
const r3 = await sf.fetch('http://cp.cloudflare.com/generate_204');
check('reachable host stays direct', r3.ok && r3.route === 'direct', JSON.stringify({ route: r3.route, status: r3.status, ms: r3.ms }));

// 6) 状态文件持久化
const st = JSON.parse(fs.readFileSync(RUN + '/state.json', 'utf8'));
check('state persisted', st['proxy-only.test'] && st['proxy-only.test'].mode === 'proxy', JSON.stringify(st));

server.close(); proxyCore.stop();
console.log('\n=== SELFTEST ===\n' + results.join('\n'));
console.log('summary: ' + results.filter((r) => r.startsWith('PASS')).length + ' pass / ' + results.filter((r) => r.startsWith('FAIL')).length + ' fail');
