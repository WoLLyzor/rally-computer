// Page photo → JPEG base64 for the vision reader, long edge ≤ 2576 px (high-resolution vision limit).
export async function prepareImage(file, { maxEdge = 2576, quality = 0.9 } = {}) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  let q = quality, blob;
  do {
    blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', q));
    q -= 0.1;
  } while (blob.size > 3.5e6 && q > 0.4);
  const data = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
  return { mediaType: 'image/jpeg', data, w, h };
}
