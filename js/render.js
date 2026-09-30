// Timeline, frame drawing (images, video clips, subtitles) and audio mix.
import { S, TELOP_FONTS, TRANSITIONS, TELOP_ANIMS } from './state.js?v=2026.09.30-7';

export const W0 = 1080, H0 = 1920;
const st = () => S.style;

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
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOut = k => k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
const easeOutCubic = k => 1 - Math.pow(1 - k, 3);
const easeOutBack = k => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };

function drawVisual(ctx, e, idx, local) {
  const s = e.s;
  if (s.visual === 'video' && s.video && s.video.readyState >= 2) {
    const v = s.video, d = v.duration;
    // if the clip is shorter than the scene, hold the last frame with a slow push-in
    const z = isFinite(d) && local > d ? 1 + Math.min(0.12, (local - d) * 0.05) : 1;
    const r = coverRect(v.videoWidth || 720, v.videoHeight || 1280, W0, H0, z);
    ctx.drawImage(v, r.x, r.y, r.w, r.h); return;
  }
  if (!s.img) {
    const g = ctx.createLinearGradient(0, 0, 0, H0); g.addColorStop(0, '#1d2130'); g.addColorStop(1, '#0b0c11');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W0, H0); return;
  }
  const p = Math.min(1, Math.max(0, local / Math.max(0.01, e.len + 0.5)));
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

/* ---------- transitions between scenes ---------- */
const TRANS = new Set(TRANSITIONS.map(t => t[0]));
export function transOf(s) {
  const t = st().useDirection && s && s.transition;
  if (t && TRANS.has(t.type)) return { type: t.type, duration: t.type === 'cut' ? 0 : clamp(+t.duration || 0.5, 0.15, 1.2) };
  return st().fade > 0 ? { type: 'dissolve', duration: st().fade } : { type: 'cut', duration: 0 };
}
function overlay(ctx, color, a) { if (a <= 0) return; ctx.save(); ctx.globalAlpha = Math.min(1, a); ctx.fillStyle = color; ctx.fillRect(0, 0, W0, H0); ctx.restore(); }
function zoomAbout(ctx, z) { ctx.translate(W0 / 2, H0 / 2); ctx.scale(z, z); ctx.translate(-W0 / 2, -H0 / 2); }
function drawTransition(ctx, pe, pi, e, i, local, tr) {
  const p = clamp(local / tr.duration, 0, 1), q = easeInOut(p);
  const prev = () => drawVisual(ctx, pe, pi, pe.len + local), cur = () => drawVisual(ctx, e, i, local);
  switch (tr.type) {
    case 'dip_black': case 'dip_white': {
      const col = tr.type === 'dip_black' ? '#000' : '#fff';
      if (p < 0.5) { prev(); overlay(ctx, col, p * 2); } else { cur(); overlay(ctx, col, (1 - p) * 2); }
      break;
    }
    case 'flash':
      if (p < 0.2) { prev(); overlay(ctx, '#fff', p / 0.2); } else { cur(); overlay(ctx, '#fff', Math.pow(1 - (p - 0.2) / 0.8, 2)); }
      break;
    case 'slide_left':
      ctx.save(); ctx.translate(-W0 * q, 0); prev(); ctx.restore();
      ctx.save(); ctx.translate(W0 * (1 - q), 0); cur(); ctx.restore();
      break;
    case 'slide_up':
      ctx.save(); ctx.translate(0, -H0 * q); prev(); ctx.restore();
      ctx.save(); ctx.translate(0, H0 * (1 - q)); cur(); ctx.restore();
      break;
    case 'zoom':
      ctx.save(); zoomAbout(ctx, 1 + q * 0.7); prev(); ctx.restore();
      ctx.save(); ctx.globalAlpha = q; zoomAbout(ctx, 1.35 - 0.35 * q); cur(); ctx.restore();
      break;
    case 'circle': {
      prev();
      const r = q * Math.hypot(W0, H0) / 2;
      ctx.save(); ctx.beginPath(); ctx.arc(W0 / 2, H0 / 2, Math.max(1, r), 0, Math.PI * 2); ctx.clip(); cur(); ctx.restore();
      ctx.save(); ctx.globalAlpha = 1 - q; ctx.strokeStyle = '#fff'; ctx.lineWidth = 14; ctx.beginPath(); ctx.arc(W0 / 2, H0 / 2, Math.max(1, r), 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      break;
    }
    default: // dissolve
      prev(); ctx.save(); ctx.globalAlpha = q; cur(); ctx.restore();
  }
}

/* ---------- telops ---------- */
const FONTS = Object.fromEntries(TELOP_FONTS.map(f => [f[0], f[1]]));
const ANIMS = new Set(TELOP_ANIMS.map(a => a[0]));
const POS = { top: 0.22, upper: 0.36, center: 0.5, lower: 0.64, bottom: 0.7 };
const isHex = c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c.trim());
// The look of one scene's telop: global settings, overridden by Claude's direction when present.
export function sceneStyle(s) {
  const g = st();
  const out = { font: g.font, weight: FONTS[g.font] || 900, size: g.size, color: g.color, stroke: g.stroke, strokeW: g.strokeW, stroke2: '', accent: '#ffd84a',
    pos: g.pos, anim: g.pop ? 'pop' : 'none', box: g.box ? 'dark' : 'none', maxChars: g.maxChars };
  const t = g.useDirection && s && s.telop;
  if (!t) return out;
  if (t.font && FONTS[t.font] != null) { out.font = t.font; out.weight = FONTS[t.font]; }
  if (+t.size) out.size = Math.round(g.size * clamp(+t.size, 0.75, 1.5));
  if (isHex(t.color)) out.color = t.color; if (isHex(t.stroke)) out.stroke = t.stroke;
  out.stroke2 = isHex(t.stroke2) ? t.stroke2 : '';
  if (isHex(t.accent)) out.accent = t.accent;
  if (POS[t.pos] != null) out.pos = POS[t.pos];
  if (ANIMS.has(t.anim)) out.anim = t.anim;
  if (['none', 'dark', 'accent'].includes(t.box)) out.box = t.box;
  out.maxChars = Math.max(6, Math.round(g.maxChars * g.size / out.size));
  return out;
}
const fontStr = sty => `${sty.weight} ${sty.size}px "${sty.font}", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif`;
const NO_START = new Set([...'、。，．,.・：；:;？！?!ー－―…‥」』）)】〕］]｝}〉》ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ々〜~']);
const wrapCache = new Map();
export const clearWrapCache = () => wrapCache.clear();
export function wrapText(ctx, text, sty) {
  const key = fontStr(sty) + '|' + sty.maxChars + '|' + text;
  if (wrapCache.has(key)) return wrapCache.get(key);
  ctx.font = fontStr(sty);
  const maxW = Math.min(W0 * 0.9, sty.maxChars * sty.size * 1.02);
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
  if (wrapCache.size > 600) wrapCache.clear();
  wrapCache.set(key, lines);
  return lines;
}
export const dispText = t => st().hidePeriod ? t.replace(/[。．]+(?=$|[」』）)])/g, '').replace(/[。．]+$/, '') : t;

// split a line into [text, emphasized] runs
function runs(line, emph) {
  const chars = [...line]; const mask = new Array(chars.length).fill(false);
  for (const w of emph || []) {
    const wc = [...String(w || '').trim()]; if (!wc.length) continue;
    for (let i = 0; i + wc.length <= chars.length; i++) if (wc.every((c, k) => chars[i + k] === c)) for (let k = 0; k < wc.length; k++) mask[i + k] = true;
  }
  const out = [];
  chars.forEach((c, i) => { const l = out[out.length - 1]; if (l && l[1] === mask[i]) l[0] += c; else out.push([c, mask[i]]); });
  return out;
}

function drawSubtitle(ctx, ch, t, anim, sty, emph) {
  const text = dispText(ch.text); if (!text) return;
  const lines = wrapText(ctx, text, sty);
  const lh = sty.size * 1.3, blockH = lh * lines.length, cy = sty.pos * H0, cx = W0 / 2;
  const a = Math.max(0, t - ch.start);
  let sc = 1, al = 1, dx = 0, dy = 0, reveal = Infinity;
  if (anim) switch (sty.anim) {
    case 'pop': { const k = Math.min(1, a / 0.18); sc = 0.82 + 0.18 * easeOutBack(k); al = Math.min(1, a / 0.07); break; }
    case 'zoom': { const k = Math.min(1, a / 0.22); sc = 1.8 - 0.8 * easeOutCubic(k); al = Math.min(1, a / 0.1); break; }
    case 'slide_up': { const k = Math.min(1, a / 0.25); dy = (1 - easeOutCubic(k)) * 90; al = Math.min(1, a / 0.15); break; }
    case 'typewriter': { const n = [...text].length; reveal = Math.floor(a / clamp(0.6 / n, 0.03, 0.07)) + 1; break; }
    case 'shake': if (a < 0.35) { const f = 1 - a / 0.35; dx = Math.sin(a * 90) * 14 * f; dy = Math.cos(a * 70) * 8 * f; sc = 1 + 0.12 * f; } break;
    case 'fade': al = Math.min(1, a / 0.25); break;
  }
  ctx.save(); ctx.globalAlpha = al;
  ctx.translate(cx + dx, cy + dy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
  ctx.font = fontStr(sty); ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const laid = lines.map(ln => { const r = runs(ln, emph).map(([s2, e2]) => ({ s: s2, e: e2, w: ctx.measureText(s2).width })); return { r, w: r.reduce((x, y) => x + y.w, 0) }; });
  if (sty.box !== 'none') {
    const wMax = Math.max(...laid.map(l => l.w)), px = sty.size * 0.45, py = sty.size * 0.28;
    const x = cx - wMax / 2 - px, y = cy - blockH / 2 - py, w = wMax + px * 2, h = blockH + py * 2;
    ctx.save(); ctx.fillStyle = sty.box === 'accent' ? sty.accent : 'rgba(0,0,0,0.6)'; if (sty.box === 'accent') ctx.globalAlpha *= 0.92;
    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, Math.min(28, h / 2)); else ctx.rect(x, y, w, h); ctx.fill(); ctx.restore();
  }
  // passes: outer outline (with shadow), inner outline, fill; emphasized runs use the accent colour
  const passes = [];
  if (sty.stroke2) passes.push({ kind: 'stroke', color: () => sty.stroke2, width: sty.strokeW * 2 + 18, shadow: true });
  if (sty.strokeW > 0) passes.push({ kind: 'stroke', color: () => sty.stroke, width: sty.strokeW * 2, shadow: !sty.stroke2 });
  passes.push({ kind: 'fill', color: run => run.e && sty.box !== 'accent' ? sty.accent : sty.color });
  for (const ps of passes) {
    let left = reveal;
    ctx.save();
    if (ps.shadow) { ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 16; ctx.shadowOffsetY = 6; }
    laid.forEach((ln, i) => {
      const y = cy - blockH / 2 + lh * (i + 0.5);
      let x = cx - ln.w / 2;
      for (const run of ln.r) {
        if (left <= 0) break;
        let str = run.s; const n = [...str].length;
        if (n > left) str = [...str].slice(0, left).join('');
        left -= n;
        if (ps.kind === 'stroke') { ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = ps.width; ctx.strokeStyle = ps.color(run); ctx.strokeText(str, x, y); }
        else { ctx.fillStyle = ps.color(run); ctx.fillText(str, x, y); }
        x += run.w;
      }
    });
    ctx.restore();
  }
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
  const i = sceneIndexAt(t), e = items[i], local = t - e.start;
  const tr = i > 0 ? transOf(e.s) : null;
  if (tr && tr.duration > 0 && local < tr.duration) drawTransition(ctx, items[i - 1], i - 1, e, i, local, tr);
  else drawVisual(ctx, e, i, local);
  const ch = e.chunks.find(c => t >= c.start && t < c.end) || (t >= TL.total - 1e-3 ? e.chunks[e.chunks.length - 1] : null);
  if (ch) drawSubtitle(ctx, ch, t, anim, sceneStyle(e.s), st().useDirection ? e.s.emphasis : null);
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
  const i = sceneIndexAt(t), local = t - TL.items[i].start;
  const need = [[i, local]];
  if (i > 0) { const tr = transOf(TL.items[i].s); if (tr.duration > 0 && local < tr.duration) need.push([i - 1, TL.items[i - 1].len + local]); }
  for (const [k, local] of need) { const s = TL.items[k].s; if (s.visual === 'video' && s.video) { s.video.pause(); await seek(s.video, clipTime(s.video, local)); } }
}
// For preview: keep clips roughly in sync while playing, or parked on the frame when scrubbing.
export function syncPreviewVideos(t, playing, redraw) {
  TL.items.forEach((e, k) => {
    const s = e.s; if (s.visual !== 'video' || !s.video) return;
    const v = s.video, local = t - e.start, visible = t >= e.start - 0.05 && t < e.end + (k + 1 < TL.items.length ? transOf(TL.items[k + 1].s).duration : 0);
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
  const byFont = new Map();
  for (const s of scenes) { const f = fontStr(sceneStyle(s)); byFont.set(f, (byFont.get(f) || '') + (s.narration || '')); }
  if (!byFont.size) byFont.set(fontStr(sceneStyle(null)), 'あ');
  try { await Promise.all([...byFont].map(([f, txt]) => document.fonts.load(f, [...new Set(txt)].join('') || 'あ'))); } catch (e) {}
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
export function lineCount(text, scene) {
  const c = document.createElement('canvas').getContext('2d');
  return wrapText(c, dispText(text), sceneStyle(scene)).length;
}
