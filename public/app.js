// ---------- state (persisted in localStorage) ----------
const STORE_KEY = 'ollama-chat.v1';
let state = load();
let abortCtl = null;

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && Array.isArray(s.chats)) return s;
  } catch {}
  return { chats: [], activeId: null, model: 'mistral' };
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}
const $ = (id) => document.getElementById(id);
const activeChat = () => state.chats.find((c) => c.id === state.activeId);

function newChat() {
  const chat = { id: crypto.randomUUID(), title: 'New chat', created: Date.now(), messages: [] };
  state.chats.unshift(chat);
  state.activeId = chat.id;
  save();
  render();
  $('input').focus();
}

// ---------- formatting ----------
const fmtBytes = (b) => {
  if (b == null) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtMs = (ms) => (ms == null ? '–' : ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${Math.round(ms)} ms`);
const fmtNum = (n, d = 1) => (n == null || !isFinite(n) ? '–' : n.toFixed(d));
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Minimal markdown: fenced code, inline code, bold.
function renderMarkdown(text) {
  const parts = text.split(/```/);
  return parts.map((p, i) => {
    if (i % 2 === 1) {
      const nl = p.indexOf('\n');
      const code = nl >= 0 ? p.slice(nl + 1) : p;
      return `<pre><code>${esc(code.replace(/\n$/, ''))}</code></pre>`;
    }
    return esc(p)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  }).join('');
}

// ---------- rendering ----------
function render() {
  renderChatList();
  renderMessages();
  renderChatStats();
}

function renderChatList() {
  const ul = $('chatList');
  ul.innerHTML = '';
  for (const c of state.chats) {
    const li = document.createElement('li');
    li.className = c.id === state.activeId ? 'active' : '';
    li.innerHTML = `<span class="t">${esc(c.title)}</span><button class="x" title="Delete chat">✕</button>`;
    li.onclick = () => { state.activeId = c.id; save(); render(); };
    li.querySelector('.x').onclick = (e) => {
      e.stopPropagation();
      state.chats = state.chats.filter((x) => x.id !== c.id);
      if (state.activeId === c.id) state.activeId = state.chats[0]?.id || null;
      save(); render();
    };
    ul.appendChild(li);
  }
}

function msgInner(m, streaming = false) {
  const meta = m.stats
    ? `<div class="meta">${m.stats.completionTokens} tokens · ${fmtNum(m.stats.tokensPerSec)} tok/s · ${fmtMs(m.stats.totalDurationMs)}${m.stats.thinkingMs ? ` · thought ${fmtMs(m.stats.thinkingMs)}` : ''} · ${esc(m.stats.model)}</div>`
    : '';
  // Keep the thinking block open while the model is still reasoning.
  const thinking = m.thinking
    ? `<details class="thinking"${streaming && !m.content ? ' open' : ''}><summary>${streaming && !m.content ? 'Thinking…' : 'Thinking'}</summary><div>${esc(m.thinking)}</div></details>`
    : '';
  const cursor = streaming && (m.content || !m.thinking) ? ' cursor' : '';
  return `<div class="role">${m.role === 'user' ? 'You' : 'Assistant'}</div>${thinking}<div class="body${cursor}">${renderMarkdown(m.content)}</div>${meta}`;
}

function messageEl(m) {
  const div = document.createElement('div');
  div.className = `msg ${m.role}${m.error ? ' error' : ''}`;
  div.innerHTML = msgInner(m);
  return div;
}

function renderMessages() {
  const chat = activeChat();
  const box = $('messages');
  box.innerHTML = '';
  $('chatTitle').textContent = chat ? chat.title : 'New chat';
  if (!chat || chat.messages.length === 0) {
    box.innerHTML = `<div class="empty"><h2>Chat with ${esc(state.model)}</h2><p>Runs entirely on your machine via Ollama.</p></div>`;
    return;
  }
  for (const m of chat.messages) box.appendChild(messageEl(m));
  box.scrollTop = box.scrollHeight;
}

function dl(el, rows) {
  el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

function renderChatStats() {
  const chat = activeChat();
  const stats = (chat?.messages || []).filter((m) => m.stats).map((m) => m.stats);
  if (!stats.length) {
    dl($('chatTotals'), [['Messages', chat ? chat.messages.length : 0], ['Responses', 0]]);
    $('lastStats').innerHTML = '<dt class="muted">No responses yet</dt>';
    return;
  }
  const sum = (k) => stats.reduce((a, s) => a + (s[k] || 0), 0);
  const max = (k) => Math.max(...stats.map((s) => s[k] || 0));
  const genTok = sum('completionTokens');
  const evalMs = sum('evalMs');
  dl($('chatTotals'), [
    ['Messages', chat.messages.length],
    ['Responses', stats.length],
    ['Prompt tokens', sum('promptTokens').toLocaleString()],
    ['Completion tokens', genTok.toLocaleString()],
    ['Total tokens', (sum('promptTokens') + genTok).toLocaleString()],
    ['Avg gen speed', `${fmtNum(evalMs ? genTok / (evalMs / 1000) : null)} tok/s`],
    ['Total compute time', fmtMs(sum('totalDurationMs'))],
    ['Total model load time', fmtMs(sum('loadDurationMs'))],
    ['Avg time to 1st token', fmtMs(sum('timeToFirstTokenMs') / stats.length)],
    ['Peak Ollama RSS', fmtBytes(max('ollamaRssPeak'))],
    ['Peak Ollama CPU', `${fmtNum(max('ollamaCpuPeak'), 0)} %`],
    ['Model memory', fmtBytes(stats[stats.length - 1].modelSizeBytes)],
  ]);
  const s = stats[stats.length - 1];
  const memDelta = s.systemUsedMemAfter - s.systemUsedMemBefore;
  dl($('lastStats'), [
    ['Model', esc(s.model)],
    ['Prompt tokens', s.promptTokens],
    ['Completion tokens', s.completionTokens],
    ['Generation speed', `${fmtNum(s.tokensPerSec)} tok/s`],
    ['Prompt speed', `${fmtNum(s.promptTokensPerSec)} tok/s`],
    ['Time to 1st token', fmtMs(s.timeToFirstTokenMs)],
    ['Thinking time', s.thinkingMs ? fmtMs(s.thinkingMs) : '–'],
    ['Time to answer', fmtMs(s.timeToAnswerMs)],
    ['Model load', fmtMs(s.loadDurationMs)],
    ['Prompt eval', fmtMs(s.promptEvalMs)],
    ['Generation', fmtMs(s.evalMs)],
    ['Total (Ollama)', fmtMs(s.totalDurationMs)],
    ['Wall clock', fmtMs(s.wallMs)],
    ['Model size in memory', fmtBytes(s.modelSizeBytes)],
    ['…of which GPU/VRAM', fmtBytes(s.modelVramBytes)],
    ['Context window', s.contextLength ? s.contextLength.toLocaleString() : '–'],
    ['Ollama RSS before', fmtBytes(s.ollamaRssBefore)],
    ['Ollama RSS peak', fmtBytes(s.ollamaRssPeak)],
    ['Ollama CPU peak', `${fmtNum(s.ollamaCpuPeak, 0)} %`],
    ['System RAM Δ', `${memDelta >= 0 ? '+' : '−'}${fmtBytes(Math.abs(memDelta))}`],
  ]);
}

// ---------- live system stats ----------
async function pollStats() {
  try {
    const s = await (await fetch('/api/stats')).json();
    const memPct = (s.system.usedMem / s.system.totalMem) * 100;
    $('sysMem').textContent = `${fmtBytes(s.system.usedMem)} / ${fmtBytes(s.system.totalMem)}`;
    $('sysMemBar').style.width = `${memPct}%`;
    $('sysCpu').textContent = `${fmtNum(s.system.cpuPercent, 0)} %`;
    $('sysCpuBar').style.width = `${Math.min(100, s.system.cpuPercent)}%`;
    $('olRss').textContent = s.ollama.processes ? fmtBytes(s.ollama.rssBytes) : 'not running';
    $('olCpu').textContent = s.ollama.processes ? `${fmtNum(s.ollama.cpuPercent, 0)} %` : '–';
    $('loadAvg').textContent = s.system.loadAvg.map((x) => x.toFixed(2)).join(' ');
    $('loadedModels').innerHTML = s.loadedModels.length
      ? s.loadedModels.map((m) => `<div class="lm"><b>${esc(m.name)}</b><br>${fmtBytes(m.size)} total · ${fmtBytes(m.sizeVram)} GPU<br><span class="muted">unloads ${new Date(m.expiresAt).toLocaleTimeString()}</span></div>`).join('')
      : 'none (loads on first message)';
  } catch {}
}

async function loadModels() {
  const sel = $('model');
  try {
    const r = await (await fetch('/api/models')).json();
    if (!r.ok) {
      $('ollamaStatus').textContent = r.error;
      return;
    }
    // Weights + KV cache + runtime overhead need noticeably more than the file size;
    // flag anything whose file alone exceeds ~70% of RAM as unlikely to load.
    const tooBig = (m) => m.size > r.totalMem * 0.7;
    const fits = r.models.filter((m) => !tooBig(m)).map((m) => m.name);
    const names = r.models.map((m) => m.name);
    sel.innerHTML = r.models.map((m) =>
      `<option value="${esc(m.name)}">${esc(m.name)} · ${fmtBytes(m.size)}${tooBig(m) ? ' ⚠ too large for this RAM' : ''}</option>`
    ).join('');
    if (!names.length) {
      sel.innerHTML = '<option>mistral</option>';
      $('ollamaStatus').textContent = 'No models installed. Run: ollama pull mistral';
      return;
    }
    $('ollamaStatus').textContent = `${names.length} model(s) available`;
    const preferred = fits.find((n) => n === state.model) || fits.find((n) => n.startsWith('mistral')) || fits[0] || names[0];
    sel.value = preferred;
    state.model = preferred;
    save();
  } catch {
    $('ollamaStatus').textContent = 'Server unreachable';
  }
}

// ---------- sending ----------
async function send(text) {
  if (!activeChat()) newChat();
  const chat = activeChat();
  if (chat.messages.length === 0) chat.title = text.slice(0, 40) + (text.length > 40 ? '…' : '');
  chat.messages.push({ role: 'user', content: text });
  const reply = { role: 'assistant', content: '' };
  chat.messages.push(reply);
  save(); render();

  const box = $('messages');
  const el = box.lastElementChild;
  const paint = () => { el.innerHTML = msgInner(reply, true); box.scrollTop = box.scrollHeight; };
  paint();
  setBusy(true);

  abortCtl = new AbortController();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: state.model,
        messages: chat.messages.filter((m) => m !== reply && !m.error).map(({ role, content }) => ({ role, content })),
      }),
      signal: abortCtl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const evt = JSON.parse(line);
        if (evt.type === 'token') {
          reply.content += evt.content;
          paint();
        } else if (evt.type === 'thinking') {
          reply.thinking = (reply.thinking || '') + evt.content;
          paint();
        } else if (evt.type === 'done') {
          reply.stats = evt.stats;
        } else if (evt.type === 'error') {
          reply.error = true;
          let msg = evt.error;
          try { msg = JSON.parse(msg).error || msg; } catch {}
          if (/requires .* but only .* available/i.test(msg)) {
            msg += `\n\n"${state.model}" doesn't fit in this machine's free memory. Pick a smaller model (e.g. mistral) in the sidebar, or close other apps to free RAM.`;
          }
          reply.content += (reply.content ? '\n\n' : '') + `Error: ${msg}`;
        }
      }
    }
  } catch (e) {
    if (e.name === 'AbortError') reply.content += reply.content ? '\n\n[stopped]' : '[stopped]';
    else { reply.error = true; reply.content += `Error: ${e.message}`; }
  } finally {
    abortCtl = null;
    setBusy(false);
    save();
    render();
    pollStats();
  }
}

function setBusy(b) {
  $('send').hidden = b;
  $('stop').hidden = !b;
  $('input').disabled = b;
  if (!b) $('input').focus();
}

// ---------- wire up ----------
$('composer').onsubmit = (e) => {
  e.preventDefault();
  const text = $('input').value.trim();
  if (!text || abortCtl) return;
  $('input').value = '';
  send(text);
};
$('input').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('composer').requestSubmit(); }
};
$('stop').onclick = () => abortCtl?.abort();
$('newChat').onclick = newChat;
$('model').onchange = (e) => { state.model = e.target.value; save(); };
$('toggleStats').onclick = () => document.body.classList.toggle('hide-stats');
if (window.innerWidth < 900) document.body.classList.add('hide-stats');

if (!activeChat()) state.activeId = state.chats[0]?.id || null;
render();
loadModels();
pollStats();
setInterval(pollStats, 2000);
