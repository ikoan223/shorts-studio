// Keeps the current project (including generated images, clips and voices) in IndexedDB on this device.
import { P, newScene } from './state.js?v=2026.09.30-5';
import { setImageBlob, setAudioBlob, setVideoBlob } from './pipeline.js?v=2026.09.30-5';
import { decodeAudio } from './render.js?v=2026.09.30-5';

const DB = 'shorts-studio', ST = 'kv';
let dbp = null;
function db() {
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function put(key, val) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(ST, 'readwrite'); tx.objectStore(ST).put(val, key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }
async function get(key) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(ST, 'readonly'); const q = tx.objectStore(ST).get(key); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
async function del(key) { const d = await db(); return new Promise((res, rej) => { const tx = d.transaction(ST, 'readwrite'); tx.objectStore(ST).delete(key); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }

const RUNTIME = new Set(['img', 'thumb', 'blur', 'video', 'audio']);
let saving = Promise.resolve();
export function saveProject() {
  const pr = P.cur; if (!pr) return Promise.resolve();
  const data = {
    ...pr,
    bgm: pr.bgm ? { name: pr.bgm.name, blob: pr.bgm.blob, id: pr.bgm.id } : null,
    scenes: pr.scenes.map(s => { const o = {}; for (const k in s) if (!RUNTIME.has(k)) o[k] = s[k]; return o; }),
  };
  saving = saving.then(() => put('current', data)).catch(e => console.warn('save failed', e));
  return saving;
}
export async function loadProject() {
  let data; try { data = await get('current'); } catch (e) { return null; }
  if (!data) return null;
  const pr = { ...data, scenes: [] };
  for (const o of data.scenes) {
    const s = newScene({ ...o, img: null, thumb: '', blur: null, video: null, audio: null });
    try { if (o.imgBlob) await setImageBlob(s, o.imgBlob); } catch (e) { s.imgBlob = null; s.imgStatus = 'pending'; }
    try { if (o.audioBlob) await setAudioBlob(s, o.audioBlob); } catch (e) { s.audioBlob = null; s.audioStatus = 'pending'; }
    try { if (o.videoBlob) await setVideoBlob(s, o.videoBlob); } catch (e) { s.videoBlob = null; s.videoStatus = 'none'; if (s.visual === 'video') s.visual = 'image'; }
    for (const k of ['imgStatus', 'audioStatus', 'videoStatus']) if (s[k] === 'generating') s[k] = 'pending';
    pr.scenes.push(s);
  }
  if (data.bgm && data.bgm.blob) { try { pr.bgm = { ...data.bgm, buffer: await decodeAudio(data.bgm.blob) }; } catch (e) { pr.bgm = null; } }
  return pr;
}
export async function clearProject() { try { await del('current'); } catch (e) {} }
