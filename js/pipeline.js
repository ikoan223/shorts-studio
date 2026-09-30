// The production loop: Claude plans → ChatGPT draws → Claude reviews (loop) → Gemini animates / voices → Claude QC (loop) → approve.
import { S, P, newScene, TELOP_FONTS, TRANSITIONS, TELOP_ANIMS } from './state.js?v=2026.09.30-7';
import * as api from './apis.js?v=2026.09.30-7';
import { buildTimeline, TL, makeBlur, decodeAudio, loadVideoEl, snapshot, lineCount, speechLen, ensureFonts, sceneStyle, transOf } from './render.js?v=2026.09.30-7';

const MOTIONS = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'static'];
const ROLES = ['hook', 'main', 'support', 'ending'];
export class StopError extends Error {}
class BudgetError extends Error {}

let ui = { log() {}, update() {}, stage() {}, save() {} };
let signal = null;
const aborted = () => signal && signal.aborted;
const check = () => { if (aborted()) throw new StopError('stopped'); };
function guard(estimate) {
  const pr = P.cur; const cap = +pr.brief.budget || 0;
  if (cap > 0 && pr.cost.usd + estimate > cap) throw new BudgetError(`予算上限 $${cap.toFixed(2)} に達するため停止しました（現在 $${pr.cost.usd.toFixed(2)}）。設定を見直して「続きから再開」できます。`);
}
async function pool(items, n, fn) {
  const q = [...items]; const errs = [];
  await Promise.all(Array.from({ length: Math.min(n, q.length) }, async () => {
    while (q.length) { check(); const it = q.shift(); try { await fn(it); } catch (e) { if (e instanceof StopError || e instanceof BudgetError || e.name === 'AbortError') throw e; errs.push(e); } }
  }));
  return errs;
}
const sceneNo = s => P.cur.scenes.indexOf(s) + 1;

/* ---------- asset helpers (also used by the editor) ---------- */
export async function setImageBlob(s, blob) {
  s.imgBlob = blob; s.img = await createImageBitmap(blob);
  if (s.thumb && s.thumb.startsWith('blob:')) URL.revokeObjectURL(s.thumb);
  s.thumb = URL.createObjectURL(blob); s.blur = makeBlur(s.img); s.imgStatus = 'ready';
}
export async function setAudioBlob(s, blob) { s.audioBlob = blob; s.audio = await decodeAudio(blob); s.audioStatus = 'ready'; }
export async function setVideoBlob(s, blob) {
  if (s.video && s.video.src) URL.revokeObjectURL(s.video.src);
  s.videoBlob = blob; s.video = await loadVideoEl(blob); s.videoStatus = 'ready';
}
function smallJpeg(bmp, w = 384) {
  const c = document.createElement('canvas'); c.width = w; c.height = Math.round(w * bmp.height / bmp.width);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.75).split(',')[1];
}
async function videoFrames(v, fracs = [0.2, 0.8], w = 288) {
  const out = [];
  for (const f of fracs) {
    await new Promise(res => { const d = () => { v.removeEventListener('seeked', d); res(); }; v.addEventListener('seeked', d); v.currentTime = (isFinite(v.duration) && v.duration > 0 ? v.duration : 1) * f; setTimeout(d, 1500); });
    const c = document.createElement('canvas'); c.width = w; c.height = Math.round(w * (v.videoHeight || 16) / (v.videoWidth || 9));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    out.push(c.toDataURL('image/jpeg', 0.72).split(',')[1]);
  }
  return out;
}

export async function genImage(s) {
  guard(S.prices.image);
  s.imgStatus = 'generating'; ui.update();
  const style = P.cur.plan && P.cur.plan.style_bible ? `\n\nStyle guide (keep consistent): ${P.cur.plan.style_bible}` : '';
  const prompt = `${s.image_prompt}${style}\n\nVertical 9:16 composition for a smartphone short video. High-end, professional quality: sharp focus, rich detail and texture, intentional lighting with depth, clean composition with a clear focal point, no generic stock-photo look. Keep the main subject in the upper and middle area; keep the lower-middle band (about 60–75% from the top) calm because subtitles will be overlaid. No text, letters, numbers, user-interface screens with readable writing, logos, captions or watermarks in the image.`;
  try {
    const blob = await api.openaiImage(prompt, signal);
    await setImageBlob(s, blob);
    s.imgAttempts++; s.needsRegen = false; s.reviewed = false; s.imgError = '';
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    s.imgStatus = 'failed'; s.imgError = api.isPolicyError(e) ? '安全ポリシーで拒否されました' : (e.raw || e.message);
    s.imgAttempts++;
    ui.log('chatgpt', `シーン${sceneNo(s)}の画像を作れませんでした: ${s.imgError}`, 'warn');
  }
  ui.update();
}
export async function genVideo(s) {
  guard(S.prices.video);
  s.videoStatus = 'generating'; ui.update();
  const secs = Math.min(10, Math.max(3, Math.ceil(speechLen(s) + S.style.pad + 0.5)));
  const prompt = `${s.video_prompt || 'Subtle natural motion, slow cinematic camera push-in.'}\n\nAnimate this still image into about ${secs} seconds of vertical 9:16 video. Keep the same subjects, style and colors. No text or captions. No sudden cuts.`;
  try {
    const blob = await api.geminiVideo(prompt, s.imgBlob, secs, signal);
    await setVideoBlob(s, blob);
    s.videoAttempts++; s.videoReviewed = false; s.videoError = '';
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    s.videoStatus = 'failed'; s.videoAttempts++; s.videoError = e.raw || e.message;
    ui.log('gemini', `シーン${sceneNo(s)}の動画を作れませんでした: ${s.videoError}`, 'warn');
  }
  ui.update();
}
export async function genVoice(s) {
  guard([...s.narration].length / 1000 * S.prices.tts);
  s.audioStatus = 'generating'; ui.update();
  const style = s.voiceStyle || (P.cur.plan && P.cur.plan.voice_style) || '';
  try {
    const blob = await api.geminiTTS(s.narration, P.cur.brief.voice || 'Kore', style, signal);
    await setAudioBlob(s, blob); s.audioError = '';
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    s.audioStatus = 'failed'; s.audioError = e.raw || e.message;
    ui.log('gemini', `シーン${sceneNo(s)}の音声を作れませんでした: ${s.audioError}`, 'warn');
  }
  ui.update();
}

/* ---------- Claude prompts & tools ---------- */
const sceneProps = {
  narration: { type: 'string', description: '日本語ナレーション（そのまま字幕にもなる）' },
  image_prompt: { type: 'string', description: 'English prompt for the image generator, complete on its own' },
  visual: { type: 'string', enum: ['image', 'video'] },
  video_prompt: { type: 'string', description: 'English. Motion for the video generator (only when visual is video)' },
  motion: { type: 'string', enum: MOTIONS, description: '静止画に付ける動き' },
  role: { type: 'string', enum: ROLES, description: 'hook=冒頭のつかみ / main=本編の核心 / support=補足・つなぎ / ending=締め' },
};
const FONT_NAMES = TELOP_FONTS.map(f => f[0]);
const TELOP_SCHEMA = {
  type: 'object', description: 'このシーンのテロップの見た目',
  properties: {
    font: { type: 'string', enum: FONT_NAMES },
    color: { type: 'string', description: '文字色 #RRGGBB' },
    stroke: { type: 'string', description: '縁取りの色 #RRGGBB' },
    stroke2: { type: 'string', description: '外側の2重縁取りの色 #RRGGBB（使わないなら空文字）' },
    accent: { type: 'string', description: '強調語の色 #RRGGBB' },
    size: { type: 'number', description: '基準サイズに対する倍率 0.8〜1.4' },
    pos: { type: 'string', enum: ['top', 'upper', 'center', 'lower', 'bottom'] },
    anim: { type: 'string', enum: TELOP_ANIMS.map(a => a[0]) },
    box: { type: 'string', enum: ['none', 'dark', 'accent'] },
  },
  required: ['font', 'color', 'stroke', 'accent', 'size', 'pos', 'anim', 'box'],
};
const TRANS_SCHEMA = {
  type: 'object', description: 'このシーンに入るときの切り替え効果',
  properties: { type: { type: 'string', enum: TRANSITIONS.map(t => t[0]) }, duration: { type: 'number', description: '秒 0.2〜1.0' } },
  required: ['type', 'duration'],
};
const PLAN_TOOL = {
  name: 'submit_plan', description: 'ショート動画の企画・台本・素材指示を提出する',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      hook: { type: 'string', description: '冒頭2秒のつかみの狙い' },
      style_bible: { type: 'string', description: 'English. Art style, palette, lighting and exact appearance of any recurring character, shared by every image' },
      voice_style: { type: 'string', description: 'ナレーションの読み方（日本語。例: 落ち着いた声で、やや明るく）' },
      scenes: { type: 'array', items: { type: 'object', properties: sceneProps, required: ['narration', 'image_prompt', 'visual', 'motion', 'role'] } },
    },
    required: ['title', 'style_bible', 'voice_style', 'scenes'],
  },
};
const REVIEW_TOOL = {
  name: 'submit_review', description: '生成画像のチェック結果を提出する',
  input_schema: {
    type: 'object',
    properties: {
      reviews: { type: 'array', items: { type: 'object', properties: {
        scene: { type: 'integer', description: 'シーン番号（1始まり）' },
        verdict: { type: 'string', enum: ['ok', 'regenerate'] },
        problems: { type: 'string', description: '日本語で具体的に' },
        new_image_prompt: { type: 'string', description: 'regenerateのとき必須。English, complete prompt that fixes the problems' },
        focus_x: { type: 'number', description: '主題の中心 0〜1（左→右）' },
        focus_y: { type: 'number', description: '主題の中心 0〜1（上→下）' },
        motion: { type: 'string', enum: MOTIONS },
      }, required: ['scene', 'verdict'] } },
      add_scenes: { type: 'array', description: '話の流れに足りない場面があるときだけ（最大2）', items: { type: 'object', properties: { after_scene: { type: 'integer' }, ...sceneProps }, required: ['after_scene', 'narration', 'image_prompt', 'motion'] } },
      comment: { type: 'string', description: '全体への一言（日本語）' },
    },
    required: ['reviews', 'comment'],
  },
};
const VIDEO_TOOL = {
  name: 'submit_video_review', description: '生成動画のチェック結果を提出する',
  input_schema: {
    type: 'object',
    properties: {
      reviews: { type: 'array', items: { type: 'object', properties: {
        scene: { type: 'integer' }, verdict: { type: 'string', enum: ['ok', 'regenerate', 'use_image'] },
        problems: { type: 'string' }, new_video_prompt: { type: 'string', description: 'English' },
      }, required: ['scene', 'verdict'] } },
    },
    required: ['reviews'],
  },
};
const FIX_ACTIONS = ['regenerate_image', 'regenerate_video', 'rewrite_narration', 'regenerate_voice', 'change_motion', 'use_image', 'remove_scene', 'restyle_telop', 'change_transition'];
const QC_TOOL = {
  name: 'submit_qc', description: '完成版の品質チェック結果を提出する',
  input_schema: {
    type: 'object',
    properties: {
      approved: { type: 'boolean', description: '公開できる品質ならtrue' },
      score: { type: 'integer', description: '0〜100' },
      summary: { type: 'string', description: '日本語で2〜3文の総評' },
      fixes: { type: 'array', description: '承認しない場合の修正指示（最大6件、効果の大きい順）', items: { type: 'object', properties: {
        scene: { type: 'integer' }, action: { type: 'string', enum: FIX_ACTIONS }, reason: { type: 'string' },
        new_image_prompt: { type: 'string' }, new_video_prompt: { type: 'string' }, new_narration: { type: 'string' },
        voice_style: { type: 'string' }, motion: { type: 'string', enum: MOTIONS },
        telop: TELOP_SCHEMA, emphasis: { type: 'array', items: { type: 'string' } }, transition: TRANS_SCHEMA,
      }, required: ['scene', 'action', 'reason'] } },
    },
    required: ['approved', 'score', 'summary', 'fixes'],
  },
};
const SYS_BASE = `あなたはYouTubeショート動画の制作チームで、ディレクター兼編集者を担当するClaudeです。画像はChatGPT（OpenAIの画像モデル）、ナレーション音声と短い動画クリップはGeminiが作ります。あなたは企画・台本・素材チェック・編集判断・最終承認を担当します。
共通ルール:
- 動画は縦型9:16、日本語ナレーション付き。ナレーションはそのまま字幕として画面に表示される。
- 実在の人物、既存のキャラクター、ブランドやロゴは使わない。
- 返答は必ず指定されたツールで行う。`;

// How many scenes become video, and which: hook and main scenes first, then Claude's other picks.
function vmaxRule(b) {
  const v = +b.videoScenes || 0;
  if (v === 0) return '今回は動画を使わないので visual はすべて image にする。';
  if (v >= 99) return 'role が hook と main のシーンは visual を video にする（大事なシーンは動画で見せる）。support と ending は image でよい。';
  return `visual を video にするのは最大${v}シーン。hook と main のうち、動きで一番伝わるシーンを優先する。`;
}
function pickVideoScenes(scenes, vmax) {
  if (vmax <= 0) { scenes.forEach(s => s.visual = 'image'); return 0; }
  const rank = s => (s.role === 'hook' ? 0 : s.role === 'main' ? 1 : 3) + (s.visual === 'video' ? 0 : 1);
  const cands = scenes.filter(s => s.visual === 'video' || s.role === 'hook' || s.role === 'main')
    .map((s, i) => [s, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(x => x[0]);
  const chosen = new Set(cands.slice(0, vmax >= 99 ? cands.length : vmax));
  scenes.forEach(s => { s.visual = chosen.has(s) ? 'video' : 'image'; if (s.visual === 'video' && !s.video_prompt) s.video_prompt = 'Cinematic, natural motion of the main subject with a slow camera push-in.'; });
  return chosen.size;
}

async function planStep() {
  const b = P.cur.brief;
  ui.log('claude', '企画と台本を考えています…', 'work');
  guard(0.05);
  const plan = await api.claudeTool({
    signal, tool: PLAN_TOOL,
    system: SYS_BASE + `
企画のルール:
- 目標の長さは約${b.length}秒。日本語ナレーションは1秒あたり約6文字で計算し、合計が目標に収まるようにする。
- 最初の2秒で興味を引くフックを置く。最後は余韻か行動の呼びかけで締める。
- シーン数は4〜10。1シーンは2〜7秒、ナレーションは短い話し言葉で1〜2文。
- 各シーンに role を付ける。hook=冒頭のつかみ、main=本編の核心（伝えたい中身そのもの）、support=補足・つなぎ、ending=締め。
- image_prompt は英語で60〜120語。それ単体で通じる完全な指示にし、被写体・状況・構図（カメラ位置、画角）・光・色・質感・雰囲気・画風を具体的に書く。style_bible の画風・色・登場人物の外見を毎回書き込む。
- 画像生成AIは文字や操作画面を正しく描けない。画像内に文字・数字・読める画面を入れず、内容は人物の表情や手元、物、光、比喩的な情景で表現する（例: 編集ソフトの解説なら、モニターの光に照らされた手元や、きらめく光の粒のような抽象表現）。
- ${vmaxRule(b)}video のシーンには、カメラや被写体の動きを英語で video_prompt に具体的に書く。`,
    content: [api.txt(`依頼内容:\n${b.theme}\n\n目標の長さ: 約${b.length}秒\nナレーションの声: ${b.voice}`)],
  });
  check();
  P.cur.plan = { title: plan.title || '無題', hook: plan.hook || '', style_bible: plan.style_bible || '', voice_style: plan.voice_style || '' };
  P.cur.scenes = (plan.scenes || []).map(sc => newScene({
    narration: String(sc.narration || '').trim(), image_prompt: sc.image_prompt || '', video_prompt: sc.video_prompt || '',
    visual: sc.visual === 'video' ? 'video' : 'image', motion: MOTIONS.includes(sc.motion) ? sc.motion : 'zoom_in',
    role: ROLES.includes(sc.role) ? sc.role : 'main',
  })).filter(s => s.narration && s.image_prompt);
  const vcount = pickVideoScenes(P.cur.scenes, +b.videoScenes || 0);
  if (!P.cur.scenes.length) throw new Error('台本を作れませんでした。依頼内容を具体的にして、もう一度試してください。');
  const est = P.cur.scenes.reduce((a, s) => a + [...s.narration].length, 0) / 6;
  ui.log('claude', `「${P.cur.plan.title}」の台本ができました。${P.cur.scenes.length}シーン、約${Math.round(est)}秒${vcount ? `、うち${vcount}シーンを動画にします` : ''}。ChatGPTに画像を依頼します。`, 'done');
  ui.update(); await ui.save();
}

async function imageLoop() {
  const b = P.cur.brief; const maxRounds = Math.max(1, +b.assetRounds || 2);
  for (let round = 1; ; round++) {
    check();
    const todo = P.cur.scenes.filter(s => !s.imgBlob || s.needsRegen || s.imgStatus === 'failed');
    if (todo.length) {
      ui.log('chatgpt', round === 1 ? `${todo.length}枚の画像を生成しています…` : `指摘を受けた${todo.length}枚を作り直しています…`, 'work');
      await pool(todo, 3, genImage);
      await ui.save();
    }
    const pending = P.cur.scenes.filter(s => !s.reviewed && (s.imgBlob || s.imgStatus === 'failed'));
    if (!pending.length) break;
    const last = round >= maxRounds;
    ui.log('claude', last ? '最後の画像チェックをしています…' : `画像をチェックしています（${round}回目）…`, 'work');
    guard(0.05 + pending.length * 0.004);
    const content = [api.txt(`作品: ${P.cur.plan.title}\nstyle_bible: ${P.cur.plan.style_bible}\n全${P.cur.scenes.length}シーンのナレーション:\n${P.cur.scenes.map((s, i) => `${i + 1}. ${s.narration}`).join('\n')}\n\n以下のシーンの画像をチェックしてください。`)];
    for (const s of pending) {
      content.push(api.txt(`シーン${sceneNo(s)}（ナレーション「${s.narration}」／指示: ${s.image_prompt.slice(0, 400)}）${s.imgStatus === 'failed' ? `\n※画像生成に失敗: ${s.imgError}。安全ポリシーに触れない表現で new_image_prompt を書き直すこと。` : ''}`));
      if (s.img) content.push(api.imgBlock(smallJpeg(s.img)));
    }
    const rv = await api.claudeTool({
      signal, tool: REVIEW_TOOL, maxTokens: 5000,
      system: SYS_BASE + `
画像チェックのルール:
- 次の点を厳しめに見る: ナレーションの内容と合っているか／シーン間で画風や登場人物が揃っているか／手や顔の崩れ・読めない文字や画面・透かしがないか／ぼやけ、のっぺりした質感、情報量の少なさ、安っぽいストック写真感など品質が低くないか／縦長で主題が収まり字幕帯（上から60〜75%付近）がうるさくないか。
- 特に role が hook と main のシーンは、見る人の目を止める完成度が必要。物足りなければ、より具体的で魅力的な new_image_prompt を書いて作り直す。
- 細かい好みでは作り直さない。明らかな問題があるときだけ regenerate にし、何を直すか new_image_prompt に反映する。
- focus_x / focus_y には、縦型にトリミングしたとき中心にしたい主題の位置を入れる。
${last ? '- これが最後のチェック。生成に失敗したシーン以外は ok にし、add_scenes は使わない。' : ''}`,
      content,
    });
    check();
    let regen = 0;
    for (const r of rv.reviews || []) {
      const s = P.cur.scenes[(r.scene | 0) - 1]; if (!s || !pending.includes(s)) continue;
      if (Number.isFinite(r.focus_x) && Number.isFinite(r.focus_y)) s.focus = { x: Math.min(1, Math.max(0, r.focus_x)), y: Math.min(1, Math.max(0, r.focus_y)) };
      if (MOTIONS.includes(r.motion)) s.motion = r.motion;
      if (r.verdict === 'regenerate' && (!last || s.imgStatus === 'failed') && s.imgAttempts < maxRounds + 1) {
        if (r.new_image_prompt) s.image_prompt = r.new_image_prompt;
        s.needsRegen = true; s.note = r.problems || ''; regen++;
        ui.log('claude', `シーン${r.scene}: ${r.problems || '作り直しが必要'} → ChatGPTに再依頼`, 'ask');
      } else { s.reviewed = true; s.note = ''; }
    }
    for (const s of pending) if (!s.needsRegen) s.reviewed = true;
    let added = 0;
    if (!last && Array.isArray(rv.add_scenes)) {
      for (const a of rv.add_scenes.slice(0, 2).sort((x, y) => (y.after_scene | 0) - (x.after_scene | 0))) {
        if (!a.narration || !a.image_prompt) continue;
        const at = Math.min(P.cur.scenes.length, Math.max(0, a.after_scene | 0));
        P.cur.scenes.splice(at, 0, newScene({ narration: a.narration, image_prompt: a.image_prompt, visual: 'image', motion: MOTIONS.includes(a.motion) ? a.motion : 'zoom_in' }));
        added++;
      }
      if (added) ui.log('claude', `話の流れを補うため、${added}シーン追加します。`, 'ask');
    }
    ui.log('claude', rv.comment || (regen ? '' : '画像はすべてOKです。'), regen || added ? 'info' : 'done');
    ui.update(); await ui.save();
    if (!regen && !added) break;
    if (last) break;
  }
  // one last attempt for anything still flagged, accepted without another review
  const leftover = P.cur.scenes.filter(s => s.needsRegen || !s.imgBlob);
  if (leftover.length) { await pool(leftover, 3, genImage); leftover.forEach(s => { s.reviewed = true; s.needsRegen = false; }); ui.update(); await ui.save(); }
  // scenes still without an image fall back to a plain background; tell the user
  const missing = P.cur.scenes.filter(s => !s.imgBlob);
  if (missing.length) ui.log('system', `画像を用意できなかったシーン: ${missing.map(sceneNo).join('、')}。編集タブで作り直すか、削除してください。`, 'warn');
}

async function videoLoop() {
  const vids = () => P.cur.scenes.filter(s => s.visual === 'video' && s.imgBlob);
  if (!vids().length) return;
  for (let round = 1; round <= 2; round++) {
    check();
    const todo = vids().filter(s => !s.videoBlob || s.videoStatus === 'failed' || s.videoRegen);
    if (todo.length) {
      ui.log('gemini', `${todo.length}シーンを動画にしています（1本数十秒〜数分かかります）…`, 'work');
      let skipped = 0;
      await pool(todo, 2, async s => {
        s.videoRegen = false;
        try { await genVideo(s); }
        catch (e) { if (e instanceof BudgetError) { s.visual = 'image'; s.videoStatus = 'none'; skipped++; } else throw e; }
      });
      if (skipped) ui.log('system', `予算の上限に近いため、${skipped}シーンは動画にせず静止画にしました。`, 'warn');
      await ui.save();
    }
    for (const s of vids()) if (s.videoStatus === 'failed' && s.videoAttempts >= 2) { s.visual = 'image'; ui.log('system', `シーン${sceneNo(s)}は静止画に切り替えました。`, 'info'); }
    const pending = vids().filter(s => s.video && !s.videoReviewed);
    if (!pending.length) break;
    ui.log('claude', '動画クリップをチェックしています…', 'work');
    guard(0.05);
    const content = [api.txt(`style_bible: ${P.cur.plan.style_bible}\n各シーンの動画から2コマずつ切り出しています。元の静止画と比べ、崩れ（顔・手・物体の変形）やちらつきがないか、ナレーションに合った動きかを確認してください。${round === 2 ? '\nこれが最後のチェック。問題が残るものは use_image にする。' : ''}`)];
    for (const s of pending) {
      content.push(api.txt(`シーン${sceneNo(s)}（ナレーション「${s.narration}」／動きの指示: ${s.video_prompt}）`));
      for (const f of await videoFrames(s.video)) content.push(api.imgBlock(f));
    }
    const rv = await api.claudeTool({ signal, tool: VIDEO_TOOL, maxTokens: 3000, system: SYS_BASE, content });
    check();
    let regen = 0;
    for (const r of rv.reviews || []) {
      const s = P.cur.scenes[(r.scene | 0) - 1]; if (!s || !pending.includes(s)) continue;
      if (r.verdict === 'use_image' || (r.verdict === 'regenerate' && round === 2)) { s.visual = 'image'; s.videoReviewed = true; ui.log('claude', `シーン${r.scene}: ${r.problems || '動画が不自然'} → 静止画を使います`, 'ask'); }
      else if (r.verdict === 'regenerate') { if (r.new_video_prompt) s.video_prompt = r.new_video_prompt; s.videoRegen = true; regen++; ui.log('claude', `シーン${r.scene}: ${r.problems || '動きが不自然'} → Geminiに再依頼`, 'ask'); }
      else s.videoReviewed = true;
    }
    for (const s of pending) if (!s.videoRegen) s.videoReviewed = true;
    ui.update(); await ui.save();
    if (!regen) { ui.log('claude', '動画クリップはOKです。', 'done'); break; }
  }
}

async function voiceStep() {
  check();
  const todo = P.cur.scenes.filter(s => !s.audioBlob || s.audioStatus === 'failed');
  if (!todo.length) return;
  ui.log('gemini', `${todo.length}シーン分のナレーションを録音しています…`, 'work');
  await pool(todo, 3, genVoice);
  const failed = P.cur.scenes.filter(s => !s.audioBlob);
  if (failed.length) await pool(failed, 2, genVoice);
  ui.update(); await ui.save();
  if (P.cur.scenes.some(s => !s.audioBlob)) ui.log('system', '一部のシーンの音声を作れませんでした。音声なしの長さで仮置きしています。', 'warn');
  else ui.log('gemini', 'ナレーションができました。', 'done');
}

async function applyFixes(fixes) {
  const byScene = new Map();
  const removals = [];
  for (const f of (fixes || []).slice(0, 6)) {
    const s = P.cur.scenes[(f.scene | 0) - 1]; if (!s) continue;
    ui.log('claude', `シーン${f.scene}: ${f.reason}`, 'ask');
    switch (f.action) {
      case 'regenerate_image': if (f.new_image_prompt) s.image_prompt = f.new_image_prompt; s.needsRegen = true; if (s.visual === 'video') s.videoRegen = true; break;
      case 'regenerate_video': if (f.new_video_prompt) s.video_prompt = f.new_video_prompt; if (s.visual !== 'video') s.visual = 'video'; s.videoRegen = true; break;
      case 'rewrite_narration': if (f.new_narration) { s.narration = f.new_narration.trim(); s.audioBlob = null; s.audio = null; s.audioStatus = 'pending'; } break;
      case 'regenerate_voice': if (f.voice_style) s.voiceStyle = f.voice_style; s.audioBlob = null; s.audio = null; s.audioStatus = 'pending'; break;
      case 'change_motion': if (MOTIONS.includes(f.motion)) s.motion = f.motion; break;
      case 'use_image': s.visual = 'image'; break;
      case 'restyle_telop': if (f.telop) s.telop = cleanTelop(f.telop, s.telop); if (Array.isArray(f.emphasis)) s.emphasis = f.emphasis.slice(0, 4); break;
      case 'change_transition': if (f.transition) s.transition = cleanTrans(f.transition); break;
      case 'remove_scene': removals.push(s); break;
    }
    byScene.set(s, true);
  }
  for (const s of removals) if (P.cur.scenes.length > 2) P.cur.scenes.splice(P.cur.scenes.indexOf(s), 1);
  const imgs = P.cur.scenes.filter(s => s.needsRegen);
  if (imgs.length) { ui.log('chatgpt', `${imgs.length}枚を作り直しています…`, 'work'); await pool(imgs, 3, async s => { await genImage(s); s.reviewed = true; }); }
  const vids = P.cur.scenes.filter(s => s.visual === 'video' && (s.videoRegen || !s.videoBlob) && s.imgBlob);
  if (vids.length) { ui.log('gemini', `${vids.length}本の動画を作り直しています…`, 'work'); await pool(vids, 2, async s => { s.videoRegen = false; await genVideo(s); s.videoReviewed = true; if (s.videoStatus === 'failed') s.visual = 'image'; }); }
  const voices = P.cur.scenes.filter(s => !s.audioBlob);
  if (voices.length) { ui.log('gemini', `${voices.length}シーンのナレーションを録り直しています…`, 'work'); await pool(voices, 3, genVoice); }
  ui.update(); await ui.save();
}

/* ---------- telop & transition direction ---------- */
const DIRECT_TOOL = {
  name: 'submit_direction', description: 'テロップの見た目・強調語・シーンの切り替え効果を提出する',
  input_schema: {
    type: 'object',
    properties: {
      concept: { type: 'string', description: 'テロップと切り替えの演出方針（日本語で1〜2文）' },
      scenes: { type: 'array', items: { type: 'object', properties: {
        scene: { type: 'integer', description: 'シーン番号（1始まり）' },
        telop: TELOP_SCHEMA,
        emphasis: { type: 'array', items: { type: 'string' }, description: 'ナレーション中の強調したい語（そのまま含まれる文字列、0〜3個）' },
        transition: TRANS_SCHEMA,
      }, required: ['scene', 'telop', 'emphasis', 'transition'] } },
    },
    required: ['concept', 'scenes'],
  },
};
const hex = c => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : '';
function cleanTelop(t, prev) {
  const o = { ...(prev || {}) };
  if (FONT_NAMES.includes(t.font)) o.font = t.font;
  for (const k of ['color', 'stroke', 'accent']) if (hex(t[k])) o[k] = hex(t[k]);
  if ('stroke2' in t) o.stroke2 = hex(t.stroke2);
  if (+t.size) o.size = Math.min(1.5, Math.max(0.75, +t.size));
  if (['top', 'upper', 'center', 'lower', 'bottom'].includes(t.pos)) o.pos = t.pos;
  if (TELOP_ANIMS.some(a => a[0] === t.anim)) o.anim = t.anim;
  if (['none', 'dark', 'accent'].includes(t.box)) o.box = t.box;
  return o;
}
function cleanTrans(t) {
  const type = TRANSITIONS.some(x => x[0] === t.type) ? t.type : 'dissolve';
  return { type, duration: Math.min(1.2, Math.max(0.2, +t.duration || 0.5)) };
}
export function describeTelop(s) {
  const y = sceneStyle(s);
  return `${y.font}／文字${y.color}／縁${y.stroke}${y.stroke2 ? '＋外縁' + y.stroke2 : ''}／強調${y.accent}${s.emphasis && s.emphasis.length ? '「' + s.emphasis.join('」「') + '」' : ''}／${y.anim}／帯${y.box}`;
}
async function directStep() {
  check();
  ui.log('claude', 'テロップのデザインと切り替え演出を考えています…', 'work');
  guard(0.06);
  buildTimeline(P.cur.scenes);
  const content = [api.txt(`作品: ${P.cur.plan.title}\n依頼: ${P.cur.brief.theme}\nstyle_bible: ${P.cur.plan.style_bible}\n\n使えるフォント:\n${TELOP_FONTS.map(f => `- ${f[0]}: ${f[2]}`).join('\n')}\n使える切り替え:\n${TRANSITIONS.map(t => `- ${t[0]}: ${t[1]}`).join('\n')}\nテロップの動き:\n${TELOP_ANIMS.map(a => `- ${a[0]}: ${a[1]}`).join('\n')}\n\n各シーンの映像（字幕なし）とナレーション:`)];
  for (let i = 0; i < P.cur.scenes.length; i++) {
    const s = P.cur.scenes[i];
    content.push(api.txt(`シーン${i + 1}（${s.role}, ${s.visual === 'video' ? '動画' : '静止画'}, ${TL.items[i] ? TL.items[i].len.toFixed(1) : '?'}秒）ナレーション: ${s.narration}`));
    if (s.img) content.push(api.imgBlock(smallJpeg(s.img, 288)));
  }
  const d = await api.claudeTool({
    signal, tool: DIRECT_TOOL, maxTokens: 6000,
    system: SYS_BASE + `
あなたはショート動画のテロップデザイナー兼編集者でもある。視聴者の目を引き、最後まで見たくなる演出を付ける。
演出のルール:
- 作品全体で統一感のある基本デザイン（フォント・配色）を決めたうえで、role ごとに強弱を付ける。hook は最も派手に（大きめ、インパクトのあるフォント、zoom や shake）、main は読みやすさとメリハリ、ending は落ち着いた締め。
- すべて同じ色・同じフォントにしない。ただし1本で使うフォントは2〜3種類までにする。
- 背景の画像の色と明るさを見て、文字が必ず読めるコントラストにする（明るい背景には濃い縁取りや帯）。主題の顔や物に重ならない pos を選ぶ。bottom は画面下のUIと重なりやすいので避け、通常は lower。
- emphasis にはナレーションに実際に含まれる語を入れる（キーワード、数字、感情語）。accent は文字色と明確に違う目立つ色。
- 切り替えは内容の区切りに合わせて選ぶ。通常の流れは dissolve（0.4〜0.6秒）、話題の転換は dip_black や slide、驚きや強調は flash や zoom。毎回同じにしない。1シーン目の transition は使われないので dissolve でよい。`,
    content,
  });
  check();
  let n = 0;
  for (const r of d.scenes || []) {
    const s = P.cur.scenes[(r.scene | 0) - 1]; if (!s) continue;
    if (r.telop) s.telop = cleanTelop(r.telop, null);
    s.emphasis = Array.isArray(r.emphasis) ? r.emphasis.filter(w => typeof w === 'string' && w && s.narration.includes(w)).slice(0, 4) : [];
    if (r.transition) s.transition = cleanTrans(r.transition);
    n++;
  }
  P.cur.directed = true;
  ui.log('claude', `テロップと切り替えの演出を決めました（${n}シーン）。${d.concept || ''}`, 'done');
  ui.update(); await ui.save();
}

export async function qcOnce(round, last) {
  buildTimeline(P.cur.scenes);
  await ensureFonts(P.cur.scenes);
  const b = P.cur.brief;
  const total = TL.total;
  const warnings = [];
  if (total > b.length * 1.35) warnings.push(`全体が${total.toFixed(1)}秒で、目標の${b.length}秒より長い`);
  if (total < b.length * 0.6) warnings.push(`全体が${total.toFixed(1)}秒で、目標の${b.length}秒より短い`);
  if (total > 180) warnings.push('YouTubeショートの上限3分を超えている');
  const content = [api.txt(`作品: ${P.cur.plan.title}\n依頼: ${b.theme}\n目標の長さ: ${b.length}秒 / 実際: ${total.toFixed(1)}秒\nフックの狙い: ${P.cur.plan.hook}\n\n以下は実際に書き出される画面（字幕入り）のコマと、各シーンのデータです。`)];
  for (let i = 0; i < TL.items.length; i++) {
    const e = TL.items[i], s = e.s;
    const chars = [...s.narration].length, sp = s.audio ? s.audio.duration : 0;
    const cps = sp ? chars / sp : 0;
    const three = e.chunks.filter(c => lineCount(c.text, s) > 2).length;
    const w = [];
    if (!s.audio) w.push('音声なし');
    if (cps > 8.5) w.push(`読み上げが速い（${cps.toFixed(1)}文字/秒）`);
    if (three) w.push('3行以上になる字幕がある');
    if (!s.img) w.push('画像なし');
    content.push(api.txt(`シーン${i + 1}（${s.role}, ${e.start.toFixed(1)}〜${e.end.toFixed(1)}秒, ${s.visual === 'video' ? '動画クリップ' : '静止画＋' + s.motion}, 入りの切り替え: ${i ? transOf(s).type : 'なし'}）\nテロップ: ${describeTelop(s)}\nナレーション: ${s.narration}\n字幕の区切り: ${e.chunks.map(c => `「${c.text}」${(c.end - c.start).toFixed(1)}秒`).join(' / ')}${w.length ? `\n自動チェックの警告: ${w.join('、')}` : ''}`));
    const first = e.chunks[0];
    const t = first ? Math.min(e.end - 0.05, first.start + Math.min(1, (first.end - first.start) / 2)) : e.start + e.len / 2;
    content.push(api.imgBlock(await snapshot(t)));
  }
  if (warnings.length) content.push(api.txt('全体の警告: ' + warnings.join('、')));
  guard(0.08);
  return api.claudeTool({
    signal, tool: QC_TOOL, maxTokens: 4000,
    system: SYS_BASE + `
最終チェックのルール:
- テロップ（フォント・色・強調・動き）と切り替え効果も評価する。読みにくい、単調、映像と合わないなどの問題は restyle_telop / change_transition で直す（費用がかからない）。
- 視聴者目線で、冒頭のつかみ、話の流れ、映像とナレーションの一致、字幕の読みやすさ（位置・行数・背景との重なり）、テンポ、長さを評価し score を付ける。
- 公開して恥ずかしくない品質（目安 score 80以上、致命的な問題なし）なら approved=true、fixes は空。
- そうでなければ approved=false とし、効果の大きい修正を最大6件 fixes に書く。修正は actions の中から選び、必要なら新しいプロンプトやナレーションを具体的に書く。
- 画像や動画の作り直しは費用がかかるので、ナレーションの手直しや動きの変更で直るならそちらを優先する。
${last ? '- これが最後のチェック。直せる余地が小さいなら、現状で公開できるかどうかをはっきり判断する。' : `- これは${round}回目のチェック。`}`,
    content,
  });
}

async function qcLoop() {
  const maxRounds = Math.max(1, +P.cur.brief.qcRounds || 3);
  for (let r = 1; r <= maxRounds; r++) {
    check();
    ui.log('claude', `完成版を通しでチェックしています（${r}回目）…`, 'work');
    const qc = await qcOnce(r, r === maxRounds);
    check();
    P.cur.verdict = { approved: !!qc.approved, score: qc.score | 0, summary: qc.summary || '', round: r };
    if (qc.approved) {
      P.cur.approved = true;
      ui.log('claude', `OK です（${qc.score}点）。${qc.summary}`, 'approve');
      ui.update(); await ui.save();
      return true;
    }
    ui.log('claude', `まだ公開できません（${qc.score}点）。${qc.summary}`, 'reject');
    ui.update();
    if (r === maxRounds) break;
    if (!qc.fixes || !qc.fixes.length) break;
    await applyFixes(qc.fixes);
  }
  await ui.save();
  return false;
}

export async function run(callbacks, abortSignal) {
  ui = { ...ui, ...callbacks }; signal = abortSignal;
  const pr = P.cur;
  pr.approved = false;
  try {
    if (!pr.plan || !pr.scenes.length) { ui.stage('plan'); await planStep(); }
    ui.stage('images'); await imageLoop();
    ui.stage('videos'); await videoLoop();
    ui.stage('voice'); await voiceStep();
    ui.stage('direct'); if (!P.cur.directed) await directStep();
    ui.stage('qc'); const ok = await qcLoop();
    ui.stage(ok ? 'done' : 'unapproved');
    if (!ok) ui.log('system', 'Claudeの承認は出ませんでした。編集タブで手直しして「もう一度チェック」するか、そのまま書き出すこともできます。', 'warn');
    return ok;
  } catch (e) {
    if (e instanceof StopError || e.name === 'AbortError') { ui.stage('stopped'); ui.log('system', '停止しました。「続きから再開」で途中から続けられます。', 'info'); }
    else if (e instanceof BudgetError) { ui.stage('stopped'); ui.log('system', e.message, 'warn'); }
    else { console.error(e); ui.stage('error'); ui.log('system', 'エラーで止まりました: ' + (e.message || e) + '。「続きから再開」で途中から続けられます。', 'error'); }
    await ui.save();
    return false;
  }
}

// Re-run only the final check (after manual edits).
// Ask Claude to redo telop styling and transitions only.
export async function redirect(callbacks, abortSignal) {
  ui = { ...ui, ...callbacks }; signal = abortSignal;
  try { ui.stage('direct'); await directStep(); P.cur.approved = false; ui.stage('unapproved'); return true; }
  catch (e) {
    if (e instanceof StopError || e.name === 'AbortError') ui.stage('stopped');
    else { ui.stage('error'); ui.log('system', 'エラー: ' + (e.message || e), 'error'); }
    await ui.save(); return false;
  }
}

export async function recheck(callbacks, abortSignal) {
  ui = { ...ui, ...callbacks }; signal = abortSignal;
  try {
    P.cur.approved = false;
    await voiceStep();
    if (!P.cur.directed) { ui.stage('direct'); await directStep(); }
    ui.stage('qc'); const ok = await qcLoop();
    ui.stage(ok ? 'done' : 'unapproved');
    return ok;
  } catch (e) {
    if (e instanceof StopError || e.name === 'AbortError') ui.stage('stopped');
    else { ui.stage('error'); ui.log('system', 'エラー: ' + (e.message || e), 'error'); }
    await ui.save(); return false;
  }
}
export function bindUi(callbacks, abortSignal) { ui = { ...ui, ...callbacks }; signal = abortSignal; }
