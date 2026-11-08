// IndexedDB(端末内の保存場所)の薄い道具。教材データ(pack)と個人データ(その他)を別の入れ物に分けている。
// VER=2: 要確認の対応状態(review)と、端末内に取り込んだ教材PDF(files)の入れ物を追加。
// 既存の入れ物は「無ければ作る」だけなので、VER=1 で保存した学習記録はそのまま残る。
// 接続まわりの堅牢化(2026-11-08): 別タブや新しい版のコードが上位版を開いたら自接続を閉じて張り直す(onversionchange)、
// 開くのがブロックされたら利用者へ案内できるようイベントを出す(onblocked)、開くのに失敗したら失敗を抱え込まない。
const NAME = 'kansa', VER = 2;
const STORES = ['pack', 'progress', 'checks', 'notes', 'attempts', 'settings', 'review', 'files'];
let dbp = null;
function open() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open(NAME, VER);
      r.onupgradeneeded = () => { STORES.forEach(s => r.result.objectStoreNames.contains(s) || r.result.createObjectStore(s)); };
      r.onsuccess = () => {
        const c = r.result;
        // 別の場所(タブ/新しい版)が上位の版を開こうとしたら、この接続は閉じて手放す。
        // 次に使うとき open() が張り直すので、「接続が閉じかけ」のまま操作して失敗し続けることがない。
        c.onversionchange = () => { try { c.close(); } catch { /* 既に閉じている等は無視 */ } if (dbp) dbp = null; };
        c.onclose = () => { if (dbp) dbp = null; };
        res(c);
      };
      r.onerror = () => rej(r.error);
      // 旧版の接続が開いたまま等でブロックされたら、待ち続けるだけでなく画面へ知らせる(main.js が案内表示する)。
      r.onblocked = () => { try { globalThis.dispatchEvent(new Event('kansa-db-blocked')); } catch { /* 通知できなくても待ち自体は続く */ } };
    });
    // 失敗した Promise を抱え続けると以後の操作が全部失敗するので、失敗時は手放して次回張り直せるようにする。
    // (成功した接続は従来どおり使い回す。利用側が掴んでいる Promise 自体の挙動は変わらない)
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}
// 接続が閉じかけ/閉じたタイミングと重なった操作は、接続を開き直して1回だけやり直す(際限なく繰り返さない)。
const isClosing = e => !!e && e.name === 'InvalidStateError' && /closing|closed/i.test(String(e.message || ''));
async function runTx(s, mode, fn) {
  for (let attempt = 0; ; attempt++) {
    const d = await open();
    try {
      const t = d.transaction(s, mode);
      return await new Promise((res, rej) => { const out = fn(t.objectStore(s)); t.oncomplete = () => res(out.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('transaction aborted')); });
    } catch (e) {
      if (attempt === 0 && isClosing(e)) { if (dbp) dbp = null; continue; }
      throw e;
    }
  }
}
const tx = (s, mode, fn) => runTx(s, mode, fn);
export const get = (s, k) => tx(s, 'readonly', st => st.get(k));
export const put = (s, k, v) => tx(s, 'readwrite', st => st.put(v, k));
export const del = (s, k) => tx(s, 'readwrite', st => st.delete(k));
export const clear = s => tx(s, 'readwrite', st => st.clear());
export async function all(s) {
  for (let attempt = 0; ; attempt++) {
    const d = await open();
    try {
      return await new Promise((res, rej) => { const o = {}; const t = d.transaction(s, 'readonly'); const c = t.objectStore(s).openCursor();
        c.onsuccess = () => { const cur = c.result; if (cur) { o[cur.key] = cur.value; cur.continue(); } else res(o); }; c.onerror = () => rej(c.error); t.onabort = () => rej(t.error || new Error('transaction aborted')); });
    } catch (e) {
      if (attempt === 0 && isClosing(e)) { if (dbp) dbp = null; continue; }
      throw e;
    }
  }
}
// バックアップ対象の個人データ。files(取り込んだ教材PDF本体)は教材そのものなので含めない(端末ごとに取り込み直す)。
export const PERSONAL = ['progress', 'checks', 'notes', 'attempts', 'settings', 'review'];
