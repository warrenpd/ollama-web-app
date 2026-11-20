// Zero-dependency Node server: serves the web UI, streams chats to a local
// Ollama instance, and reports memory / CPU usage for the host and Ollama.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = Number(process.env.PORT) || 8787;
const OLLAMA = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const PUBLIC = path.join(__dirname, 'public');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

// Resident memory + CPU of every ollama process (server + model runners).
function ollamaProcessStats() {
  return new Promise((resolve) => {
    execFile('ps', ['-A', '-o', 'pid=,rss=,pcpu=,comm='], (err, stdout) => {
      if (err) return resolve({ rssBytes: null, cpuPercent: null, processes: 0 });
      let rss = 0, cpu = 0, n = 0;
      for (const line of stdout.split('\n')) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
        if (m && /ollama/i.test(path.basename(m[4]))) {
          rss += Number(m[2]) * 1024;
          cpu += Number(m[3]);
          n++;
        }
      }
      resolve({ rssBytes: rss, cpuPercent: cpu, processes: n });
    });
  });
}

let lastCpu = os.cpus();
function systemCpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = lastCpu[i] ? lastCpu[i].times : { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 };
    const t = c.times;
    const dt = (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys) + (t.idle - p.idle) + (t.irq - p.irq);
    idle += t.idle - p.idle;
    total += dt;
  });
  lastCpu = now;
  return total > 0 ? (1 - idle / total) * 100 : 0;
}

async function snapshot() {
  const [proc, loaded] = await Promise.all([
    ollamaProcessStats(),
    fetch(`${OLLAMA}/api/ps`).then((r) => r.json()).catch(() => ({ models: [] })),
  ]);
  return {
    time: Date.now(),
    system: {
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
      usedMem: os.totalmem() - os.freemem(),
      cpuPercent: systemCpuPercent(),
      loadAvg: os.loadavg(),
      cpus: os.cpus().length,
    },
    ollama: proc,
    loadedModels: (loaded.models || []).map((m) => ({
      name: m.name, size: m.size, sizeVram: m.size_vram, expiresAt: m.expires_at,
      contextLength: m.context_length,
    })),
  };
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const before = await snapshot();
  let peakRss = before.ollama.rssBytes || 0;
  let peakCpu = 0;
  const sampler = setInterval(async () => {
    const s = await ollamaProcessStats();
    if (s.rssBytes > peakRss) peakRss = s.rssBytes;
    if (s.cpuPercent > peakCpu) peakCpu = s.cpuPercent;
  }, 500);

  const controller = new AbortController();
  res.on('close', () => controller.abort());

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  const t0 = Date.now();
  let firstTokenAt = null;
  let firstContentAt = null;
  let thinkingStartAt = null;
  let final = null;

  try {
    const upstream = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: body.model || 'mistral',
        messages: body.messages || [],
        stream: true,
        options: body.options || {},
      }),
      signal: controller.signal,
    });
    if (!upstream.ok) {
      const text = await upstream.text();
      res.write(JSON.stringify({ type: 'error', error: text || upstream.statusText }) + '\n');
      return res.end();
    }

    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of upstream.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) {
          res.write(JSON.stringify({ type: 'error', error: msg.error }) + '\n');
          continue;
        }
        // Thinking models (e.g. MiMo, Qwen) stream their reasoning separately
        // from the answer; forward both so the UI isn't silent while it thinks.
        if (msg.message && msg.message.thinking) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          if (!thinkingStartAt) thinkingStartAt = Date.now();
          res.write(JSON.stringify({ type: 'thinking', content: msg.message.thinking }) + '\n');
        }
        if (msg.message && msg.message.content) {
          if (!firstTokenAt) firstTokenAt = Date.now();
          if (!firstContentAt) firstContentAt = Date.now();
          res.write(JSON.stringify({ type: 'token', content: msg.message.content }) + '\n');
        }
        if (msg.done) final = msg;
      }
    }
  } catch (e) {
    if (!controller.signal.aborted) {
      res.write(JSON.stringify({ type: 'error', error: `Cannot reach Ollama at ${OLLAMA}: ${e.message}` }) + '\n');
    }
  } finally {
    clearInterval(sampler);
  }

  if (final && !res.writableEnded) {
    const after = await snapshot();
    const ns = 1e9;
    const model = after.loadedModels.find((m) => m.name.startsWith(final.model)) || after.loadedModels[0] || null;
    const stats = {
      model: final.model,
      wallMs: Date.now() - t0,
      timeToFirstTokenMs: firstTokenAt ? firstTokenAt - t0 : null,
      timeToAnswerMs: firstContentAt ? firstContentAt - t0 : null,
      thinkingMs: thinkingStartAt ? (firstContentAt || Date.now()) - thinkingStartAt : 0,
      totalDurationMs: final.total_duration / 1e6,
      loadDurationMs: final.load_duration / 1e6,
      promptTokens: final.prompt_eval_count || 0,
      promptEvalMs: (final.prompt_eval_duration || 0) / 1e6,
      promptTokensPerSec: final.prompt_eval_duration ? final.prompt_eval_count / (final.prompt_eval_duration / ns) : null,
      completionTokens: final.eval_count || 0,
      evalMs: (final.eval_duration || 0) / 1e6,
      tokensPerSec: final.eval_duration ? final.eval_count / (final.eval_duration / ns) : null,
      modelSizeBytes: model ? model.size : null,
      modelVramBytes: model ? model.sizeVram : null,
      contextLength: model ? model.contextLength : null,
      ollamaRssBefore: before.ollama.rssBytes,
      ollamaRssAfter: after.ollama.rssBytes,
      ollamaRssPeak: Math.max(peakRss, after.ollama.rssBytes || 0),
      ollamaCpuPeak: peakCpu,
      systemUsedMemBefore: before.system.usedMem,
      systemUsedMemAfter: after.system.usedMem,
      systemTotalMem: after.system.totalMem,
    };
    res.write(JSON.stringify({ type: 'done', stats }) + '\n');
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'POST' && url.pathname === '/api/chat') return await handleChat(req, res);
    if (req.method === 'GET' && url.pathname === '/api/stats') return sendJson(res, 200, await snapshot());
    if (req.method === 'GET' && url.pathname === '/api/models') {
      try {
        const r = await fetch(`${OLLAMA}/api/tags`);
        const j = await r.json();
        return sendJson(res, 200, { ok: true, totalMem: os.totalmem(), models: (j.models || []).map((m) => ({ name: m.name, size: m.size, details: m.details })) });
      } catch (e) {
        return sendJson(res, 200, { ok: false, models: [], error: `Cannot reach Ollama at ${OLLAMA}` });
      }
    }
    if (req.method === 'GET') {
      const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
      if (!file.startsWith(PUBLIC)) return sendJson(res, 403, { error: 'forbidden' });
      return fs.readFile(file, (err, data) => {
        if (err) return sendJson(res, 404, { error: 'not found' });
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    }
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 500, { error: e.message });
    else res.end();
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or pick another port, e.g.:  PORT=9000 npm start`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Ollama Web App running at http://localhost:${PORT}  (Ollama: ${OLLAMA})`);
});
