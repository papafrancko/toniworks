/**
 * Brand images, generated from the vector wordmark. Never from the 150 px
 * logo JPG (src/assets/brand/logo-reference.jpg): that is only the reference
 * the vector was rebuilt from.
 *
 *   public/favicon.svg           navy disc badge, transparent corners
 *   public/favicon.ico           16 and 32 px PNGs in an ICO container
 *   public/apple-touch-icon.png  180x180 full-bleed navy square (iOS masks it)
 *   public/og-default.png        1200x630 default share image
 *
 * Run `npm run brand` after changing the wordmark geometry. The geometry is
 * read from src/assets/brand/badge.svg and must match Wordmark.astro.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';

const root = new URL('../', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
const write = (file, data) => {
  writeFileSync(new URL(file, root), data);
  console.log(`${file.padEnd(28)} ${data.length} bytes`);
};

const NAVY = '#041C3F';
const WHITE = '#FFFFFF';
const BG = '#0A0D14';

const badge = read('src/assets/brand/badge.svg');
const component = read('src/components/Wordmark.astro');

const pick = (source, re, what) => {
  const m = source.match(re);
  if (!m) throw new Error(`make-brand: no ${what}`);
  return m[1];
};
const numbers = (s) => s.match(/-?\d*\.?\d+/g).map(Number);

const pathData = pick(badge, / d="([^"]+)"/, 'path in badge.svg');
const italic = pick(badge, /transform="([^"]+)"/, 'transform in badge.svg');
if (!component.includes(`d="${pathData}"`) || !component.includes(`transform="${italic}"`)) {
  throw new Error('make-brand: Wordmark.astro and badge.svg have different geometry');
}
const [ia, ib, ic, id, ie, iff] = numbers(italic);
// The component's viewBox is the wordmark box: cap top to baseline, ink edge to ink edge.
const [boxX, boxY, boxW, boxH] = numbers(pick(component, /viewBox="([^"]+)"/, 'viewBox in Wordmark.astro'));
const ratio = boxW / boxH;

/**
 * The white wordmark with a cap height of `cap` units and the top-left
 * corner of its box at (x, y), as one path with one matrix.
 */
const mark = (x, y, cap) => {
  const s = cap / boxH;
  const m = [s * ia, s * ib, s * ic, s * id, s * (ie - boxX) + x, s * (iff - boxY) + y];
  return `<path fill="${WHITE}" fill-rule="evenodd" transform="matrix(${m.map((n) => +n.toFixed(4)).join(' ')})" d="${pathData}"/>`;
};

// Opaque PNG: a full-bleed rectangle of `fill` with `body` on top.
const flatPng = (w, h, fill, body) =>
  sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="${fill}"/>${body}</svg>`,
    ),
  )
    .removeAlpha()
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();

/*
 * Favicon: the badge (disc d=150), grid-fitted for tab sizes. The wordmark's
 * cap height becomes 37.5 units (4 px at 16 px; the logo has 38) and it is
 * centred in the disc, so cap top and baseline fall on whole pixels at 16, 32,
 * 48 and 64 px and the horizontal strokes stay sharp. In the logo it sits 2.6
 * units below centre, which cannot land on the pixel grid at 16 px.
 */
const FAV_CAP = 37.5;
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 150 150"><circle cx="75" cy="75" r="75" fill="${NAVY}"/>${mark(75 - (FAV_CAP * ratio) / 2, 75 - FAV_CAP / 2, FAV_CAP)}</svg>\n`;
write('public/favicon.svg', favicon);

// ICO with PNG payloads (read by every browser, and by Windows since Vista).
const icoSizes = [16, 32];
const icoImages = await Promise.all(
  icoSizes.map((size) =>
    sharp(Buffer.from(favicon.replace('<svg ', `<svg width="${size}" height="${size}" `)))
      .ensureAlpha()
      .png({ compressionLevel: 9 })
      .toBuffer(),
  ),
);
const icoHeader = Buffer.alloc(6 + 16 * icoImages.length);
icoHeader.writeUInt16LE(1, 2); // type: icon
icoHeader.writeUInt16LE(icoImages.length, 4);
let icoOffset = icoHeader.length;
icoImages.forEach((image, i) => {
  const entry = 6 + 16 * i;
  icoHeader.writeUInt8(icoSizes[i], entry); // width
  icoHeader.writeUInt8(icoSizes[i], entry + 1); // height
  icoHeader.writeUInt16LE(1, entry + 4); // colour planes
  icoHeader.writeUInt16LE(32, entry + 6); // bits per pixel
  icoHeader.writeUInt32LE(image.length, entry + 8);
  icoHeader.writeUInt32LE(icoOffset, entry + 12);
  icoOffset += image.length;
});
write('public/favicon.ico', Buffer.concat([icoHeader, ...icoImages]));

// Apple touch icon: opaque navy square (iOS rounds the corners), wordmark
// centred at 70 % of the width, cap top and baseline on whole pixels.
{
  const size = 180;
  const cap = 40;
  write('public/apple-touch-icon.png', await flatPng(size, size, NAVY, mark((size - cap * ratio) / 2, (size - cap) / 2, cap)));
}

// Default share image: the site's ground, the wordmark on the site's 64 px
// margin, vertically centred, nothing else.
{
  const width = 1200;
  const height = 630;
  const cap = 180;
  write('public/og-default.png', await flatPng(width, height, BG, mark(64, (height - cap) / 2, cap)));
}
