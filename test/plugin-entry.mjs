// plugin-entry.mjs — 用假 ctx 驱动真实插件入口：零配置（无 corePath、无环境变量）只给订阅地址
import { apply } from '../index.js';

const registered = {};
let disposed = null;
const logs = [];
const ctx = {
  tools: { register: (def) => { registered[def.name] = def; return () => { delete registered[def.name]; }; } },
  effect: (fn) => { disposed = fn(); return disposed; },
  logger: { info: (m) => logs.push(String(m)) },
};
apply(ctx, { mixedPort: 19197, controllerPort: 19198, autoStart: false });

const results = [];
const check = (n, ok, d) => { results.push((ok ? 'PASS  ' : 'FAIL  ') + n + '  ' + d); return ok; };
const tool = registered.proxy_router;
check('注册了 proxy_router 工具', !!tool, 'name=' + (tool && tool.name));
check('工具声明 subscriptionUrl 参数', !!(tool.parameters.properties.subscriptionUrl), JSON.stringify(Object.keys(tool.parameters.properties)));

const s0 = await tool.execute({ action: 'status' }, {});
check('启动前 status 正常', s0.ok === true, s0.detail + ' | core=' + JSON.parse(s0.data).corePath);

const s1 = await tool.execute({ action: 'start', subscriptionUrl: process.env.SUB_URL }, {});
check('只给订阅地址即可启动', s1.ok === true, s1.detail);

const s2 = await tool.execute({ action: 'test' }, {});
check('节点健康测试可用', typeof s2.detail === 'string', s2.detail);

const s3 = await tool.execute({ action: 'fetch', url: 'http://cp.cloudflare.com/generate_204' }, {});
check('fetch 直连优先可用', s3.ok === true, s3.detail);

const s4 = await tool.execute({ action: 'status' }, {});
const d4 = JSON.parse(s4.data || '{}');
check('status 报告订阅与内核来源', d4.subscriptionConfigured === true && !!d4.corePath, 'core=' + d4.corePath + ' coreManaged=' + d4.coreManaged);

const s5 = await tool.execute({ action: 'stop' }, {});
check('stop 可用', s5.ok === true, s5.detail);
if (typeof disposed === 'function') disposed();

console.log(results.join('\n'));
console.log('--- 插件日志 ---');
logs.slice(0, 8).forEach((l) => console.log('  ' + l));
console.log('summary: ' + results.filter((r) => r.startsWith('PASS')).length + ' pass / ' + results.filter((r) => r.startsWith('FAIL')).length + ' fail');
