import { S, P, saveSettings, newProject, nextId, VERSION } from './state.js?v=2026.09.30-3';
import * as pipe from './pipeline.js?v=2026.09.30-3';
import { saveProject, loadProject, clearProject } from './store.js?v=2026.09.30-3';
import { buildTimeline, TL, drawFrame, W0, AC, getMix, syncPreviewVideos, stopAllVideos, clearWrapCache, ensureFonts, sceneIndexAt, decodeAudio } from './render.js?v=2026.09.30-3';
import { exportVideo } from './export.js?v=2026.09.30-3';
import { testKeys } from './apis.js?v=2026.09.30-3';
import { resetMock } from './mock.js?v=2026.09.30-3';

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => { t = Math.max(0, t || 0); const m = Math.floor(t / 60); const s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };
function toast(msg, ms = 3400) { const el = $('#toast'); el.textContent = msg; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => el.hidden = true, ms); }

const VOICES = [['Kore', 'しっかり'], ['Aoede', '軽やか'], ['Puck', '明るく元気'], ['Charon', '落ち着いた解説調'], ['Zephyr', '明るい'], ['Leda', '若々しい'],
  ['Achernar', 'やわらかい'], ['Sulafat', 'あたたかい'], ['Vindemiatrix', 'やさしい'], ['Gacrux', '大人っぽい'], ['Fenrir', '勢いがある'], ['Sadachbia', 'いきいき'], ['Achird', '親しみやすい'], ['Iapetus', 'はっきり']];
$('#voice').innerHTML = VOICES.map(([v, d]) => `<option value="${v}">${v}（${d}）</option>`).join('');

/* ---------- views ---------- */
let view = 'make';
function showView(v) {
  view = v;
  $$('.tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.view === v)));
  $$('.view').forEach(x => x.hidden = x.dataset.view !== v);
  if (v === 'edit') refreshEdit(true); else pausePreview();
  try { history.replaceState(null, '', '#' + v); } catch (e) {}
}
$$('.tab').forEach(t => t.addEventListener('click', () => showView(t.dataset.view)));
document.addEventListener('click', e => { const g = e.target.closest('[data-goto]'); if (g) showView(g.dataset.goto); });

/* ---------- settings ---------- */
function bindSettings() {
  for (const k of ['anthropic', 'openai', 'gemini']) {
    const el = $('#k-' + k); el.value = S.keys[k] || '';
    el.addEventListener('change', () => { S.keys[k] = el.value.trim(); saveSettings(); updateKeyWarn(); });
  }
  $$('[data-eye]').forEach(b => b.addEventListener('click', () => { const i = $('#' + b.dataset.eye); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; b.textContent = show ? '隠す' : '表示'; }));
  for (const k of ['claude', 'image', 'tts', 'video']) { const el = $('#m-' + k); el.value = S.models[k]; el.addEventListener('change', () => { S.models[k] = el.value.trim() || S.models[k]; el.value = S.models[k]; saveSettings(); }); }
  for (const k of ['imageQuality', 'imageSize']) { const el = $('#' + k); el.value = S[k]; el.addEventListener('change', () => { S[k] = el.value; saveSettings(); }); }
  for (const k of Object.keys(S.prices)) { const el = $('#p-' + k); if (!el) continue; el.value = S.prices[k]; el.addEventListener('change', () => { const v = parseFloat(el.value); if (v >= 0) S.prices[k] = v; saveSettings(); }); }
  const demo = $('#demo'); demo.checked = S.demo;
  demo.addEventListener('change', () => { S.demo = demo.checked; saveSettings(); updateKeyWarn(); });
  $('#testKeys').addEventListener('click', async () => {
    $('#keyResult').textContent = '確認中…';
    const r = await testKeys();
    const lab = { anthropic: 'Claude', openai: 'ChatGPT', gemini: 'Gemini' };
    $('#keyResult').textContent = Object.entries(r).map(([k, v]) => `${lab[k]}: ${v === 'ok' ? 'OK' : v}`).join(' ／ ');
  });
  let wipeArmed = false;
  $('#wipe').addEventListener('click', async e => {
    if (running) { toast('制作中は削除できません'); return; }
    if (!wipeArmed) { wipeArmed = true; e.target.textContent = 'もう一度押すと削除します'; setTimeout(() => { wipeArmed = false; e.target.textContent = '作業中の作品を削除'; }, 3000); return; }
    wipeArmed = false; e.target.textContent = '作業中の作品を削除';
    await clearProject(); P.cur = null; renderAll(); toast('削除しました');
  });
  // subtitle / audio style
  const OUT = { size: v => v + 'px', maxChars: v => v + '字', pos: v => Math.round(v * 100) + '%', strokeW: v => v + 'px', motionAmt: v => Math.round(v * 100) + '%', fade: v => (+v).toFixed(2) + 's', pad: v => (+v).toFixed(2) + 's', voiceVol: v => Math.round(v * 100) + '%', bgmVol: v => Math.round(v * 100) + '%' };
  for (const k of Object.keys(S.style)) {
    const el = document.getElementById(k); if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!S.style[k]; else el.value = S.style[k];
    const out = document.querySelector(`output[data-for="${k}"]`);
    const show = () => { if (out) out.textContent = OUT[k] ? OUT[k](S.style[k]) : S.style[k]; };
    show();
    const ev = el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input';
    el.addEventListener(ev, () => {
      let v = el.type === 'checkbox' ? el.checked : el.value;
      if (el.type === 'range') v = parseFloat(v);
      S.style[k] = v; show(); saveSettings(); clearWrapCache();
      refreshEdit(['maxChars', 'pad'].includes(k));
    });
  }
}
function hasKeys() { return S.keys.anthropic && S.keys.openai && S.keys.gemini; }
function updateKeyWarn() {
  $('#modeChip').hidden = !S.demo;
  $('#keyWarn').hidden = S.demo || hasKeys();
}
$('#tryDemo').addEventListener('click', () => { S.demo = true; $('#demo').checked = true; saveSettings(); updateKeyWarn(); toast('デモモードにしました。料金はかかりません'); });

/* ---------- brief ---------- */
const BRIEF_KEY = 'shortsStudio.brief.v1';
function readBrief() {
  return {
    theme: $('#theme').value.trim(), length: +$('#len').value, voice: $('#voice').value, videoScenes: +$('#vids').value,
    assetRounds: +$('#assetRounds').value, qcRounds: +$('#qcRounds').value, budget: Math.max(0, parseFloat($('#budget').value) || 0), autoExport: $('#autoExport').checked,
  };
}
function fillBrief(b) {
  if (!b) return;
  if (b.theme != null) $('#theme').value = b.theme;
  const set = (id, v) => { if (v != null) $(id).value = v; };
  set('#len', b.length); set('#voice', b.voice); set('#vids', b.videoScenes); set('#assetRounds', b.assetRounds); set('#qcRounds', b.qcRounds); set('#budget', b.budget);
  if (b.autoExport != null) $('#autoExport').checked = b.autoExport;
}
try { fillBrief(JSON.parse(localStorage.getItem(BRIEF_KEY) || 'null')); } catch (e) {}
$('#briefForm').addEventListener('input', () => { try { localStorage.setItem(BRIEF_KEY, JSON.stringify(readBrief())); } catch (e) {} });

/* ---------- running ---------- */
let running = false, ctl = null, wake = null;
async function lockWake() { try { wake = await navigator.wakeLock.request('screen'); } catch (e) { wake = null; } }
function releaseWake() { try { wake && wake.release(); } catch (e) {} wake = null; }
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && running && !wake) lockWake(); });
window.addEventListener('beforeunload', e => { if (running || exporting) { e.preventDefault(); e.returnValue = ''; } });

const ORDER = ['plan', 'images', 'videos', 'voice', 'qc', 'export'];
const callbacks = {
  log: addLog,
  update: () => scheduleRender(),
  stage: st => { if (!P.cur) return; P.cur.stage = st; if (ORDER.includes(st)) P.cur.reached = st; scheduleRender(); },
  save: () => saveProject(),
};

async function runPipeline(fn) {
  if (running) return;
  running = true; ctl = new AbortController(); updateButtons(); lockWake();
  let ok = false;
  try { ok = await fn(callbacks, ctl.signal); } finally {
    running = false; ctl = null; releaseWake(); updateButtons(); renderAll(); await saveProject();
  }
  if (ok && P.cur.brief.autoExport) { showView('edit'); await doExport(false); }
  else if (ok) toast('Claudeが承認しました。編集タブで書き出せます');
}
$('#briefForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (running) return;
  if (!S.demo && !hasKeys()) { toast('先に設定タブで3つのAPIキーを入れてください'); showView('settings'); return; }
  const brief = readBrief();
  if (!brief.theme) { toast('作りたい内容を書いてください'); $('#theme').focus(); return; }
  resetMock(); newProject(brief); $('#log').innerHTML = '';
  addLog('system', `制作を開始します（v${VERSION} · ${S.demo ? 'デモモード' : `Claude: ${S.models.claude} / 画像: ${S.models.image} / 音声: ${S.models.tts}`}）`, 'info');
  renderAll(); await saveProject();
  await runPipeline(pipe.run);
});
$('#resumeBtn').addEventListener('click', async () => {
  if (!P.cur || running) return;
  const b = readBrief();
  Object.assign(P.cur.brief, { budget: b.budget, assetRounds: b.assetRounds, qcRounds: b.qcRounds, autoExport: b.autoExport });
  addLog('system', '続きから再開します。', 'info');
  await runPipeline(pipe.run);
});
$('#stopBtn').addEventListener('click', () => { if (ctl) { ctl.abort(); $('#stopBtn').disabled = true; } });
let newArmed = false;
$('#newBtn').addEventListener('click', async e => {
  if (running) return;
  if (!newArmed) { newArmed = true; e.target.textContent = '今の作品を消して新しく作る？'; setTimeout(() => { newArmed = false; e.target.textContent = '新しく作る'; }, 3500); return; }
  newArmed = false; e.target.textContent = '新しく作る';
  pausePreview(); stopAllVideos(); await clearProject(); P.cur = null; $('#log').innerHTML = ''; renderAll();
  $('#theme').focus();
});

function updateButtons() {
  const pr = P.cur, has = !!(pr && (pr.plan || pr.scenes.length));
  const finished = pr && (pr.stage === 'done' || pr.stage === 'exported' || pr.stage === 'exporting');
  $('#startBtn').hidden = has;
  $('#resumeBtn').hidden = !has || running || finished;
  $('#newBtn').hidden = !has || running;
  $('#stopBtn').hidden = !running; $('#stopBtn').disabled = false;
  $('#startBtn').disabled = running;
  ['#theme', '#len', '#voice', '#vids'].forEach(s => $(s).disabled = running || has);
  $('#recheckBtn').disabled = running || !pr || !pr.scenes.length;
  updateExportGate();
}

/* ---------- log ---------- */
const WHO = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini', system: 'システム' };
function logEl(e) {
  const li = document.createElement('li'); li.className = e.kind || 'info';
  const d = new Date(e.t);
  li.innerHTML = `<span class="who ${e.agent}">${WHO[e.agent] || e.agent}</span><span class="msg">${esc(e.text)}</span><time>${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}</time>`;
  return li;
}
function addLog(agent, text, kind = 'info') {
  if (!text || !P.cur) return;
  const e = { t: Date.now(), agent, text, kind }; P.cur.log.push(e);
  if (P.cur.log.length > 400) P.cur.log.splice(0, P.cur.log.length - 400);
  const box = $('#log'); const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(logEl(e)); if (stick) box.scrollTop = box.scrollHeight;
}
function renderLog() {
  const box = $('#log'); box.innerHTML = '';
  if (P.cur) P.cur.log.forEach(e => box.appendChild(logEl(e)));
  box.scrollTop = box.scrollHeight;
}

/* ---------- 制作 view render ---------- */
let rq = 0;
function scheduleRender() { if (rq) return; rq = requestAnimationFrame(() => { rq = 0; renderMake(); if (view === 'edit') refreshEdit(true); }); }
function renderAll() { renderMake(); renderLog(); updateButtons(); if (view === 'edit') refreshEdit(true); }
function badges(s) {
  const b = [];
  if (s.imgStatus === 'generating') b.push(['run', '画像を生成中']);
  else if (s.imgStatus === 'failed') b.push(['ng', '画像失敗']);
  else if (s.needsRegen) b.push(['re', 'やり直し']);
  else if (s.reviewed) b.push(['ok', 'OK']);
  else if (s.imgBlob) b.push(['', 'チェック待ち']);
  if (s.imgAttempts > 1) b.push(['', s.imgAttempts + '回目']);
  if (s.visual === 'video') b.push(s.videoStatus === 'generating' ? ['run', '動画を生成中'] : s.videoStatus === 'ready' ? ['', '動画'] : s.videoStatus === 'failed' ? ['ng', '動画失敗'] : ['', '動画予定']);
  if (s.audioStatus === 'generating') b.push(['run', '録音中']); else if (s.audioBlob) b.push(['', '♪']);
  return b;
}
function renderMake() {
  const pr = P.cur;
  $('#projTitle').textContent = pr && pr.plan ? pr.plan.title : 'シーン';
  const g = $('#sgrid');
  if (!pr || !pr.scenes.length) g.innerHTML = `<p class="empty">${pr && running ? 'Claudeが台本を考えています…' : '「制作スタート」を押すと、Claudeが台本を書き、シーンがここに並びます。'}</p>`;
  else g.innerHTML = pr.scenes.map((s, i) => `
    <div class="sc"><div class="th ${s.imgStatus === 'generating' || s.videoStatus === 'generating' || s.audioStatus === 'generating' ? 'busy' : ''}">${s.thumb ? `<img src="${esc(s.thumb)}" alt="">` : ''}<span class="n">${i + 1}</span>
      <div class="bd">${badges(s).map(([c, t]) => `<span class="${c}">${t}</span>`).join('')}</div></div>
      <p title="${esc(s.note)}">${esc(s.narration)}</p></div>`).join('');
  // steps
  const reachedIdx = pr ? ORDER.indexOf(pr.reached || '') : -1;
  const st = pr ? pr.stage : 'idle';
  $$('#steps li').forEach((li, i) => {
    li.className = '';
    if (!pr) return;
    const stg = ORDER[i];
    if (stg === 'export') { if (st === 'exporting') li.className = 'active'; else if (st === 'exported') li.className = 'done'; return; }
    if (i < reachedIdx) li.className = 'done';
    else if (i === reachedIdx) {
      if (running) li.className = 'active';
      else if (['done', 'exporting', 'exported'].includes(st)) li.className = 'done';
      else li.className = 'halt';
    }
    if (stg === 'qc' && ['done', 'exporting', 'exported'].includes(st)) li.className = 'done';
  });
  // cost
  const c = pr ? pr.cost : { usd: 0, claudeIn: 0, claudeOut: 0, images: 0, videos: 0, ttsChars: 0 };
  const cap = pr ? +pr.brief.budget : +$('#budget').value || 0;
  $('#costNow').textContent = '$' + c.usd.toFixed(2);
  $('#costCap').textContent = cap > 0 ? `/ 上限 $${cap.toFixed(2)}` : '/ 上限なし';
  const r = cap > 0 ? Math.min(1, c.usd / cap) : 0; const bar = $('#costBar'); bar.style.width = (r * 100) + '%'; bar.classList.toggle('hot', r > 0.85);
  $('#costDetail').textContent = `Claude ${(c.claudeIn + c.claudeOut).toLocaleString()}トークン · 画像 ${c.images}枚 · 動画 ${c.videos}本 · 音声 ${c.ttsChars}文字${S.demo ? '（デモ）' : ''}`;
  const vm = $('#verdictMini');
  if (pr && pr.verdict) { vm.hidden = false; vm.className = 'verdict ' + (pr.approved ? 'ok' : 'ng'); vm.textContent = pr.approved ? `Claude OK ${pr.verdict.score}点` : `未承認 ${pr.verdict.score}点`; }
  else vm.hidden = true;
}

/* ---------- 編集 view ---------- */
const pv = $('#pv'), pctx = pv.getContext('2d'); const PS = pv.width / W0;
let playing = false, pos = 0, src = null, t0 = 0;
const scenes = () => (P.cur ? P.cur.scenes : []);
function draw() {
  syncPreviewVideos(pos, playing, () => { if (!playing) drawFrame(pctx, pos, PS, false); });
  drawFrame(pctx, pos, PS, playing);
  $('#tcNow').textContent = fmt(pos);
  $('#seek').value = TL.total ? Math.round(pos / TL.total * 1000) : 0;
  const ph = $('#tl .ph'); if (ph) ph.style.left = (TL.total ? pos / TL.total * 100 : 0) + '%';
  const cur = TL.items.length ? sceneIndexAt(pos) : -1;
  $$('#tl .blk').forEach((b, k) => b.classList.toggle('on', k === cur));
  $$('#elist .es').forEach((b, k) => b.classList.toggle('cur', k === cur));
}
function setPlayIcon() {
  $('#playIco').innerHTML = playing ? '<path d="M3 2h4v12H3zM9 2h4v12H9z"/>' : '<path d="M4 2l10 6-10 6z"/>';
  $('#playBtn').setAttribute('aria-label', playing ? '一時停止' : '再生');
}
async function play() {
  if (!TL.total || exporting) return;
  const ac = AC(); try { await ac.resume(); } catch (e) {}
  if (pos >= TL.total - 0.05) pos = 0;
  const buf = await getMix(scenes(), P.cur && P.cur.bgm);
  src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
  t0 = ac.currentTime - pos; src.start(0, pos); playing = true; setPlayIcon(); loop();
}
function loop() {
  if (!playing) return;
  pos = AC().currentTime - t0;
  if (pos >= TL.total) { pos = TL.total; pausePreview(); draw(); return; }
  draw(); requestAnimationFrame(loop);
}
function pausePreview() { if (!playing) return; playing = false; try { src && src.stop(); } catch (e) {} src = null; stopAllVideos(); setPlayIcon(); }
function seekTo(t) { const was = playing; pausePreview(); pos = Math.max(0, Math.min(TL.total, t)); draw(); if (was) play(); }
$('#playBtn').addEventListener('click', () => playing ? pausePreview() : play());
$('#seek').addEventListener('input', e => seekTo(e.target.value / 1000 * TL.total));
$('#tl').addEventListener('click', e => { const r = $('#tl').getBoundingClientRect(); seekTo((e.clientX - r.left) / r.width * TL.total); });

let lastSig = '';
function refreshEdit(structural) {
  buildTimeline(scenes());
  if (pos > TL.total) pos = TL.total;
  $('#tcAll').textContent = fmt(TL.total);
  $('#tl').innerHTML = TL.items.map((e, i) => `<div class="blk ${e.s.visual === 'video' ? 'vid' : ''}" style="flex-grow:${Math.max(0.05, e.len).toFixed(3)}">${i + 1}</div>`).join('') + '<div class="ph"></div>';
  const sig = scenes().map(s => [s.id, s.thumb, s.visual, s.imgStatus, s.audioStatus, s.videoStatus, !!s.audioBlob, s.stale].join(',')).join('|') + (running ? 'R' : '');
  if (structural && sig !== lastSig) { renderEditor(); lastSig = sig; }
  updateMeta(); renderVerdict(); draw();
  clearTimeout(refreshEdit.ft);
  refreshEdit.ft = setTimeout(async () => { await ensureFonts(scenes()); draw(); }, 250);
}
const ICON = {
  up: '<svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
function renderEditor() {
  const box = $('#elist'); const list = scenes();
  if (!list.length) { box.innerHTML = '<p class="muted small">まだシーンがありません。制作タブで作り始めてください。</p>'; return; }
  const busy = running || exporting;
  box.innerHTML = list.map((s, i) => `
    <article class="es" data-i="${i}">
      <div class="th">${s.thumb ? `<img src="${esc(s.thumb)}" alt="">` : ''}<span class="kind">${s.visual === 'video' ? (s.videoBlob ? '動画' : '動画なし') : '静止画'}</span></div>
      <div class="body">
        <div class="hd"><h3>シーン ${i + 1}</h3><span class="tcs" data-tc></span>
          <div class="acts">
            <button class="icon" data-act="up" aria-label="上へ" ${i === 0 || busy ? 'disabled' : ''}>${ICON.up}</button>
            <button class="icon" data-act="down" aria-label="下へ" ${i === list.length - 1 || busy ? 'disabled' : ''}>${ICON.down}</button>
            <button class="icon" data-act="del" aria-label="削除" ${busy || list.length < 2 ? 'disabled' : ''}>${ICON.del}</button>
          </div></div>
        <textarea data-act="text" rows="2" aria-label="シーン${i + 1}のナレーションと字幕" ${busy ? 'disabled' : ''}>${esc(s.narration)}</textarea>
        <div class="row">
          <button class="btn sm ${s.stale ? 'primary' : ''}" data-act="voice" ${busy ? 'disabled' : ''}>${s.stale ? '声を録り直す（文が変わりました）' : '声を録り直す'}</button>
          <button class="btn sm" data-act="img" ${busy ? 'disabled' : ''}>画像を作り直す</button>
          <button class="btn sm" data-act="kind" ${busy || !s.imgBlob ? 'disabled' : ''}>${s.visual === 'video' ? '静止画にする' : '動画にする'}</button>
        </div>
        <details><summary>画像の指示（英語）${s.visual === 'video' ? 'と動きの指示' : ''}</summary>
          <textarea data-act="prompt" aria-label="画像の指示">${esc(s.image_prompt)}</textarea>
          ${s.visual === 'video' ? `<textarea data-act="vprompt" aria-label="動きの指示">${esc(s.video_prompt)}</textarea>` : ''}
        </details>
      </div>
    </article>`).join('');
}
function updateMeta() { $$('#elist .es').forEach((el, i) => { const e = TL.items[i]; const tc = el.querySelector('[data-tc]'); if (e && tc) tc.textContent = `${fmt(e.start)}–${fmt(e.end)}${e.s.audio ? '' : ' 音声なし'}`; }); }
function markChanged() { if (!P.cur) return; if (P.cur.approved) addLog('system', '内容を変更したので、書き出す前にClaudeの再チェックが必要です。', 'info'); P.cur.approved = false; if (P.cur.verdict) P.cur.verdict.stale = true; if (P.cur.stage === 'done' || P.cur.stage === 'exported') P.cur.stage = 'unapproved'; renderVerdict(); renderMake(); updateButtons(); }
async function single(fn) {
  if (running) return;
  running = true; ctl = new AbortController(); pausePreview(); updateButtons(); refreshEdit(true);
  pipe.bindUi(callbacks, ctl.signal);
  try { await fn(); } catch (e) { if (e.name !== 'AbortError') toast(e.message || String(e)); }
  finally { running = false; ctl = null; updateButtons(); await saveProject(); refreshEdit(true); renderMake(); }
}
$('#elist').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'TEXTAREA') return;
  const i = +b.closest('.es').dataset.i; const list = scenes(); const s = list[i]; const act = b.dataset.act;
  if (act === 'up' && i > 0) { [list[i - 1], list[i]] = [list[i], list[i - 1]]; markChanged(); lastSig = ''; refreshEdit(true); saveProject(); }
  else if (act === 'down' && i < list.length - 1) { [list[i + 1], list[i]] = [list[i], list[i + 1]]; markChanged(); lastSig = ''; refreshEdit(true); saveProject(); }
  else if (act === 'del') { list.splice(i, 1); markChanged(); lastSig = ''; refreshEdit(true); saveProject(); }
  else if (act === 'voice') single(async () => { addLog('gemini', `シーン${i + 1}の声を録り直しています…`, 'work'); await pipe.genVoice(s); s.stale = false; markChanged(); });
  else if (act === 'img') single(async () => {
    addLog('chatgpt', `シーン${i + 1}の画像を作り直しています…`, 'work'); await pipe.genImage(s); s.reviewed = true;
    if (s.visual === 'video' && s.imgBlob) { addLog('gemini', `シーン${i + 1}の動画も作り直しています…`, 'work'); await pipe.genVideo(s); if (s.videoStatus === 'failed') s.visual = 'image'; }
    markChanged();
  });
  else if (act === 'kind') {
    if (s.visual === 'video') { s.visual = 'image'; markChanged(); lastSig = ''; refreshEdit(true); saveProject(); }
    else if (s.videoBlob) { s.visual = 'video'; markChanged(); lastSig = ''; refreshEdit(true); saveProject(); }
    else single(async () => { s.visual = 'video'; if (!s.video_prompt) s.video_prompt = 'Subtle natural motion, slow cinematic camera push-in.'; addLog('gemini', `シーン${i + 1}を動画にしています…`, 'work'); await pipe.genVideo(s); if (s.videoStatus === 'failed') { s.visual = 'image'; toast('動画を作れませんでした'); } markChanged(); });
  }
});
$('#elist').addEventListener('input', e => {
  const t = e.target; if (t.tagName !== 'TEXTAREA') return;
  const s = scenes()[+t.closest('.es').dataset.i]; if (!s) return;
  if (t.dataset.act === 'text') { s.narration = t.value; if (!s.stale) { s.stale = true; const btn = t.closest('.es').querySelector('[data-act="voice"]'); btn.classList.add('primary'); btn.textContent = '声を録り直す（文が変わりました）'; } markChanged(); refreshEdit(false); }
  if (t.dataset.act === 'prompt') s.image_prompt = t.value;
  if (t.dataset.act === 'vprompt') s.video_prompt = t.value;
  clearTimeout(e.target._sv); e.target._sv = setTimeout(saveProject, 800);
});
function renderVerdict() {
  const pr = P.cur, v = pr && pr.verdict;
  const badge = $('#vBadge');
  if (!v) { badge.className = 'vbadge'; badge.textContent = '未チェック'; $('#vScore').textContent = ''; $('#vSummary').textContent = 'Claudeの最終チェックはまだです。'; }
  else {
    badge.className = 'vbadge ' + (pr.approved ? 'ok' : 'ng');
    badge.textContent = pr.approved ? 'Claude OK' : (v.stale ? '変更あり・再チェック待ち' : '未承認');
    $('#vScore').textContent = `${v.score}点`;
    $('#vSummary').textContent = v.summary;
  }
  updateExportGate();
}
$('#recheckBtn').addEventListener('click', () => {
  if (!P.cur || running) return;
  for (const s of P.cur.scenes) if (s.stale) { s.audioBlob = null; s.audio = null; s.audioStatus = 'pending'; s.stale = false; }
  lastSig = '';
  runPipeline(pipe.recheck);
});

/* ---------- export ---------- */
let exporting = false, cancelExport = false, outBlob = null, outName = '';
function updateExportGate() {
  const pr = P.cur; const ok = !!(pr && pr.approved);
  $('#exportBtn').disabled = running || exporting || !pr || !pr.scenes.length;
  $('#exportBtn').textContent = ok ? 'MP4を書き出す' : 'Claudeの承認待ち';
  if (!ok) $('#exportBtn').disabled = true;
  $('#forceExport').hidden = ok || !pr || !pr.scenes.length || running || exporting;
}
const stamp = () => { const d = new Date(); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };
async function doExport(force) {
  const pr = P.cur; if (!pr || exporting || running) return;
  if (!pr.approved && !force) { toast('Claudeの承認がまだです'); return; }
  pausePreview(); exporting = true; cancelExport = false; updateButtons();
  $('#prog').hidden = false; $('#cancelBtn').hidden = false; $('#result').hidden = true;
  pr.stage = 'exporting'; renderMake(); lockWake();
  try {
    buildTimeline(pr.scenes);
    const r = await exportVideo(pr.scenes, pr.bgm, (f, label, t) => {
      $('#progBar').value = f; if (label) $('#status').textContent = label;
      if (t != null && view === 'edit') { pos = t; drawFrame(pctx, t, PS, true); }
    }, () => cancelExport);
    outBlob = r.blob;
    const base = (pr.plan && pr.plan.title ? pr.plan.title : 'short').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
    outName = `${base}_${stamp()}.${r.ext}`;
    const v = $('#outVid'); if (v.src) URL.revokeObjectURL(v.src); v.src = URL.createObjectURL(outBlob);
    $('#outMeta').textContent = `${r.info} · ${(outBlob.size / 1048576).toFixed(1)}MB`;
    $('#result').hidden = false; $('#progBar').value = 1;
    $('#status').textContent = r.secs ? `書き出し完了（${r.secs}秒）。確認して保存してください。` : '書き出し完了。確認して保存してください。';
    try { $('#shareBtn').hidden = !(navigator.canShare && navigator.canShare({ files: [new File([outBlob], outName, { type: outBlob.type })] })); } catch (e) { $('#shareBtn').hidden = true; }
    pr.stage = 'exported'; addLog('system', `書き出しが完了しました（${r.info}）。「編集・書き出し」タブで保存できます。`, 'done');
  } catch (e) {
    pr.stage = pr.approved ? 'done' : 'unapproved';
    if (e && e.message === 'cancel') $('#status').textContent = '中止しました';
    else { console.error(e); $('#status').textContent = '書き出しに失敗しました: ' + (e && e.message || e) + '。720×1280にするか、ChromeかEdgeの最新版で試してください。'; }
  } finally {
    exporting = false; releaseWake(); $('#prog').hidden = true; $('#cancelBtn').hidden = true; pos = 0; updateButtons(); renderMake(); if (view === 'edit') refreshEdit(true); saveProject();
  }
}
$('#exportBtn').addEventListener('click', () => doExport(false));
$('#forceExport').addEventListener('click', () => doExport(true));
$('#cancelBtn').addEventListener('click', () => { cancelExport = true; });
$('#saveBtn').addEventListener('click', () => {
  if (!outBlob) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(outBlob); a.download = outName; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
});
$('#shareBtn').addEventListener('click', async () => {
  if (!outBlob) return;
  try { await navigator.share({ files: [new File([outBlob], outName, { type: outBlob.type })], title: outName }); }
  catch (e) { if (e.name !== 'AbortError') toast('共有できませんでした。「保存する」を使ってください'); }
});

/* ---------- BGM ---------- */
$('#bgmBtn').addEventListener('click', () => { $('#bgmIn').value = ''; $('#bgmIn').click(); });
$('#bgmIn').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f || !P.cur) { if (!P.cur) toast('先に作品を作ってください'); return; }
  pausePreview();
  try { P.cur.bgm = { id: nextId(), name: f.name, blob: f, buffer: await decodeAudio(f) }; } catch (err) { toast(f.name + ' を読み込めませんでした'); return; }
  renderBgm(); refreshEdit(false); saveProject();
});
$('#bgmDel').addEventListener('click', () => { if (!P.cur) return; pausePreview(); P.cur.bgm = null; renderBgm(); refreshEdit(false); saveProject(); });
function renderBgm() { const b = P.cur && P.cur.bgm; $('#bgmName').textContent = b ? b.name : 'なし'; $('#bgmDel').hidden = !b; }

/* ---------- boot ---------- */
bindSettings(); updateKeyWarn(); $('#ver').textContent = VERSION;
(async () => {
  const pr = await loadProject();
  if (pr) {
    P.cur = pr;
    if (['plan', 'images', 'videos', 'voice', 'qc'].includes(pr.stage)) pr.stage = 'stopped';
    if (pr.stage === 'exporting') pr.stage = pr.approved ? 'done' : 'unapproved';
    fillBrief(pr.brief);
  }
  renderAll(); renderBgm();
  const h = (location.hash || '').slice(1);
  if (['make', 'edit', 'settings'].includes(h)) showView(h);
})();
