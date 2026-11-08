// ZIPファイルをブラウザの中で展開する(外部ライブラリなし)。deflate(通常の圧縮)と無圧縮に対応。
export async function readZip(buf) {
  const v = new DataView(buf), u8 = new Uint8Array(buf), dec = new TextDecoder('utf-8');
  let e = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 70000); i--) if (v.getUint32(i, true) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('ZIPとして読めませんでした');
  const n = v.getUint16(e + 10, true); let p = v.getUint32(e + 16, true); const out = [];
  for (let k = 0; k < n; k++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('ZIPの目次が壊れています');
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true), nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), off = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nl)); p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const lnl = v.getUint16(off + 26, true), lxl = v.getUint16(off + 28, true), s = off + 30 + lnl + lxl;
    const data = u8.subarray(s, s + csize);
    let bytes;
    if (method === 0) bytes = data;
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else throw new Error('未対応の圧縮方式: ' + name);
    // text() は従来どおり UTF-8 として復号する。bytes() は §3.1/§1.7 用に追加したバイナリ取得経路で、
    // WebP 等のバイナリを text() 経由で壊さずに取り出すために使う(コピーを返し、元の展開バッファの共有による書き換えを防ぐ)。
    out.push({ name, text: () => dec.decode(bytes), bytes: () => bytes.slice() });
  }
  return out;
}
