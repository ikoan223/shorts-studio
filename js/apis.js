// Direct browser calls to Anthropic (Claude), OpenAI (images) and Google Gemini (voice, video).
import { S, P } from './state.js';
import * as mock from './mock.js';

export class ApiError extends Error {
  constructor(provider, status, message) { super(`${provider}: ${message}`); this.provider = provider; this.status = status; this.raw = message; }
}
const sleep = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

async function jfetch(provider, url, opts) {
  let r;
  try { r = await fetch(url, opts); }
  catch (e) { if (e.name === 'AbortError') throw e; throw new ApiError(provider, 0, 'サーバーに接続できませんでした（通信環境かAPIキーの設定を確認してください）'); }
  const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {}
  if (!r.ok) {
    const m = (j && (j.error && (j.error.message || j.error.type) || j.message)) || txt.slice(0, 300) || r.statusText;
    throw new ApiError(provider, r.status, m);
  }
  return j;
}
async function retry(fn, signal, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (e.name === 'AbortError') throw e;
      last = e;
      const st = e.status;
      if (!(st === 0 || st === 408 || st === 409 || st === 429 || st >= 500)) throw e;
      await sleep(Math.min(30000, 2000 * Math.pow(2, i)) + Math.random() * 800, signal);
    }
  }
  throw last;
}
const need = (k, name) => { if (!S.keys[k]) throw new ApiError(name, 401, 'APIキーが設定されていません（設定タブで入力してください）'); return S.keys[k]; };
export const b64ToBlob = (b64, type) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return new Blob([u], { type }); };
export const blobToB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(blob); });
function addCost(kind, n) {
  const c = P.cur && P.cur.cost; if (!c) return;
  const pr = S.prices;
  if (kind === 'claude') { c.claudeIn += n.in; c.claudeOut += n.out; c.usd += n.in / 1e6 * pr.claudeIn + n.out / 1e6 * pr.claudeOut; }
  if (kind === 'image') { c.images++; c.usd += pr.image; }
  if (kind === 'video') { c.videos++; c.usd += pr.video; }
  if (kind === 'tts') { c.ttsChars += n; c.usd += n / 1000 * pr.tts; }
}

/* ---------- Claude ---------- */
// content: array of Anthropic content blocks. Forces one tool call and returns its input.
export async function claudeTool({ system, content, tool, maxTokens = 6000, signal }) {
  if (S.demo) return mock.claudeTool({ tool, content, signal });
  const key = need('anthropic', 'Claude');
  const body = { model: S.models.claude, max_tokens: maxTokens, system, messages: [{ role: 'user', content }], tools: [tool], tool_choice: { type: 'tool', name: tool.name } };
  const j = await retry(() => jfetch('Claude', 'https://api.anthropic.com/v1/messages', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify(body),
  }), signal);
  if (j.usage) addCost('claude', { in: (j.usage.input_tokens || 0) + (j.usage.cache_read_input_tokens || 0), out: j.usage.output_tokens || 0 });
  const tu = (j.content || []).find(c => c.type === 'tool_use');
  if (!tu) throw new ApiError('Claude', 200, '想定した形式の返答がありませんでした');
  return tu.input;
}
export const imgBlock = (b64, media = 'image/jpeg') => ({ type: 'image', source: { type: 'base64', media_type: media, data: b64 } });
export const txt = text => ({ type: 'text', text });

/* ---------- OpenAI images ---------- */
export async function openaiImage(prompt, signal) {
  if (S.demo) { const b = await mock.image(prompt, signal); addCost('image'); return b; }
  const key = need('openai', 'ChatGPT');
  const call = size => jfetch('ChatGPT', 'https://api.openai.com/v1/images/generations', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
    body: JSON.stringify({ model: S.models.image, prompt, size, quality: S.imageQuality, n: 1, output_format: 'jpeg' }),
  });
  let j;
  try { j = await retry(() => call(S.imageSize), signal); }
  catch (e) {
    if (e.status === 400 && /size|resolution|dimension/i.test(e.raw) && S.imageSize !== '1024x1536') j = await retry(() => call('1024x1536'), signal);
    else throw e;
  }
  const d = j.data && j.data[0];
  if (!d) throw new ApiError('ChatGPT', 200, '画像が返ってきませんでした');
  addCost('image');
  if (d.b64_json) return b64ToBlob(d.b64_json, 'image/jpeg');
  if (d.url) { const r = await fetch(d.url, { signal }); return r.blob(); }
  throw new ApiError('ChatGPT', 200, '画像データが見つかりませんでした');
}
export const isPolicyError = e => e && e.status === 400 && /safety|policy|moderation|rejected|not allowed/i.test(e.raw || '');

/* ---------- Gemini TTS ---------- */
function pcmToWav(pcm, rate, ch = 1) {
  const h = new ArrayBuffer(44), v = new DataView(h);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true); v.setUint32(24, rate, true);
  v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, pcm.length, true);
  return new Blob([h, pcm], { type: 'audio/wav' });
}
let ttsLegacy = '';
export async function geminiTTS(text, voice, style, signal) {
  if (S.demo) { const b = await mock.tts(text, signal); addCost('tts', [...text].length); return b; }
  const key = need('gemini', 'Gemini');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(S.models.tts)}:generateContent`;
  const opts = body => ({ method: 'POST', signal, headers: { 'content-type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body) });
  const modern = { contents: [{ role: 'user', parts: [{ text, ...(style ? { speech_metadata: { style } } : {}) }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice } } } };
  const legacy = { contents: [{ parts: [{ text: style ? `次の文を「${style}」の雰囲気で読み上げてください：\n${text}` : text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } } };
  let j;
  if (ttsLegacy === S.models.tts) j = await retry(() => jfetch('Gemini', url, opts(legacy)), signal);
  else {
    try { j = await retry(() => jfetch('Gemini', url, opts(modern)), signal); }
    catch (e) { if (e.status !== 400) throw e; j = await retry(() => jfetch('Gemini', url, opts(legacy)), signal); ttsLegacy = S.models.tts; }
  }
  const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
  const part = parts.find(p => p.inlineData || p.inline_data);
  if (!part) throw new ApiError('Gemini', 200, '音声が返ってきませんでした');
  const inl = part.inlineData || part.inline_data;
  const bytes = b64ToBlob(inl.data, 'application/octet-stream');
  const head = new Uint8Array(await bytes.slice(0, 4).arrayBuffer());
  addCost('tts', [...text].length);
  if (String.fromCharCode(...head) === 'RIFF') return new Blob([bytes], { type: 'audio/wav' });
  const mime = inl.mimeType || inl.mime_type || '';
  if (/mpeg|mp3|ogg|opus|aac|mp4/.test(mime)) return new Blob([bytes], { type: mime });
  const rate = +((mime.match(/rate=(\d+)/) || [])[1] || 24000);
  return pcmToWav(new Uint8Array(await bytes.arrayBuffer()), rate);
}

/* ---------- Gemini video (Gemini Omni via Interactions API, or Veo via predictLongRunning) ---------- */
function findVideo(o, depth = 0) {
  if (!o || typeof o !== 'object' || depth > 8) return null;
  const mime = o.mime_type || o.mimeType || '';
  if ((o.type === 'video' || /^video\//.test(mime)) && (o.data || o.uri || o.url)) return { data: o.data, uri: o.uri || o.url, mime: mime || 'video/mp4' };
  if (o.inlineData && /^video\//.test(o.inlineData.mimeType || '')) return { data: o.inlineData.data, mime: o.inlineData.mimeType };
  if (o.video && (o.video.uri || o.video.bytesBase64Encoded)) return { uri: o.video.uri, data: o.video.bytesBase64Encoded, mime: o.video.mimeType || 'video/mp4' };
  for (const k in o) { const r = findVideo(o[k], depth + 1); if (r) return r; }
  return null;
}
async function fetchVideoUri(uri, key, signal) {
  let r;
  try { r = await fetch(uri, { signal, headers: { 'x-goog-api-key': key } }); }
  catch (e) { if (e.name === 'AbortError') throw e; r = await fetch(uri + (uri.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key), { signal }); }
  if (!r.ok) throw new ApiError('Gemini', r.status, '生成された動画をダウンロードできませんでした');
  return r.blob();
}
export async function geminiVideo(prompt, imageBlob, seconds, signal) {
  if (S.demo) { const b = await mock.video(prompt, imageBlob, seconds, signal); addCost('video'); return b; }
  const key = need('gemini', 'Gemini');
  const model = S.models.video;
  const headers = { 'content-type': 'application/json', 'x-goog-api-key': key };
  const img64 = imageBlob ? await blobToB64(imageBlob) : null;
  const deadline = Date.now() + 10 * 60 * 1000;
  let found = null;
  if (/^veo/i.test(model)) {
    const dur = [4, 6, 8].reduce((a, b) => Math.abs(b - seconds) < Math.abs(a - seconds) ? b : a, 8);
    const inst = { prompt }; if (img64) inst.image = { bytesBase64Encoded: img64, mimeType: imageBlob.type || 'image/jpeg' };
    const op = await retry(() => jfetch('Gemini', `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:predictLongRunning`, {
      method: 'POST', signal, headers, body: JSON.stringify({ instances: [inst], parameters: { aspectRatio: '9:16', durationSeconds: dur } }),
    }), signal);
    let cur = op;
    while (!cur.done) {
      if (Date.now() > deadline) throw new ApiError('Gemini', 504, '動画の生成が10分以内に終わりませんでした');
      await sleep(8000, signal);
      cur = await retry(() => jfetch('Gemini', `https://generativelanguage.googleapis.com/v1beta/${op.name}`, { signal, headers }), signal);
    }
    if (cur.error) throw new ApiError('Gemini', 400, cur.error.message || '動画を生成できませんでした');
    found = findVideo(cur.response);
  } else {
    const input = img64 ? [{ type: 'image', data: img64, mime_type: imageBlob.type || 'image/jpeg' }, { type: 'text', text: prompt }] : prompt;
    const send = withFormat => jfetch('Gemini', 'https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST', signal, headers, body: JSON.stringify({ model, input, ...(withFormat ? { response_format: { type: 'video', aspect_ratio: '9:16' } } : {}) }),
    });
    let j;
    try { j = await retry(() => send(true), signal); }
    catch (e) { if (e.status === 400 && /response_format|aspect/i.test(e.raw)) j = await retry(() => send(false), signal); else throw e; }
    while (j && !findVideo(j) && j.id && /progress|queued|running|pending/i.test(j.status || '')) {
      if (Date.now() > deadline) throw new ApiError('Gemini', 504, '動画の生成が10分以内に終わりませんでした');
      await sleep(6000, signal);
      j = await retry(() => jfetch('Gemini', `https://generativelanguage.googleapis.com/v1beta/interactions/${encodeURIComponent(j.id)}`, { signal, headers }), signal);
    }
    if (j && /fail|error|cancel/i.test(j.status || '') && !findVideo(j)) throw new ApiError('Gemini', 400, (j.error && j.error.message) || '動画を生成できませんでした');
    found = findVideo(j);
  }
  if (!found) throw new ApiError('Gemini', 200, '動画が返ってきませんでした');
  addCost('video');
  if (found.data) return b64ToBlob(found.data, found.mime || 'video/mp4');
  return fetchVideoUri(found.uri, key, signal);
}

/* ---------- key check ---------- */
export async function testKeys() {
  const out = {};
  const run = async (k, fn) => { try { await fn(); out[k] = 'ok'; } catch (e) { out[k] = e.status === 401 || e.status === 403 ? 'キーが無効です' : (e.raw || e.message); } };
  await Promise.all([
    S.keys.anthropic ? run('anthropic', () => jfetch('Claude', 'https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': S.keys.anthropic, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } })) : (out.anthropic = '未入力'),
    S.keys.openai ? run('openai', () => jfetch('ChatGPT', 'https://api.openai.com/v1/models', { headers: { authorization: 'Bearer ' + S.keys.openai } })) : (out.openai = '未入力'),
    S.keys.gemini ? run('gemini', () => jfetch('Gemini', 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': S.keys.gemini } })) : (out.gemini = '未入力'),
  ]);
  return out;
}
