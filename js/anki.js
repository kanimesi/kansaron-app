// 暗記マーク(🌑)が付いた見出しと、その直後の教材原文(同じ頁の範囲内)を取り出す。原文は加工しない。
const lvl = l => /^[０-９0-9]+[．.]\s*\S/.test(l) ? 1 : /^[（(][０-９0-9]+[)）]/.test(l) ? 2 : /^[①-⑳]/.test(l) ? 3 : 9;
// 「記号のみ行」の判定(2026-11-11 全面監査 中-3 対応)。body 末尾に残る図版ベクター描画の断片
// (例:「ロ／：＋」「-―_/ I ¥_---ー_J」「9一」の繰り返し)を落とすためだけに使う。本文の意味行には触れない。
// 記号行とみなす条件(すべてを満たす行だけ):
//  1. 空行でない(trim して文字がある)
//  2. ひらがなを含まない(助詞・活用語尾など文の一部を絶対に落とさないため)
//  3. 漢字は「一・口・丁・二・三」しか含まない(この5字はベクター断片の崩れ字として現れる。実語は他の漢字を伴う)
//  4. ％・% を含まない(「100％」「５％」のような数値ラベルは意味行として残す)
//  5. 日付形(数字/数字)でない(「3/31」等は残す)
//  6. 英字だけの2文字以上の語でない(「YES」等の語は残す)
//  7. 構成文字がすべて「空白・句読点と記号(Unicode の P/S カテゴリ)・数字・英字・カタカナ・長音とイテレーション記号・条件3の漢字」の範囲内
// この判定は末尾からの除去にだけ使い、body の途中にある行は(2段組の混成も含め)一切触らない。
const SYMBOL_OK_KANJI = new Set(['一', '口', '丁', '二', '三']);
const SYMBOL_CHARS = /^[\s\p{P}\p{S}0-9０-９A-Za-zＡ-Ｚａ-ｚ\p{Script=Katakana}ー・ヽヾ一口丁二三]+$/u;
function isSymbolOnlyLine(l) {
  const t = l.trim();
  if (!t) return false;
  if (/[ぁ-ん]/.test(t)) return false;
  const kanji = t.match(/\p{Script=Han}/gu) || [];
  if (kanji.some(k => !SYMBOL_OK_KANJI.has(k))) return false;
  if (/[%％]/.test(t)) return false;
  if (/^\d{1,2}\/\d{1,2}$/.test(t)) return false;
  if (/^[A-Za-zＡ-Ｚａ-ｚ]{2,}$/.test(t)) return false;
  return SYMBOL_CHARS.test(t);
}
const FOOT = /^-\s*[①-⑩0-9０-９]+-\d+-\d+\s*-\s*$/;
export function extractAnki(pages) {
  const out = [];
  for (const p of pages) {
    const lines = p.text.split('\n');
    // 各行が p.text の何文字目から始まるか。body の範囲(bodyFrom/bodyTo)を text の文字位置で返すために使う
    const starts = []; let acc = 0;
    for (const l of lines) { starts.push(acc); acc += l.length + 1; }
    lines.forEach((ln, i) => {
      // 本物の暗記マーク = 🌑 のあとに、(👉/🔎の参照以外)文章が続かない行。文中の「🌑論点は…」という凡例の言及は除く。
      const m = ln.match(/^(.*?)\s*🌑\s*((?:[👉🔎].*)?)$/);
      if (!m) return;
      let heading = m[1].trim(); const ref = m[2].trim(); let hi = i;
      if (!heading) { // 🌑が単独の行 → 見出し語は直前の空でない行
        for (let j = i - 1; j >= 0; j--) if (lines[j].trim() && !lines[j].includes('🌑')) { heading = lines[j].trim(); hi = j; break; }
      }
      const own = lvl(heading), cut = own === 9 ? 3 : own;
      let parent = '';
      for (let j = hi - 1; j >= 0; j--) { const t = lines[j].trim(); if (lvl(t) <= 2 && t.length > 2 && !t.includes('🌑')) { parent = t; break; } }
      const body = []; const bodyIdx = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.includes('🌑') || FOOT.test(l.trim())) break;
        if (lvl(l.trim()) <= cut && body.some(x => x.trim())) break;
        body.push(l); bodyIdx.push(j);
      }
      // 末尾の空行と「記号のみ行」を落とす(記号行の間に空行が挟まる場合も含め、意味行に当たるまで)。
      // body/bodyIdx を一緒に縮めるので、body は p.text の部分文字列のまま、bodyFrom/bodyTo も追随する。
      while (body.length && (!body[body.length - 1].trim() || isSymbolOnlyLine(body[body.length - 1]))) { body.pop(); bodyIdx.pop(); }
      while (body.length && !body[0].trim()) { body.shift(); bodyIdx.shift(); }
      // body は p.text の部分文字列(連続した行の連結)なので、範囲を文字位置で特定できる。
      // 表示側が「この項目の範囲内にある表・図」を判定するために使う。body が空なら null。
      let bodyFrom = null, bodyTo = null;
      if (bodyIdx.length) { bodyFrom = starts[bodyIdx[0]]; bodyTo = starts[bodyIdx[bodyIdx.length - 1]] + lines[bodyIdx[bodyIdx.length - 1]].length; }
      out.push({ ref, parent, printed: p.printed, n: out.filter(o => o.printed === p.printed).length, heading, body: body.join('\n'), bodyFrom, bodyTo });
    });
  }
  return out;
}
