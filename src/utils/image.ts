import sharp, { OverlayOptions } from "sharp";

export async function createMosaic(imageUrls: string[]): Promise<Buffer | null> {
  if (!imageUrls.length || imageUrls.length > 4) return null;

  try {
    const buffers = await Promise.all(
      imageUrls.map(async url => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch ${url}`);
        return Buffer.from(await res.arrayBuffer());
      })
    );

    if (buffers.length === 1) return buffers[0];

    const canvasWidth = 1200;
    const canvasHeight = 675;
    const gap = 10;

    let composites: OverlayOptions[] = [];

    if (buffers.length === 2) {
      const w = (canvasWidth - gap) / 2;
      const h = canvasHeight;
      const img1 = await sharp(buffers[0]).resize(Math.round(w), h, { fit: "cover" }).toBuffer();
      const img2 = await sharp(buffers[1]).resize(Math.round(w), h, { fit: "cover" }).toBuffer();
      composites = [
        { input: img1, left: 0, top: 0 },
        { input: img2, left: Math.round(w + gap), top: 0 },
      ];
    } else if (buffers.length === 3) {
      const w1 = (canvasWidth - gap) / 2;
      const h1 = canvasHeight;
      const w2 = (canvasWidth - gap) / 2;
      const h2 = (canvasHeight - gap) / 2;
      const img1 = await sharp(buffers[0]).resize(Math.round(w1), h1, { fit: "cover" }).toBuffer();
      const img2 = await sharp(buffers[1]).resize(Math.round(w2), Math.round(h2), { fit: "cover" }).toBuffer();
      const img3 = await sharp(buffers[2]).resize(Math.round(w2), Math.round(h2), { fit: "cover" }).toBuffer();
      composites = [
        { input: img1, left: 0, top: 0 },
        { input: img2, left: Math.round(w1 + gap), top: 0 },
        { input: img3, left: Math.round(w1 + gap), top: Math.round(h2 + gap) },
      ];
    } else if (buffers.length === 4) {
      const w = (canvasWidth - gap) / 2;
      const h = (canvasHeight - gap) / 2;
      const img1 = await sharp(buffers[0]).resize(Math.round(w), Math.round(h), { fit: "cover" }).toBuffer();
      const img2 = await sharp(buffers[1]).resize(Math.round(w), Math.round(h), { fit: "cover" }).toBuffer();
      const img3 = await sharp(buffers[2]).resize(Math.round(w), Math.round(h), { fit: "cover" }).toBuffer();
      const img4 = await sharp(buffers[3]).resize(Math.round(w), Math.round(h), { fit: "cover" }).toBuffer();
      composites = [
        { input: img1, left: 0, top: 0 },
        { input: img2, left: Math.round(w + gap), top: 0 },
        { input: img3, left: 0, top: Math.round(h + gap) },
        { input: img4, left: Math.round(w + gap), top: Math.round(h + gap) },
      ];
    }

    const output = await sharp({
      create: {
        width: canvasWidth,
        height: canvasHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 1 },
      },
    })
      .composite(composites)
      .jpeg({ quality: 90 })
      .toBuffer();

    return output;
  } catch (err) {
    console.error("Error creating mosaic:", err);
    return null;
  }
}
