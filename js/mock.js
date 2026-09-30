// Demo mode: fake AI responses so the whole flow can be tried without API keys or cost.
const wait = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});
let reviewCalls = 0, qcCalls = 0, videoReviewCalls = 0;
export function resetMock() { reviewCalls = 0; qcCalls = 0; videoReviewCalls = 0; }

const PAL = [['#ff9a6b', '#5b3fd6', '#1c1440'], ['#34d1c4', '#1f5fe0', '#0d1636'], ['#ffd84a', '#ff5c8a', '#3a1238'], ['#b8f28a', '#2a8f6a', '#0e2a22'], ['#f7c1ff', '#7a4bd8', '#1b1036']];
let imgN = 0;
export async function image(prompt, signal) {
  await wait(500 + Math.random() * 600, signal);
  const k = imgN++ % PAL.length, pal = PAL[k];
  const c = document.createElement('canvas'); c.width = 864; c.height = 1536; const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 1536); g.addColorStop(0, pal[0]); g.addColorStop(0.55, pal[1]); g.addColorStop(1, pal[2]);
  x.fillStyle = g; x.fillRect(0, 0, 864, 1536);
  x.fillStyle = 'rgba(255,255,255,0.85)'; x.beginPath(); x.arc(200 + (k * 137) % 460, 420, 120, 0, Math.PI * 2); x.fill();
  for (let j = 0; j < 4; j++) {
    x.fillStyle = `rgba(0,0,0,${0.18 + j * 0.14})`; x.beginPath(); x.moveTo(0, 1536);
    for (let X = 0; X <= 864; X += 24) x.lineTo(X, 860 + j * 150 + Math.sin(X / (120 + j * 40) + k * 2 + j) * (60 - j * 10));
    x.lineTo(864, 1536); x.closePath(); x.fill();
  }
  x.fillStyle = 'rgba(255,255,255,0.9)'; x.font = '600 30px monospace'; x.fillText('DEMO IMAGE ' + imgN, 150, 110);
  return new Promise(r => c.toBlob(r, 'image/jpeg', 0.85));
}

export async function tts(text, signal) {
  await wait(300 + Math.random() * 400, signal);
  const dur = Math.max(1.2, [...text].length / 6.8), sr = 24000, n = Math.floor(dur * sr);
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr, syll = Math.floor(t * 7);
    const env = Math.max(0, Math.sin((t * 7 - syll) * Math.PI)) * 0.25;
    pcm[i] = Math.round(env * Math.sin(2 * Math.PI * (180 + (syll % 5) * 25) * t) * 32767);
  }
  const h = new ArrayBuffer(44), v = new DataView(h); const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true);
  return new Blob([h, pcm.buffer], { type: 'audio/wav' });
}

export async function video(prompt, imageBlob, seconds, signal) {
  const bmp = await createImageBitmap(imageBlob);
  const c = document.createElement('canvas'); c.width = 360; c.height = 640; const x = c.getContext('2d');
  const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find(t => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
  if (!mime) { await wait(800, signal); throw Object.assign(new Error('デモ動画を作れないブラウザです'), { raw: 'デモ動画を作れないブラウザです' }); }
  const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime });
  const parts = []; rec.ondataavailable = e => e.data.size && parts.push(e.data);
  const done = new Promise(r => rec.onstop = r);
  const dur = Math.min(3, seconds) * 1000, t0 = performance.now();
  rec.start(200);
  await new Promise(res => {
    const tick = () => {
      const p = (performance.now() - t0) / dur;
      const z = 1 + 0.25 * Math.min(1, p), w = 360 * z, h = 640 * z;
      x.drawImage(bmp, (360 - w) / 2, (640 - h) / 2 - 30 * p, w, h);
      if (p >= 1 || (signal && signal.aborted)) res(); else requestAnimationFrame(tick);
    };
    tick();
  });
  rec.stop(); await done;
  if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
  return new Blob(parts, { type: mime.split(';')[0] });
}

export async function claudeTool({ tool, content, signal }) {
  await wait(700 + Math.random() * 500, signal);
  const text = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  if (tool.name === 'submit_plan') {
    const theme = (text.match(/依頼内容:\n([\s\S]*?)\n\n/) || [])[1] || 'テーマ';
    const vids = +((text.match(/最大(\d+)シーン/) || [])[1] || 1);
    const lines = ['朝5時、まだ外は真っ暗。', 'でもこの1時間が、一日でいちばん集中できる。', 'まずはコーヒーを淹れて、深呼吸。', 'スマホは別の部屋に置いておく。', '気づけば作業が半分終わってる！', 'あなたも明日、一緒に朝活しよう。'];
    return {
      title: 'デモ：' + theme.slice(0, 18), hook: '暗い朝の静けさで引き込む',
      style_bible: 'soft gradient illustration, warm dawn palette, minimal shapes',
      voice_style: '落ち着いた声で、少しゆっくり',
      scenes: lines.map((n, i) => ({ narration: n, image_prompt: `Demo scene ${i + 1}: ${n}`, visual: i === 1 && vids > 0 ? 'video' : 'image', video_prompt: 'slow push-in', motion: ['zoom_in', 'pan_left', 'zoom_out', 'pan_right', 'zoom_in', 'static'][i], role: ['hook', 'main', 'support', 'main', 'main', 'ending'][i] })),
    };
  }
  if (tool.name === 'submit_review') {
    reviewCalls++;
    const nums = [...text.matchAll(/シーン(\d+)（/g)].map(m => +m[1]);
    return {
      reviews: nums.map((n, i) => ({ scene: n, verdict: reviewCalls === 1 && i === 2 ? 'regenerate' : 'ok', problems: reviewCalls === 1 && i === 2 ? '（デモ）ナレーションと画像の雰囲気が合っていない' : '', new_image_prompt: 'Demo regenerated image', focus_x: 0.5, focus_y: 0.4 })),
      comment: reviewCalls === 1 ? '（デモ）1枚だけ作り直してもらいます。' : '（デモ）画像はOKです。',
    };
  }
  if (tool.name === 'submit_video_review') {
    videoReviewCalls++;
    const nums = [...text.matchAll(/シーン(\d+)（/g)].map(m => +m[1]);
    return { reviews: nums.map(n => ({ scene: n, verdict: 'ok' })) };
  }
  if (tool.name === 'submit_direction') {
    const nums = [...text.matchAll(/シーン(\d+)（/g)].map(m => +m[1]);
    const looks = [
      { font: 'Dela Gothic One', color: '#ffffff', stroke: '#e0245e', stroke2: '#1a1a1a', accent: '#ffe14d', size: 1.25, pos: 'center', anim: 'zoom', box: 'none' },
      { font: 'Noto Sans JP', color: '#ffffff', stroke: '#1b2a6b', stroke2: '', accent: '#ffd84a', size: 1, pos: 'lower', anim: 'pop', box: 'none' },
      { font: 'Mochiy Pop One', color: '#fff7e0', stroke: '#6a2c91', stroke2: '#ffffff', accent: '#ff7ab6', size: 1, pos: 'lower', anim: 'slide_up', box: 'none' },
      { font: 'Noto Sans JP', color: '#1a1a1a', stroke: '#ffffff', stroke2: '', accent: '#e0245e', size: 0.95, pos: 'lower', anim: 'typewriter', box: 'accent' },
      { font: 'Reggae One', color: '#ffe14d', stroke: '#111111', stroke2: '', accent: '#ffffff', size: 1.1, pos: 'upper', anim: 'shake', box: 'none' },
      { font: 'Kaisei Decol', color: '#ffffff', stroke: '#222222', stroke2: '', accent: '#ffd84a', size: 1, pos: 'center', anim: 'fade', box: 'dark' },
    ];
    const trans = ['dissolve', 'flash', 'slide_left', 'dip_black', 'zoom', 'circle'];
    return {
      concept: '（デモ）冒頭は極太で強く、本編は読みやすさ重視、締めは上品に。',
      scenes: nums.map((n, i) => ({ scene: n, telop: looks[i % looks.length], emphasis: i === 0 ? ['朝5時'] : i === 1 ? ['いちばん'] : [], transition: { type: trans[i % trans.length], duration: 0.6 } })),
    };
  }
  if (tool.name === 'submit_qc') {
    qcCalls++;
    if (qcCalls === 1) return { approved: false, score: 72, summary: '（デモ）流れは良いが、2シーン目のナレーションが長く字幕が詰まって見える。', fixes: [{ scene: 2, action: 'rewrite_narration', reason: '（デモ）字幕が長いので短くする', new_narration: 'この1時間が、いちばん集中できる。' }] };
    return { approved: true, score: 86, summary: '（デモ）冒頭のつかみと字幕の読みやすさが改善され、公開できる品質です。', fixes: [] };
  }
  throw new Error('unknown tool');
}
