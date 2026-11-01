// src/intent.ts
export type Mode = "ask" | "edit" | "fix";

const FIX_WORDS = /(修复|修好|改正|bug|缺陷|报错|失败|不通过|重构|实现|加上|改成|删除|创建|生成|写一个)/i;
const ASK_WORDS = /(为什么|什么意思|怎么工作|原理|区别|哪个更好|介绍|解释|读一下|看一下|分析)/i;

export function classify(input: string): { mode: Mode; confidence: number } {
  const t = input.trim();
  // 显式指令优先
  if (t.startsWith("/fix ")) return { mode: "fix", confidence: 1 };
  if (t.startsWith("/edit ")) return { mode: "edit", confidence: 1 };
  if (t.startsWith("/ask ")) return { mode: "ask", confidence: 1 };

  const fix = FIX_WORDS.test(t) ? 1 : 0;
  const ask = ASK_WORDS.test(t) ? 1 : 0;
  if (fix && !ask) return { mode: "fix", confidence: 0.8 };
  if (ask && !fix) return { mode: "ask", confidence: 0.8 };
  // 含代码块或文件路径 → 大概率是编辑
  if (/(```|\.ts|\.py|src\/)/.test(t)) return { mode: "edit", confidence: 0.6 };
  return { mode: "ask", confidence: 0.5 };
}