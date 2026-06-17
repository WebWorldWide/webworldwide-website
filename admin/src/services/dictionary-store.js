// @ts-check
/**
 * dictionary-store.js — the writer's spell-check preferences: the custom
 * dictionary (words the proofreader should never flag) and the checking
 * language. Backing store: `site/data/dictionary.json`
 * (`{ language: string, words: string[] }`), next to `redirects.json`.
 *
 * Used by `routes/proofread.js` to (a) pick the LanguageTool language and
 * (b) drop spelling matches for accepted words — engine-agnostic, so it
 * works no matter how LanguageTool is configured. Edited from the editor
 * ("Add to dictionary") and from Settings.
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { writeFileAtomic } from '../utils/atomicWrite.js';

const SITE_DIR = process.env.SITE_DIR || join(process.cwd(), '..', 'site');
const DICT_JSON = join(SITE_DIR, 'data', 'dictionary.json');

// LanguageTool language codes we expose in the UI. Anything else is
// rejected so a typo can't wedge the checker into an unsupported locale.
export const SUPPORTED_LANGUAGES = [
  'en-US',
  'en-GB',
  'en-CA',
  'en-AU',
  'de-DE',
  'fr',
  'es',
  'pt-BR',
];
const DEFAULT_LANGUAGE = 'en-US';

/**
 * Normalize a single dictionary word: trimmed, collapsed, lowercased.
 * @param w
 */
function normWord(w) {
  return String(w || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * Read the spell-check config. Returns a stable shape even when the file
 * is missing/corrupt; `wordSet` is a lowercase Set for O(1) lookups.
 *
 * @returns {{ language: string, words: string[], wordSet: Set<string> }}
 */
export function readDictionary() {
  let language = DEFAULT_LANGUAGE;
  let words = [];
  if (existsSync(DICT_JSON)) {
    try {
      const parsed = JSON.parse(readFileSync(DICT_JSON, 'utf-8'));
      if (parsed && typeof parsed === 'object') {
        if (SUPPORTED_LANGUAGES.includes(parsed.language)) language = parsed.language;
        if (Array.isArray(parsed.words)) words = parsed.words.map(normWord).filter(Boolean);
      }
    } catch (err) {
      console.warn('[dictionary] parse failed; using defaults:', err.message);
    }
  }
  // De-dupe while preserving order.
  words = [...new Set(words)];
  return { language, words, wordSet: new Set(words) };
}

/**
 * Persist the config atomically. Coerces to the safe shape: a supported
 * language and a de-duped, normalized word list.
 *
 * @param {{ language?: string, words?: string[] }} next
 * @returns {{ language: string, words: string[] }}
 */
export function writeDictionary(next) {
  const language = SUPPORTED_LANGUAGES.includes(next?.language) ? next.language : DEFAULT_LANGUAGE;
  const words = [
    ...new Set((Array.isArray(next?.words) ? next.words : []).map(normWord).filter(Boolean)),
  ];
  mkdirSync(dirname(DICT_JSON), { recursive: true });
  writeFileAtomic(DICT_JSON, JSON.stringify({ language, words }, null, 2) + '\n');
  return { language, words };
}

/**
 * Add a single word to the dictionary (the editor's "Add to dictionary").
 * Idempotent. Returns the updated word list.
 *
 * @param {string} word
 * @returns {{ language: string, words: string[] }}
 */
export function addWord(word) {
  const w = normWord(word);
  const current = readDictionary();
  if (!w || current.wordSet.has(w)) return { language: current.language, words: current.words };
  return writeDictionary({ language: current.language, words: [...current.words, w] });
}
