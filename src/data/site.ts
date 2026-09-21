import { isScalar, isSeq, type Pair } from 'yaml';
import tekster from '../content/tekster.yaml?raw';
import { ContentFile } from './content-file';

/**
 * Site-wide facts and copy used by the footer, About, the film page and
 * metadata. The name and URL live here; everything the owners may want to
 * reword lives in src/content/tekster.yaml, which they edit on GitHub.
 * Mistakes in that file fail the build with a Danish message.
 */

const file = new ContentFile('src/content/tekster.yaml', tekster);

const root = file.fields(file.doc.contents, ['about', 'kontakt', 'film', 'firma'], 'øverst i filen');
if (!root) {
  file.problem(
    file.doc.contents as { range?: unknown },
    'filen skal have blokkene about:, kontakt:, film: og firma: (se eksemplerne i filen).',
  );
}

interface Block {
  name: string;
  fields: Map<string, Pair>;
  /** The block's own line, for "mangler feltet" messages. */
  at: unknown;
}

/** The fields of one block. An `optional` block may be left out altogether. */
const block = (name: string, allowed: readonly string[], optional = false): Block => {
  const pair = root?.get(name);
  if (!pair) {
    if (root && !optional) file.problem(null, `blokken "${name}:" mangler.`);
    return { name, fields: new Map(), at: undefined };
  }
  const fields = file.fields(pair.value, allowed, `under "${name}:"`);
  if (!fields) {
    file.problem(
      file.at(pair),
      `"${name}:" skal have felterne ${allowed.map((f) => `${f}:`).join(', ')} på linjerne under, rykket to mellemrum ind.`,
    );
  }
  return { name, fields: fields ?? new Map(), at: fields ? file.at(pair) : undefined };
};

/** A text that must be filled in. */
const required = ({ name, fields, at }: Block, field: string): string => {
  const pair = fields.get(field);
  const value = file.text(pair, `"${field}:" under "${name}:"`);
  if (!pair) {
    if (at) file.problem(at as { range?: unknown }, `"${name}:" mangler feltet "${field}:".`);
  } else if (value === '') {
    // After ">-" the text goes on the lines below; written after the colon it is a YAML error.
    const blockScalar =
      isScalar(pair.value) && (pair.value.type === 'BLOCK_FOLDED' || pair.value.type === 'BLOCK_LITERAL');
    file.problem(
      file.at(pair),
      `"${field}:" under "${name}:" er tom. ${blockScalar ? 'Skriv teksten på linjen under >-, rykket ind.' : 'Skriv teksten efter kolon.'}`,
    );
  }
  return value ?? '';
};

/**
 * A text that may be empty ('') or left out. '' written as the text itself
 * (on the line under >-) counts as empty too, not as two apostrophes.
 */
const optional = ({ name, fields }: Block, field: string): string => {
  const value = file.text(fields.get(field), `"${field}:" under "${name}:"`) ?? '';
  return /^(''|"")$/.test(value) ? '' : value;
};

/** A list of texts ("- ..." items). Empty items are skipped; a single text counts as one item. */
const list = ({ name, fields }: Block, field: string): string[] => {
  const value = fields.get(field)?.value;
  if (value && !isSeq(value) && !isScalar(value)) {
    file.problem(
      value as { range?: unknown },
      `"${field}:" under "${name}:" skal være en liste, hvor hvert afsnit starter med "- >-".`,
    );
    return [];
  }
  const items = isSeq(value) ? value.items : [value];
  return items.map((item) => file.scalar(item, `et afsnit under "${field}:"`) ?? '').filter(Boolean);
};

const about = block('about', ['indledning', 'afsnit', 'sidste_linje']);
const kontakt = block('kontakt', ['email', 'tekst', 'instagram', 'by']);
const film = block('film', ['produceret_af']);
const firma = block('firma', ['navn', 'adresse', 'cvr'], true);

const email = required(kontakt, 'email');
if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  file.problem(file.at(kontakt.fields.get('email')), '"email:" skal være en mailadresse, fx hello@toniworks.dk.');
}

// "toni__works", "@toni__works" and a pasted profile link all work.
const instagram = required(kontakt, 'instagram')
  .replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, '')
  .replace(/^@/, '')
  .replace(/[/?].*$/, '');
if (instagram && !/^[A-Za-z0-9._]+$/.test(instagram)) {
  file.problem(file.at(kontakt.fields.get('instagram')), '"instagram:" skal være navnet på Instagram, fx toni__works.');
}

const cvr = optional(firma, 'cvr').replace(/\s+/g, '');
if (cvr && !/^\d{8}$/.test(cvr)) {
  file.problem(file.at(firma.fields.get('cvr')), `"cvr:" skal være 8 cifre, fx 12345678 (eller '' indtil det kendes).`);
}

const values = {
  city: required(kontakt, 'by'),
  contactNote: optional(kontakt, 'tekst'),
  lead: required(about, 'indledning'),
  paragraphs: list(about, 'afsnit'),
  closing: optional(about, 'sidste_linje'),
  producedBy: required(film, 'produceret_af'),
  legalName: optional(firma, 'navn'),
  address: optional(firma, 'adresse'),
};

file.stopIfProblems();

export const site = {
  name: 'TONI Works',
  url: 'https://www.toniworks.dk',
  email,
  instagram: { handle: `@${instagram}`, url: `https://www.instagram.com/${instagram}/` },
  city: values.city,
  /** "Tobias Franck-Winther og Nicolas Kaiser": film credit line, About description, photo alt. */
  founders: values.producedBy,
  /**
   * Company details required by e-handelsloven § 7 (name, address, CVR).
   * Rendered under the copyright line only when filled in.
   */
  company: {
    legalName: values.legalName,
    address: values.address,
    cvr,
  },
};

/** Page copy from tekster.yaml. */
export const texts = {
  about: {
    /** The About h1. */
    lead: values.lead,
    paragraphs: values.paragraphs,
    /** The dim last line; '' = not rendered. */
    closing: values.closing,
  },
  /** Dim line under the footer mail address; '' = not rendered. */
  contactNote: values.contactNote,
};
