// What the user decides about blocks, applied the same way by every reader:
// the layer rules of codetac.structure.json come before the reader's (first
// match wins), a file's reclassification wins over both, and AI suggestions
// (codetac structure --suggest) only fill what is still Unknown, and only
// while the file is unchanged. `classes` is Map(path → { path, layer, rule,
// runsOn? }), changed in place; the problems found are returned as notes.
import { readSuggestions } from './suggest.mjs';
import { t } from './text.mjs';

export function applyUserLayers(folder, files, classes, config) {
  const notes = [];
  const unusedLayers = new Set(config.layers.map(rule => rule.pattern));
  for (const [path, item] of classes) {
    const rule = config.layers.find(candidate => candidate.test(path));
    if (!rule) continue;
    unusedLayers.delete(rule.pattern);
    classes.set(path, { ...item, layer: rule.layer, rule: `config:${rule.pattern}` });
  }
  for (const pattern of unusedLayers) notes.push({ message: t('notes.layerRuleUnused', { pattern }) });
  for (const [path, layer] of Object.entries(config.reclassify)) {
    if (classes.has(path)) classes.set(path, { ...classes.get(path), layer, rule: 'manual' });
    else notes.push({ message: t('notes.reclassifyMissing', { path }) });
  }
  const suggestions = readSuggestions(folder);
  for (const file of files) {
    const item = classes.get(file.path);
    const suggestion = suggestions[file.path];
    if (item.layer === 'unknown' && item.rule !== 'manual' && suggestion?.hash === file.hash && suggestion.block !== 'unknown') {
      classes.set(file.path, { ...item, layer: suggestion.block, rule: 'ai-suggestion', suggested: true });
    }
  }
  return notes;
}
