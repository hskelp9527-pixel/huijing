/** Clear image commands need no text-model planning. Complex canvas actions retain tools. */
export function directIntent(text: string): "generate" | "edit" | null {
  if (/排版|对齐|排列|自动迭代|自动修订|layout|align/i.test(text)
    || /^(?:请)?(?:如何|怎么|讨论|分析|how to|explain|brainstorm)/i.test(text.trim())
    || /(?:先|只|仅).{0,5}(?:方案|建议|分析|讨论)/.test(text)) return null;
  if (/改图|修改|改成|换成|编辑|扩图|补绘|扩展(?:画|图)|edit\b|outpaint|expand\b/i.test(text)) return "edit";
  if (/生成|生图|画(?:一|两|三|四|个|张|幅)|绘制|设计(?:一|两|三|四|个|张|幅)|制作(?:一|两|三|四|个|张|幅)|做(?:一|两|三|四|个|张|幅)|generate|draw\b|create.*(?:image|picture)/i.test(text)) return "generate";
  return null;
}

export function wantsQualityReview(text: string) {
  const positive = text.replace(/(?:不需要|无需|不用|不要|不必).{0,6}(?:检查|审查|review)/gi, "");
  return /检查|审查|质量|review/i.test(positive);
}
