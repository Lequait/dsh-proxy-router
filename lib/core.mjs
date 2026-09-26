// dsh-proxy-router/core — 订阅 -> 本地内核 -> 直连/代理双路智能取回（纯 Node，无第三方依赖）
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

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
export function detectCore() {
  var names = ['mihomo.exe', 'verge-mihomo.exe', 'clash-meta.exe', 'mihomo', 'verge-mihomo', 'clash-meta'];
  var cands = [];
  if (process.env.DSH_PROXY_CORE) cands.push(process.env.DSH_PROXY_CORE);
  var dirs = [], seen = {};
  (process.env.PATH || '').split(path.delimiter).forEach(function (d) { if (d) dirs.push(d); });
  ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'USERPROFILE'].forEach(function (k) {
    var base = process.env[k];
    if (!base) return;
    dirs.push(path.join(base, 'Clash Verge'));
    dirs.push(path.join(base, 'Programs', 'Clash Verge'));
    dirs.push(path.join(base, 'Mihomo'));
    dirs.push(path.join(base, 'mihomo'));
  });
  dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin');
  dirs.forEach(function (d) { names.forEach(function (n) { var p = path.join(d, n); if (!seen[p]) { seen[p] = 1; cands.push(p); } }); });
  for (var i = 0; i < cands.length; i++) { try { if (fs.existsSync(cands[i])) return cands[i]; } catch (e) {} }
  return null;
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
