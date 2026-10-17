/**
 * app.js: the page's logic (runs in the main browser thread).
 *
 * Files in this project:
 *   index.html  page markup
 *   style.css   all styling (colors are CSS variables at the top)
 *   app.js      this file: file list, queue, audio player, live captions, export
 *   worker.js   Whisper transcription, run in a background worker
 *
 * Data model: `items` is the list of added files. Each item looks like
 *   { id, file, url, status, pct, err, segments, sec, body, st }
 *   status:   'queued' | 'working' | 'done' | 'cancelled' | 'error'
 *   segments: [{ start, end, text, words: [{ w, start }] }]   (times in seconds)
 *   sec/body/st: the item's section, text area and status label in the transcript
 */

const $ = id => document.getElementById(id);
const audio = $('audio'), list = $('list');
// ---------- State ----------
let items = [];          // every added file (see data model above)
let cur = null;          // item loaded in the audio player
let worker = null;       // the Whisper worker (created on first use)
let runItem = null;      // item currently being transcribed
let resolveRun = null;   // call this to let the queue move on to the next file
let running = false;     // is the queue running?
let stopped = false;     // did the user press Cancel?
let active = -1;         // index of the caption segment being shown
let activeRow = null;    // that segment's row in the transcript
let capWord = -1;        // index of the highlighted word in the caption
let raf = 0;             // requestAnimationFrame id for the caption loop
let nextId = 1;          // id for the next added file
const dl = {};

/* ---------- helpers ---------- */
const p2 = n => String(n).padStart(2, '0');
const clock = t => { const h = Math.floor(t / 3600), m = Math.floor(t % 3600 / 60), s = Math.floor(t % 60);
  return (h ? h + ':' + p2(m) : m) + ':' + p2(s); };
const srtTime = t => `${p2(Math.floor(t / 3600))}:${p2(Math.floor(t % 3600 / 60))}:${p2(Math.floor(t % 60))},${String(Math.floor(t * 1000) % 1000).padStart(3, '0')}`;
const fmtSize = b => b > 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
const status = (t, err) => { $('status').textContent = t; $('status').classList.toggle('err', !!err); };
const progress = f => { $('fill').style.width = Math.round(f * 100) + '%'; };
const segs = () => cur ? cur.segments : [];
const setBusy = b => { running = b; $('model').disabled = b; $('stop').hidden = !b; $('prog').hidden = !b; renderFiles(); };

/* ---------- file list ---------- */
const VALID = /\.(mp3|m4a|wav|ogg|oga|opus|webm|flac|aac|mp4|mov|mkv)$/i;
function addFiles(fl) {
  const ok = [...fl].filter(f => /^(audio|video)\//.test(f.type) || VALID.test(f.name));
  if (!ok.length) { status('Those files are not audio. Try mp3, m4a or wav.', true); return; }
  for (const f of ok) {
    const it = { id: nextId++, file: f, url: URL.createObjectURL(f), segments: [], status: 'queued', pct: 0, err: '' };
    items.push(it); makeSection(it);
  }
  if (!cur) select(items[0]); else renderFiles();
  if (!running) status(`${items.length} file${items.length > 1 ? 's' : ''} ready. Press Transcribe.`);
}
const LABEL = { queued: 'Queued', done: 'Done', cancelled: 'Cancelled, partial transcript kept' };
function renderFiles() {
  const box = $('files'); box.textContent = '';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'chip' + (it === cur ? ' sel' : ''); row.dataset.id = it.id; row.tabIndex = 0;
    const ok = document.createElement('span'); ok.className = 'ok ' + it.status;
    ok.textContent = it.status === 'done' ? '\u2713' : it.status === 'working' ? '\u2026' : it.status === 'error' ? '!' : '';
    const meta = document.createElement('div'); meta.className = 'meta';
    const name = document.createElement('strong'); name.textContent = it.file.name;
    const sub = document.createElement('span');
    const label = it.status === 'working' ? `Transcribing ${Math.round(it.pct * 100)}%` : it.status === 'error' ? it.err : LABEL[it.status];
    sub.textContent = `${fmtSize(it.file.size)}, ${label}`; sub.title = sub.textContent;
    if (it.st) it.st.textContent = label;
    meta.append(name, sub);
    const x = document.createElement('button'); x.className = 'x'; x.title = 'Remove file';
    x.setAttribute('aria-label', 'Remove ' + it.file.name); x.innerHTML = '&times;';
    row.append(ok, meta, x); box.append(row);
  }
  const todo = items.filter(x => x.status !== 'done' && x.status !== 'working').length;
  $('go').disabled = running || todo === 0;
  $('go').textContent = todo > 1 ? `Transcribe ${todo} files` : 'Transcribe';
  $('dropZone').classList.toggle('compact', items.length > 0);
  $('dropMsg').textContent = items.length ? 'Add more files' : 'Choose audio files or drop them here';
  list.classList.toggle('single', items.length < 2);
  $('now').textContent = cur ? 'Playing: ' + cur.file.name : '';
}
$('files').onclick = e => {
  const row = e.target.closest('.chip'); if (!row) return;
  const it = items.find(x => x.id == row.dataset.id);
  if (e.target.closest('.x')) removeItem(it);
  else { if (it !== cur) select(it); it.sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
};
$('files').onkeydown = e => { if (e.key === 'Enter' && e.target.classList.contains('chip')) e.target.click(); };

function makeSection(it) {
  const sec = document.createElement('section'); sec.className = 'doc';
  const h = document.createElement('div'); h.className = 'dochead';
  const n = document.createElement('strong'); n.textContent = it.file.name;
  it.st = document.createElement('span'); h.append(n, it.st);
  it.body = document.createElement('div'); it.body.className = 'docbody';
  sec.append(h, it.body); list.append(sec); it.sec = sec;
}
function resetCaption() { $('capText').textContent = ''; active = -1; activeRow = null; capWord = -1; }
function select(it) {
  audio.pause(); activeRow?.classList.remove('active'); resetCaption();
  cur = it;
  if (!it) { audio.removeAttribute('src'); audio.load(); $('player').hidden = true; $('out').hidden = true; renderFiles(); return; }
  audio.src = it.url; $('player').hidden = false; $('out').hidden = false;
  renderFiles();
}
function playAt(it, t) {   // one player for all files: switch its source when a line from another file is clicked
  if (it !== cur) {
    select(it);
    audio.addEventListener('loadedmetadata', () => { audio.currentTime = t; audio.play(); }, { once: true });
  } else { audio.currentTime = t; audio.play(); }
}
function removeItem(it) {
  if (it.segments.length && !confirm(`Remove ${it.file.name} and its transcript?`)) return;
  if (it === runItem) {   // stop this one; the queue carries on with the next file
    if (worker) { worker.terminate(); worker = null; }
    const r = resolveRun; runItem = null; resolveRun = null; r && r();
  }
  URL.revokeObjectURL(it.url); it.sec.remove();
  items = items.filter(x => x !== it);
  if (cur === it) select(items[0] || null); else renderFiles();
  if (!items.length && !running) status('');
}

/* ---------- drag and drop ---------- */
$('file').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
const dz = $('dropZone');
['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
dz.addEventListener('drop', e => addFiles(e.dataTransfer.files));

/* ---------- decode to 16 kHz mono (what Whisper expects) ---------- */
async function decode(f) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  const buf = await ctx.decodeAudioData(await f.arrayBuffer());
  ctx.close();
  const out = new Float32Array(buf.length), ch = buf.numberOfChannels;
  for (let c = 0; c < ch; c++) { const d = buf.getChannelData(c); for (let i = 0; i < d.length; i++) out[i] += d[i] / ch; }
  return out;
}

/* ---------- worker + queue ---------- */
const finish = () => { const r = resolveRun; runItem = null; resolveRun = null; renderFiles(); r && r(); };
function getWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js', { type: 'module' });
  worker.onmessage = ({ data: m }) => {
    const it = runItem; if (!it) return;
    if (m.type === 'status') status(m.text === 'Transcribing...' ? `Transcribing ${it.file.name}...` : m.text);
    else if (m.type === 'dl') {
      dl[m.file] = m;
      const L = Object.values(dl).reduce((a, x) => a + x.loaded, 0), T = Object.values(dl).reduce((a, x) => a + x.total, 0);
      progress(L / T); status(`Downloading model... ${Math.round(L / T * 100)}%`);
    } else if (m.type === 'segs') {
      addSegments(it, m.segs); it.pct = m.pct; progress(m.pct); renderFiles();
      status(`Transcribing ${it.file.name}: ${Math.round(m.pct * 100)}%. You can already play finished parts.`);
    } else if (m.type === 'done') { it.status = 'done'; it.pct = 1; finish(); }
    else if (m.type === 'error') { it.status = 'error'; it.err = 'Failed: ' + m.text; finish(); }
  };
  worker.onerror = e => {
    worker = null; const it = runItem; if (!it) return;
    it.status = 'error'; it.err = 'Worker failed to start. Serve the page over http(s), not file://.'; finish();
  };
  return worker;
}
function transcribe(it) {
  return new Promise(async res => {
    runItem = it; resolveRun = res;
    it.status = 'working'; it.pct = 0; it.segments = []; progress(0);
    it.body.textContent = ''; if (it === cur) resetCaption();
    renderFiles(); status(`Decoding ${it.file.name}...`);
    let data;
    try { data = await decode(it.file); }
    catch { if (runItem === it) { it.status = 'error'; it.err = 'Could not decode this file'; finish(); } return; }
    if (runItem !== it) return;   // cancelled or removed while decoding
    getWorker().postMessage({ model: $('model').value, audio: data }, [data.buffer]);
  });
}
async function runQueue() {
  if (running) return;
  items.forEach(x => { if (x.status === 'cancelled' || x.status === 'error') x.status = 'queued'; });
  stopped = false; setBusy(true); progress(0);
  let it;
  while (!stopped && (it = items.find(x => x.status === 'queued'))) await transcribe(it);
  setBusy(false);
  const nDone = items.filter(x => x.status === 'done').length, nErr = items.filter(x => x.status === 'error').length;
  if (!items.length) status('');
  else if (stopped) status('Cancelled. Finished and partial transcripts are kept.');
  else if (nErr) status(`Finished with ${nErr} error${nErr > 1 ? 's' : ''}. See the file list.`, true);
  else status(`Done: ${nDone} file${nDone !== 1 ? 's' : ''} transcribed.`);
}
$('go').onclick = runQueue;
$('stop').onclick = () => {
  stopped = true;
  if (worker) { worker.terminate(); worker = null; }
  if (runItem) { runItem.status = 'cancelled'; const r = resolveRun; runItem = null; resolveRun = null; r && r(); }
};

/* ---------- transcript + live captions ---------- */
// Whisper gives segment timing; word starts are estimated by spreading the segment
// duration across its words by length, with a little extra pause after punctuation.
function timeWords(s) {
  const ws = s.text.split(/\s+/).filter(Boolean);
  const wt = ws.map(w => w.length + 1 + (/[,;:]$/.test(w) ? 2 : /[.?!]$/.test(w) ? 4 : 0));
  const total = wt.reduce((a, b) => a + b, 0), dur = Math.max(s.end - s.start, 0.3);
  let acc = 0;
  return ws.map((w, k) => { const start = s.start + dur * acc / total; acc += wt[k]; return { w, start }; });
}
function addRow(it, s) {
  const row = document.createElement('div'); row.className = 'seg'; row.dataset.i = it.body.children.length;
  const t = document.createElement('button'); t.className = 't'; t.textContent = clock(s.start); t.title = 'Play from here';
  const x = document.createElement('span'); x.textContent = s.text;
  row.append(t, x); it.body.append(row);
}
function addSegments(it, newSegs) {
  for (const s of newSegs) { s.words = timeWords(s); it.segments.push(s); addRow(it, s); }
}
list.onclick = e => {
  const row = e.target.closest('.seg'); if (!row) return;
  const it = items.find(x => x.body === row.parentElement);
  if (it) playAt(it, it.segments[row.dataset.i].start);
};
// keep the playing line in view (CSS scroll-margin leaves room for the sticky player)
const reveal = el => el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
function sync() {
  const S = segs(), t = audio.currentTime, cap = $('capText');
  const i = S.findLastIndex(s => s.start <= t + 0.05);
  const on = i >= 0 && t <= S[i].end + 1.5;
  const idx = on ? i : -1;
  if (idx !== active) {
    cap.textContent = '';
    if (on) for (const w of S[i].words) {
      const s = document.createElement('span'); s.className = 'w'; s.textContent = w.w;
      cap.append(s, ' ');
    }
    capWord = -2; // force a repaint of word states
    activeRow?.classList.remove('active');
    active = idx;
    activeRow = on ? cur.body.children[idx] : null;
    if (activeRow) { activeRow.classList.add('active'); if (!audio.paused) reveal(activeRow); }
  }
  if (on) {
    const w2 = S[i].words.findLastIndex(w => w.start <= t);
    if (w2 !== capWord) {
      [...cap.children].forEach((el, k) => { el.classList.toggle('done', k < w2); el.classList.toggle('cur', k === w2); });
      capWord = w2;
    }
  }
}
// timeupdate only fires ~4x per second, so run a per-frame loop while playing for smooth word highlighting
function loop() {
  cancelAnimationFrame(raf);
  const f = () => { sync(); if (!audio.paused && !audio.ended) raf = requestAnimationFrame(f); };
  f();
}
audio.onplay = loop;
audio.onpause = audio.onseeked = audio.ontimeupdate = sync;
audio.onended = () => {   // roll on to the next file in the list
  const n = items[items.indexOf(cur) + 1];
  if (n) { select(n); audio.play(); n.sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
};

/* ---------- export ---------- */
const stem = it => it.file.name.replace(/\.[^.]+$/, '');
function txtOf(it) {
  const S = it.segments;
  if ($('ts').checked) return S.map(s => `[${clock(s.start)}] ${s.text}`).join('\n');
  const paras = [];
  for (let i = 0; i < S.length; i += 5) paras.push(S.slice(i, i + 5).map(s => s.text).join(' '));
  return paras.join('\n\n');
}
function toTxt() {   // every file, each under its own heading when there is more than one
  const multi = items.length > 1;
  
  // Check multi upload and whether remove heading is enabled
  const toggleHeadingCheckbox = document.querySelector('#fileHeadings');
  return items.filter(it => it.segments.length).map(it => ( (multi && !toggleHeadingCheckbox.checked) ? `=== ${it.file.name} ===\n\n` : '') + txtOf(it)).join('\n\n\n' );
}
const toSrt = it => it.segments.map((s, i) => `${i + 1}\n${srtTime(s.start)} --> ${srtTime(Math.max(s.end, s.start + 0.5))}\n${s.text}\n`).join('\n');
function save(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
$('txt').onclick = () => { const t = toTxt(); if (t) save((items.length > 1 ? 'transcripts' : stem(items[0])) + '.txt', t); };
$('srt').onclick = () => cur && cur.segments.length && save(stem(cur) + '.srt', toSrt(cur));
$('copy').onclick = async () => {
  const t = toTxt(); if (!t) return;
  await navigator.clipboard.writeText(t);
  const b = $('copy'); b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy', 1200);
};

// Get the button element
const backToTopBtn = document.getElementById("backToTopBtn");

// Listen for scroll events to toggle button visibility
window.addEventListener("scroll", () => {
  // Show button when user scrolls down 300px from the top
  if (window.scrollY > 300) {
    backToTopBtn.style.display = "block";
  } else {
    backToTopBtn.style.display = "none";
  }
});

// When the user clicks on the button, scroll to the top smoothly
backToTopBtn.addEventListener("click", () => {
  window.scrollTo({
    top: 0,
    behavior: "smooth" // Ensures a smooth transition back up
  });
});
