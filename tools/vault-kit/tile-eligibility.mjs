export const MAX_LEVEL_BY_NODE = new Map([
  [1, 15],
  [2, 15],
  [3, 15],
  [29, 15],
  [30, 15],
]);

export function nodeSupportsKamiLevel(node, level) {
  const numericLevel = Number(level);
  if (!Number.isFinite(numericLevel) || numericLevel < 1) return false;
  const maxLevel = MAX_LEVEL_BY_NODE.get(Number(node));
  return maxLevel === undefined || numericLevel <= maxLevel;
}
