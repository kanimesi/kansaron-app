// 暗記マーク(🌑)が付いた見出しと、その直後の教材原文(同じ頁の範囲内)を取り出す。原文は加工しない。
const lvl = l => /^[０-９0-9]+[．.]\s*\S/.test(l) ? 1 : /^[（(][０-９0-9]+[)）]/.test(l) ? 2 : /^[①-⑳]/.test(l) ? 3 : 9;
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
      while (body.length && !body[body.length - 1].trim()) { body.pop(); bodyIdx.pop(); }
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
