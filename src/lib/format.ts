export function normalizeText(value: string): string {
  return value
    .toLocaleLowerCase("nl")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(podcast|episode|aflevering|spotify|with|met)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function similarity(a: string, b: string): number {
  const left = new Set(normalizeText(a).split(" ").filter(Boolean));
  const right = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) {
    return 0;
  }
  const intersection = [...left].filter((word) => right.has(word)).length;
  const union = new Set([...left, ...right]).size;
  return intersection / union;
}
