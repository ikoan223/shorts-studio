// MP4 export: WebCodecs (H.264/AAC, fallback VP9/Opus) + a small ISO-BMFF muxer.
// Falls back to real-time MediaRecorder where WebCodecs is missing.
import { S } from './state.js?v=2026.09.30-5';
import { TL, W0, drawFrame, prepareFrame, getMix, AC, ensureFonts, stopAllVideos } from './render.js?v=2026.09.30-5';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export const MP4 = (() => {
  const u16 = n => [(n >> 8) & 255, n & 255];
  const u32 = n => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const s4 = s => [...s].map(c => c.charCodeAt(0));
  const zeros = n => new Array(n).fill(0);
  const u32arr = list => { const a = new Uint8Array(list.length * 4); const dv = new DataView(a.buffer); list.forEach((v, i) => dv.setUint32(i * 4, v)); return a; };
  function box(type, ...parts) {
    let len = 8; for (const p of parts) len += p.length;
    const out = new Uint8Array(len); new DataView(out.buffer).setUint32(0, len); out.set(s4(type), 4);
    let o = 8; for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const fbox = (type, v, flags, ...parts) => box(type, [v, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...parts);
  const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
  function durations(tr) {
    const s = tr.samples, ts = tr.timescale, d = [];
    for (let i = 0; i < s.length; i++) {
      const a = Math.round(s[i].pts * ts / 1e6);
      const b = i + 1 < s.length ? Math.round(s[i + 1].pts * ts / 1e6) : a + Math.max(1, Math.round((s[i].dur || tr.defaultDur) * ts / 1e6));
      d.push(Math.max(1, b - a));
    }
    return d;
  }
  function sampleEntry(tr) {
    if (tr.kind === 'video') {
      const inner = tr.codec === 'avc' ? box('avcC', tr.desc) : fbox('vpcC', 1, 0, [0, 40, (8 << 4) | (1 << 1), 1, 1, 1], u16(0));
      return box(tr.codec === 'avc' ? 'avc1' : 'vp09', zeros(6), u16(1), zeros(16), u16(tr.width), u16(tr.height),
        u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x18), u16(0xffff), inner);
    }
    let inner;
    if (tr.codec === 'aac') {
      const asc = tr.desc && tr.desc.length ? [...tr.desc] : [0x11, 0x90];
      const dsi = [0x05, asc.length, ...asc];
      const dcd = [0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, ...u32(0), ...u32(0), ...dsi];
      const sl = [0x06, 1, 0x02];
      inner = fbox('esds', 0, 0, [0x03, 3 + dcd.length + sl.length, 0, 0, 0, ...dcd, ...sl]);
    } else {
      let preskip = 312; const d = tr.desc;
      if (d && d.length >= 19 && String.fromCharCode(...d.slice(0, 8)) === 'OpusHead') preskip = d[10] | (d[11] << 8);
      inner = box('dOps', [0, tr.channels], u16(preskip), u32(tr.sampleRate), u16(0), [0]);
    }
    return box(tr.codec === 'aac' ? 'mp4a' : 'Opus', zeros(6), u16(1), zeros(8), u16(tr.channels), u16(16), u16(0), u16(0), u32(tr.sampleRate * 65536), inner);
  }
  function trak(tr, id, chunkOffsets, chunkCounts, movieTs) {
    const durs = durations(tr);
    const mdDur = durs.reduce((a, b) => a + b, 0);
    const mvDur = Math.round(mdDur / tr.timescale * movieTs);
    const stts = []; for (const d of durs) { const l = stts[stts.length - 1]; if (l && l[1] === d) l[0]++; else stts.push([1, d]); }
    const stsc = []; chunkCounts.forEach((c, i) => { const l = stsc[stsc.length - 1]; if (!l || l[1] !== c) stsc.push([i + 1, c, 1]); });
    const isV = tr.kind === 'video';
    const stbl = [fbox('stsd', 0, 0, u32(1), sampleEntry(tr)), fbox('stts', 0, 0, u32(stts.length), u32arr(stts.flat()))];
    if (isV) { const keys = []; tr.samples.forEach((s, i) => s.key && keys.push(i + 1)); stbl.push(fbox('stss', 0, 0, u32(keys.length), u32arr(keys))); }
    stbl.push(fbox('stsc', 0, 0, u32(stsc.length), u32arr(stsc.flat())),
      fbox('stsz', 0, 0, u32(0), u32(tr.samples.length), u32arr(tr.samples.map(s => s.data.length))),
      fbox('stco', 0, 0, u32(chunkOffsets.length), u32arr(chunkOffsets)));
    return {
      dur: mvDur,
      box: box('trak',
        fbox('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(mvDur), zeros(8), u16(0), u16(isV ? 0 : 1), u16(isV ? 0 : 0x0100), u16(0), MATRIX,
          u32(isV ? tr.width * 65536 : 0), u32(isV ? tr.height * 65536 : 0)),
        box('mdia',
          fbox('mdhd', 0, 0, u32(0), u32(0), u32(tr.timescale), u32(mdDur), u16(0x55c4), u16(0)),
          fbox('hdlr', 0, 0, u32(0), s4(isV ? 'vide' : 'soun'), zeros(12), s4(isV ? 'VideoHandler\0' : 'SoundHandler\0')),
          box('minf', isV ? fbox('vmhd', 0, 1, zeros(8)) : fbox('smhd', 0, 0, u16(0), u16(0)),
            box('dinf', fbox('dref', 0, 0, u32(1), fbox('url ', 0, 1))), box('stbl', ...stbl)))),
    };
  }
  function build(tracks) {
    const layout = []; const ptr = tracks.map(() => 0);
    for (let w = 5e5; ; w += 5e5) {
      let more = false;
      tracks.forEach((tr, ti) => {
        const st = ptr[ti];
        while (ptr[ti] < tr.samples.length && tr.samples[ptr[ti]].pts < w) ptr[ti]++;
        if (ptr[ti] > st) layout.push({ ti, first: st, count: ptr[ti] - st });
        if (ptr[ti] < tr.samples.length) more = true;
      });
      if (!more) break;
    }
    const ftyp = box('ftyp', s4('isom'), u32(512), s4('isom'), s4('iso2'), s4(tracks[0].codec === 'avc' ? 'avc1' : 'iso6'), s4('mp41'));
    const makeMoov = base => {
      const offs = tracks.map(() => []), counts = tracks.map(() => []); let o = base;
      for (const c of layout) {
        offs[c.ti].push(o); counts[c.ti].push(c.count);
        const s = tracks[c.ti].samples; for (let i = c.first; i < c.first + c.count; i++) o += s[i].data.length;
      }
      const traks = tracks.map((tr, i) => trak(tr, i + 1, offs[i], counts[i], 1000));
      const dur = Math.max(...traks.map(t => t.dur));
      const mvhd = fbox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(dur), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(tracks.length + 1));
      return { moov: box('moov', mvhd, ...traks.map(t => t.box)), end: o };
    };
    const base = ftyp.length + makeMoov(0).moov.length + 8;
    const { moov, end } = makeMoov(base);
    const head = new Uint8Array(8); new DataView(head.buffer).setUint32(0, end - base + 8); head.set(s4('mdat'), 4);
    const parts = [ftyp, moov, head];
    for (const c of layout) { const s = tracks[c.ti].samples; for (let i = c.first; i < c.first + c.count; i++) parts.push(s[i].data); }
    return new Blob(parts, { type: 'video/mp4' });
  }
  return { build };
})();

const toU8 = d => d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d.buffer, d.byteOffset, d.byteLength);

async function pickVideo(w, h, fps) {
  if (!('VideoEncoder' in window)) return null;
  const br = (w >= 1080 ? 10e6 : 6e6) * (fps > 30 ? 1.5 : 1);
  const lvl = w >= 1080 && fps > 30 ? '2a' : '28';
  for (const [codec, kind] of [['avc1.6400' + lvl, 'avc'], ['avc1.4d00' + lvl, 'avc'], ['avc1.4200' + lvl, 'avc'], ['avc1.640033', 'avc'], ['vp09.00.40.08', 'vp9']]) {
    const cfg = { codec, width: w, height: h, bitrate: br, framerate: fps };
    if (kind === 'avc') cfg.avc = { format: 'avc' };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return { cfg, kind }; } catch (e) {}
  }
  return null;
}
async function pickAudio() {
  if (!('AudioEncoder' in window)) return null;
  for (const [codec, kind, bitrate] of [['mp4a.40.2', 'aac', 192000], ['opus', 'opus', 160000]]) {
    const cfg = { codec, sampleRate: 48000, numberOfChannels: 2, bitrate };
    try { if ((await AudioEncoder.isConfigSupported(cfg)).supported) return { cfg, kind }; } catch (e) {}
  }
  return null;
}
const fmt = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };

// onProgress(fraction, label, t) ; returns {blob, ext, info}
export async function exportVideo(scenes, bgm, onProgress, isCancelled) {
  const ow = S.style.res === '720' ? 720 : 1080, oh = ow === 720 ? 1280 : 1920, fps = +S.style.fps || 30;
  stopAllVideos();
  onProgress(0, 'フォントと音声を準備中…');
  await ensureFonts(scenes);
  const buf = await getMix(scenes, bgm);
  const v = await pickVideo(ow, oh, fps), a = await pickAudio();
  if (!v || !a) return exportRealtime(ow, oh, fps, buf, onProgress, isCancelled);
  const vs = [], as = []; let vdesc = null, adesc = null, err = null;
  const ve = new VideoEncoder({ output: (c, m) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); vs.push({ data: d, pts: c.timestamp, dur: c.duration, key: c.type === 'key' }); if (m && m.decoderConfig && m.decoderConfig.description && !vdesc) vdesc = toU8(m.decoderConfig.description).slice(); }, error: e => err = e });
  ve.configure(v.cfg);
  const cv = document.createElement('canvas'); cv.width = ow; cv.height = oh;
  const cx = cv.getContext('2d', { alpha: false }); const sc = ow / W0;
  const n = Math.max(1, Math.round(TL.total * fps)); const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    if (isCancelled()) throw new Error('cancel');
    if (err) throw err;
    const t = i / fps;
    await prepareFrame(t);
    drawFrame(cx, t, sc);
    const fr = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
    ve.encode(fr, { keyFrame: i % (fps * 2) === 0 }); fr.close();
    while (ve.encodeQueueSize > 4) await sleep(2);
    if (i % 8 === 0) {
      const el = (performance.now() - t0) / 1000, eta = i > 10 ? el / i * (n - i) : 0;
      onProgress(i / n * 0.95, `映像を書き出し中… ${Math.round(i / n * 100)}%${eta ? `（残り約${Math.ceil(eta)}秒）` : ''}`, t);
      await sleep(0);
    }
  }
  await ve.flush(); ve.close(); if (err) throw err;
  onProgress(0.96, '音声をエンコード中…');
  const ae = new AudioEncoder({ output: (c, m) => { const d = new Uint8Array(c.byteLength); c.copyTo(d); as.push({ data: d, pts: c.timestamp, dur: c.duration, key: true }); if (m && m.decoderConfig && m.decoderConfig.description && !adesc) adesc = toU8(m.decoderConfig.description).slice(); }, error: e => err = e });
  ae.configure(a.cfg);
  const sr = buf.sampleRate, L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  for (let o = 0; o < buf.length; o += 4800) {
    if (isCancelled()) throw new Error('cancel');
    const f = Math.min(4800, buf.length - o); const d = new Float32Array(f * 2);
    d.set(L.subarray(o, o + f), 0); d.set(R.subarray(o, o + f), f);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: f, numberOfChannels: 2, timestamp: Math.round(o * 1e6 / sr), data: d });
    ae.encode(ad); ad.close();
    while (ae.encodeQueueSize > 16) await sleep(1);
  }
  await ae.flush(); ae.close(); if (err) throw err;
  onProgress(0.98, 'MP4にまとめています…'); await sleep(0);
  if (v.kind === 'avc' && !vdesc) throw new Error('映像の設定情報を取得できませんでした');
  const blob = MP4.build([
    { kind: 'video', codec: v.kind, desc: vdesc, width: ow, height: oh, timescale: 90000, defaultDur: 1e6 / fps, samples: vs },
    { kind: 'audio', codec: a.kind, desc: adesc, channels: 2, sampleRate: 48000, timescale: 48000, defaultDur: a.kind === 'aac' ? 1024 / 48000 * 1e6 : 20000, samples: as },
  ]);
  const label = (v.kind === 'avc' ? 'H.264' : 'VP9') + ' + ' + (a.kind === 'aac' ? 'AAC' : 'Opus');
  return { blob, ext: 'mp4', info: `${ow}×${oh} · ${fps}fps · ${fmt(TL.total)} · ${label}`, secs: ((performance.now() - t0) / 1000).toFixed(1) };
}

async function exportRealtime(ow, oh, fps, buf, onProgress, isCancelled) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('このブラウザは動画の書き出しに対応していません');
  const mime = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  if (!mime) throw new Error('このブラウザは動画の書き出しに対応していません');
  const cv = document.createElement('canvas'); cv.width = ow; cv.height = oh;
  const cx = cv.getContext('2d', { alpha: false }); const sc = ow / W0;
  const ac = AC(); await ac.resume();
  const dest = ac.createMediaStreamDestination();
  const stream = new MediaStream([...cv.captureStream(fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: ow >= 1080 ? 10e6 : 6e6 });
  const parts = []; rec.ondataavailable = e => e.data.size && parts.push(e.data);
  const done = new Promise(r => rec.onstop = r);
  await prepareFrame(0); drawFrame(cx, 0, sc);
  const s = ac.createBufferSource(); s.buffer = buf; s.connect(dest);
  rec.start(500); const st = ac.currentTime + 0.1; s.start(st);
  onProgress(0, 'リアルタイムで録画中（このブラウザは高速書き出しに非対応）…');
  await new Promise(res => {
    const tick = async () => {
      const t = ac.currentTime - st;
      if (isCancelled() || t >= TL.total) { res(); return; }
      if (t >= 0) {
        for (const e of TL.items) { const v = e.s.video; if (e.s.visual === 'video' && v) { const loc = t - e.start; if (loc >= 0 && loc < e.len) { if (v.paused) { v.currentTime = Math.min(loc, (v.duration || 99) - 0.05); v.play().catch(() => {}); } } else if (!v.paused) v.pause(); } }
        drawFrame(cx, t, sc); onProgress(t / TL.total, 'リアルタイムで録画中…', t);
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
  try { s.stop(); } catch (e) {}
  stopAllVideos(); rec.stop(); await done;
  if (isCancelled()) throw new Error('cancel');
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  return { blob: new Blob(parts, { type: mime.split(';')[0] }), ext, info: `${ow}×${oh} · ${fmt(TL.total)} · ${ext.toUpperCase()}（リアルタイム録画）`, secs: null };
}
