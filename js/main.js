import * as db from './db.js';
import { readZip } from './zip.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = ['未学習', '学習中', '理解済み', '想起可能', '答案作成可能'];
const EVAL = ['◎', '○', '△', '×'];
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const addDays = n => { const d = new Date(); d.setDate(d.getDate() + n); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const badge = i => `<span class="badge b-${i === 'A' || i === 'B' || i === 'C' ? i : 'x'}">${esc(i === '-' ? '－' : i)}</span>`;

// ---------- 教材データ(読み取り専用)と個人データ ----------
const D = { ready: false, cl: {}, st: {} };
let PR = {}, CK = {}, NT = {}, AT = {}, SET = {};

async function loadAll() {
  D.manifest = await db.get('pack', 'manifest.json');
  D.ready = !!D.manifest;
  if (D.ready) {
    D.structure = await db.get('pack', 'structure.json');
    D.exams = await db.get('pack', 'exams.json');
    D.links = await db.get('pack', 'links.json');
    D.items = D.structure.items;
    D.byId = Object.fromEntries(D.items.map(i => [i.id, i]));
  }
  [PR, CK, NT, AT, SET] = await Promise.all(['progress', 'checks', 'notes', 'attempts', 'settings'].map(db.all));
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
  return `
  <div class="card"><h2>学習の進み(論点 ${total} 項目)</h2>
    <div class="bar"><div style="width:${(done / total * 100).toFixed(1)}%"></div></div>
    <p class="muted">着手済み ${done} / ${total}　${STATUS.map(s => `<span class="chip">${s} ${cnt[s]}</span>`).join('')}</p>
    <p class="muted">論点リストの想起チェック: ${rec} / ${recTotal}</p></div>
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
async function inputPage(printed) {
  // 教材ページ番号の先頭は丸数字（①〜⑩）なので、章番号は丸数字から求める（+printed だと NaN になる）
  const ch = '①②③④⑤⑥⑦⑧⑨⑩'.indexOf(printed[0]) + 1; const pages = await chapterPages(ch); const idx = pages.findIndex(p => p.printed === printed);
  if (idx < 0) { setTitle('Input', '#/input'); return '<p>頁が見つかりません。</p>'; }
  const pg = pages[idx]; const raw = SET.rawView;
  SET.last = { printed }; db.put('settings', 'last', SET.last);
  setTitle(`Input ${printed}`, `#/input/ch/${ch}`);
  const here = D.items.filter(i => i.inputPage === printed);
  const nt = NT['page:' + printed] || '';
  return `
  ${here.map(i => `<div class="card"><div>${badge(i.importance)} <b>${i.no} ${esc(i.title)}</b> <span class="muted">(重要度は教材の値)</span></div>
    ${i.importanceNotes?.length ? `<div class="warn">${i.importanceNotes.map(esc).join('<br>')}</div>` : ''}
    <div class="seg" style="margin-top:8px">${STATUS.map(s => `<button data-act="status" data-id="${i.id}" data-v="${s}" class="${prog(i.id).status === s ? 'on' : ''}">${s}</button>`).join('')}</div>
    <a class="btn sub" href="#/ron/t/${i.id}">論点の詳細</a></div>`).join('')}
  <div class="pager"><a class="btn sub" href="${idx > 0 ? '#/input/p/' + pages[idx - 1].printed : '#/input/ch/' + ch}">‹ 前</a><a class="btn sub" href="${idx < pages.length - 1 ? '#/input/p/' + pages[idx + 1].printed : '#/input/ch/' + ch}">次 ›</a></div>
  <p><span class="label">教材原文</span><span class="muted">${printed}(PDF ${pg.pdf}頁)・${idx + 1}/${pages.length}</span>
  <button class="btn sub" data-act="rawtoggle" style="float:right;margin:0;padding:4px 10px;font-size:13px">${raw ? '整形表示へ' : 'そのまま表示'}</button></p>
  <div class="src">${esc(raw ? pg.raw : pg.text)}</div>
  <p class="muted">※抽出テキストです。図表は崩れることがあります。正確さが必要なときはPDFで確認してください(PDF表示は今後追加)。</p>
  <div class="card"><h2><span class="label ai" style="background:var(--navy)">自分のメモ</span></h2><textarea data-act="note" data-key="page:${printed}" placeholder="この頁のメモ">${esc(nt)}</textarea></div>
  <div class="pager"><a class="btn sub" href="${idx > 0 ? '#/input/p/' + pages[idx - 1].printed : '#/input/ch/' + ch}">‹ 前</a><a class="btn sub" href="${idx < pages.length - 1 ? '#/input/p/' + pages[idx + 1].printed : '#/input/ch/' + ch}">次 ›</a></div>`;
}

// ---------- 論点 ----------
const F = { ch: '全部', imp: '全部', st: '全部', mode: '項目', cch: 1 };
async function ron(args) {
  setTab('ron');
  if (!D.ready) { setTitle('論点'); return needPack(); }
  if (args[0] === 't') return topic(args[1]);
  setTitle('論点');
  let h = seg('mode', ['項目', '想起チェック'], F.mode);
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
  h += `<p class="muted">${list.length}件</p>` + list.map(i => { const p = prog(i.id); return `<a class="row" href="#/ron/t/${i.id}">${badge(i.importance)}<div class="main">${i.no} ${esc(i.title)}<div class="sub">第${i.ch}章 ・ <span class="chip st-${p.status}">${p.status}</span> 理解${p.understand}/5 答案${p.writing}/5</div></div>›</a>`; }).join('');
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
   <button class="btn sub" data-act="open-ex">原文を開く</button><div id="extext"></div></div>`;
}

// ---------- メニュー ----------
async function menu() {
  setTitle('メニュー'); setTab('menu');
  const m = D.manifest; const persisted = navigator.storage?.persisted ? await navigator.storage.persisted() : null;
  return `
  <div class="card"><h2>教材データの取り込み</h2>
   ${m ? `<p class="muted">取り込み済み: ${esc(m.generatedAt)} 版 / 論点${m.counts.topics}・Input${m.counts.inputPages}頁・過去問${m.counts.exams}問<br>状態: ${esc(m.status)}</p>` : '<p>まだ取り込まれていません。</p>'}
   <input type="file" id="packfile" accept=".zip,.json" multiple hidden>
   <button class="btn" data-act="pick-pack">ZIP(またはJSON)を選ぶ</button>
   <p class="muted">教材データは、この端末の中だけに保存されます(外部へ送信されません)。</p><div id="packmsg"></div></div>
  <div class="card"><h2>バックアップ(自分の学習記録)</h2>
   <p class="muted">進捗・チェック・メモ・演習記録を1つのファイルに書き出します。端末の保存領域はiOSに消されることがあるため、定期的な書き出しをおすすめします。教材本文は含まれません。</p>
   <button class="btn" data-act="export">書き出す</button>
   <input type="file" id="restorefile" accept=".json" hidden><button class="btn sub" data-act="pick-restore">復元する</button><div id="bkmsg"></div></div>
  <div class="card"><h2>保存の安全性</h2><p class="muted">端末の保存を「消されにくく」する申請: ${persisted === null ? '未対応' : persisted ? '許可されています' : 'まだ許可されていません'}</p>
   <button class="btn sub" data-act="persist">申請する</button></div>
  ${m ? `<div class="card"><h2>教材データについての注意</h2><ul class="muted">${m.notes.map(n => `<li>${esc(n)}</li>`).join('')}</ul></div>` : ''}`;
}

// ---------- イベント ----------
const msg = (id, t) => { const e = $('#' + id); if (e) e.innerHTML = `<p class="muted">${esc(t)}</p>`; };
document.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act;
  if (a === 'seg') { const n = b.dataset.name; if (n.startsWith('ev')) { b.parentElement.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); return; } F[n] = n === 'cch' ? +b.dataset.v.replace(/\D/g, '') : b.dataset.v; return render(); }
  if (a === 'status') { await saveProg(b.dataset.id, { status: b.dataset.v }); return render(); }
  if (a === 'field') { await saveProg(b.dataset.id, { [b.dataset.field]: isNaN(+b.dataset.v) ? b.dataset.v : +b.dataset.v }); return render(); }
  if (a === 'rquick') { const n = +b.dataset.n; await saveProg(b.dataset.id, { reviewDate: n ? addDays(n) : '' }); return render(); }
  if (a === 'rawtoggle') { SET.rawView = !SET.rawView; await db.put('settings', 'rawView', SET.rawView); return render(); }
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
  if (a === 'ck') { CK[t.dataset.id] = t.checked ? { recalled: true, at: new Date().toISOString() } : { recalled: false }; await db.put('checks', t.dataset.id, CK[t.dataset.id]); return render(); }
  if (a === 'rdate') { await saveProg(t.dataset.id, { reviewDate: t.value }); return; }
  if (a === 'note') { NT[t.dataset.key] = t.value; return db.put('notes', t.dataset.key, t.value); }
  if (t.id === 'packfile') return importPack([...t.files]);
  if (t.id === 'restorefile') return restore(t.files[0]);
});

async function importPack(files) {
  try {
    msg('packmsg', '読み込み中…'); let n = 0; const take = async (name, text) => { const base = name.split('/').pop(); if (!base.endsWith('.json') || base.startsWith('.')) return; JSON.parse(text); await db.put('pack', base, JSON.parse(text)); n++; };
    for (const f of files) { if (f.name.endsWith('.zip')) for (const z of await readZip(await f.arrayBuffer())) await take(z.name, z.text()); else await take(f.name, await f.text()); }
    D.st = {}; D.cl = {}; await loadAll();
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
  const fn = { home, input, ron, output, menu }[t] || home;
  let html; try { html = await fn(args.length ? args : []); } catch (e) { html = `<div class="warn">エラー: ${esc(e.message)}</div>`; console.error(e); }
  const y = scrollY; $('#view').innerHTML = html; if (t === 'home' || args.length === 0) scrollTo(0, 0); else scrollTo(0, y > 0 && ['status', 'field'].length ? y : 0);
}
window.addEventListener('hashchange', () => { scrollTo(0, 0); render(); });
(async () => { await loadAll(); await render(); if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {}); })();
