// IndexedDB(端末内の保存場所)の薄い道具。教材データ(pack)と個人データ(その他)を別の入れ物に分けている。
// VER=2: 要確認の対応状態(review)と、端末内に取り込んだ教材PDF(files)の入れ物を追加。
// 既存の入れ物は「無ければ作る」だけなので、VER=1 で保存した学習記録はそのまま残る。
const NAME = 'kansa', VER = 2;
const STORES = ['pack', 'progress', 'checks', 'notes', 'attempts', 'settings', 'review', 'files'];
let dbp;
function open() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open(NAME, VER);
    r.onupgradeneeded = () => { STORES.forEach(s => r.result.objectStoreNames.contains(s) || r.result.createObjectStore(s)); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
const tx = async (s, mode, fn) => { const d = await open(); return new Promise((res, rej) => { const t = d.transaction(s, mode); const out = fn(t.objectStore(s)); t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); }); };
export const get = (s, k) => tx(s, 'readonly', st => st.get(k));
export const put = (s, k, v) => tx(s, 'readwrite', st => st.put(v, k));
export const del = (s, k) => tx(s, 'readwrite', st => st.delete(k));
export const clear = s => tx(s, 'readwrite', st => st.clear());
export async function all(s) {
  const d = await open();
  return new Promise((res, rej) => { const o = {}; const t = d.transaction(s, 'readonly'); const c = t.objectStore(s).openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { o[cur.key] = cur.value; cur.continue(); } else res(o); }; c.onerror = () => rej(c.error); });
}
// バックアップ対象の個人データ。files(取り込んだ教材PDF本体)は教材そのものなので含めない(端末ごとに取り込み直す)。
export const PERSONAL = ['progress', 'checks', 'notes', 'attempts', 'settings', 'review'];
