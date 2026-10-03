// The sentences of the StructureTAC interface (phase 12, step 5 of the
// specification): every one lives in text/<language>.json, ready to be
// translated; the code only names them. The plan page gets the same file from
// the panel and uses the same rules (plural by "one"/"other", {name} holes).
import { readFileSync } from 'node:fs';

export const LANGUAGE = 'en';
export const TEXT = JSON.parse(readFileSync(new URL(`./text/${LANGUAGE}.json`, import.meta.url), 'utf8'));

// The plan page with its sentences in place (the panel serves this).
export function planPageWithText(page, text = TEXT) {
  const json = JSON.stringify({ layers: text.layers, plan: text.plan }).replace(/</g, '\\u003c');
  return page.replace('/*CODETAC_TEXT*/null', () => json);
}

// The Diff's report page (phase D3) with its sentences.
export function reportPageWithText(page, text = TEXT) {
  return page.replace('/*CODETAC_TEXT*/null', () => JSON.stringify({ report: text.report }).replace(/</g, '\\u003c'));
}

// The Privacy page (phase 10, step 5) with its sentences.
export function privacyPageWithText(page, text = TEXT) {
  return page.replace('/*CODETAC_TEXT*/null', () => JSON.stringify({ privacy: text.privacy }).replace(/</g, '\\u003c'));
}

// The live window (phase L3) with its sentences.
export function livePageWithText(page, text = TEXT) {
  return page.replace('/*CODETAC_TEXT*/null', () => JSON.stringify({ live: { page: text.live.page } }).replace(/</g, '\\u003c'));
}

// t('card.files', { count: 2 }) → "2 files". An unknown key is a bug: it throws.
export function t(key, vars = {}, text = TEXT) {
  let value = key.split('.').reduce((node, part) => node?.[part], text);
  if (value && typeof value === 'object' && 'other' in value) value = vars.count === 1 ? value.one : value.other;
  if (typeof value !== 'string') throw new Error(`No text for ${key}.`);
  return value.replace(/\{(\w+)\}/g, (hole, name) => (name in vars ? String(vars[name]) : hole));
}
