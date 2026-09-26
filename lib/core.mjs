// dsh-proxy-router/core — 订阅 -> 本地内核 -> 直连/代理双路智能取回（纯 Node，无第三方依赖）
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const UA_SUB = 'clash-verge/v1.7.7';
export const HEALTH_URL = 'http://cp.cloudflare.com/generate_204';
export const CLOUDFLARE_204 = 'http://cp.cloudflare.com/generate_204';

// ---------------- 订阅解析 ----------------
export function b64decode(s) {
  var t = String(s).trim().replace(/-/g, '+').replace(/_/g, '/');
  t += '='.repeat((4 - (t.length % 4)) % 4);
  return Buffer.from(t, 'base64').toString('utf8');
}
export function parseSubscription(body) {
  var text = String(body || '');
  if (/^\s*proxies\s*:/m.test(text)) return { format: 'clash-yaml', nodes: parseClashProxies(text) };
  var isPlain = /^[a-z0-9]+:\/\//im.test(text);
  var dec = isPlain ? text : b64decode(text);
  var nodes = dec.split(/\r?\n/).map(function (l) { return l.trim(); })
    .filter(function (l) { return /^[a-z0-9]+:\/\//i.test(l); })
    .map(parseUri).filter(Boolean);
  return { format: isPlain ? 'plain-uri-list' : 'base64-uri-list', nodes: nodes };
}
function parseClashProxies(text) {
  var lines = text.split(/\r?\n/);
  var start = -1;
  for (var i = 0; i < lines.length; i++) if (/^proxies\s*:/.test(lines[i])) { start = i; break; }
  if (start < 0) return [];
  var blocks = [], cur = null;
  for (var j = start + 1; j < lines.length; j++) {
    var line = lines[j];
    if (/^[a-zA-Z-]+\s*:/.test(line)) break;
    var item = line.match(/^\s*-\s*(.*)$/);
    if (item) { if (cur) blocks.push(cur); cur = item[1].trim() ? [item[1].trim()] : []; }
    else if (cur && line.trim()) cur.push(line.trim());
  }
  if (cur) blocks.push(cur);
  return blocks.map(function (block) {
    var o = {};
    block.forEach(function (l) {
      if (l.charAt(0) === '{') {
        l.replace(/^\{|\}$/g, '').split(/,(?=(?:[^"']|"[^"]*"|'[^']*')*$)/).forEach(function (kv) {
          var i2 = kv.indexOf(':'); if (i2 > 0) o[kv.slice(0, i2).trim()] = kv.slice(i2 + 1).trim().replace(/^["']|["']$/g, '');
        });
      } else {
        var kv = l.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (kv) o[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
      }
    });
    var ports = String(o.ports || o.port || '');
    var port = Number(ports.indexOf('-') >= 0 ? ports.split('-')[0] : ports);
    if (!o.server) return null;
    return { name: o.name || o.server, type: (o.type || '').toLowerCase(), server: o.server, port: port,
      transport: /hysteria|tuic|wireguard/.test(o.type || '') ? 'udp' : 'tcp', raw: block.join('\n') };
  }).filter(Boolean);
}
function parseUri(uri) {
  var m = uri.match(/^([a-z0-9]+):\/\//i);
  if (!m) return null;
  var scheme = m[1].toLowerCase();
  var body = uri.slice(scheme.length + 3);
  var parts = body.split('#');
  var name = parts[1] ? decodeURIComponent(parts[1]) : '';
  if (scheme === 'vmess') { try { var j = JSON.parse(b64decode(parts[0])); return { name: j.ps || name, type: 'vmess', server: j.add, port: Number(j.port), transport: 'tcp', raw: uri }; } catch (e) { return null; } }
  var at = parts[0].lastIndexOf('@');
  if (at < 0) return null;
  var tail = parts[0].slice(at + 1);
  var qi = tail.indexOf('?');
  var hostport = qi >= 0 ? tail.slice(0, qi) : tail;
  var q = new URLSearchParams(qi >= 0 ? tail.slice(qi + 1) : '');
  var i = hostport.lastIndexOf(':');
  var udp = ['hysteria2', 'hy2', 'tuic', 'wireguard', 'wg'].indexOf(scheme) >= 0;
  return { name: name, type: scheme, server: hostport.slice(0, i), port: Number(hostport.slice(i + 1)),
    transport: udp ? 'udp' : 'tcp', sni: q.get('sni') || q.get('peer') || '', net: q.get('type') || 'tcp', raw: uri };
}

// ---------------- 传输 ----------------
export function directFetch(urlStr, opts) {
  var timeoutMs = (opts && opts.timeoutMs) || 8000;
  var u = new URL(urlStr);
  var t0 = Date.now();
  if (u.protocol === 'https:') {
    return new Promise(function (resolve, reject) {
      var s = tls.connect({ host: u.hostname, port: Number(u.port || 443), servername: u.hostname, timeout: timeoutMs, rejectUnauthorized: false }, function () {
        var req = https.request({ host: u.hostname, port: Number(u.port || 443), path: u.pathname + u.search, headers: { Host: u.host, 'User-Agent': 'dsh-proxy-router/1' }, createConnection: function () { return s; }, agent: false }, function (res) {
          var c = []; res.on('data', function (x) { c.push(x); });
          res.on('end', function () { s.destroy(); resolve({ status: res.statusCode, bytes: Buffer.concat(c).length, ms: Date.now() - t0, route: 'direct' }); });
        });
        req.on('error', function (e) { s.destroy(); reject(e); }); req.end();
      });
      s.once('error', reject);
      s.once('timeout', function () { s.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    });
  }
  return new Promise(function (resolve, reject) {
    var s = net.connect({ host: u.hostname, port: Number(u.port || 80) });
    s.setTimeout(timeoutMs, function () { s.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
    s.once('error', reject);
    s.once('connect', function () {
      var req = http.request({ host: u.hostname, port: Number(u.port || 80), path: u.pathname + u.search, method: 'GET', headers: { Host: u.host, 'User-Agent': 'dsh-proxy-router/1' }, createConnection: function () { return s; }, agent: false }, function (res) {
        var c = []; res.on('data', function (x) { c.push(x); });
        res.on('end', function () { s.destroy(); resolve({ status: res.statusCode, bytes: Buffer.concat(c).length, ms: Date.now() - t0, route: 'direct' }); });
      });
      req.on('error', reject); req.end();
    });
  });
}
export function proxyFetch(urlStr, proxyUrl, opts) {
  var timeoutMs = (opts && opts.timeoutMs) || 12000;
  var u = new URL(urlStr), p = new URL(proxyUrl), t0 = Date.now();
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () { if (!settled) { settled = true; try { sock.destroy(); } catch (e) {} reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); } }, timeoutMs + 3000);
    var sock = net.connect({ host: p.hostname, port: Number(p.port || 8080) });
    function fin(fn, v) { if (settled) return; settled = true; clearTimeout(timer); fn(v); }
    sock.once('error', function (e) { fin(reject, e); });
    sock.once('connect', function () {
      if (u.protocol === 'http:') {
        var req = http.request({ host: p.hostname, port: Number(p.port || 8080), path: urlStr, method: 'GET', headers: { Host: u.host, 'User-Agent': 'dsh-proxy-router/1' }, createConnection: function () { return sock; }, agent: false }, function (res) {
          var c = []; res.on('data', function (x) { c.push(x); });
          res.on('end', function () { sock.destroy(); fin(resolve, { status: res.statusCode, bytes: Buffer.concat(c).length, ms: Date.now() - t0, route: 'proxy', proxy: p.host }); });
        });
        req.on('error', function (e) { fin(reject, e); }); req.end();
        return;
      }
      sock.write('CONNECT ' + u.hostname + ':' + (u.port || 443) + ' HTTP/1.1\r\nHost: ' + u.hostname + '\r\n\r\n');
      var buf = '';
      function onData(c) {
        buf += c.toString('latin1');
        if (buf.indexOf('\r\n\r\n') < 0) return;
        sock.removeListener('data', onData);
        if (!/^HTTP\/1\.[01] 200/.test(buf)) { fin(reject, Object.assign(new Error('proxy-refused ' + buf.split('\r\n')[0]), { code: 'EPROXY' })); return; }
        var t = tls.connect({ socket: sock, servername: u.hostname, rejectUnauthorized: false }, function () {
          var req = https.request({ host: u.hostname, port: Number(u.port || 443), path: u.pathname + u.search, headers: { Host: u.host, 'User-Agent': 'dsh-proxy-router/1' }, createConnection: function () { return t; }, agent: false }, function (res) {
            var c = []; res.on('data', function (x) { c.push(x); });
            res.on('end', function () { t.destroy(); fin(resolve, { status: res.statusCode, bytes: Buffer.concat(c).length, ms: Date.now() - t0, route: 'proxy', proxy: p.host }); });
          });
          req.on('error', function (e) { fin(reject, e); }); req.end();
        });
        t.once('error', function (e) { fin(reject, e); });
      }
      sock.on('data', onData);
    });
  });
}

// ---------------- 智能取回：直连优先 + 代理兜底 + 按主机学习 ----------------
export function createSmartFetch(cfg) {
  cfg = cfg || {};
  var proxy = cfg.proxy || null;
  var stateFile = cfg.stateFile || null;
  var directTimeoutMs = cfg.directTimeoutMs || 8000;
  var proxyTimeoutMs = cfg.proxyTimeoutMs || 12000;
  var ttlMs = cfg.ttlMs || 30 * 60 * 1000;
  var state = {};
  if (stateFile) { try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) {} }
  function save() { if (!stateFile) return; try { fs.mkdirSync(path.dirname(stateFile), { recursive: true }); fs.writeFileSync(stateFile, JSON.stringify(state, null, 1)); } catch (e) {} }
  function fresh(h) { return state[h] && (Date.now() - state[h].at) < ttlMs ? state[h] : null; }
  return {
    getProxy: function () { return proxy; },
    setProxy: function (v) { proxy = v; },
    state: function () { return state; },
    fetch: async function (url, o) {
      o = o || {};
      var h = new URL(url).hostname;
      var known = o.force ? null : fresh(h);
      var order = known && known.mode === 'proxy' ? ['proxy', 'direct'] : ['direct', 'proxy'];
      var errors = [], tried = [];
      for (var i = 0; i < order.length; i++) {
        var route = order[i];
        if (route === 'proxy' && !proxy) continue;
        tried.push(route);
        try {
          var r = route === 'direct' ? await directFetch(url, { timeoutMs: directTimeoutMs }) : await proxyFetch(url, proxy, { timeoutMs: proxyTimeoutMs });
          state[h] = { mode: route, detail: 'ok', at: Date.now() }; save();
          return Object.assign({ ok: true, learnedFrom: known ? known.mode : null, tried: tried }, r);
        } catch (e) { errors.push(route + ':' + (e.code || e.message)); }
      }
      if (errors.length > 1) { state[h] = { mode: 'proxy', detail: errors.join(' -> '), at: Date.now() }; save(); }
      return { ok: false, route: null, status: 0, error: errors.join(' -> '), tried: tried };
    },
  };
}

// ---------------- 内核监督 ----------------
export var CORE_NAMES = ['mihomo.exe', 'verge-mihomo.exe', 'clash-meta.exe', 'clash-win64.exe', 'mihomo', 'verge-mihomo', 'clash-meta'];
var _coreCache;
function isFile(p) { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } }
/**
 * 内核优先级：0 = 完整 mihomo（支持 vless/tuic/hysteria2），1 = clash-meta，2 = 其它 Clash 内核；-1 = 不可用。
 * 明确排除服务包装器与 GUI（clash-core-service.exe、clash-verge.exe），它们不是内核本体。
 */
export function coreTier(p) {
  var b = path.basename(String(p || '')).toLowerCase().replace(/\.exe$/, '');
  if (!b || b.indexOf('service') >= 0 || b === 'clash-verge' || b.indexOf('gui') >= 0) return -1;
  if (b === 'mihomo' || b === 'verge-mihomo' || b.indexOf('mihomo-') === 0 || b.indexOf('verge-mihomo-') === 0) return 0;
  if (b.indexOf('clash-meta') === 0) return 1;
  if (b.indexOf('clash-win64') === 0 || b.indexOf('clash-rs') === 0 || b === 'clash') return 2;
  return -1;
}
function psLines(script) {
  if (process.platform !== 'win32') return [];
  try {
    var r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 25000, windowsHide: true });
    return String(r.stdout || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  } catch (e) { return []; }
}
/** 正在运行的内核进程路径（Clash Verge 常驻内核靠这一步找到，与装在哪个盘无关）。 */
export function runningCorePaths() {
  return psLines('Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "mihomo|clash" } | Select-Object -ExpandProperty Path')
    .filter(function (p) { return coreTier(p) >= 0; });
}
/** 注册表卸载项里 Clash/Mihomo 的安装目录。 */
export function registryCoreDirs() {
  return psLines("Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Clash|Mihomo' -and $_.InstallLocation } | Select-Object -ExpandProperty InstallLocation");
}
/**
 * 零配置找内核：环境变量 → PATH → 常见安装目录 → 正在运行的内核 → 注册表安装目录。
 * 同一批候选按 coreTier 排序，优先完整 mihomo。
 * @param fresh - 忽略缓存重新搜索。
 * @returns 可执行文件路径，找不到返回 null。
 */
export function detectCore(fresh) {
  if (!fresh && _coreCache !== undefined) return _coreCache;
  if (process.env.DSH_PROXY_CORE && isFile(process.env.DSH_PROXY_CORE)) { _coreCache = process.env.DSH_PROXY_CORE; return _coreCache; }
  var dirs = [], cands = [], seen = {};
  var push = function (p) { if (p && !seen[p]) { seen[p] = 1; cands.push(p); } };
  (process.env.PATH || '').split(path.delimiter).forEach(function (d) { if (d) dirs.push(d); });
  ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'USERPROFILE'].forEach(function (k) {
    var base = process.env[k];
    if (!base) return;
    [['Clash Verge'], ['Programs', 'Clash Verge'], ['Mihomo'], ['mihomo'], ['Programs', 'mihomo']].forEach(function (parts) {
      dirs.push(path.join.apply(path, [base].concat(parts)));
    });
  });
  if (process.platform === 'win32') {
    dirs.push('C:\\Program Files\\Clash Verge', 'C:\\Program Files\\Mihomo');
    runningCorePaths().forEach(push);          // 运行中的内核本身就是可执行文件路径
    registryCoreDirs().forEach(function (d) { dirs.push(d); });
  }
  ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/snap/bin'].forEach(function (d) { dirs.push(d); });
  dirs.forEach(function (d) { CORE_NAMES.forEach(function (n) { push(path.join(d, n)); }); });
  var usable = cands.filter(function (p) { return coreTier(p) >= 0 && isFile(p); });
  usable.sort(function (a, b) { return coreTier(a) - coreTier(b); });
  _coreCache = usable.length ? usable[0] : null;
  return _coreCache;
}
/** 取一段文本（直连）。 */
export function httpGetText(url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var u = new URL(url);
    var mod = u.protocol === 'https:' ? https : http;
    var req = mod.get({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: { 'User-Agent': 'dsh-proxy-router/1', Accept: '*/*' }, timeout: timeoutMs || 15000 }, function (res) {
      var c = []; res.on('data', function (x) { c.push(x); });
      res.on('end', function () { resolve({ status: res.statusCode, text: Buffer.concat(c).toString('utf8') }); });
    });
    req.on('error', reject); req.on('timeout', function () { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
  });
}
export function coreAssetName(version) {
  var v = String(version).replace(/^v/, '');
  var arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  if (process.platform === 'win32') return 'mihomo-windows-' + arch + '-compatible-v' + v + '.zip';
  if (process.platform === 'darwin') return 'mihomo-darwin-' + arch + '-v' + v + '.gz';
  return 'mihomo-linux-' + arch + '-compatible-v' + v + '.gz';
}
export var CORE_MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/', 'https://ghproxy.net/'];
export var CORE_PINNED = 'v1.19.31';
/** 下载内核到本地（找不到内核时的兜底）。返回可执行文件路径。 */
export async function downloadCore(o) {
  o = o || {};
  var log = o.log || function () {};
  var dir = o.dir || path.join(o.home || process.env.DSH_HOME || os.tmpdir(), 'cache', 'proxy-router', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  var version = o.version || CORE_PINNED;
  try {
    var latest = JSON.parse((await httpGetText('https://api.github.com/repos/MetaCubeX/mihomo/releases/latest', 12000)).text);
    if (latest && latest.tag_name) version = latest.tag_name;
  } catch (e) { log('取最新版本失败，改用 ' + version + '：' + (e.code || e.message)); }
  var asset = coreAssetName(version);
  var url = 'https://github.com/MetaCubeX/mihomo/releases/download/' + version + '/' + asset;
  var file = path.join(dir, asset);
  var lastErr = 'no-source';
  for (var i = 0; i < CORE_MIRRORS.length; i++) {
    var target = CORE_MIRRORS[i] + url;
    try {
      log('下载内核：' + (CORE_MIRRORS[i] ? CORE_MIRRORS[i] : 'direct') + asset + ' ...');
      var resp = await httpGetBuffer(target, 240000);
      if (resp.bytes < 1000000) throw new Error('响应过小 ' + resp.bytes + 'B');
      fs.writeFileSync(file, resp.buffer);
      log('已下载 ' + (resp.bytes / 1048576).toFixed(1) + ' MB');
      break;
    } catch (e) { lastErr = (e.code || e.message); log('该源失败：' + lastErr); }
  }
  if (!fs.existsSync(file)) throw new Error('内核下载失败（' + lastErr + '）。可手动下载 mihomo 并在插件配置里填 corePath。');
  var bin = path.join(dir, process.platform === 'win32' ? 'mihomo.exe' : 'mihomo');
  if (asset.slice(-4) === '.zip') {
    runQuiet('tar', ['-xf', file, '-C', dir]);
    if (!fs.existsSync(bin)) runQuiet('powershell.exe', ['-NoProfile', '-Command', 'Expand-Archive -Path "' + file + '" -DestinationPath "' + dir + '" -Force']);
  } else {
    runQuiet('gunzip', ['-f', file]);
    if (!fs.existsSync(bin)) runQuiet('tar', ['-xzf', file, '-C', dir]);
  }
  if (!fs.existsSync(bin)) throw new Error('内核下载完成但解压失败：' + file);
  try { fs.chmodSync(bin, 493); } catch (e) {}
  log('内核就绪：' + bin);
  return bin;
}
function runQuiet(cmd, args) { try { spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true }); } catch (e) {} }
export function httpGetBuffer(url, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var u = new URL(url);
    var mod = u.protocol === 'https:' ? https : http;
    var req = mod.get({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + u.search, headers: { 'User-Agent': 'dsh-proxy-router/1' }, timeout: timeoutMs || 60000 }, function (res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); return resolve(httpGetBuffer(new URL(res.headers.location, url).toString(), timeoutMs)); }
      var c = []; res.on('data', function (x) { c.push(x); });
      res.on('end', function () { var b = Buffer.concat(c); resolve({ status: res.statusCode, buffer: b, bytes: b.length }); });
    });
    req.on('error', reject); req.on('timeout', function () { req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })); });
  });
}
/** 零配置启动：先找内核，找不到再下载，然后启动。 */
export async function startRouterAuto(o) {
  var exe = o.coreExe || detectCore();
  if (!exe) {
    if (o.autoDownload === false) throw new Error('找不到 mihomo 内核，且已禁用自动下载：请在配置里填 corePath 或设 DSH_PROXY_CORE');
    (o.log || function () {} )('未发现本地内核，尝试自动下载 mihomo ...');
    exe = await downloadCore({ log: o.log, home: o.home });
  }
  return startRouter(Object.assign({}, o, { coreExe: exe }));
}
export function generateConfig(o) {
  var health = o.healthUrl || HEALTH_URL;
  var head = [
    'mixed-port: ' + o.mixedPort,
    'allow-lan: false',
    'mode: rule',
    'log-level: warning',
    'ipv6: false',
    'find-process-mode: off',
    'external-controller: 127.0.0.1:' + o.controllerPort,
    'secret: "' + o.secret + '"',
    'unified-delay: true',
    'tcp-concurrent: true',
    'profile:',
    '  store-selected: true',
    o.extraYaml ? String(o.extraYaml).trim() : '',
  ].filter(Boolean).join('\n');
  var source = o.subUrl
    ? ['proxy-providers:', '  sub:', '    type: http', '    url: "' + o.subUrl + '"', '    interval: 3600',
       '    path: ./providers/sub.yaml', '    health-check:', '      enable: true', '      url: ' + health,
       '      interval: 300', '      timeout: 5000'].join('\n')
    : 'proxies:\n' + o.inlineNodesText;
  var tail = [
    'proxy-groups:',
    '  - name: PROXY',
    '    type: url-test',
    '    url: ' + health,
    '    interval: 300',
    '    tolerance: 50',
    '    timeout: 5000',
    o.subUrl ? '    use: [sub]' : '    proxies: [DIRECT]',
    'rules:',
    '  - MATCH,PROXY',
  ].join('\n');
  return head + '\n' + source + '\n' + tail + '\n';
}
export function startRouter(o) {
  return new Promise(function (resolvePromise, rejectPromise) {
    var exe = o.coreExe || detectCore();
    if (!exe) { rejectPromise(new Error('找不到 mihomo 内核：请设置 corePath，或把 mihomo/verge-mihomo 放到已知目录')); return; }
    fs.mkdirSync(o.dir, { recursive: true });
    var cfgPath = path.join(o.dir, 'config.yaml');
    fs.writeFileSync(cfgPath, generateConfig(o), 'utf8');
    var logFd = fs.openSync(path.join(o.dir, 'core.log'), 'a');
    var child = spawn(exe, ['-d', o.dir, '-f', cfgPath], { stdio: ['ignore', logFd, logFd], windowsHide: true });
    var api = function (p) {
      return new Promise(function (res2, rej2) {
        var req = http.request({ host: '127.0.0.1', port: o.controllerPort, path: p, headers: { Authorization: 'Bearer ' + o.secret }, timeout: 8000 }, function (res) {
          var c = []; res.on('data', function (x) { c.push(x); });
          res.on('end', function () { try { res2(JSON.parse(Buffer.concat(c).toString())); } catch (e) { rej2(new Error('bad json')); } });
        });
        req.on('error', rej2); req.on('timeout', function () { req.destroy(new Error('api timeout')); }); req.end();
      });
    };
    (async function () {
      var info = null;
      for (var i = 0; i < 60; i++) { try { info = await api('/version'); break; } catch (e) { await new Promise(function (r) { setTimeout(r, 250); }); } }
      if (!info) { try { child.kill(); } catch (e) {} rejectPromise(new Error('内核启动失败：控制器无响应（看 ' + path.join(o.dir, 'core.log') + '）')); return; }
      resolvePromise({
        proxyUrl: 'http://127.0.0.1:' + o.mixedPort,
        mixedPort: o.mixedPort, controllerPort: o.controllerPort, secret: o.secret,
        version: info.version, coreExe: exe, dir: o.dir, cfgPath: cfgPath, pid: child.pid,
        api: api,
        status: async function () {
          var g = await api('/proxies/PROXY');
          var nodes = g.all || [];
          var prov = await api('/providers/proxies').catch(function () { return null; });
          var list = prov && prov.providers && prov.providers.sub ? (prov.providers.sub.proxies || []).map(function (p) { return p.name; }) : [];
          var healthy = [];
          var limit = o.concurrency || 8;
          for (var i = 0; i < list.length; i += limit) {
            var batch = list.slice(i, i + limit);
            var got = await Promise.all(batch.map(async function (name) {
              try {
                var d = await api('/proxies/' + encodeURIComponent(name) + '/delay?timeout=5000&url=' + encodeURIComponent(HEALTH_URL));
                return d && d.delay ? { name: name, delay: d.delay } : null;
              } catch (e) { return null; }
            }));
            got.forEach(function (x) { if (x) healthy.push(x); });
          }
          healthy.sort(function (a, b) { return a.delay - b.delay; });
          return { version: info.version, mixedPort: o.mixedPort, selected: g.now, total: nodes.length, tested: list.length, healthy: healthy };
        },
        stop: function () { try { child.kill(); } catch (e) {} try { fs.closeSync(logFd); } catch (e) {} },
      });
    })().catch(rejectPromise);
  });
}
