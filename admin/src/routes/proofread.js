// @ts-check
/**
 * proofread.js — same-origin proxy to the self-hosted LanguageTool service,
 * plus the writer's custom-dictionary management.
 *
 * The editor calls `POST /api/proofread` (behind the /api auth gate) with
 * the post's plain text; we forward it to LanguageTool's `/v2/check` and
 * return a trimmed, stable match shape. Keeping it server-side means the
 * browser never needs a cross-origin connect-src exception, and the
 * LanguageTool container is never exposed publicly.
 *
 * The custom dictionary (words the writer accepted) is applied HERE, not in
 * LanguageTool, so it works regardless of how the engine is configured:
 * spelling matches for accepted words are dropped before returning.
 *
 * Everything degrades gracefully: if LanguageTool is unreachable (still
 * starting, down, or absent in dev) we return 503 and the editor simply
 * shows no squiggles rather than breaking typing.
 *
 *   POST /api/proofread                 { text, language? } → { matches, language }
 *   GET  /api/proofread/dictionary      → { language, words }
 *   POST /api/proofread/dictionary      { word }            → { language, words }
 *   PUT  /api/proofread/dictionary      { language, words } → { language, words }
 */

import { Router } from 'express';
import {
  readDictionary,
  writeDictionary,
  addWord,
  SUPPORTED_LANGUAGES,
} from '../services/dictionary-store.js';

const router = Router();

const LT_URL = process.env.LANGUAGETOOL_URL || 'http://languagetool:8010/v2';
// LanguageTool's own request cap is ~60k chars; mirror it so we fail fast
// with a clear code instead of forwarding a doomed request.
const MAX_TEXT = 60_000;

router.post('/', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text : '';
  if (!text.trim()) return res.json({ matches: [] });
  if (text.length > MAX_TEXT) return res.status(413).json({ error: 'text_too_large' });

  const dict = readDictionary();
  // Client may pass a language; otherwise use the configured one. Reject
  // anything unsupported so a bad value can't wedge the checker.
  const reqLang = typeof req.body?.language === 'string' ? req.body.language : '';
  const language = SUPPORTED_LANGUAGES.includes(reqLang) ? reqLang : dict.language;

  try {
    const params = new URLSearchParams();
    params.set('text', text);
    params.set('language', language);
    // Don't nag about smart-quotes/dashes in a Markdown editor — those are
    // typographical preferences the build handles, not writing errors.
    params.set('disabledCategories', 'TYPOGRAPHY');

    const r = await fetch(`${LT_URL}/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
      signal: AbortSignal.timeout(9000),
    });
    if (!r.ok) {
      console.warn('[proofread] LanguageTool returned', r.status);
      return res.status(502).json({ error: 'proofreader_unavailable' });
    }
    const data = await r.json();
    const matches = [];
    for (const m of Array.isArray(data.matches) ? data.matches : []) {
      const cat = m.rule?.category?.id || '';
      const issueType = m.rule?.issueType || '';
      // Bucket into the three squiggle styles the editor renders.
      const kind =
        issueType === 'misspelling' || cat === 'TYPOS'
          ? 'spelling'
          : issueType === 'style' || cat === 'STYLE' || cat === 'REDUNDANCY'
            ? 'style'
            : 'grammar';
      // Drop spelling flags for words the writer added to their dictionary.
      if (kind === 'spelling' && typeof m.offset === 'number' && typeof m.length === 'number') {
        const flagged = text
          .slice(m.offset, m.offset + m.length)
          .trim()
          .toLowerCase();
        if (flagged && dict.wordSet.has(flagged)) continue;
      }
      matches.push({
        offset: m.offset,
        length: m.length,
        message: m.message || '',
        shortMessage: m.shortMessage || '',
        replacements: (Array.isArray(m.replacements) ? m.replacements : [])
          .slice(0, 8)
          .map((x) => x.value)
          .filter((v) => typeof v === 'string'),
        rule: m.rule?.id || '',
        category: cat,
        kind,
      });
    }
    res.json({ matches, language: data.language?.code || language });
  } catch (err) {
    console.warn('[proofread] check failed:', err instanceof Error ? err.message : err);
    res.status(503).json({ error: 'proofreader_unavailable' });
  }
});

// ── Custom dictionary ────────────────────────────────────────────────
router.get('/dictionary', (_req, res) => {
  const { language, words } = readDictionary();
  res.json({ language, words, supported: SUPPORTED_LANGUAGES });
});

// Append one word (editor "Add to dictionary").
router.post('/dictionary', (req, res) => {
  const word = typeof req.body?.word === 'string' ? req.body.word : '';
  if (!word.trim()) return res.status(400).json({ error: 'word required' });
  res.json(addWord(word));
});

// Replace the whole config (Settings panel).
router.put('/dictionary', (req, res) => {
  const language = req.body?.language;
  const words = Array.isArray(req.body?.words)
    ? req.body.words
    : typeof req.body?.words === 'string'
      ? req.body.words.split('\n')
      : [];
  res.json(writeDictionary({ language, words }));
});

export default router;
