#!/usr/bin/env node
/**
 * Adds a film to the site. Run by the GitHub workflow "Tilføj film"
 * (.github/workflows/tilfoej-film.yml); works locally too:
 *
 *   node scripts/add-film.mjs --link <url> --titel <titel> [--kunde SALTY]
 *
 * 1. Downloads the master: a Dropbox share link (forced to dl=1), a Google
 *    Drive share link (through the large-file confirmation) or any direct
 *    http(s) link to the file. WeTransfer and other web pages are refused.
 *    Locally (not on GitHub) --link may also be a path to a file on disk.
 * 2. Checks it with ffprobe: a video whose display aspect is within 1 % of
 *    2048:1340 and at least 1280 px wide; warns when there is no sound.
 * 3. Makes the slug from the title (æ->ae, ø->oe, å->aa, the rest a-z0-9 and
 *    dashes; -2, -3 … when taken).
 * 4. Encodes the WHOLE film with scripts/encode-media.mjs --only=<slug>
 *    --source=<master>: the same five files, settings and checks as every
 *    other film. Nothing is cut; only format and pixel size change.
 * 5. Appends the film at the end of src/content/film.yaml (comments and
 *    formatting kept) and prints a Danish summary.
 *
 * The downloaded master is deleted afterwards. On failure nothing is left
 * behind: the film's folder is removed and the manifest restored.
 *
 * On GitHub Actions it also writes step outputs (slug, titel, url) and, with
 * --summary-file <path>, a Danish Markdown summary for the job page.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FILM_YAML, FILM_YAML_NAME, ROOT, SLUG_RE, Stop, appendFilm, parseFilms } from './film-yaml.mjs';

const OUT = path.join(ROOT, 'src', 'assets', 'films');
const MANIFEST = path.join(ROOT, 'src', 'data', 'media-manifest.json');
const ENCODE = path.join(ROOT, 'scripts', 'encode-media.mjs');
const SITE = 'https://www.toniworks.dk';

const TARGET = { width: 2048, height: 1340 };
const ASPECT_TOLERANCE = 0.01;
const MIN_WIDTH = 1280;
/** Every video file must stay under 25 MB; past ~3 min that costs too much picture. */
const MAX_SECONDS = 180;
const LONG_SECONDS = 60;
const MAX_DOWNLOAD_BYTES = 10e9;
const MAX_DOWNLOAD_TEXT = '10 GB';
const CONNECT_TIMEOUT_MS = 60_000;
const STALL_TIMEOUT_MS = 120_000;
const DOWNLOAD_ATTEMPTS = 3;
const USER_AGENT = 'toniworks-add-film (+https://www.toniworks.dk)';

const ON_GITHUB = Boolean(process.env.GITHUB_ACTIONS);

// ---------------------------------------------------------------- messages

const USE_DROPBOX = 'Læg filmen i Dropbox, og brug Dropbox-linket (Del → Kopiér link).';
const MSG = {
  wetransfer:
    'WeTransfer-links kan ikke bruges: de åbner en side med en download-knap, ikke selve filen, og de udløber efter få dage. ' +
    USE_DROPBOX,
  videoSite: `Linket går til en side på YouTube/Vimeo, ikke til selve filmfilen. Brug masterfilen: ${USE_DROPBOX}`,
  dropboxFolder:
    'Linket peger på en mappe i Dropbox, ikke på selve filmen. Højreklik på filmfilen i Dropbox, vælg Del → Kopiér link, og brug det link.',
  dropboxTransfer: 'Dropbox Transfer-links kan ikke bruges (de åbner en side, ikke filen). Del selve filmfilen: Del → Kopiér link.',
  dropboxPrivate:
    'Det link er til jeres egen Dropbox-visning og virker kun, når man er logget ind. Del filen i stedet: Del → Kopiér link.',
  dropboxHtml:
    'Dropbox viste en side i stedet for filen. Er linket slået fra, udløbet eller kun delt med bestemte personer? ' +
    'Lav et nyt link til filmfilen (Del → Kopiér link, "Alle med linket").',
  driveFolder: `Linket peger på en mappe i Google Drive, ikke på selve filmen. ${USE_DROPBOX}`,
  driveUnknown: `Kan ikke finde filen i Google Drive-linket. ${USE_DROPBOX}`,
  driveHtml:
    'Google Drive ville ikke udlevere filen: Drive viser en side i stedet for filen, typisk fordi filen ikke er delt med ' +
    '"Alle med linket", eller fordi den er hentet for mange gange i dag. Google Drive er upålideligt til store filer. ' +
    USE_DROPBOX,
  html:
    'Linket åbner en webside, ikke selve videofilen. Brug et Dropbox-link til filmfilen (Del → Kopiér link) ' +
    'eller et direkte link, der henter .mp4/.mov-filen med det samme.',
};

function httpMessage(status) {
  if (status === 404 || status === 410) {
    return `Filen findes ikke på linket (HTTP ${status}). Er linket stadig gyldigt, og er filen ikke flyttet eller slettet?`;
  }
  if (status === 401 || status === 403) {
    return `Adgang nægtet (HTTP ${status}). Linket skal være delt, så alle med linket kan hente filen.`;
  }
  if (status === 429) return 'Tjenesten afviser for mange downloads lige nu (HTTP 429). Vent lidt, og prøv igen.';
  if (status >= 500) return `Tjenesten bag linket svarer ikke (HTTP ${status}). Prøv igen om lidt.`;
  return `Filen kunne ikke hentes (HTTP ${status}). Tjek linket, og prøv igen.`;
}

// ---------------------------------------------------------------- link

/**
 * Turns what the owners paste into something downloadable, or refuses it.
 * Returns { kind: 'dropbox' | 'drive' | 'direct' | 'local', url | file }.
 */
export function resolveLink(input, { allowLocal = !ON_GITHUB } = {}) {
  const raw = String(input ?? '')
    .trim()
    .replace(/^<(.*)>$/, '$1')
    .replace(/^(["'])(.*)\1$/, '$2')
    .trim();
  if (!raw) throw new Stop('Der mangler et link til filmen.');
  if (allowLocal && !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && fs.existsSync(raw)) {
    return { kind: 'local', file: path.resolve(raw) };
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Stop(`"${raw}" er ikke et link. Kopiér hele linket, fx https://www.dropbox.com/scl/fi/…`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Stop('Linket skal starte med https://');
  const host = url.hostname.toLowerCase();
  const is = (...domains) => domains.some((d) => host === d || host.endsWith(`.${d}`));

  if (is('wetransfer.com', 'we.tl')) throw new Stop(MSG.wetransfer);
  if (is('youtube.com', 'youtu.be') || host === 'vimeo.com' || host === 'www.vimeo.com') throw new Stop(MSG.videoSite);

  if (is('dropboxusercontent.com')) return { kind: 'dropbox', url: url.href };
  if (is('dropbox.com')) {
    const p = url.pathname;
    // A folder link is fine when it points at one file inside the folder
    // (".../scl/fo/<id>/<path>/film.mp4"); Dropbox then serves that file.
    if (/^\/(sh|scl\/fo)\//.test(p) && !/\/[^/]+\.(mp4|mov|m4v|mkv|webm|avi|mxf)$/i.test(p)) {
      throw new Stop(MSG.dropboxFolder);
    }
    if (/^\/(t|transfer)\//.test(p)) throw new Stop(MSG.dropboxTransfer);
    if (/^\/(home|preview|work)(\/|$)/.test(p)) throw new Stop(MSG.dropboxPrivate);
    url.hostname = 'www.dropbox.com';
    url.protocol = 'https:';
    url.searchParams.delete('raw');
    url.searchParams.set('dl', '1');
    return { kind: 'dropbox', url: url.href };
  }
  if (is('drive.google.com', 'docs.google.com', 'drive.usercontent.google.com')) {
    if (/\/folders\//.test(url.pathname)) throw new Stop(MSG.driveFolder);
    const id = /\/file\/d\/([\w-]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get('id');
    if (!id || !/^[\w-]+$/.test(id)) throw new Stop(MSG.driveUnknown);
    return {
      kind: 'drive',
      url: `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`,
    };
  }
  return { kind: 'direct', url: url.href };
}

const decodeEntities = (s) =>
  s.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|#39);/gi, (m, e) => {
    const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }[e.toLowerCase()];
    if (named) return named;
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });

/**
 * Google Drive's "can't scan this file for viruses" page: a form whose hidden
 * fields (id, export, confirm, uuid) make the real download URL.
 */
export function driveConfirmUrl(html) {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const action = /\baction="([^"]*)"/i.exec(form[1])?.[1];
    if (!action) continue;
    let url;
    try {
      url = new URL(decodeEntities(action), 'https://drive.usercontent.google.com/');
    } catch {
      continue;
    }
    if (url.hostname !== 'drive.usercontent.google.com' || !url.pathname.startsWith('/download')) continue;
    for (const input of form[2].matchAll(/<input\b[^>]*>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(input[0])?.[1];
      const value = /\bvalue="([^"]*)"/i.exec(input[0])?.[1] ?? '';
      if (name) url.searchParams.set(decodeEntities(name), decodeEntities(value));
    }
    if (url.searchParams.get('id')) return url.href;
  }
  return null;
}

/** The master's own name, from Content-Disposition or the URL; safe as a file name. */
export function fileNameFrom(disposition, url) {
  let name = '';
  const star = /filename\*\s*=\s*([^;]+)/i.exec(disposition ?? '');
  if (star) {
    const value = star[1].trim().replace(/^"(.*)"$/, '$1');
    const encoded = /^[\w-]*'[^']*'(.*)$/.exec(value)?.[1] ?? value;
    try {
      name = decodeURIComponent(encoded);
    } catch {
      name = encoded;
    }
  }
  if (!name) {
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition ?? '');
    if (plain) name = (plain[1] ?? plain[2] ?? '').trim();
  }
  if (!name) {
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    } catch {
      name = '';
    }
  }
  name = name
    .replaceAll('\\', '/')
    .split('/')
    .pop()
    .normalize('NFC')
    .replace(/[\p{Cc}<>:"|?*]+/gu, '_')
    .trim()
    .replace(/^\.+/, '');
  if (!name || name.toLowerCase() === 'download') name = 'master';
  return name.slice(-120);
}

// ---------------------------------------------------------------- download

const mbText = (bytes) => `${(bytes / 1e6).toLocaleString('da-DK', { maximumFractionDigits: 1 })} MB`;

/** `promise`, or abort the request and reject when it takes longer than `ms`. */
async function withStall(promise, ctl, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(what);
          ctl.abort(err);
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function open(url) {
  const ctl = new AbortController();
  const res = await withStall(
    fetch(url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': USER_AGENT, accept: '*/*' } }),
    ctl,
    CONNECT_TIMEOUT_MS,
    `intet svar i ${CONNECT_TIMEOUT_MS / 1000} sekunder`,
  );
  if (!res.ok) {
    ctl.abort();
    throw new Stop(httpMessage(res.status));
  }
  const reader = res.body.getReader();
  const read = () => withStall(reader.read(), ctl, STALL_TIMEOUT_MS, `ingen data i ${STALL_TIMEOUT_MS / 1000} sekunder`);
  const first = await read();
  return { res, ctl, read, first: first.done ? new Uint8Array(0) : first.value, done: first.done };
}

function looksLikeHtml(res, first) {
  const head = Buffer.from(first.subarray(0, 1024)).toString('latin1').replace(/^\xEF\xBB\xBF/, '').trimStart();
  if (head) return head.startsWith('<');
  return /text\/html/i.test(res.headers.get('content-type') ?? '');
}

async function readText(conn, limit = 2_000_000) {
  const chunks = [conn.first];
  let size = conn.first.length;
  let done = conn.done;
  while (!done && size < limit) {
    const next = await conn.read();
    done = next.done;
    if (next.value) {
      chunks.push(next.value);
      size += next.value.length;
    }
  }
  conn.ctl.abort();
  return Buffer.concat(chunks).toString('utf8');
}

async function downloadOnce(link, dir) {
  let conn = await open(link.url);
  if (looksLikeHtml(conn.res, conn.first)) {
    const html = await readText(conn);
    const next = link.kind === 'drive' ? driveConfirmUrl(html) : null;
    if (!next) throw new Stop(link.kind === 'drive' ? MSG.driveHtml : link.kind === 'dropbox' ? MSG.dropboxHtml : MSG.html);
    conn = await open(next);
    if (looksLikeHtml(conn.res, conn.first)) {
      conn.ctl.abort();
      throw new Stop(MSG.driveHtml);
    }
  }
  const total = Number(conn.res.headers.get('content-length')) || 0;
  if (total > MAX_DOWNLOAD_BYTES) {
    conn.ctl.abort();
    throw new Stop(`Filen er ${mbText(total)}. Den må højst fylde ${MAX_DOWNLOAD_TEXT} – eksportér en mindre master (fx H.264/HEVC i høj kvalitet).`);
  }
  const name = fileNameFrom(conn.res.headers.get('content-disposition'), conn.res.url || link.url);
  const file = path.join(dir, name);
  console.log(`  ${name}${total ? `, ${mbText(total)}` : ''}`);

  const fh = await fs.promises.open(file, 'w');
  let bytes = 0;
  let reported = 0;
  try {
    let chunk = conn.first;
    let done = conn.done;
    for (;;) {
      if (chunk.length) {
        await fh.write(chunk);
        bytes += chunk.length;
        if (bytes > MAX_DOWNLOAD_BYTES) {
          throw new Stop(`Filen er over ${MAX_DOWNLOAD_TEXT} – eksportér en mindre master (fx H.264/HEVC i høj kvalitet).`);
        }
        const step = total ? Math.floor((bytes / total) * 10) : Math.floor(bytes / 100e6);
        if (step > reported) {
          reported = step;
          console.log(total ? `  ${step * 10} % (${mbText(bytes)})` : `  ${mbText(bytes)} hentet`);
        }
      }
      if (done) break;
      const next = await conn.read();
      done = next.done;
      chunk = next.value ?? new Uint8Array(0);
    }
  } catch (err) {
    conn.ctl.abort();
    throw err;
  } finally {
    await fh.close();
  }
  if (total && bytes !== total) throw new Error(`hentede ${bytes} af ${total} bytes`);
  return { file, name, bytes };
}

async function download(link, dir) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadOnce(link, dir);
    } catch (err) {
      if (err instanceof Stop) throw err;
      const reason = err.cause?.code ?? err.cause?.message ?? err.message;
      if (attempt >= DOWNLOAD_ATTEMPTS) {
        throw new Stop(`Filen kunne ikke hentes (${reason}). Tjek at linket virker i en browser, og prøv igen.`);
      }
      console.log(`  forbindelsen svigtede (${reason}), prøver igen …`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}

// ---------------------------------------------------------------- inspection

function findFfprobe() {
  if (process.env.FFPROBE) return process.env.FFPROBE;
  const exe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  if (process.env.FFMPEG) {
    const sibling = path.join(path.dirname(process.env.FFMPEG), exe);
    if (fs.existsSync(sibling)) return sibling;
  }
  if (spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0) return 'ffprobe';
  const packages = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(packages)) {
    for (const pkg of fs.readdirSync(packages).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      for (const build of fs.readdirSync(path.join(packages, pkg)).sort().reverse()) {
        const candidate = path.join(packages, pkg, build, 'bin', exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error('ffprobe not found: set FFPROBE or put it on PATH');
}

const ratio = (r) => {
  const [n, d] = String(r ?? '').split(/[/:]/).map(Number);
  return d ? n / d : NaN;
};
const secondsText = (s) => (s < 90 ? `${Math.round(s)} sek.` : `${Math.floor(s / 60)} min. ${Math.round(s % 60)} sek.`);

/** ffprobe checks with Danish reasons. Returns facts for the summary plus warnings. */
export async function inspect(file) {
  const result = spawnSync(findFfprobe(), ['-v', 'error', '-of', 'json', '-show_format', '-show_streams', file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  let probe;
  try {
    if (result.status !== 0) throw new Error(result.stderr);
    probe = JSON.parse(result.stdout);
  } catch {
    throw new Stop('Filen kan ikke læses som en video. Er det den rigtige fil (fx en .mp4 eller .mov)?');
  }
  const streams = probe.streams ?? [];
  const videos = streams.filter((s) => s.codec_type === 'video');
  const v = videos.find((s) => !s.disposition?.attached_pic);
  if (!v) throw new Stop('Filen indeholder ingen video. Er det den rigtige fil?');
  if (videos[0] !== v) throw new Stop('Filen har et indlejret coverbillede foran videoen. Eksportér filmen igen uden coverbillede (thumbnail).');
  const warnings = [];

  const rotation = Number(v.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v.tags?.rotate ?? 0);
  if (rotation % 180 !== 0) {
    throw new Stop(`Filen er gemt roteret (${Math.abs(rotation)}°). Eksportér filmen igen i 2048×1340 uden rotation.`);
  }

  const width = v.width;
  const height = v.height;
  const sarValue = ratio(v.sample_aspect_ratio);
  const sar = Number.isFinite(sarValue) && sarValue > 0 ? sarValue : 1;
  const aspect = (width * sar) / height;
  if (!(Math.abs(aspect / (TARGET.width / TARGET.height) - 1) <= ASPECT_TOLERANCE)) {
    const shown = Math.abs(sar - 1) > 1e-3 ? ` (vises som ${Math.round(width * sar)}×${height})` : '';
    throw new Stop(
      `Filmen er ${width}×${height}${shown}. Sitet viser kun film i samme format som de andre: ` +
        '2048×1340 (eller samme forhold, fx 4096×2680). Billedet bliver aldrig beskåret eller strakt, ' +
        'så også almindelig 3:2 som 1920×1280 bliver afvist. Eksportér filmen i 2048×1340, og prøv igen.',
    );
  }
  if (width < MIN_WIDTH) {
    throw new Stop(`Filmen er kun ${width}×${height} pixels. Den skal være mindst ${MIN_WIDTH} pixels bred, helst 2048×1340.`);
  }
  if (width < TARGET.width) {
    warnings.push(`Filmen er ${width}×${height} og bliver skaleret op til 2048×1340 på store skærme. Eksportér gerne i 2048×1340 næste gang.`);
  }

  if (['smpte2084', 'arib-std-b67'].includes(v.color_transfer)) {
    throw new Stop('Filmen er i HDR. Sitet viser film i almindelig SDR (Rec. 709): eksportér filmen i Rec. 709, og prøv igen.');
  }
  if (/^bt2020/.test(v.color_primaries ?? '') || /^bt2020/.test(v.color_space ?? '')) {
    throw new Stop('Filmen er gemt i farverummet Rec. 2020. Sitet viser film i Rec. 709: eksportér filmen i Rec. 709, og prøv igen.');
  }
  const fps = ratio(v.r_frame_rate);
  const avg = ratio(v.avg_frame_rate);
  if (Number.isFinite(fps) && Number.isFinite(avg) && avg > 0 && Math.abs(avg / fps - 1) > 0.01) {
    throw new Stop('Filmen har skiftende billedhastighed (variable frame rate). Eksportér den med fast billedhastighed, fx 25 fps, og prøv igen.');
  }

  const duration = Number(probe.format?.duration) || Number(v.duration) || 0;
  if (duration < 0.5) throw new Stop('Filen er ikke en film (den varer under et halvt sekund).');
  if (duration > MAX_SECONDS) {
    throw new Stop(
      `Filmen varer ${secondsText(duration)}. Sitet tager film på op til ${MAX_SECONDS / 60} minutter, ` +
        'fordi hver videofil skal holdes under 25 MB. Kontakt udvikleren, hvis der skal være plads til længere film.',
    );
  }
  if (duration > LONG_SECONDS) {
    warnings.push('Filmen er over et minut lang. For at holde hver videofil under 25 MB kan billedkvaliteten være skruet lidt ned.');
  }

  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!audio) warnings.push('Filmen har ingen lyd. Den lægges op med et stille lydspor.');

  return { width, height, duration, fps, codec: v.codec_name, audio: Boolean(audio), warnings };
}

// ---------------------------------------------------------------- slug

/** "Vågne op!" -> "vaagne-op". */
export function slugify(title) {
  const slug = String(title)
    .normalize('NFC')
    .toLowerCase()
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'oe')
    .replace(/å/g, 'aa')
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'film';
}

export function uniqueSlug(base, taken) {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

function takenSlugs(films) {
  const taken = new Set(films.map((f) => f.slug));
  if (fs.existsSync(OUT)) for (const d of fs.readdirSync(OUT)) taken.add(d);
  if (fs.existsSync(MANIFEST)) for (const s of Object.keys(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).films ?? {})) taken.add(s);
  return taken;
}

// ---------------------------------------------------------------- helpers

function cleanText(value, label, max) {
  const text = String(value ?? '')
    .normalize('NFC')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) throw new Stop(`Der mangler en ${label}.`);
  if (text.length > max) throw new Stop(`${label[0].toUpperCase()}${label.slice(1)} må højst være ${max} tegn.`);
  return text;
}

function parseArgs(argv) {
  const opts = {};
  const keys = new Set(['link', 'titel', 'kunde', 'summary-file']);
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(argv[i]);
    if (!m || !keys.has(m[1])) throw new Error(`unknown argument ${argv[i]}\nusage: node scripts/add-film.mjs --link <url> --titel <titel> [--kunde SALTY]`);
    opts[m[1]] = m[2] ?? argv[++i];
  }
  return opts;
}

/** Escapes text for GitHub's Markdown job summary. */
const md = (s) => String(s).replace(/[\\`*_{}[\]<>|#!]/g, '\\$&');
/** Escapes a workflow-command message (::error::). */
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function setOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(''));
}

function encode(slug, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENCODE, `--only=${slug}`, `--source=${file}`], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => resolve(code));
  });
}

// ---------------------------------------------------------------- main

let cleanup = () => {};

async function main() {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      cleanup();
      process.exit(130);
    });
  }
  const args = parseArgs(process.argv.slice(2));
  const titel = cleanText(args.titel, 'titel', 80);
  const kunde = cleanText(String(args.kunde ?? '').trim() || 'SALTY', 'kunde', 60);
  const link = resolveLink(args.link);

  // Read the list first: a broken film.yaml should stop us before a long download.
  if (!fs.existsSync(FILM_YAML)) throw new Stop(`${FILM_YAML_NAME} findes ikke.`);
  const { films } = parseFilms(fs.readFileSync(FILM_YAML, 'utf8'));
  const slug = uniqueSlug(slugify(titel), takenSlugs(films));
  if (!SLUG_RE.test(slug)) throw new Error(`bad slug ${slug}`);
  // Dry run of the film.yaml edit: a title that can't be written stops us before the download and encode.
  appendFilm(fs.readFileSync(FILM_YAML, 'utf8'), { slug, titel, kunde });
  const dir = path.join(OUT, slug);
  console.log(`Titel: ${titel}  (kunde: ${kunde})\nAdresse: ${SITE}/film/${slug}\n`);

  const tmp = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'toniworks-film-'));
  const manifestBefore = fs.existsSync(MANIFEST) ? fs.readFileSync(MANIFEST) : null;
  let done = false;
  cleanup = () => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!done) {
      fs.rmSync(dir, { recursive: true, force: true });
      if (manifestBefore) fs.writeFileSync(MANIFEST, manifestBefore);
    }
  };

  try {
    let master;
    if (link.kind === 'local') {
      master = { file: link.file, name: path.basename(link.file), bytes: fs.statSync(link.file).size };
      console.log(`Bruger filen ${link.file}`);
    } else {
      console.log(`Henter filmen${link.kind === 'dropbox' ? ' fra Dropbox' : link.kind === 'drive' ? ' fra Google Drive' : ''} …`);
      master = await download(link, tmp);
      console.log(`  hentet: ${mbText(master.bytes)}`);
    }

    console.log('\nTjekker filen …');
    const info = await inspect(master.file);
    console.log(`  ${info.width}×${info.height}, ${secondsText(info.duration)}, ${info.codec}${info.audio ? ', med lyd' : ', uden lyd'}`);
    for (const w of info.warnings) console.log(ON_GITHUB ? `::warning::${escapeData(w)}` : `  Bemærk: ${w}`);

    console.log(`\nKoder hele filmen (${slug}) …${ON_GITHUB ? '\n::group::Kodning (encode-media.mjs)' : ''}`);
    const code = await encode(slug, master.file);
    if (ON_GITHUB) console.log('::endgroup::');
    if (code !== 0) {
      throw new Stop('Kodningen af filmen fejlede (se loggen ovenfor). Filmen er ikke tilføjet. Prøv igen, og kontakt udvikleren, hvis det sker igen.');
    }
    const entry = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).films?.[slug];
    if (!entry || typeof entry.controlsScrim !== 'boolean') throw new Error(`media-manifest.json has no complete entry for ${slug}`);

    // Re-read: the list may have been edited while we encoded (locally).
    const text = fs.readFileSync(FILM_YAML, 'utf8');
    const updated = appendFilm(text, { slug, titel, kunde });
    fs.writeFileSync(FILM_YAML, updated);
    done = true;

    const count = parseFilms(updated).films.length;
    const files = fs.readdirSync(dir);
    const bytes = files.reduce((sum, f) => sum + fs.statSync(path.join(dir, f)).size, 0);
    const url = `${SITE}/film/${slug}`;
    const facts = [
      ['Titel', titel],
      ['Kunde', kunde],
      ['Adresse', url],
      ['Længde', secondsText(entry.master.durationSec)],
      ['Plads', `sidst på forsiden (nr. ${count} af ${count})`],
      ['Filer', `src/assets/films/${slug}/ – ${files.length} filer, ${mbText(bytes)}`],
      ['Mørk bjælke bag afspillerens knapper', entry.controlsScrim ? 'ja (bunden af filmen er lys)' : 'nej'],
    ];

    console.log('\nFilmen er tilføjet.\n');
    for (const [k, v] of facts) console.log(`  ${`${k}:`.padEnd(38)} ${v}`);
    for (const w of info.warnings) console.log(`\n  Bemærk: ${w}`);
    console.log(`\nFlyt, omdøb eller skjul filmen i ${FILM_YAML_NAME}: rækkefølgen i filen er rækkefølgen på sitet.`);

    setOutputs({ slug, titel, url });
    if (args['summary-file']) {
      const repo = process.env.GITHUB_REPOSITORY;
      const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com';
      const fileLink = repo ? `[${FILM_YAML_NAME}](${server}/${repo}/blob/main/${FILM_YAML_NAME})` : FILM_YAML_NAME;
      const summary = [
        `## Filmen er tilføjet: ${md(titel)}`,
        '',
        '| | |',
        '|---|---|',
        ...facts.map(([k, v]) => `| ${md(k)} | ${k === 'Adresse' ? `<${v}>` : md(v)} |`),
        '',
        ...info.warnings.map((w) => `> **Bemærk:** ${md(w)}\n`),
        'Siden er opdateret om ca. 2 minutter, når Vercel har bygget.',
        '',
        `Vil I flytte, omdøbe eller skjule filmen? Redigér ${fileLink}: rækkefølgen i filen er rækkefølgen på sitet.`,
        '',
      ].join('\n');
      fs.writeFileSync(args['summary-file'], summary);
    }
  } finally {
    cleanup();
  }
}

function fail(err) {
  const known = err instanceof Stop;
  console.error(`\nFilmen blev ikke tilføjet.\n${known ? err.message : `Uventet fejl: ${err.stack ?? err}`}`);
  const message = known ? err.message : 'Der skete en uventet fejl (se loggen). Prøv igen, og send linket til denne kørsel til udvikleren, hvis det sker igen.';
  if (ON_GITHUB) console.log(`::error title=Filmen blev ikke tilføjet::${escapeData(message)}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Filmen blev ikke tilføjet\n\n${md(message)}\n\nIntet er ændret på sitet.\n`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(fail);
}
