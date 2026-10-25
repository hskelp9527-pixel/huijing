/** Only the frozen user request grants a revision; child/provider text cannot grant permission. */
export function allowsAutomaticRevision(text: string) {
  if (/不允许\s*自动迭代|不要\s*自动迭代|禁止\s*自动迭代|无需\s*自动迭代|(?:do\s+not|don't|never|disallow)\s+(?:allow\s+)?auto(?:matic)?\s+iteration/i.test(text)) return false;
  return /允许\s*自动迭代|\ballow\s+auto(?:matic)?\s+iteration\b/i.test(text);
}
