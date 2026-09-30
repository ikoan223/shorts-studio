export const VERSION = '2026.09.30-3';
// Settings (per device, localStorage) and the current project.
export const DEF_STYLE = {
  font: 'Noto Sans JP', size: 78, maxChars: 12, pos: 0.66, color: '#ffffff', stroke: '#111111', strokeW: 12,
  box: false, pop: true, hidePeriod: true, fade: 0.25, pad: 0.3, motionAmt: 0.08,
  voiceVol: 1, bgmVol: 0.15, duck: true, res: '1080', fps: '30',
};
export const DEF_SETTINGS = {
  keys: { anthropic: '', openai: '', gemini: '' },
  models: { claude: 'claude-sonnet-5-5', image: 'gpt-image-2.5-flare', tts: 'gemini-3.8-flash-tts', video: 'gemini-omni-1.1-flash' },
  imageQuality: 'medium',
  imageSize: '864x1536',
  // USD estimates; Claude uses real token usage, the rest are per-item estimates
  prices: { claudeIn: 2, claudeOut: 10, image: 0.04, video: 0.5, tts: 0.02 },
  demo: false,
  style: { ...DEF_STYLE },
};
const KEY = 'shortsStudio.settings.v1';

function merge(base, over) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k in over) {
    if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object') out[k] = merge(base[k], over[k]);
    else if (over[k] !== undefined) out[k] = over[k];
  }
  return out;
}
function load() {
  try { return merge(DEF_SETTINGS, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (e) { return merge(DEF_SETTINGS, {}); }
}
export const S = load();
export function saveSettings() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }

let uid = Date.now() % 1e6;
export const nextId = () => ++uid;

export const P = { cur: null };

export function newProject(brief) {
  P.cur = {
    id: 'p' + Date.now(),
    createdAt: Date.now(),
    brief,
    plan: null,
    scenes: [],
    log: [],
    cost: { usd: 0, claudeIn: 0, claudeOut: 0, images: 0, videos: 0, ttsChars: 0 },
    stage: 'idle',
    approved: false,
    verdict: null,
    bgm: null,
  };
  return P.cur;
}

export function newScene(fields = {}) {
  return {
    id: nextId(),
    narration: '', image_prompt: '', video_prompt: '', visual: 'image', motion: 'zoom_in', focus: { x: 0.5, y: 0.45 },
    voiceStyle: '',
    img: null, imgBlob: null, thumb: '', blur: null, imgStatus: 'pending', imgAttempts: 0, reviewed: false, needsRegen: false,
    video: null, videoBlob: null, videoStatus: 'none', videoAttempts: 0, videoReviewed: false,
    audio: null, audioBlob: null, audioStatus: 'pending',
    note: '',
    ...fields,
  };
}
