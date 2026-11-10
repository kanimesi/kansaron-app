import * as db from './db.js';
import { readZip } from './zip.js';
import { extractAnki } from './anki.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = ['未学習', '学習中', '理解済み', '想起可能', '答案作成可能'];
const EVAL = ['◎', '○', '△', '×'];
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const badge = i => `<span class="badge b-${i === 'A' || i === 'B' || i === 'C' ? i : 'x'}">${esc(i === '-' ? '－' : i)}</span>`;

// ---------- 教材データ(読み取り専用)と個人データ ----------
const D = { ready: false, cl: {}, st: {} };
let PR = {}, CK = {}, NT = {}, AT = {}, SET = {}, RV = {}, PDFS = {};
// 検証状態(論点ごと・本人の確認)。初期値は一律「実装済み」。内容を確認した本人が「検証済み」に上げる。
const VSTATE = ['実装済み', '検証済み'];
const vstate = id => PR[id]?.vstate || '実装済み';
// 「PDFを選ぶ」で押された巻の受け渡し用(モジュール変数のみで受け渡す)。
// iOS Safari は「ボタンを押した直後の同期的処理」でないとファイル選択を開かないため、
// クリック→ input.click() の間に await(DB書き込み等)を挟んではいけない。
let pdfPickBook = null;
// 端末内に取り込んだ教材PDF(files store)。Input原文の章で使う巻と、過去問(Output)用。
const PDF_BOOKS = [
  { key: 'input1', label: 'Input編1（上巻・第1〜3章）' },
  { key: 'input2', label: 'Input編2（下巻・第4〜10章）' },
  { key: 'output', label: 'Output編（過去問TRIAL）' },
  { key: 'shin', label: 'シン・論文まとめ' },
];
const pdfForChapter = ch => (ch <= 3 ? 'input1' : 'input2');
let pdfUrls = {};   // 取り込み済みPDFの Blob URL(この起動の間だけ有効)
let figUrls = {};   // §3.1-3: Input差し込み画像(img/*.webp)の Blob URL。起動中だけ有効で、同じ src はキャッシュして再利用する。起動時に一括生成はしない

async function loadAll() {
  D.manifest = await db.get('pack', 'manifest.json');
  D.ready = !!D.manifest;
  if (D.ready) {
    D.structure = await db.get('pack', 'structure.json');
    D.exams = await db.get('pack', 'exams.json');
    D.links = await db.get('pack', 'links.json');
    D.review = (await db.get('pack', 'review.json')) || [];
    D.items = D.structure.items;
    D.byId = Object.fromEntries(D.items.map(i => [i.id, i]));
  }
  [PR, CK, NT, AT, SET, RV] = await Promise.all(['progress', 'checks', 'notes', 'attempts', 'settings', 'review'].map(db.all));
  PDFS = await db.all('files');
  for (const k of Object.keys(pdfUrls)) URL.revokeObjectURL(pdfUrls[k]);
  pdfUrls = {};
  for (const [k, v] of Object.entries(PDFS)) if (v?.blob) pdfUrls[k] = URL.createObjectURL(v.blob);
  // §3.1-3: パック再取り込み時(loadAll)は、教材PDF用URLと同様に差し込み画像URLも失効させる
  for (const k of Object.keys(figUrls)) { try { URL.revokeObjectURL(figUrls[k]); } catch { /* 失効できないURLは無視 */ } }
  figUrls = {};
}
// §3.1-3: 頁を開いたときに、その頁の fig 分だけ pack store から Blob を取得して URL を作る(起動時一括生成はしない)
async function figUrl(src) {
  if (!src) return null;
  if (figUrls[src]) return figUrls[src];
  let v = null;
  try { v = await db.get('pack', src); } catch { return null; }
  if (!v) return null;
  let blob = null;
  if (typeof Blob !== 'undefined' && v instanceof Blob) blob = v;
  else if (v instanceof Uint8Array) blob = new Blob([v], { type: 'image/webp' });
  else if (v instanceof ArrayBuffer) blob = new Blob([v], { type: 'image/webp' });
  else if (v?.blob instanceof Blob) blob = v.blob; // 念のための包み形式(通常は Blob そのものが入っている)
  else return null;
  try { figUrls[src] = URL.createObjectURL(blob); } catch { return null; }
  return figUrls[src];
}
// PDFを開く。ページ指定(#page=)は端末のPDFビューアが対応している場合だけ効く(効かない場合は先頭から開く)。
function openPdf(bookKey, page) {
  const u = pdfUrls[bookKey];
  if (!u) return;
  window.open(page ? `${u}#page=${page}` : u, '_blank');
}
async function chapterPages(ch) { return D.st[ch] ||= (await db.get('pack', `sourcetexts-input-ch${ch}.json`)) || []; }
async function chapterChecklist(ch) { return D.cl[ch] ||= (await db.get('pack', `checklist-ch${ch}.json`)) || []; }
const prog = id => PR[id] || { status: '未学習', understand: 0, writing: 0 };
async function saveProg(id, patch) { PR[id] = { ...prog(id), ...patch, updatedAt: new Date().toISOString() }; await db.put('progress', id, PR[id]); }

// ---------- 画面の共通部品 ----------
function setTitle(t, back) { $('#title').textContent = t; const b = $('#back'); b.hidden = !back; b.onclick = () => (typeof back === 'string' ? (location.hash = back) : history.back()); }
function setTab(t) { document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('on', a.dataset.t === t)); }
const seg = (name, opts, cur) => `<div class="seg">${opts.map(o => `<button data-act="seg" data-name="${name}" data-v="${esc(o)}" class="${String(o) === String(cur) ? 'on' : ''}">${esc(o)}</button>`).join('')}</div>`;
const needPack = () => `<div class="card"><h2>最初に教材データを取り込みます</h2><p>「メニュー」タブ →「教材データの取り込み」で、先ほどお送りした <b>kansa-datapack-phase3-all.zip</b> を選んでください。</p><a class="btn" href="#/menu">メニューへ</a></div>`;

// ---------- ホーム ----------
async function home() {
  setTitle('ホーム'); setTab('home');
  if (!D.ready) return needPack();
  const cnt = Object.fromEntries(STATUS.map(s => [s, 0]));
  D.items.forEach(i => cnt[prog(i.id).status]++);
  const total = D.items.length, done = total - cnt['未学習'];
  let rec = 0, recTotal = 0;
  for (let c = 1; c <= 10; c++) { const rows = await chapterChecklist(c); recTotal += rows.length; rows.forEach(r => CK[r.id]?.recalled && rec++); }
  // 今日の学習メニュー(理由つき)
  const menu = [];
  const last = SET.last;
  if (last) menu.push({ href: `#/input/p/${last.printed}`, t: `続きから: Input ${last.printed}`, why: '前回ここまで読みました' });
  D.items.filter(i => prog(i.id).status === '学習中').slice(0, 3).forEach(i => menu.push({ href: `#/ron/t/${i.id}`, t: `${i.no} ${i.title}`, why: '「学習中」のままです' }));
  D.items.filter(i => { const p = prog(i.id); return p.reviewDate && p.reviewDate <= today(); }).slice(0, 5).forEach(i => menu.push({ href: `#/ron/t/${i.id}`, t: `${i.no} ${i.title}`, why: `復習予定日(${prog(i.id).reviewDate})になりました` }));
  Object.entries(AT).forEach(([id, arr]) => { const a = arr[arr.length - 1]; if (a && a.subs.some(s => s.eval === '×')) menu.push({ href: `#/output/e/${id}`, t: `過去問 ${id}`, why: '直近の演習で×がありました' }); });
  D.items.filter(i => i.importance === 'A' && prog(i.id).status === '未学習').slice(0, 3).forEach(i => menu.push({ href: `#/ron/t/${i.id}`, t: `${i.no} ${i.title}`, why: '重要度A(教材の値)で未学習です' }));
  const uniq = []; const seen = new Set(); menu.forEach(m => { if (!seen.has(m.href + m.why)) { seen.add(m.href + m.why); uniq.push(m); } });
  const rvTotal = (D.review || []).length, rvOpen = (D.review || []).filter(r => !RV[r.id]?.done).length;
  const vsDone = D.items.filter(i => vstate(i.id) === '検証済み').length;
  return `
  <div class="card"><h2>学習の進み(論点 ${total} 項目)</h2>
    <div class="bar"><div style="width:${(done / total * 100).toFixed(1)}%"></div></div>
    <p class="muted">着手済み ${done} / ${total}　${STATUS.map(s => `<span class="chip">${s} ${cnt[s]}</span>`).join('')}</p>
    <p class="muted">論点リストの想起チェック: ${rec} / ${recTotal}</p>
    <p class="muted">論点の検証: 検証済み ${vsDone} / ${total}（<a href="#/ron/v">検証画面へ</a>）</p>
    ${rvTotal ? `<p class="muted">要確認: 未対応 ${rvOpen} / ${rvTotal}件（<a href="#/review">要確認画面へ</a>）</p>` : ''}</div>
  <div class="card"><h2>今日の学習メニュー</h2>
    ${uniq.length ? uniq.slice(0, 10).map(m => `<a class="row" href="${m.href}"><div class="main">${esc(m.t)}<div class="sub">理由: ${esc(m.why)}</div></div>›</a>`).join('') : '<p class="muted">まだ記録がありません。Inputを開くと、ここに続きが表示されます。</p>'}
    <p class="muted">※候補の目安です。やる順番は自由に決めてください。</p></div>
  <div class="card"><h2>学習サイクル(教材の流れ)</h2><p class="muted">Input → 論点リストで想起 → Output過去問 → 模範解答と比較 → Inputで復習 → 再想起</p></div>`;
}

// ---------- Input ----------
async function input(args) {
  setTab('input');
  if (!D.ready) { setTitle('Input'); return needPack(); }
  if (args[0] === 'p') return inputPage(args[1]);
  if (args[0] === 'ch') return inputChapter(+args[1]);
  setTitle('Input(教材原文)');
  return D.structure.chapters.map(c => {
    const its = D.items.filter(i => i.ch === c.ch); const d = its.filter(i => prog(i.id).status !== '未学習').length;
    return `<a class="row" href="#/input/ch/${c.ch}"><div class="main">第${c.ch}章 ${esc(c.title)}<div class="sub">${its.length}項目 ・ 着手 ${d}</div></div>›</a>`;
  }).join('');
}
async function inputChapter(ch) {
  const c = D.structure.chapters.find(x => x.ch === ch); setTitle(`第${ch}章 ${c.title}`, '#/input');
  let h = '';
  for (const s of D.structure.sections.filter(s => s.ch === ch)) {
    h += `<h3 style="color:var(--navy);margin:14px 0 6px">第${s.sec}節 ${esc(s.title)}</h3>`;
    h += D.items.filter(i => i.ch === ch && i.sec === s.sec).map(i => { const p = prog(i.id); return `<a class="row" href="#/input/p/${i.inputPage}"><span>${badge(i.importance)}</span><div class="main">${i.no} ${esc(i.title)}<div class="sub">${i.inputPage}頁〜 <span class="chip st-${p.status}">${p.status}</span></div></div>›</a>`; }).join('');
  }
  return h;
}
// ---------- Input原文の表・図差し込み(仕様 §3.2/§3.3) ----------
// 整形表示(rawView 偽)かつ tables/figs がある頁だけが対象。「そのまま表示」では一切出さない(§3.4)。
// text/raw 自体は一切変えない(二重表示は U3 で受け入れ済み)。
function collectInserts(pg) {
  const out = [];
  if (Array.isArray(pg.tables)) for (const t of pg.tables) {
    if (!t || typeof t.html !== 'string' || !t.html) continue; // §3.3: html が空・欠落なら読み飛ばす
    out.push({ kind: 'table', entry: t, order: Number.isFinite(+t.order) ? +t.order : out.length });
  }
  if (Array.isArray(pg.figs)) for (const f of pg.figs) {
    if (!f) continue;
    out.push({ kind: 'fig', entry: f, order: Number.isFinite(+f.order) ? +f.order : out.length });
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}
function insertCaption(ins, atTail) {
  const e = ins.entry;
  let cap;
  if (ins.kind === 'table') {
    const flags = Array.isArray(e.flags) ? e.flags : [];
    // §3.2/U8: 注記は header-split のみ。punct-float のみ等では警告を出さない
    cap = flags.includes('header-split') ? '表（原文から再構成）※見出し行は原本と見比べてください' : '表（原文から再構成）';
  } else {
    cap = e.kind === 'table' ? '表（原文の画像）' : '図（原文の画像）';
    if (e.alt) cap += ' ' + e.alt;
  }
  if (atTail) cap += '（原本での位置が特定できなかったため、頁の末尾に表示しています）';
  return cap;
}
async function renderInsert(ins, urls, atTail) {
  const e = ins.entry, cap = insertCaption(ins, atTail);
  if (ins.kind === 'table') {
    // §3.2: 表 html は自生成データのためエスケープせず、横スクロール可能なラッパーにそのまま挿入する
    return `<div class="insert"><div class="tbl-wrap">${e.html}</div><p class="insert-cap">${esc(cap)}</p></div>`;
  }
  const url = e.src ? urls[e.src] : null;
  if (!url) {
    // §3.3: Blob が無い場合は画面全体を落とさず、alt＋取り込み直しの案内枠を出す
    return `<div class="insert"><div class="fig-missing"><p>${esc(e.alt || '図表')}</p><p>画像が取り込まれていません。教材データを改訂3以降で取り込み直してください</p></div><p class="insert-cap">${esc(cap)}</p></div>`;
  }
  return `<div class="insert"><img class="fig-img" data-act="fig-zoom" src="${esc(url)}" alt="${esc(e.alt || '')}"><p class="insert-cap">${esc(cap)}</p></div>`;
}
async function buildFormattedBody(pg) {
  const text = String(pg.text ?? '');
  const inserts = collectInserts(pg);
  if (!inserts.length) return `<div class="src">${esc(text)}</div>`;
  // この頁の fig 分だけ Blob URL を用意する(§3.1-3)
  const urls = {};
  for (const ins of inserts) if (ins.kind === 'fig' && ins.entry.src && !(ins.entry.src in urls)) urls[ins.entry.src] = await figUrl(ins.entry.src);
  // §3.3: カーソル方式。order 順に、前回位置より後ろから前方検索する(afterOccurrence 対応)
  const resolved = [], tail = [];
  let cursor = 0;
  for (const ins of inserts) {
    const e = ins.entry, after = typeof e.after === 'string' ? e.after : null;
    if (after === '' && e.position === 'top') { resolved.push({ ins, pos: 0 }); continue; }
    if (!after) { tail.push(ins); continue; }
    const want = Number.isInteger(e.afterOccurrence) && e.afterOccurrence >= 0 ? e.afterOccurrence : 0;
    let pos = cursor, found = -1;
    for (let k = 0; k <= want; k++) {
      const idx = text.indexOf(after, pos);
      if (idx < 0) { found = -1; break; }
      found = idx;
      pos = idx + Math.max(after.length, 1);
    }
    if (found < 0) { tail.push(ins); continue; }
    const at = found + after.length;
    resolved.push({ ins, pos: at });
    if (at > cursor) cursor = at;
  }
  resolved.sort((a, b) => a.pos - b.pos || a.ins.order - b.ins.order);
  const parts = [];
  let prev = 0;
  for (const r of resolved) {
    const frag = text.slice(prev, r.pos);
    if (frag.trim()) parts.push(`<div class="src">${esc(frag)}</div>`);
    parts.push(await renderInsert(r.ins, urls, false));
    prev = r.pos;
  }
  const rest = text.slice(prev);
  if (rest.trim()) parts.push(`<div class="src">${esc(rest)}</div>`);
  for (const ins of tail) parts.push(await renderInsert(ins, urls, true));
  return parts.join('');
}
// §3.6: 拡大表示(オーバーレイ方式)。選んだ理由は報告参照。
// 元の頁は再描画しないので、閉じれば元のスクロール位置のまま戻れる。画像タップで2倍幅に切替でき、
// ビューポートは拡大を禁止していないためピンチズームでも詳細を確認できる。
function openFigZoom(img) {
  closeFigZoom();
  const ov = document.createElement('div');
  ov.className = 'fig-overlay'; ov.id = 'fig-overlay';
  ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true');
  ov.innerHTML = `<button type="button" class="fig-close" aria-label="閉じる">× 閉じる</button><div class="fig-scroll"><img src="${esc(img.getAttribute('src') || '')}" alt="${esc(img.getAttribute('alt') || '')}"></div>`;
  ov.addEventListener('click', ev => {
    if (ev.target.closest('.fig-close')) { closeFigZoom(); return; }
    const im = ev.target.closest('.fig-scroll img');
    if (im) { im.classList.toggle('zoomed'); return; }
    if (ev.target === ov || ev.target.classList.contains('fig-scroll')) closeFigZoom();
  });
  document.body.appendChild(ov);
}
function closeFigZoom() { document.getElementById('fig-overlay')?.remove(); }

async function inputPage(printed) {
  // 教材ページ番号の先頭は丸数字（①〜⑩）なので、章番号は丸数字から求める（+printed.split だと NaN になる）
  const ch = '①②③④⑤⑥⑦⑧⑨⑩'.indexOf(printed[0]) + 1; const pages = await chapterPages(ch); const idx = pages.findIndex(p => p.printed === printed);
  if (idx < 0) { setTitle('Input', '#/input'); return '<p>頁が見つかりません。</p>'; }
  const pg = pages[idx]; const raw = SET.rawView;
  SET.last = { printed }; db.put('settings', 'last', SET.last);
  setTitle(`Input ${printed}`, `#/input/ch/${ch}`);
  const here = D.items.filter(i => i.inputPage === printed);
  const nt = NT['page:' + printed] || '';
  const book = pdfForChapter(ch), hasPdf = !!PDFS[book]?.blob;
  // §3.2/§3.4: 整形表示のときだけ差し込みを組み立てる。そのまま表示(raw)では現行どおり1ブロックで差し込みなし
  const hasInserts = !raw && ((Array.isArray(pg.tables) && pg.tables.length) || (Array.isArray(pg.figs) && pg.figs.length));
  const bodyHtml = raw ? `<div class="src">${esc(pg.raw)}</div>` : hasInserts ? await buildFormattedBody(pg) : `<div class="src">${esc(pg.text)}</div>`;
  return `
  ${here.map(i => `<div class="card"><div>${badge(i.importance)} <b>${i.no} ${esc(i.title)}</b> <span class="muted">(重要度は教材の値)</span></div>
    ${i.importanceNotes?.length ? `<div class="warn">${i.importanceNotes.map(esc).join('<br>')}</div>` : ''}
    <div class="seg" style="margin-top:8px">${STATUS.map(s => `<button data-act="status" data-id="${i.id}" data-v="${s}" class="${prog(i.id).status === s ? 'on' : ''}">${s}</button>`).join('')}</div>
    <a class="btn sub" href="#/ron/t/${i.id}">論点の詳細</a></div>`).join('')}
  <div class="pager"><a class="btn sub" href="${idx > 0 ? '#/input/p/' + pages[idx - 1].printed : '#/input/ch/' + ch}">‹ 前</a><a class="btn sub" href="${idx < pages.length - 1 ? '#/input/p/' + pages[idx + 1].printed : '#/input/ch/' + ch}">次 ›</a></div>
  <div class="card"><h2>原本PDFで見る</h2>
  ${hasPdf ? `<p class="muted">この頁は ${esc(PDF_BOOKS.find(b => b.key === book).label)} のPDF ${pg.pdf}頁です。開いた先でページ指定が効かない端末では、先頭から開きます（その場合は ${pg.pdf}頁へ移動してください）。</p><button class="btn" data-act="open-pdf" data-book="${book}" data-page="${pg.pdf}">PDF ${pg.pdf}頁を開く</button>`
    : `<p class="muted">まだ教材PDFが取り込まれていません。「メニュー」→「教材PDFの取り込み」で ${esc(PDF_BOOKS.find(b => b.key === book).label)} のPDFを取り込むと、この頁を原本のまま開けます。</p><a class="btn sub" href="#/menu">メニューへ</a>`}</div>
  <p><span class="label">教材原文</span><span class="muted">${printed}(PDF ${pg.pdf}頁)・${idx + 1}/${pages.length}</span>
  <button class="btn sub" data-act="rawtoggle" style="float:right;margin:0;padding:4px 10px;font-size:13px">${raw ? '整形表示へ' : 'そのまま表示'}</button></p>
  ${bodyHtml}
  <p class="muted">※抽出テキストです。図表は崩れることがあります。正確さが必要なときは原本PDFで確認してください。</p>
  <div class="card"><h2><span class="label ai" style="background:var(--navy)">自分のメモ</span></h2><textarea data-act="note" data-key="page:${printed}" placeholder="この頁のメモ">${esc(nt)}</textarea></div>
  <div class="pager"><a class="btn sub" href="${idx > 0 ? '#/input/p/' + pages[idx - 1].printed : '#/input/ch/' + ch}">‹ 前</a><a class="btn sub" href="${idx < pages.length - 1 ? '#/input/p/' + pages[idx + 1].printed : '#/input/ch/' + ch}">次 ›</a></div>`;
}

// ---------- 論点 ----------
const F = { ch: '全部', imp: '全部', st: '全部', mode: '項目', cch: 1, vst: '全部' };
async function ron(args) {
  setTab('ron');
  if (!D.ready) { setTitle('論点'); return needPack(); }
  if (args[0] === 't') return topic(args[1]);
  if (args[0] === 'v') return verifyView();
  setTitle('論点');
  let h = `<p style="margin:0 0 8px"><a class="btn sub" href="#/ron/v">🔎 検証画面（実装済み → 検証済み）</a></p>` + seg('mode', ['項目', '想起チェック'], F.mode);
  if (F.mode === '想起チェック') {
    h += `<p></p>` + seg('cch', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], F.cch).replace(/>(\d+)</g, '>第$1章<');
    const rows = await chapterChecklist(F.cch); let lastG = null, lastS = null;
    h += `<p class="muted">論点リスト(第${F.cch}章 ${rows.length}行)。思い出せたらチェック。※重要度・見出しは教材のとおりです。</p>`;
    for (const r of rows) {
      if (r.section !== lastS) { lastS = r.section; lastG = null; h += `<h3 style="color:var(--navy);margin:14px 0 4px">第${r.section}節</h3>`; }
      if (r.group !== lastG) { lastG = r.group; if (r.group) h += `<div class="muted" style="margin-top:8px"><b>${esc(r.group)}</b></div>`; }
      const on = !!CK[r.id]?.recalled;
      h += `<label class="chk"><input type="checkbox" data-act="ck" data-id="${r.id}" ${on ? 'checked' : ''}><div class="main">${badge(r.importance)} ${r.context?.length ? `<span class="muted">${esc(r.context.join(' › '))} › </span>` : ''}${esc(r.item)}
        <div class="sub">${r.mark ? `<span class="chip">${esc(r.mark)}</span>` : ''}${r.ref ? `<span class="chip">${esc(r.ref)}</span>` : ''}${on ? `想起 ${esc(CK[r.id].at.slice(0, 10))}` : ''}</div></div></label>`;
    }
    return h;
  }
  h += `<p class="muted" style="margin-bottom:2px">章</p>` + seg('ch', ['全部', ...D.structure.chapters.map(c => c.ch)], F.ch);
  h += `<p class="muted" style="margin-bottom:2px">重要度(教材)</p>` + seg('imp', ['全部', 'A', 'B', 'C'], F.imp);
  h += `<p class="muted" style="margin-bottom:2px">状態</p>` + seg('st', ['全部', ...STATUS], F.st) + '<p></p>';
  const list = D.items.filter(i => (F.ch === '全部' || i.ch === +F.ch) && (F.imp === '全部' || i.importance === F.imp) && (F.st === '全部' || prog(i.id).status === F.st));
  h += `<p class="muted">${list.length}件</p>` + list.map(i => { const p = prog(i.id); return `<a class="row" href="#/ron/t/${i.id}">${badge(i.importance)}<div class="main">${i.no} ${esc(i.title)}<div class="sub">第${i.ch}章 ・ <span class="chip st-${p.status}">${p.status}</span> 理解${p.understand}/5 答案${p.writing}/5 ・ <span class="chip">${vstate(i.id)}</span></div></div>›</a>`; }).join('');
  return h;
}
// ---------- 検証画面（論点ごとの検証状態：実装済み → 検証済み） ----------
async function verifyView() {
  setTitle('検証（論点の確認）', '#/ron');
  const total = D.items.length, done = D.items.filter(i => vstate(i.id) === '検証済み').length;
  let h = `<div class="card"><h2>論点の検証状態</h2>
   <div class="bar"><div style="width:${total ? done / total * 100 : 0}%"></div></div>
   <p class="muted">検証済み ${done} / ${total}件（${total ? Math.round(done / total * 100) : 0}%）・ 実装済み ${total - done}件</p>
   <p class="muted">「実装済み」はデータとして収録済みという意味です。内容を確認したら、その論点を「検証済み」に上げてください（状態はこの端末に保存され、バックアップにも含まれます）。</p></div>`;
  h += `<p class="muted" style="margin-bottom:2px">章</p>` + seg('ch', ['全部', ...D.structure.chapters.map(c => c.ch)], F.ch);
  h += `<p class="muted" style="margin-bottom:2px">検証状態</p>` + seg('vst', ['全部', ...VSTATE], F.vst) + '<p></p>';
  const list = D.items.filter(i => (F.ch === '全部' || i.ch === +F.ch) && (F.vst === '全部' || vstate(i.id) === F.vst));
  h += `<p class="muted">${list.length}件</p>` + list.map(i => {
    const v = vstate(i.id);
    return `<div class="row">${badge(i.importance)}<div class="main"><a href="#/ron/t/${i.id}" style="color:inherit;text-decoration:none">${i.no} ${esc(i.title)}</a><div class="sub">第${i.ch}章 ・ ${v === '検証済み' && PR[i.id]?.vAt ? '確認 ' + esc(PR[i.id].vAt.slice(0, 10)) : ''}</div>
     <div class="seg" style="margin-top:6px">${VSTATE.map(s => `<button data-act="vstate" data-id="${i.id}" data-v="${s}" class="${v === s ? 'on' : ''}">${s}</button>`).join('')}</div></div></div>`;
  }).join('');
  return h;
}
async function topic(id) {
  const i = D.byId[id]; setTitle(`${i.no} ${i.title}`, '#/ron');
  const p = prog(id); const pages = await chapterPages(i.ch);
  const a = pages.findIndex(x => x.printed === i.inputPage); const nxt = D.items.filter(x => x.ch === i.ch).map(x => pages.findIndex(y => y.printed === x.inputPage)).filter(n => n > a).sort((x, y) => x - y)[0];
  const range = new Set(pages.slice(a, nxt ?? pages.length).map(x => x.printed));
  const rel = D.links.filter(l => l.ron.some(r => range.has(r.id)));
  const exIds = [...new Set(rel.map(l => l.exam))];
  return `
  <div class="card"><div>${badge(i.importance)} 重要度(教材) ${i.shinImportance && i.shinImportance !== i.importance ? ` / シン: ${i.shinImportance}` : ''}</div>
   ${i.importanceNotes?.length ? `<div class="warn" style="margin-top:6px">${i.importanceNotes.map(esc).join('<br>')}</div>` : ''}
   <p><a class="btn" href="#/input/p/${i.inputPage}">Inputを読む(${i.inputPage})</a></p></div>
  <div class="card"><h2>学習状態</h2>${seg2('status', STATUS, p.status, id)}
   <h2 style="margin-top:12px">検証状態</h2><div class="seg">${VSTATE.map(s => `<button data-act="vstate" data-id="${id}" data-v="${s}" class="${vstate(id) === s ? 'on' : ''}">${s}</button>`).join('')}</div>
   <p class="muted">「実装済み」は収録済みの意味です。内容を確認したら「検証済み」にしてください。</p>
   <h2 style="margin-top:12px">理解度(自己評価 0〜5)</h2>${seg2('understand', [0, 1, 2, 3, 4, 5], p.understand, id)}
   <h2 style="margin-top:12px">答案作成能力(自己評価 0〜5)</h2>${seg2('writing', [0, 1, 2, 3, 4, 5], p.writing, id)}
   <p class="muted">理解度と答案作成能力は別の指標です(自己申告)。</p></div>
  <div class="card"><h2>復習予定日(目安・変更可)</h2>
   <input type="date" data-act="rdate" data-id="${id}" value="${esc(p.reviewDate || '')}" style="font-size:16px;padding:8px;border:1px solid var(--bd);border-radius:10px">
   <p>${[1, 3, 7, 14].map(n => `<button class="btn sub" data-act="rquick" data-id="${id}" data-n="${n}">${n}日後</button>`).join('')}<button class="btn ng" data-act="rquick" data-id="${id}" data-n="0">消す</button></p>
   <p class="muted">日数は一般的な目安で、科学的に決まった値ではありません。自分に合わせて変えてください。</p></div>
  <div class="card"><h2>この論点に関連する過去問(教材の関連論点表より)</h2>${exIds.length ? exIds.map(e => { const x = D.exams.find(y => y.id === e); return `<a class="row" href="#/output/e/${e}"><div class="main">${e} ${esc(x.title || '')}<div class="sub">${esc(x.source || '')}</div></div>›</a>`; }).join('') : '<p class="muted">該当なし(関連づけは下書きです)</p>'}</div>`;
}
const seg2 = (field, opts, cur, id) => `<div class="seg">${opts.map(o => `<button data-act="field" data-field="${field}" data-id="${id}" data-v="${o}" class="${String(o) === String(cur) ? 'on' : ''}">${o}</button>`).join('')}</div>`;

// ---------- Output ----------
async function output(args) {
  setTab('output');
  if (!D.ready) { setTitle('Output'); return needPack(); }
  if (args[0] === 'e') return exam(args[1]);
  setTitle('Output(過去問)');
  let h = '<p class="muted">解答の入力は今回はありません。解いたあとの自己評価だけ記録できます。</p>', cur = 0;
  for (const e of D.exams) {
    if (e.ch !== cur) { cur = e.ch; h += `<h3 style="color:var(--navy);margin:14px 0 6px">第${cur}章 ${esc(D.structure.chapters[cur - 1].title)}</h3>`; }
    const n = (AT[e.id] || []).length;
    h += `<a class="row" href="#/output/e/${e.id}"><div class="main">${e.id} ${esc(e.title || '')}<div class="sub">${esc(e.source || '')}</div><div>${e.subQuestions.map(s => `<span class="chip">${esc((s.sub ? s.sub + ' ' : '') + s.formatLabel)} ${esc(s.star || '')}</span>`).join('')}</div></div>${n ? `<span class="chip">${n}回</span>` : ''}›</a>`;
  }
  return h;
}
async function exam(id) {
  const e = D.exams.find(x => x.id === id); setTitle(`${id} ${e.title || ''}`, '#/output');
  const at = AT[id] || [];
  return `<div class="card"><div class="muted">${esc(e.source || '(出典の自動抽出なし)')}</div>
   ${e.subQuestions.map(s => `<div style="margin-top:6px"><span class="chip">${esc((s.sub || '全体') + (s.part ? '-' + s.part : ''))}</span><span class="chip">${esc(s.formatLabel)}</span><span class="chip">重要度 ${esc(s.star || '?')}</span></div>`).join('')}
   ${e.autoNotes?.length ? `<div class="warn" style="margin-top:8px">${e.autoNotes.map(esc).join('<br>')}</div>` : ''}</div>
  <div class="card"><h2>演習の記録(自己評価)</h2>
   ${e.subQuestions.map((s, k) => `<div style="margin:8px 0"><div class="muted">${esc(s.sub || '全体')}${s.part ? '-' + s.part : ''}</div>${seg('ev' + k, EVAL, '')}</div>`).join('')}
   <textarea id="atmemo" placeholder="気づき・できなかった点"></textarea>
   <button class="btn" data-act="attempt" data-id="${id}" data-n="${e.subQuestions.length}">記録する</button>
   ${at.length ? '<h2 style="margin-top:10px">これまで</h2>' + at.slice().reverse().map(a => `<div class="muted">${esc(a.date)} ${a.subs.map(s => esc(s.eval)).join(' ')} ${esc(a.memo || '')}</div>`).join('') : ''}</div>
  <div class="card"><h2>教材原文(過去問 ${e.pages[0]}〜${e.pages[e.pages.length - 1]}頁)</h2><p class="muted">答案構成の例・模範解答も含みます。まず自分で書いてから開きましょう。</p>
   <button class="btn sub" data-act="open-ex">原文を開く</button><div id="extext"></div>
   ${PDFS.output?.blob ? `<p style="margin-top:8px"><button class="btn" data-act="open-pdf" data-book="output" data-page="${e.pages[0] + 3}">原本PDFで見る（PDF ${e.pages[0] + 3}頁〜）</button></p><p class="muted">開いた先でページ指定が効かない端末では先頭から開きます。その場合は PDF ${e.pages[0] + 3}頁へ移動してください。</p>` : ''}</div>`;
}
// ---------- 要確認（制作時の要確認リスト） ----------
const RF = { st: '全部' };
async function reviewChecks(args) {
  setTab('review'); setTitle('要確認');
  if (!D.ready) return needPack();
  const items = D.review || [];
  if (!items.length) return '<p>要確認データ（review.json）が取り込まれていません。改訂2以降の教材データパックを取り込んでください。</p>';
  const done = items.filter(r => RV[r.id]?.done).length;
  let h = `<div class="card"><h2>要確認リスト（制作時の確認事項）</h2>
   <div class="bar"><div style="width:${items.length ? done / items.length * 100 : 0}%"></div></div>
   <p class="muted">対応済み ${done} / ${items.length}件 ・ 未対応 ${items.length - done}件</p>
   <p class="muted">制作時に記録された確認事項です。内容を見て片づいたら「対応済みにする」を押してください（状態はこの端末に保存され、バックアップにも含まれます）。「制作記録の状態」は制作工程での扱いで、アプリ内の対応とは別です。</p></div>`;
  h += seg('rst', ['全部', '未対応', '対応済み'], RF.st) + '<p></p>';
  const list = items.filter(r => RF.st === '全部' || (RF.st === '対応済み') === !!RV[r.id]?.done);
  let cur = '';
  for (const r of list) {
    if (r.unit !== cur) { cur = r.unit; h += `<h3 style="color:var(--navy);margin:14px 0 6px">${esc(r.unit)}</h3>`; }
    const st = RV[r.id];
    h += `<div class="card"><div><span class="chip">${esc(r.id)}</span>${st?.done ? '<span class="chip" style="background:#e3f4ea;border-color:#a9dcbc">対応済み</span>' : '<span class="chip" style="background:#fff4e0;border-color:#f0cf95">未対応</span>'}<span class="chip">${esc(r.productionState)}</span></div>
     <div style="margin-top:4px"><b>${esc(r.title)}</b></div>
     ${r.detail ? `<div class="sub" style="font-size:13px;color:var(--tx);margin-top:4px">${esc(r.detail)}</div>` : ''}
     ${r.handling ? `<div class="muted" style="margin-top:4px">扱い: ${esc(r.handling)}</div>` : ''}
     ${r.statusNote ? `<div class="muted">状態メモ: ${esc(r.statusNote)}</div>` : ''}
     <div class="muted">出所: ${esc(r.source)}${st?.done && st.at ? ' ・ 対応 ' + esc(st.at.slice(0, 10)) : ''}</div>
     <p><button class="btn ${st?.done ? 'ng' : ''}" data-act="rvdone" data-id="${esc(r.id)}">${st?.done ? '未対応に戻す' : '対応済みにする'}</button></p></div>`;
  }
  if (!list.length) h += '<p>この表示条件の項目はありません。</p>';
  return h;
}

// ---------- メニュー ----------
async function menu(args = []) {
  setTab('menu');
  if (args[0] === 'search') return search();
  if (args[0] === 'review') return review();
  if (args[0] === 'log') return logView();
  if (args[0] === 'anki') return ankiView();
  setTitle('メニュー');
  const m = D.manifest; const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  return `
  <a class="row" href="#/menu/search"><div class="main">🔍 教材検索<div class="sub">Input・過去問・論点リストを横断して検索</div></div>›</a>
  <a class="row" href="#/menu/anki"><div class="main">🌑 暗記マーク集<div class="sub">Inputの🌑が付いた見出しと原文を章ごとに一覧</div></div>›</a>
  <a class="row" href="#/menu/review"><div class="main">🔁 復習リスト<div class="sub">復習予定日の一覧と更新</div></div>›</a>
  <a class="row" href="#/menu/log"><div class="main">📊 学習記録<div class="sub">章ごとの進み・演習の記録</div></div>›</a>
  <div class="card"><h2>教材データの取り込み</h2>
   ${m ? `<p class="muted">取り込み済み: ${esc(m.generatedAt)} 版 / 論点${m.counts.topics}・Input${m.counts.inputPages}頁・過去問${m.counts.exams}問<br>状態: ${esc(m.status)}</p>` : '<p>まだ取り込まれていません。</p>'}
   <input type="file" id="packfile" accept=".zip,.json" multiple class="visually-hidden" aria-hidden="true" tabindex="-1">
   <button class="btn" data-act="pick-pack">ZIP(またはJSON)を選ぶ</button>
   <p class="muted">教材データは、この端末の中だけに保存されます(外部へ送信されません)。</p><div id="packmsg"></div></div>
  <div class="card"><h2>教材PDFの取り込み（原本表示用）</h2>
   <p class="muted">図表や読み順が崩れた頁を原本のまま見るためのものです。お持ちの教材PDFをこの端末の中に取り込みます（外部へ送信されません。PDFはバックアップには含まれないので、端末ごとに取り込んでください）。</p>
   ${PDF_BOOKS.map(b => `<div style="margin:6px 0"><span>${esc(b.label)}</span><br>
     ${PDFS[b.key]?.blob ? `<span class="chip">取り込み済み: ${esc(PDFS[b.key].name || '')}${PDFS[b.key].size ? '（' + Math.round(PDFS[b.key].size / 1024) + 'KB）' : ''}</span> <button class="btn sub" data-act="open-pdf" data-book="${b.key}">開く</button> <button class="btn ng" data-act="del-pdf" data-book="${b.key}">削除</button>`
       : `<button class="btn sub" data-act="pick-pdf" data-book="${b.key}">PDFを選ぶ</button>`}</div>`).join('')}
   <input type="file" id="pdffile" accept="application/pdf,.pdf" class="visually-hidden" aria-hidden="true" tabindex="-1">
   <div id="pdfmsg"></div></div>
  <div class="card"><h2>バックアップ(自分の学習記録)</h2>
   <p class="muted">進捗・チェック・メモ・演習記録・検証状態・要確認の対応状態を1つのファイルに書き出します。端末の保存領域はiOSに消されることがあるため、定期的な書き出しをおすすめします。教材本文と取り込んだPDFは含まれません。</p>
   <button class="btn" data-act="export">書き出す</button>
   <input type="file" id="restorefile" accept=".json" class="visually-hidden" aria-hidden="true" tabindex="-1"><button class="btn sub" data-act="pick-restore">復元する</button><div id="bkmsg"></div></div>
  <div class="card"><h2>保存の安全性</h2><p class="muted">端末の保存を「消されにくく」する申請: ${persisted === null ? '未対応' : persisted ? '許可されています' : 'まだ許可されていません'}</p>
   <button class="btn sub" data-act="persist">申請する</button></div>
  ${m ? `<div class="card"><h2>教材データについての注意</h2><ul class="muted">${m.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}`;
}


// ---------- 教材検索 ----------
const norm = t => t.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
let SIDX;
async function buildIndex() {
  if (SIDX) return SIDX; SIDX = [];
  for (let c = 1; c <= 10; c++) {
    for (const p of await chapterPages(c)) SIDX.push({ k: 'Input', label: `Input ${p.printed}`, href: `#/input/p/${p.printed}`, text: p.text });
    for (const r of await chapterChecklist(c)) SIDX.push({ k: '論点リスト', label: `論点リスト 第${c}章 ${r.group || ''}`, href: '#/ron', text: (r.context || []).join(' ') + ' ' + r.item, cch: c, imp: r.importance });
  }
  for (const e of D.exams) for (const p of e.pageTexts) SIDX.push({ k: '過去問', label: `過去問 ${e.id} ${e.title || ''}`, href: `#/output/e/${e.id}`, text: p.text });
  SIDX.forEach(x => { x.n = norm(x.text); }); return SIDX;
}
async function search() {
  setTitle('教材検索', '#/menu');
  if (!D.ready) return needPack();
  const q = SET.q || '', kind = SET.qk || '全部';
  let out = `<input type="text" id="q" placeholder="例: 職業的懐疑心" value="${esc(q)}"><p></p>${seg('qk', ['全部', 'Input', '論点リスト', '過去問'], kind)}<p class="muted">※過去問の検索結果には、模範解答を含む頁が出ることがあります。</p>`;
  if (q.trim().length >= 2) {
    const nq = norm(q), idx = await buildIndex(); const hits = [];
    for (const x of idx) { if (kind !== '全部' && x.k !== kind) continue; const i = x.n.indexOf(nq); if (i >= 0) hits.push({ x, i }); }
    out += `<p class="muted">${hits.length}件${hits.length > 60 ? '(先頭60件を表示)' : ''}</p>`;
    out += hits.slice(0, 60).map(({ x, i }) => { const flat = x.text.replace(/\s+/g, ''); const j = flat.toLowerCase().indexOf(q.replace(/\s+/g, '').toLowerCase()); const a = Math.max(0, (j >= 0 ? j : i) - 20), snip = flat.slice(a, a + 80 + q.length);
      return `<a class="row" href="${x.href}"><div class="main"><span class="chip">${esc(x.k)}</span>${esc(x.label.replace(x.k, "").trim())}<div class="sub">…${esc(snip)}…</div></div>›</a>`; }).join('');
  } else out += '<p class="muted">2文字以上で検索できます。</p>';
  if (SET.qh?.length) out += `<h3 style="color:var(--navy)">検索履歴</h3><div class="seg">${SET.qh.map(h => `<button data-act="qh" data-v="${esc(h)}">${esc(h)}</button>`).join('')}</div>`;
  return out;
}

// ---------- 復習リスト ----------
async function review() {
  setTitle('復習リスト', '#/menu');
  if (!D.ready) return needPack();
  const t = today(), withDate = D.items.filter(i => prog(i.id).reviewDate).sort((a, b) => prog(a.id).reviewDate.localeCompare(prog(b.id).reviewDate));
  const group = (title, list) => list.length ? `<h3 style="color:var(--navy);margin:14px 0 6px">${title}(${list.length})</h3>` + list.map(i => { const p = prog(i.id); return `<div class="row"><div class="main"><a href="#/ron/t/${i.id}" style="color:inherit;text-decoration:none">${badge(i.importance)} ${i.no} ${esc(i.title)}</a><div class="sub">予定 ${esc(p.reviewDate)} ・ ${p.status}${p.lastReviewed ? ' ・ 前回 ' + esc(p.lastReviewed) : ''}</div>
      <div style="margin-top:6px"><a class="btn sub" style="padding:6px 10px;font-size:13px" href="#/input/p/${i.inputPage}">Input</a>${[3, 7, 14].map(n => `<button class="btn" style="padding:6px 10px;font-size:13px" data-act="reviewed" data-id="${i.id}" data-n="${n}">復習した→${n}日後</button>`).join('')}</div></div></div>`; }).join('') : '';
  const late = withDate.filter(i => prog(i.id).reviewDate < t), now = withDate.filter(i => prog(i.id).reviewDate === t), soon = withDate.filter(i => prog(i.id).reviewDate > t);
  const none = D.items.filter(i => ['理解済み', '想起可能', '答案作成可能'].includes(prog(i.id).status) && !prog(i.id).reviewDate);
  return `<p class="muted">復習予定日は「論点の詳細」で設定します。日数は目安で、自分で変えられます。</p>` + (withDate.length || none.length ? group('期限を過ぎたもの', late) + group('今日', now) + group('これから', soon)
    + (none.length ? `<h3 style="color:var(--navy);margin:14px 0 6px">理解済み以上で予定日が未設定(${none.length})</h3>` + none.slice(0, 30).map(i => `<a class="row" href="#/ron/t/${i.id}"><div class="main">${i.no} ${esc(i.title)}</div>›</a>`).join('') : '') : '<p>まだ復習予定がありません。</p>');
}

// ---------- 学習記録 ----------
async function logView() {
  setTitle('学習記録', '#/menu');
  if (!D.ready) return needPack();
  const rows = D.structure.chapters.map(c => { const its = D.items.filter(i => i.ch === c.ch), n = its.length, d = its.filter(i => prog(i.id).status !== '未学習').length, u = its.filter(i => ['理解済み', '想起可能', '答案作成可能'].includes(prog(i.id).status)).length;
    return `<div class="card"><b>第${c.ch}章 ${esc(c.title)}</b><div class="bar" style="margin:6px 0"><div style="width:${n ? d / n * 100 : 0}%"></div></div><span class="muted">着手 ${d}/${n} ・ 理解済み以上 ${u}</span></div>`; }).join('');
  const att = Object.entries(AT).flatMap(([id, arr]) => arr.map(a => ({ id, ...a }))).sort((a, b) => b.date.localeCompare(a.date));
  const cnt = { '◎': 0, '○': 0, '△': 0, '×': 0 }; att.forEach(a => a.subs.forEach(s => cnt[s.eval]++));
  return `<div class="card"><h2>自己申告(学習状態・理解度)</h2><p class="muted">下の章ごとの進みは、自分で付けた学習状態にもとづく自己申告です。</p></div>${rows}
   <div class="card"><h2>演習の結果(過去問の自己評価)</h2><p class="muted">${att.length}回 ・ ${Object.entries(cnt).map(([k, v]) => k + v).join(' ')}</p>
   ${att.slice(0, 20).map(a => `<a class="row" href="#/output/e/${a.id}"><div class="main">${esc(a.date)} 過去問${a.id}<div class="sub">${a.subs.map(s => s.eval).join(' ')} ${esc(a.memo || '')}</div></div>›</a>`).join('') || '<p class="muted">まだ記録がありません。</p>'}</div>`;
}

// ---------- 暗記マーク集 ----------
let ANKI;
async function ankiAll() { if (ANKI) return ANKI; ANKI = []; for (let c = 1; c <= 10; c++) for (const a of extractAnki(await chapterPages(c))) ANKI.push({ ...a, ch: c, key: `anki:${a.printed}:${a.n}` }); return ANKI; }
async function ankiView() {
  setTitle('暗記マーク集', '#/menu');
  if (!D.ready) return needPack();
  const all = await ankiAll(), ch = SET.ach || '全部', only = SET.aonly || '全部';
  const done = a => !!CK[a.key]?.recalled;
  const list = all.filter(a => (ch === '全部' || a.ch === +ch) && (only === '全部' || !done(a)));
  let h = `<div class="card"><h2>Inputの🌑(暗記マーク) ${all.length}か所</h2><div class="bar"><div style="width:${all.filter(done).length / all.length * 100}%"></div></div>
   <p class="muted">覚えた ${all.filter(done).length} / ${all.length}。見出しをタップすると、その直後の教材原文が開きます(頁内の範囲を機械的に区切っているため、図表の位置によっては前後がずれることがあります)。</p></div>`;
  h += `<p class="muted" style="margin-bottom:2px">章</p>` + seg('ach', ['全部', ...D.structure.chapters.map(c => c.ch)], ch) + `<p></p>` + seg('aonly', ['全部', '未暗記のみ'], only) + `<p class="muted">${list.length}件</p>`;
  let cur = '';
  for (const a of list) {
    if (a.ch !== cur) { cur = a.ch; h += `<h3 style="color:var(--navy);margin:16px 0 6px">第${cur}章 ${esc(D.structure.chapters[cur - 1].title)}</h3>`; }
    h += `<details class="card" style="padding:8px 12px"><summary style="list-style:none;display:flex;gap:10px;align-items:flex-start">
      <input type="checkbox" data-act="ankick" data-key="${a.key}" ${done(a) ? 'checked' : ''} onclick="event.stopPropagation()" style="width:22px;height:22px;margin-top:3px;flex:none">
      <div class="main" style="flex:1;min-width:0">${a.parent && a.parent !== a.heading ? `<div class="sub">${esc(a.parent)}</div>` : ''}<b>🌑 ${esc(a.heading)}</b><div class="sub">Input ${a.printed}${a.ref ? ' ・ ' + esc(a.ref) : ''}</div></div></summary>
      ${a.body ? `<p><span class="label">教材原文</span></p><div class="src">${esc(a.body)}</div>` : '<p class="muted">この見出しの直後に本文がありません(図表や次頁にある場合があります)。頁で確認してください。</p>'}
      <p><a class="btn sub" href="#/input/p/${a.printed}">この頁を開く</a></p></details>`;
  }
  return h;
}

// ---------- イベント ----------
const msg = (id, t) => { const e = $('#' + id); if (e) e.innerHTML = `<p class="muted">${esc(t)}</p>`; };
document.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act;
  if (a === 'seg') { const n = b.dataset.name; if (n === 'ach' || n === 'aonly') { SET[n] = b.dataset.v; await db.put('settings', n, b.dataset.v); return render(); }
    if (n === 'qk') { SET.qk = b.dataset.v; await db.put('settings', 'qk', SET.qk); return render(); }
    if (n === 'rst') { RF.st = b.dataset.v; return render(); }
    if (n.startsWith('ev')) { b.parentElement.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); return; } F[n] = n === 'cch' ? +b.dataset.v.replace(/\D/g, '') : b.dataset.v; return render(); }
  if (a === 'vstate') { const v = b.dataset.v; await saveProg(b.dataset.id, v === '検証済み' ? { vstate: v, vAt: new Date().toISOString() } : { vstate: v, vAt: '' }); return render(); }
  if (a === 'rvdone') { const id = b.dataset.id; const cur = RV[id]?.done; RV[id] = cur ? { done: false } : { done: true, at: new Date().toISOString() }; await db.put('review', id, RV[id]); return render(); }
  if (a === 'pick-pdf') { pdfPickBook = b.dataset.book; return $('#pdffile').click(); }
  if (a === 'open-pdf') { openPdf(b.dataset.book, b.dataset.page ? +b.dataset.page : null); return; }
  if (a === 'del-pdf') { if (!confirm('この端末に取り込んだPDFを削除します。よろしいですか?')) return; await db.del('files', b.dataset.book); await loadAll(); return render(); }
  if (a === 'qh') { SET.q = b.dataset.v; await db.put('settings', 'q', SET.q); return render(); }
  if (a === 'reviewed') { await saveProg(b.dataset.id, { reviewDate: addDays(+b.dataset.n), lastReviewed: today() }); return render(); }
  if (a === 'status') { await saveProg(b.dataset.id, { status: b.dataset.v }); return render(); }
  if (a === 'field') { await saveProg(b.dataset.id, { [b.dataset.field]: isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v }); return render(); }
  if (a === 'rquick') { const n = +b.dataset.n; await saveProg(b.dataset.id, { reviewDate: n ? addDays(n) : '' }); return render(); }
  if (a === 'rawtoggle') { SET.rawView = !SET.rawView; await db.put('settings', 'rawView', SET.rawView); return render(); }
  if (a === 'fig-zoom') { openFigZoom(b); return; }
  if (a === 'pick-pack') return $('#packfile').click();
  if (a === 'pick-restore') return $('#restorefile').click();
  if (a === 'persist') { const ok = await navigator.storage?.persist?.(); alert(ok ? '許可されました' : '許可されませんでした(ホーム画面に追加すると通りやすくなります)'); return render(); }
  if (a === 'export') return exportBackup();
  if (a === 'attempt') {
    const subs = []; for (let k = 0; k < +b.dataset.n; k++) subs.push({ eval: document.querySelector(`[data-name="ev${k}"].on`)?.dataset.v || '' });
    if (subs.some(s => !s.eval)) return alert('すべての小問に自己評価を選んでください');
    const arr = AT[b.dataset.id] || []; arr.push({ date: today(), subs, memo: $('#atmemo').value, source: 'practice' }); AT[b.dataset.id] = arr; await db.put('attempts', b.dataset.id, arr); return render();
  }
  if (a === 'open-ex') { const e = D.exams.find(x => x.id === location.hash.split('/').pop()); $('#extext').innerHTML = e.pageTexts.map(p => `<p><span class="label">教材原文</span><span class="muted">${p.printed}頁</span></p><div class="src">${esc(p.text)}</div>`).join(''); b.hidden = true; }
});
document.addEventListener('change', async ev => {
  const t = ev.target; const a = t.dataset?.act;
  if (a === 'ankick') { CK[t.dataset.key] = t.checked ? { recalled: true, at: new Date().toISOString() } : { recalled: false }; await db.put('checks', t.dataset.key, CK[t.dataset.key]); const y = scrollY, o = [...document.querySelectorAll('details[open]')].map(d => d.querySelector('[data-key]')?.dataset.key); await render(); document.querySelectorAll('details').forEach(d => o.includes(d.querySelector('[data-key]')?.dataset.key) && (d.open = true)); scrollTo(0, y); return; }
  if (a === 'ck') { CK[t.dataset.id] = t.checked ? { recalled: true, at: new Date().toISOString() } : { recalled: false }; await db.put('checks', t.dataset.id, CK[t.dataset.id]); return render(); }
  if (a === 'rdate') { await saveProg(t.dataset.id, { reviewDate: t.value }); return; }
  if (a === 'note') { NT[t.dataset.key] = t.value; return db.put('notes', t.dataset.key, t.value); }
  if (t.id === 'q') { SET.q = t.value; await db.put('settings', 'q', t.value); if (t.value.trim().length >= 2) { SET.qh = [t.value, ...(SET.qh || []).filter(x => x !== t.value)].slice(0, 8); await db.put('settings', 'qh', SET.qh); } return render(); }
  if (t.id === 'packfile') return importPack([...t.files]);
  if (t.id === 'restorefile') return restore(t.files[0]);
  if (t.id === 'pdffile') return importPdf(t.files[0]);
});

async function importPdf(f) {
  try {
    if (!f) return;
    const book = pdfPickBook || 'input1'; pdfPickBook = null;
    if (!/\.pdf$/i.test(f.name) && f.type !== 'application/pdf') return msg('pdfmsg', 'PDFファイルを選んでください。');
    await db.put('files', book, { name: f.name, size: f.size, importedAt: new Date().toISOString(), blob: f });
    await loadAll(); msg('pdfmsg', `取り込みました: ${f.name}`); render();
  } catch (e) { msg('pdfmsg', '失敗しました: ' + e.message); }
}

// 保存場所がブロックされた(db.js が知らせる)ら、メニューを開いている間だけ案内を出す。
addEventListener('kansa-db-blocked', () => { const e = document.getElementById('packmsg'); if (e) e.innerHTML = '<p class="muted">保存場所を開けず待っています。別のタブやホーム画面のアイコンなど、他でこのアプリを開いていたら、そちらを閉じてから再読み込みしてください。</p>'; });

async function importPack(files) {
  try {
    // 事前チェック: 保存場所が使える状態かを最初に1回だけ確かめる。ダメなら展開まで進まず、再読み込みを案内する。
    try { await db.get('pack', 'manifest.json'); } catch (e) { return msg('packmsg', '保存場所の確認ができませんでした（' + e.message + '）。ページを再読み込みしてから、もう一度取り込んでください。'); }
    msg('packmsg', '読み込み中…'); let n = 0;
    // §3.1/§1.7: .json は現行処理(basenameキー・JSON.parse)を完全維持。img/*.webp はキー=エントリ名そのまま・値=Blob で保存し件数に含める。それ以外は現行どおり無視する
    const take = async (name, source) => {
      if (name.startsWith('img/') && name.endsWith('.webp')) {
        let bytes = null;
        if (source instanceof Blob) bytes = new Uint8Array(await source.arrayBuffer());
        else if (source && typeof source.bytes === 'function') bytes = source.bytes();
        else return; // バイナリとして取得できない経路からは保存しない(text経由で壊れたデータを入れない)
        if (!(bytes instanceof Uint8Array)) return;
        await db.put('pack', name, new Blob([bytes], { type: 'image/webp' })); n++; return;
      }
      const base = name.split('/').pop(); if (!base.endsWith('.json') || base.startsWith('.')) return;
      let text;
      if (source instanceof Blob) text = await source.text();
      else if (source && typeof source.text === 'function') text = source.text();
      else if (typeof source === 'string') text = source;
      else return;
      JSON.parse(text); await db.put('pack', base, JSON.parse(text)); n++;
    };
    for (const f of files) { if (f.name.endsWith('.zip')) for (const z of await readZip(await f.arrayBuffer())) await take(z.name, z); else await take(f.name, f); }
    D.st = {}; D.cl = {}; SIDX = null; ANKI = null; await loadAll();
    if (!D.ready) return msg('packmsg', `${n}個を保存しましたが manifest.json がありません。ZIP全体を選んでください。`);
    msg('packmsg', `取り込み完了(${n}ファイル)。ホームへ戻ります。`); setTimeout(() => (location.hash = '#/home'), 900);
  } catch (e) { msg('packmsg', '失敗しました: ' + e.message); }
}
async function exportBackup() {
  const out = { app: 'kansa', version: 1, exportedAt: new Date().toISOString() };
  for (const s of db.PERSONAL) out[s] = await db.all(s);
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' }); const name = `kansa-backup-${today()}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) { try { await navigator.share({ files: [file], title: name }); return msg('bkmsg', '共有しました(ファイルに保存を選ぶと確実です)'); } catch { /* キャンセルは無視 */ } }
  const u = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); msg('bkmsg', name + ' を書き出しました');
}
async function restore(f) {
  try {
    const o = JSON.parse(await f.text()); if (o.app !== 'kansa') throw new Error('このアプリのバックアップではありません');
    if (!confirm('今の学習記録を、このファイルの内容で置き換えます。よろしいですか?')) return;
    for (const s of db.PERSONAL) { await db.clear(s); for (const [k, v] of Object.entries(o[s] || {})) await db.put(s, k, v); }
    await loadAll(); msg('bkmsg', '復元しました');
  } catch (e) { msg('bkmsg', '失敗しました: ' + e.message); }
}

// ---------- ルーター ----------
async function render() {
  // ハッシュ内の教材ページ番号（①等の丸数字）はブラウザが %E2%91%A0 のように符号化して返すため、ここで復号する
  const rawHash = location.hash.replace(/^#\//, '');
  let decoded = rawHash;
  try { decoded = decodeURIComponent(rawHash); } catch { /* 復号できない場合は元のまま */ }
  const [t, ...args] = (decoded || 'home').split('/');
  const fn = { home, input, ron, output, menu, review: reviewChecks }[t] || home;
  let html; try { html = await fn(args.length ? args : []); } catch (e) { html = `<div class="warn">エラー: ${esc(e.message)}</div>`; console.error(e); }
  const y = scrollY; $('#view').innerHTML = html; if (t === 'home' || args.length === 0) scrollTo(0, 0); else scrollTo(0, y > 0 && ['status', 'field'].length ? y : 0);
}
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
(async () => { await loadAll(); await render(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); })();
