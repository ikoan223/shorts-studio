// Timeline, frame drawing (images, video clips, subtitles) and audio mix.
import { S } from './state.js?v=2026.09.30-4';

export const W0 = 1080, H0 = 1920;
const st = () => S.style;
const FONTS = { 'Noto Sans JP': 900, 'M PLUS Rounded 1c': 800, 'Zen Maru Gothic': 900, 'Dela Gothic One': 400 };

let actx = null;
export const AC = () => actx || (actx = new (window.AudioContext || window.webkitAudioContext)());
export async function decodeAudio(blob) {
  const ab = await blob.arrayBuffer();
  return new Promise((res, rej) => { const p = AC().decodeAudioData(ab, res, rej); if (p && p.catch) p.catch(rej); });
}

/* ---------- timeline ---------- */
export const speechLen = s => s.audio ? s.audio.duration : Math.max(1.8, [...(s.narration || '')].length / 6.5);

export function splitChunks(text) {
  let parts = String(text || '').split(/\n+/).map(t => t.trim()).filter(Boolean);
  parts = parts.flatMap(p => (p.match(/[^。！？!?]+(?:[。！？!?]+[」』）)]?)?|[。！？!?]+/g) || [p]).map(t => t.trim()).filter(Boolean));
  const maxLen = st().maxChars * 2, out = [];
  for (let p of parts) {
    while ([...p].length > maxLen + 2) {
      const chars = [...p]; let cut = -1;
      for (let i = maxLen; i >= Math.floor(maxLen * 0.45); i--) if ('、，, 　'.includes(chars[i - 1])) { cut = i; break; }
      if (cut < 0) cut = Math.ceil(chars.length / Math.ceil(chars.length / maxLen));
      out.push(chars.slice(0, cut).join('').trim()); p = chars.slice(cut).join('').trim();
    }
    if (p) out.push(p);
  }
  return out;
}

export let TL = { items: [], total: 0 };
export function buildTimeline(scenes) {
  let t = 0; const items = [];
  for (const s of scenes) {
    const speech = speechLen(s);
    const len = speech + st().pad;
    const e = { s, start: t, len, end: t + len, chunks: [] };
    const parts = splitChunks(s.narration);
    const w = parts.map(p => Math.max(1, p.replace(/[\s、。，．！？!?,.「」『』（）()…・ー〜~]/g, '').length));
    const tot = w.reduce((a, b) => a + b, 0); let acc = 0;
    parts.forEach((p, i) => {
      const a = t + speech * acc / tot; acc += w[i];
      e.chunks.push({ text: p, start: a, end: i === parts.length - 1 ? t + len : t + speech * acc / tot });
    });
    items.push(e); t += len;
  }
  TL = { items, total: t };
  return TL;
}
export const sceneIndexAt = t => { const i = TL.items.findIndex(e => t < e.end); return i < 0 ? TL.items.length - 1 : i; };

/* ---------- drawing ---------- */
export function coverRect(iw, ih, W, H, z = 1) { const sc = Math.max(W / iw, H / ih) * z; const w = iw * sc, h = ih * sc; return { x: (W - w) / 2, y: (H - h) / 2, w, h }; }

export function makeBlur(img) {
  const c = document.createElement('canvas'); c.width = 90; c.height = 160;
  const x = c.getContext('2d'); const r = coverRect(img.width, img.height, 90, 160, 1.15);
  try { x.filter = 'blur(5px)'; } catch (e) {}
  x.drawImage(img, r.x, r.y, r.w, r.h); x.filter = 'none';
  return c;
}

const clipTime = (el, local) => { const d = el.duration; return isFinite(d) && d > 0 ? Math.min(local, d - 0.04) : local; };

function drawVisual(ctx, e, idx, local) {
  const s = e.s;
  if (s.visual === 'video' && s.video && s.video.readyState >= 2) {
    const v = s.video, r = coverRect(v.videoWidth || 720, v.videoHeight || 1280, W0, H0, 1);
    ctx.drawImage(v, r.x, r.y, r.w, r.h); return;
  }
  if (!s.img) {
    const g = ctx.createLinearGradient(0, 0, 0, H0); g.addColorStop(0, '#1d2130'); g.addColorStop(1, '#0b0c11');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W0, H0); return;
  }
  const p = Math.min(1, Math.max(0, local / Math.max(0.01, e.len + st().fade)));
  const m = s.motion === 'static' ? 0 : st().motionAmt;
  const zoomOut = s.motion === 'zoom_out';
  const z = 1 + m * (zoomOut ? 1 - p : p) + (s.motion && s.motion.startsWith('pan') ? m * 0.6 : 0);
  const r = coverRect(s.img.width, s.img.height, W0, H0, z);
  // aim the frame at the focus point, keeping the image covering the screen
  const fx = s.focus ? s.focus.x : 0.5, fy = s.focus ? s.focus.y : 0.5;
  let x = W0 / 2 - fx * r.w, y = H0 / 2 - fy * r.h;
  if (s.motion === 'pan_left' || s.motion === 'pan_right') x += (s.motion === 'pan_left' ? 1 : -1) * (p - 0.5) * (r.w - W0) * 0.9;
  x = Math.min(0, Math.max(W0 - r.w, x)); y = Math.min(0, Math.max(H0 - r.h, y));
  ctx.drawImage(s.img, x, y, r.w, r.h);
}

const fontStr = () => `${FONTS[st().font] || 900} ${st().size}px "${st().font}", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif`;
export const subtitleFont = fontStr;
const NO_START = new Set([...'、。，．,.・：；:;？！?!ー－―…‥」』）)】〕］]｝}〉》ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々〜~']);
const wrapCache = new Map();
export const clearWrapCache = () => wrapCache.clear();
export function wrapText(ctx, text) {
  const key = fontStr() + '|' + st().maxChars + '|' + text;
  if (wrapCache.has(key)) return wrapCache.get(key);
  ctx.font = fontStr();
  const maxW = Math.min(W0 * 0.9, st().maxChars * st().size * 1.02);
  const toks = text.match(/[A-Za-z0-9'’%&@#\-_.,]+|\s+|[\s\S]/gu) || [];
  const mw = t => ctx.measureText(t).width;
  const greedy = lim => {
    const lines = []; let cur = '', cw = 0;
    for (const tk of toks) {
      if (!cur && /^\s+$/.test(tk)) continue;
      const w = mw(tk);
      if (cur && cw + w > lim && !NO_START.has(tk[0])) { lines.push(cur.trimEnd()); cur = tk.trimStart(); cw = mw(cur); }
      else { cur += tk; cw += w; }
    }
    if (cur) lines.push(cur.trimEnd());
    return lines;
  };
  let lines = greedy(maxW);
  if (lines.length === 2) {
    // prefer breaking right after 、！？ or a space near the middle
    const chars = [...text]; let best = -1, bestD = 1;
    chars.forEach((c, i) => { if ('、，,！？!? 　'.includes(c) && i < chars.length - 1) { const d = Math.abs((i + 1) / chars.length - 0.5); if (d < bestD && d <= 0.25) { bestD = d; best = i + 1; } } });
    if (best > 0) { const a = chars.slice(0, best).join('').trim(), b = chars.slice(best).join('').trim(); if (mw(a) <= maxW && mw(b) <= maxW) { lines = [a, b]; } }
  }
  if (lines.length > 1 && !(lines.length === 2 && /[、，,！？!? 　]$/.test(lines[0]))) {
    const alt = greedy(Math.max(mw(text) / lines.length * 1.06, Math.max(...toks.map(mw))));
    if (alt.length === lines.length) lines = alt;
  }
  if (wrapCache.size > 400) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}
export const dispText = t => st().hidePeriod ? t.replace(/[。．]+(?=$|[」』）)])/g, '').replace(/[。．]+$/, '') : t;
const easeOutBack = k => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };

function drawSubtitle(ctx, ch, t, anim) {
  const text = dispText(ch.text); if (!text) return;
  const lines = wrapText(ctx, text);
  const y0 = st();
  const lh = y0.size * 1.3, blockH = lh * lines.length, cy = y0.pos * H0, cx = W0 / 2;
  let sc = 1, al = 1;
  if (y0.pop && anim) { const a = t - ch.start; const k = Math.min(1, Math.max(0, a / 0.18)); sc = 0.82 + 0.18 * easeOutBack(k); al = Math.min(1, Math.max(0, a / 0.07)); }
  ctx.save(); ctx.globalAlpha = al;
  ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
  ctx.font = fontStr(); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if (y0.box) {
    const wMax = Math.max(...lines.map(l => ctx.measureText(l).width));
    const px = y0.size * 0.45, py = y0.size * 0.28;
    const x = cx - wMax / 2 - px, y = cy - blockH / 2 - py, w = wMax + px * 2, h = blockH + py * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.58)'; ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(28, h / 2)); else ctx.rect(x, y, w, h);
    ctx.fill();
  }
  lines.forEach((ln, i) => {
    const y = cy - blockH / 2 + lh * (i + 0.5);
    if (y0.strokeW > 0) { ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = y0.strokeW * 2; ctx.strokeStyle = y0.stroke; ctx.strokeText(ln, cx, y); }
    ctx.fillStyle = y0.color; ctx.fillText(ln, cx, y);
  });
  ctx.restore();
}

export function drawFrame(ctx, t, scale, anim = true) {
  ctx.setTransform(scale, 0, 0, scale, 0, 0); ctx.globalAlpha = 1;
  ctx.fillStyle = '#0b0c11'; ctx.fillRect(0, 0, W0, H0);
  const items = TL.items;
  if (!items.length) {
    ctx.fillStyle = '#8a90a3'; ctx.font = `700 44px "Zen Kaku Gothic New", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('まだシーンがありません', W0 / 2, H0 / 2); return;
  }
  const i = sceneIndexAt(t), e = items[i], local = t - e.start, fade = st().fade;
  if (fade > 0 && i > 0 && local < fade) {
    const pe = items[i - 1];
    drawVisual(ctx, pe, i - 1, pe.len + local);
    ctx.globalAlpha = Math.max(0, local / fade); drawVisual(ctx, e, i, local); ctx.globalAlpha = 1;
  } else drawVisual(ctx, e, i, local);
  const ch = e.chunks.find(c => t >= c.start && t < c.end) || (t >= TL.total - 1e-3 ? e.chunks[e.chunks.length - 1] : null);
  if (ch) drawSubtitle(ctx, ch, t, anim);
}

/* ---------- video clip positioning ---------- */
function seek(el, time) {
  return new Promise(res => {
    if (Math.abs(el.currentTime - time) < 0.001 && el.readyState >= 2) return res();
    const done = () => { el.removeEventListener('seeked', done); clearTimeout(to); res(); };
    const to = setTimeout(done, 1500);
    el.addEventListener('seeked', done); el.currentTime = time;
  });
}
// For export: put every clip visible at time t on the exact frame.
export async function prepareFrame(t) {
  if (!TL.items.length) return;
  const i = sceneIndexAt(t), fade = st().fade;
  const need = [[i, t - TL.items[i].start]];
  if (fade > 0 && i > 0 && t - TL.items[i].start < fade) need.push([i - 1, TL.items[i - 1].len + t - TL.items[i].start]);
  for (const [k, local] of need) { const s = TL.items[k].s; if (s.visual === 'video' && s.video) { s.video.pause(); await seek(s.video, clipTime(s.video, local)); } }
}
// For preview: keep clips roughly in sync while playing, or parked on the frame when scrubbing.
export function syncPreviewVideos(t, playing, redraw) {
  TL.items.forEach((e, k) => {
    const s = e.s; if (s.visual !== 'video' || !s.video) return;
    const v = s.video, local = t - e.start, visible = t >= e.start - 0.05 && t < e.end + st().fade;
    if (!visible) { if (!v.paused) v.pause(); return; }
    const want = clipTime(v, Math.max(0, local));
    if (playing) {
      if (local >= 0 && v.paused && want < (v.duration || 1e9) - 0.05) { v.currentTime = want; v.play().catch(() => {}); }
      else if (Math.abs(v.currentTime - want) > 0.3) v.currentTime = want;
    } else {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - want) > 0.02) { v.currentTime = want; v.addEventListener('seeked', redraw, { once: true }); }
    }
  });
}
export function stopAllVideos() { TL.items.forEach(e => e.s.video && !e.s.video.paused && e.s.video.pause()); }

export async function loadVideoEl(blob) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
  v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
  v.src = URL.createObjectURL(blob);
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('動画を読み込めませんでした')), 20000);
    v.addEventListener('loadeddata', () => { clearTimeout(to); res(); }, { once: true });
    v.addEventListener('error', () => { clearTimeout(to); rej(new Error('動画を読み込めませんでした')); }, { once: true });
  });
  if (!isFinite(v.duration)) {
    // WebM from MediaRecorder has no duration until the end is probed
    await new Promise(res => {
      const on = () => { if (isFinite(v.duration)) { v.removeEventListener('durationchange', on); res(); } };
      v.addEventListener('durationchange', on); v.currentTime = 1e7; setTimeout(res, 4000);
    });
    await seek(v, 0);
  }
  return v;
}

/* ---------- audio mix ---------- */
let mixed = null, mixKey = '';
export const audioKey = (scenes, bgm) => scenes.map(s => s.id + ':' + (s.audio ? s.audio.length : 'x') + ':' + [...(s.narration || '')].length).join('|') +
  `|${st().pad}|${st().voiceVol}|${st().bgmVol}|${st().duck}|${bgm ? bgm.id : 0}`;
export async function getMix(scenes, bgm) {
  const k = audioKey(scenes, bgm);
  if (mixed && mixKey === k) return mixed;
  const sr = 48000, len = Math.max(1, Math.ceil(TL.total * sr));
  const oc = new OfflineAudioContext(2, len, sr);
  const vg = oc.createGain(); vg.gain.value = st().voiceVol; vg.connect(oc.destination);
  for (const e of TL.items) if (e.s.audio) { const src = oc.createBufferSource(); src.buffer = e.s.audio; src.connect(vg); src.start(e.start); }
  if (bgm && st().bgmVol > 0) {
    const src = oc.createBufferSource(); src.buffer = bgm.buffer; src.loop = true;
    const g = oc.createGain(); const v = st().bgmVol, low = v * 0.45;
    g.gain.setValueAtTime(v, 0);
    if (st().duck) for (const e of TL.items) if (e.s.audio) {
      const a = e.start, b = e.start + e.s.audio.duration;
      g.gain.setValueAtTime(v, Math.max(0, a - 0.15)); g.gain.linearRampToValueAtTime(low, a + 0.05);
      g.gain.setValueAtTime(low, b); g.gain.linearRampToValueAtTime(v, b + 0.3);
    }
    const fo = Math.max(0, TL.total - 1.5);
    g.gain.cancelScheduledValues(fo); g.gain.setValueAtTime(st().duck ? low : v, fo); g.gain.linearRampToValueAtTime(0, TL.total);
    src.connect(g); g.connect(oc.destination); src.start(0); src.stop(TL.total);
  }
  mixed = await oc.startRendering(); mixKey = k;
  return mixed;
}

export async function ensureFonts(scenes) {
  const txt = [...new Set(scenes.map(s => s.narration).join(''))].join('') || 'あ';
  try { await document.fonts.load(fontStr(), txt); } catch (e) {}
  wrapCache.clear();
}

// Small JPEG of a frame for Claude to look at.
export async function snapshot(t, w = 360) {
  const c = document.createElement('canvas'); c.width = w; c.height = Math.round(w * 16 / 9);
  await prepareFrame(t);
  drawFrame(c.getContext('2d'), t, w / W0, false);
  return c.toDataURL('image/jpeg', 0.72).split(',')[1];
}
// Lines of a subtitle chunk at the current style (for QC checks).
export function lineCount(text) {
  const c = document.createElement('canvas').getContext('2d');
  return wrapText(c, dispText(text)).length;
}
