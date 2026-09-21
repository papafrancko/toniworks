/**
 * Per-film share image, rendered at build time: /og/<slug>.png, 1200x630.
 * The film's poster (frame 0) is letterboxed on --bg, never cropped, with the
 * white wordmark small in the top-left corner (geometry from Wordmark.astro).
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { srcDir } from 'astro:config/server';
import sharp from 'sharp';
import { films, type Film } from '../../data/films';
import wordmarkSource from '../../components/Wordmark.astro?raw';

const WIDTH = 1200;
const HEIGHT = 630;
const BG = '#0A0D14';
const MARK_CAP = 18;
const MARK_INSET = 32;

export const getStaticPaths = (() =>
  films.map((film) => ({ params: { slug: film.slug }, props: { film } }))) satisfies GetStaticPaths;

const pick = (re: RegExp) => {
  const match = wordmarkSource.match(re);
  if (!match) throw new Error(`og: ${re} not found in Wordmark.astro`);
  return match[1];
};
const numbers = (value: string) => (value.match(/-?\d*\.?\d+/g) ?? []).map(Number);

/** The wordmark as one white path, cap height `cap`, top-left of its box at (x, y). */
const wordmark = (x: number, y: number, cap: number) => {
  const [boxX, boxY, , boxH] = numbers(pick(/viewBox="([^"]+)"/));
  const [a, b, c, d, e, f] = numbers(pick(/transform="([^"]+)"/));
  const s = cap / boxH;
  const matrix = [s * a, s * b, s * c, s * d, s * (e - boxX) + x, s * (f - boxY) + y];
  return `<path fill="#FFFFFF" fill-rule="evenodd" transform="matrix(${matrix.join(' ')})" d="${pick(/\sd="([^"]+)"/)}"/>`;
};

/** Absolute file path of the poster source (sharp reads it from disk). */
const posterPath = (slug: string) => {
  const url = new URL(`assets/films/${slug}/poster.jpg`, srcDir);
  return decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:)/, '');
};

export const GET: APIRoute = async ({ props }) => {
  const { film } = props as { film: Film };

  // Scaled to fit inside 1200x630 (height-bound for 3:2), centred: never cropped.
  const poster = film.full.poster
    ? await sharp(posterPath(film.slug))
        .resize({ width: WIDTH, height: HEIGHT, fit: 'inside', kernel: 'lanczos3' })
        .toBuffer({ resolveWithObject: true })
    : undefined;
  const mark = `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${wordmark(MARK_INSET, MARK_INSET, MARK_CAP)}</svg>`;

  const png = await sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: BG } })
    .composite([
      ...(poster
        ? [
            {
              input: poster.data,
              left: Math.round((WIDTH - poster.info.width) / 2),
              top: Math.round((HEIGHT - poster.info.height) / 2),
            },
          ]
        : []),
      { input: new TextEncoder().encode(mark), left: 0, top: 0 },
    ])
    .removeAlpha()
    // 256-colour dithered PNG: ~180-270 KB instead of ~400-520 KB truecolour, which
    // keeps it under the ~300 KB some messengers (WhatsApp) allow for link previews.
    // The dither reads as film grain at share-card size.
    .png({ palette: true, colours: 256, dither: 1, effort: 10, compressionLevel: 9 })
    .toBuffer();

  return new Response(new Uint8Array(png), { headers: { 'Content-Type': 'image/png' } });
};
