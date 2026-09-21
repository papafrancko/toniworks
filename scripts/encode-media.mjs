#!/usr/bin/env node
/**
 * Media pipeline: a film's master -> src/assets/films/<slug>/
 *
 *   full-2048.av1.mp4 / full-2048.h264.mp4   2048x1340 (native)
 *   full-1280.av1.mp4 / full-1280.h264.mp4   1280x838 (lanczos)
 *   poster.jpg                               frame 0 of full-2048.h264.mp4
 *
 * Every file is the WHOLE film: first to last frame, same framing, same mix.
 * Nothing is cut, trimmed, looped or re-edited; only codec and pixel size
 * change. The one thing dropped is the 60-80 ms of AAC that runs past the
 * last video frame in the masters (audio ends with the picture). A master
 * whose sound ends early is padded with silence to the last frame; one with
 * no sound at all gets a silent track, so every file has the same layout.
 * Every file is tagged BT.709 limited range; an untagged master is read as
 * BT.709 (masters tagged BT.709, like the launch films, pass through as is).
 *
 * Every file must stay under 25 MB. A file that comes out larger is encoded
 * again with a lower bitrate cap (H.264) and/or a higher CRF until it fits
 * (see BUDGET_FILL); the CRF (and cap) used is recorded in the manifest.
 *
 * Usage:  npm run media                  encode missing files, verify all
 *         npm run media -- --force       re-encode everything
 *         npm run media -- --only=loeb,slik
 *         npm run media -- --only=<slug> --source=<master>   any film, any master
 *         npm run media -- --selftest    check that ffmpeg has what the pipeline needs
 *
 * Without --source the masters are the launch films in materiale/opslag/ (not
 * in git), limited to the films listed in src/content/film.yaml. Films added
 * later with scripts/add-film.mjs have no master here: re-encode one with
 * --only=<slug> --source=<master> --force.
 *
 * Existing files are kept as they are (not re-encoded) unless --force.
 *
 * ffmpeg/ffprobe: env FFMPEG / FFPROBE, else PATH, else the winget Gyan build.
 * Writes src/data/media-manifest.json (codec strings, sizes, controls contrast,
 * and per film `controlsScrim`, which the site reads).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SLUG_RE, readFilms } from './film-yaml.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTERS = path.join(ROOT, 'materiale', 'opslag');
const OUT = path.join(ROOT, 'src', 'assets', 'films');
const MANIFEST = path.join(ROOT, 'src', 'data', 'media-manifest.json');

/** The launch films and their masters in materiale/opslag/. */
const FILMS = [
  { slug: 'loeb', master: 'Film1_løb_final_opslag.mp4' },
  { slug: 'sauna', master: 'Film2_sauna_final_opslag.mp4' },
  { slug: 'morgen', master: 'Film3_alene_final_opslag.mp4' },
  { slug: 'slik', master: 'Film4_slik_final_opslag.mp4' },
  { slug: 'vaagne', master: 'Film5_vågne_final_opslag.mp4' },
  { slug: 'pakke', master: 'Film6_pakke_final_opslag.mp4' },
];

// MEDIA_BUDGET_MB exists to exercise the retry path in tests; the site's budget is 25.
const BUDGET_BYTES = Number(process.env.MEDIA_BUDGET_MB || 25) * 1024 * 1024;
/*
 * A file over budget is encoded again, aiming at 95 % of the budget:
 *  - H.264 first keeps its CRF and lowers the VBV cap (maxrate) to the
 *    budget's average rate (capped CRF: only the heaviest passages give way).
 *    Grain can sit at the cap whatever the CRF, so raising the CRF alone may
 *    not shrink the file at all.
 *  - Then (and for AV1, which has no cap) the CRF goes up. The first step
 *    assumes the size halves every 4 (x264) / 6 (SVT-AV1) CRF steps, later
 *    steps use the slope measured so far, at most +10 per step.
 *  - When a big step lands far under budget (< 80 %), one more attempt tries
 *    the CRF interpolated between the last miss and the fit, so a film
 *    doesn't lose more quality than it has to.
 * For vaagne (30 s of grain), 2048 H.264 CRF 20 gave 35.7 MB; it is kept at
 * CRF 22 (20.9 MB) from before this rule, which would now give CRF 20 capped
 * at ~6.1 Mbit/s instead.
 */
const BUDGET_FILL = 0.95;
const REFINE_BELOW = 0.8;
const CRF_PER_HALVING = { h264: 4, av1: 6 };
const MAX_CRF_STEP = 10;
const MAX_CRF = { h264: 51, av1: 63 };
const MAX_ATTEMPTS = 6;
const AUDIO_BPS = 192_000;
const CAP_BUFFER_SEC = 1;
const GOP_SECONDS = 2;
const AUDIO = ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2'];
const COLOR = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv'];
const SCALE_FLAGS = 'lanczos+accurate_rnd+full_chroma_int';

/*
 * Calibrated on morgen (darkest grade) against the master:
 * - x264 aq-mode 3 biases bits towards dark flat areas and keeps the grain in
 *   the shadows (aq-mode 1 smears it into blotches). CRF 20: VMAF 95.4.
 * - SVT-AV1 at defaults smooths shadow grain into blotchy contours. Temporal
 *   filtering off + ac-bias + variance boost + luminance-qp-bias keep it, at
 *   ~60 % of the H.264 size (VMAF-equal AV1 would be far smaller but visibly
 *   blotchier in the dark areas).
 */
const X264 = ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-tune', 'film', '-x264-params', 'aq-mode=3'];
const SVTAV1 = [
  '-c:v', 'libsvtav1', '-preset', '5',
  '-svtav1-params', 'tune=0:enable-tf=0:ac-bias=1.0:enable-variance-boost=1:luminance-qp-bias=50',
];

const VARIANTS = [
  // 2048 H.264 first: the poster is taken from it.
  { file: 'full-2048.h264.mp4', codec: 'h264', width: 2048, height: 1340, crf: 20, maxrate: '10M', bufsize: '20M' },
  { file: 'full-2048.av1.mp4', codec: 'av1', width: 2048, height: 1340, crf: 28 },
  { file: 'full-1280.h264.mp4', codec: 'h264', width: 1280, height: 838, crf: 20, maxrate: '5M', bufsize: '10M' },
  { file: 'full-1280.av1.mp4', codec: 'av1', width: 1280, height: 838, crf: 28 },
];
/** The size every film is shown at; poster and controls measurement use it. */
const FRAME = { width: VARIANTS[0].width, height: VARIANTS[0].height };

/*
 * Where the film-page player's white text sits, in 2048x1340 pixels,
 * derived from the layout with a few px margin:
 *  - desktop: padding 0 64 28, 16 px row, glyph 10 + gap 18 + "0:18 / 0:18"
 *    (~75 px) left, "lyd til" (~44 px) right; union over video boxes
 *    1100-1440 CSS px wide (the height cap narrows the box).
 *  - mobile: padding 0 20 14, ~15 px row, glyph 9 + gap 12 + time (~69 px),
 *    "lyd til" (~40 px); boxes 360-430 CSS px wide.
 * The play/pause glyph is small next to the time's box, so a bright patch
 * under it can hide in that box's p75: it gets boxes of its own, measured in
 * the built player (union of pause bars and play triangle, +3 px): mobile
 * 360-430 CSS px wide, tablet (768-1199 px viewports, 40 px margin, desktop
 * controls) and desktop (boxes 966-1443 px wide).
 * "strip-*" is the coarse envelope (bottom 7 %, left third / right fifth),
 * reported for reference only.
 */
const CONTROL_REGIONS = [
  { name: 'desktop-time', x0: 85, x1: 318, y0: 1251, y1: 1306, text: true },
  { name: 'desktop-sound', x0: 1839, x1: 1963, y0: 1251, y1: 1306, text: true },
  { name: 'mobile-time', x0: 81, x1: 643, y0: 1158, y1: 1288, text: true },
  { name: 'mobile-sound', x0: 1690, x1: 1967, y0: 1158, y1: 1288, text: true },
  { name: 'desktop-glyph', x0: 88, x1: 164, y0: 1246, y1: 1302, glyph: true },
  { name: 'tablet-glyph', x0: 67, x1: 142, y0: 1224, y1: 1292, glyph: true },
  { name: 'mobile-glyph', x0: 92, x1: 174, y0: 1181, y1: 1269, glyph: true },
  { name: 'strip-left', x0: 0, x1: 683, y0: 1246, y1: 1340, text: false },
  { name: 'strip-right', x0: 1638, x1: 2048, y0: 1246, y1: 1340, text: false },
];
const CONTROL_SAMPLE_EVERY = 5; // frames
const MIN_CONTRAST = 4.5; // WCAG AA, white 13 px text
const MIN_GLYPH_CONTRAST = 3; // WCAG AA, non-text (the play/pause glyph)
/** The contrast a region's background must give white: text 4.5:1, glyph 3:1. */
const required = (region) => (region.glyph ? MIN_GLYPH_CONTRAST : MIN_CONTRAST);
/*
 * Scrim when, in any text or glyph box, more than a quarter of the background
 * (p75) is too bright for its contrast for longer than "a brief moment".
 */
const SCRIM_PERCENTILE = 0.75;
const SCRIM_TOLERANCE_SEC = 0.5;

// ---------------------------------------------------------------- tools

function findTool(name) {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const fromEnv = process.env[name.toUpperCase()];
  if (fromEnv) return fromEnv;
  if (name === 'ffprobe' && process.env.FFMPEG) {
    const sibling = path.join(path.dirname(process.env.FFMPEG), exe);
    if (fs.existsSync(sibling)) return sibling;
  }
  if (spawnSync(name, ['-version'], { stdio: 'ignore' }).status === 0) return name;
  const packages = path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
    'Microsoft', 'WinGet', 'Packages',
  );
  if (fs.existsSync(packages)) {
    for (const pkg of fs.readdirSync(packages).filter((d) => d.startsWith('Gyan.FFmpeg'))) {
      for (const build of fs.readdirSync(path.join(packages, pkg)).sort().reverse()) {
        const candidate = path.join(packages, pkg, build, 'bin', exe);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  throw new Error(`${name} not found: set ${name.toUpperCase()}, put it on PATH or install Gyan.FFmpeg via winget`);
}

const FFMPEG = findTool('ffmpeg');
const FFPROBE = findTool('ffprobe');
// SVT-AV1 logs its banner to stderr regardless of ffmpeg's loglevel.
const ENV = { ...process.env, SVT_LOG: '2' };

function run(cmd, args, { binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${path.basename(cmd)} exited ${code}\n${args.join(' ')}\n${err.trim()}`));
      const buf = Buffer.concat(out);
      resolve(binary ? buf : buf.toString('utf8'));
    });
  });
}

const ffmpeg = (args, opts) => run(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...args], opts);
const ffprobeJson = async (args) => JSON.parse(await run(FFPROBE, ['-v', 'error', '-of', 'json', ...args]));

async function checkEncoders() {
  const encoders = await run(FFMPEG, ['-hide_banner', '-encoders']);
  const missing = ['libx264', 'libsvtav1', ' aac ', ' mjpeg '].filter((enc) => !encoders.includes(enc));
  if (missing.length) throw new Error(`ffmpeg (${FFMPEG}) lacks encoder(s): ${missing.map((e) => e.trim()).join(', ')}`);
}

// ---------------------------------------------------------------- probing

function masterPath(name) {
  if (!fs.existsSync(MASTERS)) {
    throw new Error(`${path.relative(ROOT, MASTERS)} not found (the masters are not in git): pass --only=<slug> --source=<master>`);
  }
  // Match on NFC so "ø"/"å" survive whatever normalisation the filesystem uses.
  const wanted = name.normalize('NFC');
  const hit = fs.readdirSync(MASTERS).find((f) => f.normalize('NFC') === wanted);
  if (!hit) throw new Error(`master not found: ${path.join(MASTERS, name)}`);
  return path.join(MASTERS, hit);
}

const ratio = (r) => {
  const [n, d] = String(r).split(/[/:]/).map(Number);
  return n / d;
};
/** Display aspect ratio as a number; unknown / 0:1 sample aspect counts as square pixels. */
const displayAspect = (s) => {
  const sar = ratio(s?.sample_aspect_ratio ?? '1:1');
  return (s?.width * (Number.isFinite(sar) && sar > 0 ? sar : 1)) / s?.height;
};

async function probeMaster(file) {
  const { streams } = await ffprobeJson([
    '-count_frames', '-select_streams', 'v:0',
    '-show_entries',
    'stream=width,height,sample_aspect_ratio,r_frame_rate,nb_read_frames,duration,color_range,color_space,color_transfer,color_primaries',
    file,
  ]);
  const v = streams[0];
  if (!v) throw new Error(`no video stream in ${file}`);
  const { streams: audio } = await ffprobeJson(['-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,duration', file]);
  const fps = ratio(v.r_frame_rate);
  const frames = Number(v.nb_read_frames);
  const durationSec = frames / fps;
  const a = audio[0];
  return {
    width: v.width,
    height: v.height,
    aspect: displayAspect(v),
    fps,
    rFrameRate: v.r_frame_rate,
    frames,
    durationSec,
    /** Tagged BT.709, limited range (every launch master): encoded as is. */
    bt709: v.color_primaries === 'bt709' && v.color_transfer === 'bt709' && v.color_space === 'bt709' && v.color_range === 'tv',
    colorSpace: v.color_space,
    audio: a
      ? // Unknown length counts as short: padding is a no-op when the sound is long enough.
        { sampleRate: Number(a.sample_rate), short: !(Number(a.duration) >= durationSec - 1e-3) }
      : null,
  };
}

/** Reads avcC / av1C from the sample description to build the RFC 6381 string. */
function videoCodecString(file) {
  const buf = fs.readFileSync(file);
  const hex = (n) => n.toString(16).padStart(2, '0');
  const avcC = buf.indexOf('avcC');
  if (avcC > 0) {
    const p = avcC + 4; // configurationVersion, profile, compatibility, level
    return `avc1.${hex(buf[p + 1])}${hex(buf[p + 2])}${hex(buf[p + 3])}`;
  }
  const av1C = buf.indexOf('av1C');
  if (av1C > 0) {
    const p = av1C + 4;
    const profile = buf[p + 1] >> 5;
    const level = buf[p + 1] & 0x1f;
    const tier = buf[p + 2] >> 7 ? 'H' : 'M';
    const highBitdepth = (buf[p + 2] >> 6) & 1;
    const twelveBit = (buf[p + 2] >> 5) & 1;
    const depth = highBitdepth ? (twelveBit ? 12 : 10) : 8;
    return `av01.${profile}.${String(level).padStart(2, '0')}${tier}.${String(depth).padStart(2, '0')}`;
  }
  throw new Error(`no avcC/av1C box in ${file}`);
}

const AAC_OBJECT_TYPES = { LC: 2, 'HE-AAC': 5, 'HE-AACv2': 29 };

async function verifyVideo(file, variant, master) {
  const problems = [];
  const { streams, format } = await ffprobeJson([
    '-count_frames',
    '-show_entries',
    'stream=codec_type,codec_name,profile,width,height,sample_aspect_ratio,display_aspect_ratio,pix_fmt,nb_read_frames,duration,start_time,' +
      'color_range,color_space,color_transfer,color_primaries,sample_rate,channels:format=duration,size',
    file,
  ]);
  const video = streams.filter((s) => s.codec_type === 'video');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  if (streams.length !== 2 || video.length !== 1 || audio.length !== 1) {
    problems.push(`streams: ${streams.map((s) => s.codec_type).join('+')} (want exactly video+audio)`);
  }
  const v = video[0];
  const a = audio[0];
  const frames = Number(v?.nb_read_frames);
  const vDur = Number(v?.duration);
  const aDur = Number(a?.duration);
  const fDur = Number(format.duration);
  const bytes = Number(format.size);
  const wantCodec = variant.codec === 'h264' ? 'h264' : 'av1';
  const wantPix = variant.codec === 'h264' ? 'yuv420p' : 'yuv420p10le';

  if (v?.codec_name !== wantCodec) problems.push(`video codec ${v?.codec_name}`);
  if (v?.pix_fmt !== wantPix) problems.push(`pix_fmt ${v?.pix_fmt}`);
  if (v?.width !== variant.width || v?.height !== variant.height) problems.push(`size ${v?.width}x${v?.height}`);
  // 1280x838 is not exactly 512:335, so scale sets SAR 1676:1675: the picture displays at the master's shape.
  if (Math.abs(displayAspect(v) / master.aspect - 1) > 1e-4) {
    problems.push(`display aspect ${v?.display_aspect_ratio} != master ${master.aspect.toFixed(5)}`);
  }
  if (frames !== master.frames) problems.push(`frames ${frames} != master ${master.frames}`);
  if (Math.abs(vDur - master.durationSec) > 1e-3) problems.push(`video duration ${vDur} != ${master.durationSec}`);
  if (Math.abs(aDur - master.durationSec) > 1e-3) problems.push(`audio duration ${aDur} != ${master.durationSec}`);
  if (Math.abs(fDur - master.durationSec) > 1e-3) problems.push(`container duration ${fDur}`);
  if (Number(v?.start_time) !== 0 || Number(a?.start_time) !== 0) problems.push('stream start_time != 0');
  for (const key of ['color_space', 'color_transfer', 'color_primaries']) {
    if (v?.[key] !== 'bt709') problems.push(`${key} ${v?.[key]}`);
  }
  if (v?.color_range !== 'tv') problems.push(`color_range ${v?.color_range}`);
  if (a?.codec_name !== 'aac' || a?.profile !== 'LC') problems.push(`audio ${a?.codec_name} ${a?.profile}`);
  if (Number(a?.sample_rate) !== 48000 || a?.channels !== 2) problems.push(`audio ${a?.sample_rate} Hz ${a?.channels} ch`);
  if (bytes > BUDGET_BYTES) problems.push(`${mb(bytes)} MB, over the ${mb(BUDGET_BYTES)} MB budget`);

  // Keyframes from packet flags (no decode): one at 0, then at most GOP apart.
  const { packets } = await ffprobeJson(['-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', file]);
  const keys = packets.filter((p) => p.flags.startsWith('K')).map((p) => Number(p.pts_time)).sort((x, y) => x - y);
  if (keys[0] !== 0) problems.push(`first keyframe at ${keys[0]}`);
  const maxGap = Math.max(...keys.slice(1).map((t, i) => t - keys[i]), master.durationSec - keys.at(-1));
  if (maxGap > GOP_SECONDS + 1e-3) problems.push(`keyframe gap ${maxGap.toFixed(2)} s`);

  const audioCodec = `mp4a.40.${AAC_OBJECT_TYPES[a?.profile] ?? 2}`;
  return {
    problems,
    info: {
      width: v?.width,
      height: v?.height,
      frames,
      durationSec: vDur,
      bytes,
      codecsString: `${videoCodecString(file)}, ${audioCodec}`,
      keyframes: keys.length,
    },
  };
}

// ---------------------------------------------------------------- encoding

function tmpPath(file) {
  // Not *.mp4 / *.jpg, so the Astro glob never picks up a half-written file.
  return path.join(path.dirname(file), `.${path.basename(file)}.part`);
}

/** `rate`: { crf, maxrate?, bufsize? }; maxrate/bufsize default to the variant's (H.264 only). */
const codecArgs = (variant, rate) =>
  variant.codec === 'h264'
    ? [...X264, '-crf', String(rate.crf), '-maxrate', rate.maxrate ?? variant.maxrate, '-bufsize', rate.bufsize ?? variant.bufsize]
    : [...SVTAV1, '-crf', String(rate.crf)];

async function encodeVideo(src, out, variant, master, rate) {
  const gop = Math.round(master.fps * GOP_SECONDS);
  const format = variant.codec === 'h264' ? 'yuv420p' : 'yuv420p10le';
  const size = `scale=${variant.width}:${variant.height}:flags=${SCALE_FLAGS}`;
  const vf = master.bt709
    ? [variant.width !== master.width || variant.height !== master.height ? size : null, `format=${format}`]
    : [
        // Untagged or other-tagged master: untagged YUV counts as BT.709; full range and
        // SD matrices are converted; the frames are then tagged BT.709 limited range.
        `${size}${['bt709', 'bt470bg', 'smpte170m', 'smpte240m', 'fcc'].includes(master.colorSpace) ? '' : ':in_color_matrix=bt709'}:out_color_matrix=bt709:out_range=tv`,
        `format=${format}`,
        'setparams=range=tv:color_primaries=bt709:color_trc=bt709:colorspace=bt709',
      ];
  // Audio ends exactly on the last video frame (sample-accurate, no fade);
  // short or missing sound is completed with silence up to that frame.
  const sampleRate = master.audio?.sampleRate ?? 48000;
  const endSample = Math.round(master.durationSec * sampleRate);
  const inputs = master.audio
    ? ['-i', src, '-map', '0:v:0', '-map', '0:a:0']
    : ['-i', src, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-map', '0:v:0', '-map', '1:a:0'];
  const af = `${master.audio && !master.audio.short ? '' : 'apad,'}atrim=end_sample=${endSample}`;
  await ffmpeg([
    '-y', ...inputs, '-dn', '-sn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-fps_mode', 'passthrough',
    '-vf', vf.filter(Boolean).join(','),
    ...codecArgs(variant, rate), '-g', String(gop),
    ...COLOR,
    '-af', af,
    ...AUDIO,
    '-movflags', '+faststart', '-write_tmcd', '0',
    '-f', 'mp4', out,
  ]);
}

const kbps = (rate) => (/M$/.test(rate) ? parseFloat(rate) * 1000 : parseFloat(rate));
const rateText = (r) => `crf ${r.crf}${r.maxrate ? `, maxrate ${r.maxrate}` : ''}`;

/** Video rate (kbit/s) that keeps a capped H.264 file inside the budget, VBV buffer and audio included. */
function budgetKbps(master) {
  const bits = BUDGET_BYTES * BUDGET_FILL * 8 * 0.98; // ~2 % container overhead
  return Math.floor((bits / (master.durationSec + CAP_BUFFER_SEC) - AUDIO_BPS) / 1000);
}

/** Next CRF after over-budget `tries` at the current cap, aiming at BUDGET_FILL of the budget. */
function nextCrf(tries, codec) {
  const last = tries.at(-1);
  let perHalving = CRF_PER_HALVING[codec];
  if (tries.length >= 2) {
    const prev = tries.at(-2);
    const halvings = Math.log2(prev.bytes / last.bytes);
    if (halvings > 0.05) perHalving = Math.min(12, Math.max(2, (last.crf - prev.crf) / halvings));
  }
  const step = Math.round(perHalving * Math.log2(last.bytes / (BUDGET_BYTES * BUDGET_FILL)));
  return Math.min(MAX_CRF[codec], last.crf + Math.min(MAX_CRF_STEP, Math.max(1, step)));
}

/**
 * Encodes `variant` so it fits the budget (see BUDGET_FILL above). Returns the
 * rate used: { crf } or, for a capped H.264, { crf, maxrate, bufsize }.
 */
async function encodeWithinBudget(src, dest, variant, master) {
  const tmp = tmpPath(dest);
  const best = `${tmp}.fit`;
  let rate = { crf: variant.crf };
  let tries = []; // over budget, at the current cap
  let fit = null; // lowest-CRF attempt that fits
  let over = null; // highest-CRF attempt over budget, at the current cap
  let attempts = 0;
  let refined = false;
  try {
    for (;;) {
      const start = Date.now();
      process.stdout.write(`  encode ${variant.file} (${rateText(rate)}) ... `);
      await encodeVideo(src, tmp, variant, master, rate);
      attempts++;
      const bytes = fs.statSync(tmp).size;
      console.log(`${seconds(start)}, ${mb(bytes)} MB`);
      if (bytes <= BUDGET_BYTES) {
        if (!fit || rate.crf < fit.crf) {
          fs.renameSync(tmp, best);
          fit = { ...rate, bytes };
        }
      } else {
        over = { ...rate, bytes };
        tries.push(over);
      }

      if (fit) {
        const canRefine = !refined && over && fit.crf - over.crf > 1 && fit.bytes < BUDGET_BYTES * REFINE_BELOW && attempts < MAX_ATTEMPTS;
        if (!canRefine) break;
        // Size is roughly exponential in CRF: interpolate log(size) towards the target, rounding up.
        const t = Math.log(over.bytes / (BUDGET_BYTES * BUDGET_FILL)) / Math.log(over.bytes / fit.bytes);
        rate = { ...rate, crf: Math.min(fit.crf - 1, Math.max(over.crf + 1, Math.ceil(over.crf + t * (fit.crf - over.crf)))) };
        refined = true;
        console.log(`    ${mb(fit.bytes)} MB leaves room, trying ${rateText(rate)}`);
        continue;
      }
      if (attempts >= MAX_ATTEMPTS || rate.crf >= MAX_CRF[variant.codec]) {
        throw new Error(`${variant.file}: ${mb(bytes)} MB at ${rateText(rate)}, still over the ${mb(BUDGET_BYTES)} MB budget`);
      }
      const cap = budgetKbps(master);
      if (variant.codec === 'h264' && !rate.maxrate && cap < kbps(variant.maxrate)) {
        rate = { ...rate, maxrate: `${cap}k`, bufsize: `${cap * CAP_BUFFER_SEC}k` };
        tries = [];
        over = null;
      } else {
        rate = { ...rate, crf: nextCrf(tries, variant.codec) };
      }
      console.log(`    over the ${mb(BUDGET_BYTES)} MB budget, trying ${rateText(rate)}`);
    }
    fs.renameSync(best, dest);
    const { bytes, ...used } = fit;
    return used;
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(best, { force: true });
  }
}

// BT.709 limited-range YUV -> full-range RGB, with full chroma interpolation.
const TO_RGB = `scale=in_color_matrix=bt709:in_range=tv:out_range=pc:flags=bicubic+accurate_rnd+full_chroma_int+full_chroma_inp,format=rgb24`;

async function encodePoster(h264File, dest) {
  const tmp = tmpPath(dest);
  try {
    // JFIF readers assume BT.601 full range: convert RGB into exactly that.
    await ffmpeg([
      '-y', '-i', h264File, '-map', '0:v:0', '-frames:v', '1',
      '-vf', `${TO_RGB},scale=out_color_matrix=bt601:out_range=pc:flags=accurate_rnd,format=yuvj444p`,
      '-c:v', 'mjpeg', '-q:v', '2', '-map_metadata', '-1',
      '-f', 'image2', '-update', '1', tmp,
    ]);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function rawFrame0(file, filter) {
  return ffmpeg(['-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', filter, '-f', 'rawvideo', '-'], { binary: true });
}

/** Poster vs the video's own frame 0, both decoded to RGB by ffmpeg. */
async function verifyPoster(poster, h264File) {
  const { streams } = await ffprobeJson(['-show_entries', 'stream=width,height,pix_fmt', poster]);
  const jpeg = await rawFrame0(poster, 'scale=in_color_matrix=bt601:in_range=pc:out_range=pc:flags=accurate_rnd+full_chroma_int,format=rgb24');
  const video = await rawFrame0(h264File, TO_RGB);
  const problems = [];
  if (jpeg.length !== video.length) problems.push(`poster ${jpeg.length} bytes vs frame ${video.length}`);
  const sum = [0, 0, 0];
  for (let i = 0; i < Math.min(jpeg.length, video.length); i++) sum[i % 3] += Math.abs(jpeg[i] - video[i]);
  const pixels = video.length / 3;
  const mad = sum.map((s) => +(s / pixels).toFixed(3));
  if (Math.max(...mad) > 1.5) problems.push(`poster differs from frame 0: MAD ${mad.join('/')}`);
  const s = streams[0];
  if (s.width !== FRAME.width || s.height !== FRAME.height) problems.push(`poster size ${s.width}x${s.height}`);
  return {
    problems,
    info: { width: s.width, height: s.height, bytes: fs.statSync(poster).size, pixFmt: s.pix_fmt, madVsFrame0: mad },
  };
}

// ---------------------------------------------------------------- controls contrast

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const LIN = Array.from({ length: 256 }, (_, i) => srgbToLinear(i / 255));
const contrastOnWhite = (lum) => 1.05 / (lum + 0.05);

/**
 * Contrast of white text against the film under the controls, every 5th frame
 * of the whole film (the 2048x1340 H.264 encode). Per sampled frame and region
 * the background luminance is summarised as mean, p75 and p90;
 * contrast = 1.05 / (L + 0.05).
 */
async function measureControls(file, master) {
  const top = Math.min(...CONTROL_REGIONS.map((r) => r.y0));
  const height = FRAME.height - top;
  const width = FRAME.width;
  const raw = await ffmpeg(
    [
      '-i', file, '-map', '0:v:0',
      '-vf', `select='not(mod(n\\,${CONTROL_SAMPLE_EVERY}))',${TO_RGB},crop=${width}:${height}:0:${top}`,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-',
    ],
    { binary: true },
  );
  const frameBytes = width * height * 3;
  const samples = raw.length / frameBytes;
  const step = CONTROL_SAMPLE_EVERY / master.fps;
  const stats = ['mean', 'p75', 'p90'];
  const result = {};
  let scrimSeconds = 0;

  for (const r of CONTROL_REGIONS) {
    const perFrame = [];
    for (let f = 0; f < samples; f++) {
      const lums = [];
      for (let y = r.y0 - top; y < r.y1 - top; y += 2) {
        let i = f * frameBytes + (y * width + r.x0) * 3;
        for (let x = r.x0; x < r.x1; x += 2, i += 6) {
          lums.push(0.2126 * LIN[raw[i]] + 0.7152 * LIN[raw[i + 1]] + 0.0722 * LIN[raw[i + 2]]);
        }
      }
      lums.sort((a, b) => a - b);
      const at = (q) => lums[Math.min(lums.length - 1, Math.floor(lums.length * q))];
      perFrame.push({
        t: f * step,
        mean: lums.reduce((a, b) => a + b, 0) / lums.length,
        p75: at(SCRIM_PERCENTILE),
        p90: at(0.9),
      });
    }
    // secondsBelowAA counts against the region's own AA level (text 4.5:1, glyph 3:1).
    const entry = { requiredContrast: required(r) };
    for (const s of stats) {
      const worst = perFrame.reduce((a, b) => (b[s] > a[s] ? b : a));
      const below = perFrame.filter((p) => contrastOnWhite(p[s]) < required(r)).length * step;
      entry[s] = {
        minContrast: +contrastOnWhite(worst[s]).toFixed(2),
        worstAtSec: +worst.t.toFixed(2),
        secondsBelowAA: +below.toFixed(2),
      };
    }
    result[r.name] = entry;
    if (r.text || r.glyph) scrimSeconds = Math.max(scrimSeconds, entry.p75.secondsBelowAA);
  }
  return {
    sampledFrames: samples,
    everyNthFrame: CONTROL_SAMPLE_EVERY,
    rule:
      `scrim if any text box has p75 background contrast < ${MIN_CONTRAST}:1, or any glyph box < ${MIN_GLYPH_CONTRAST}:1, ` +
      `for > ${SCRIM_TOLERANCE_SEC} s`,
    regions: result,
    recommendScrim: scrimSeconds > SCRIM_TOLERANCE_SEC,
  };
}

// ---------------------------------------------------------------- selftest

/** Encodes a short test clip with the real settings: fails fast on an ffmpeg without them. */
async function selftest() {
  console.log(`ffmpeg: ${FFMPEG}\n${(await run(FFMPEG, ['-hide_banner', '-version'])).split('\n')[0]}`);
  await checkEncoders();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'encode-selftest-'));
  try {
    for (const variant of VARIANTS.slice(0, 2)) {
      const out = path.join(dir, variant.file);
      await ffmpeg([
        '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x210:rate=25:duration=0.4',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-map', '0:v:0', '-map', '1:a:0',
        '-vf', `format=${variant.codec === 'h264' ? 'yuv420p' : 'yuv420p10le'}`,
        ...codecArgs(variant, { crf: variant.crf }), '-g', '50', ...COLOR,
        '-af', 'apad,atrim=end_sample=17640', ...AUDIO,
        '-movflags', '+faststart', '-f', 'mp4', out,
      ]);
      const { streams } = await ffprobeJson(['-show_entries', 'stream=codec_name,pix_fmt,sample_rate', out]);
      const got = streams.map((s) => s.codec_name).join('+');
      const want = `${variant.codec === 'h264' ? 'h264' : 'av1'}+aac`;
      if (got !== want) throw new Error(`selftest ${variant.file}: got ${got}, want ${want}`);
      console.log(`  ${variant.file}: ${got} ok (${videoCodecString(out)})`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('selftest ok: libx264, libsvtav1 (with the pipeline parameters) and aac work');
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const opts = { force: false, only: null, source: null, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') opts.force = true;
    else if (arg === '--selftest') opts.selftest = true;
    else if (arg.startsWith('--only=')) opts.only = arg.slice(7).split(',').filter(Boolean);
    else if (arg.startsWith('--source=')) opts.source = arg.slice(9);
    else if (arg === '--source' && argv[i + 1]) opts.source = argv[++i];
    else throw new Error(`unknown argument ${arg}`);
  }
  return opts;
}

/** Which films to encode/verify, and from which master. */
function selectJobs(opts) {
  if (opts.source) {
    if (opts.only?.length !== 1) throw new Error('--source needs exactly one film: --only=<slug> --source=<master>');
    const [slug] = opts.only;
    if (!SLUG_RE.test(slug)) throw new Error(`invalid slug "${slug}" (lowercase a-z, 0-9 and single dashes)`);
    const src = path.resolve(opts.source);
    if (!fs.statSync(src, { throwIfNoEntry: false })?.isFile()) throw new Error(`master not found: ${src}`);
    return [{ slug, src }];
  }
  const known = (slug) => FILMS.find((f) => f.slug === slug);
  if (opts.only) {
    return opts.only.map((slug) => {
      if (!known(slug)) throw new Error(`${slug}: no master in materiale/opslag; use --only=${slug} --source=<master>`);
      return { slug, src: masterPath(known(slug).master) };
    });
  }
  // Launch films still on the list (a film removed with remove-film.mjs stays removed).
  const listed = readFilms()?.map((f) => f.slug) ?? null;
  const jobs = [];
  for (const film of FILMS) {
    if (listed && !listed.includes(film.slug)) console.log(`skip ${film.slug}: not in src/content/film.yaml`);
    else jobs.push({ slug: film.slug, src: masterPath(film.master) });
  }
  for (const slug of listed ?? []) {
    if (!known(slug)) console.log(`skip ${slug}: no master here (added with add-film); re-encode with --only=${slug} --source=<master>`);
  }
  return jobs;
}

const seconds = (start) => `${((Date.now() - start) / 1000).toFixed(1)} s`;
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) return selftest();
  await checkEncoders();
  console.log(`ffmpeg: ${FFMPEG}`);
  const jobs = selectJobs(opts);

  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
  // Existing films keep their place; new ones are appended.
  const films = manifest.films ?? {};
  const rows = [];
  const failures = [];

  for (const film of jobs) {
    const src = film.src;
    const master = await probeMaster(src);
    const dir = path.join(OUT, film.slug);
    fs.mkdirSync(dir, { recursive: true });
    console.log(`\n${film.slug}  ${path.basename(src)}  ${master.width}x${master.height} ${master.frames} frames ${master.durationSec} s`);
    if (!master.audio) console.log('  no audio in the master: adding a silent track');
    else if (master.audio.short) console.log('  audio ends before the last frame: padding with silence');

    const previous = films[film.slug];
    const entry = {
      controlsScrim: false,
      master: { file: path.basename(src).normalize('NFC'), width: master.width, height: master.height, frames: master.frames, durationSec: master.durationSec, fps: master.rFrameRate },
      files: {},
    };
    let posterStale = opts.force;

    for (const variant of VARIANTS) {
      const dest = path.join(dir, variant.file);
      // A kept file keeps the rate it was made with.
      // A file without a manifest record (e.g. left by an aborted run) is made again.
      const kept = previous?.files?.[variant.file];
      let rate = { crf: kept?.crf ?? variant.crf, ...(kept?.maxrate ? { maxrate: kept.maxrate } : {}) };
      if (opts.force || !fs.existsSync(dest) || kept?.crf === undefined) {
        const { crf, maxrate } = await encodeWithinBudget(src, dest, variant, master);
        rate = { crf, ...(maxrate ? { maxrate } : {}) };
        if (variant.file === 'full-2048.h264.mp4') posterStale = true;
      }
      const { problems, info } = await verifyVideo(dest, variant, master);
      entry.files[variant.file] = { ...info, ...rate };
      rows.push({ slug: film.slug, file: variant.file, ...info, problems });
      problems.forEach((p) => failures.push(`${film.slug}/${variant.file}: ${p}`));
    }

    const h264 = path.join(dir, 'full-2048.h264.mp4');
    const poster = path.join(dir, 'poster.jpg');
    if (posterStale || !fs.existsSync(poster)) {
      process.stdout.write('  poster.jpg (frame 0 of full-2048.h264.mp4) ... ');
      await encodePoster(h264, poster);
      console.log('ok');
    }
    const posterCheck = await verifyPoster(poster, h264);
    entry.files['poster.jpg'] = { ...posterCheck.info, source: 'full-2048.h264.mp4 frame 0' };
    rows.push({ slug: film.slug, file: 'poster.jpg', ...posterCheck.info, frames: 1, durationSec: 0, codecsString: `jpeg ${posterCheck.info.pixFmt}`, problems: posterCheck.problems });
    posterCheck.problems.forEach((p) => failures.push(`${film.slug}/poster.jpg: ${p}`));

    process.stdout.write('  measuring controls contrast ... ');
    entry.controls = await measureControls(h264, master);
    entry.controlsScrim = entry.controls.recommendScrim;
    console.log(entry.controls.recommendScrim ? 'scrim recommended' : 'no scrim needed');

    films[film.slug] = entry;
  }

  const out = {
    $comment: 'Generated by scripts/encode-media.mjs (npm run media). Do not edit by hand.',
    films,
  };
  fs.writeFileSync(MANIFEST, `${JSON.stringify(out, null, 2)}\n`);

  console.log('\n');
  const table = rows.map((r) => ({
    film: r.slug,
    file: r.file,
    size: `${r.width}x${r.height}`,
    frames: r.frames,
    sec: r.durationSec,
    MB: mb(r.bytes) + (r.bytes > BUDGET_BYTES ? ' OVER 25 MB' : ''),
    codecs: r.codecsString,
    check: r.problems.length ? 'FAIL' : 'ok',
  }));
  console.table(table);
  for (const { slug } of jobs) {
    const c = films[slug].controls;
    const worst = CONTROL_REGIONS.filter((r) => r.text || r.glyph)
      .map((r) => `${r.name} p75 min ${c.regions[r.name].p75.minContrast}:1 (${c.regions[r.name].p75.secondsBelowAA} s < ${required(r)})`)
      .join(', ');
    console.log(`controls ${slug}: ${c.recommendScrim ? 'SCRIM' : 'no scrim'} — ${worst}`);
  }
  console.log(`\nmanifest: ${path.relative(ROOT, MANIFEST)}`);
  if (failures.length) {
    console.error(`\nVerification failed:\n  ${failures.join('\n  ')}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exitCode = 1;
});
