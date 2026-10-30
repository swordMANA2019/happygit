import "dotenv/config";
import path from "node:path";

export const ROOT = path.resolve(process.env.AGENT_ROOT ?? process.cwd());
export const MODEL = process.env.AGENT_MODEL ?? "gpt-4o-mini";
export const MAX_STEPS = Number(process.env.AGENT_MAX_STEPS ?? 25);

export const IGNORE = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out",
  "coverage", ".venv", "__pycache__", ".cache",
]);

export const TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".py", ".go", ".rs",
  ".java", ".c", ".h", ".cpp", ".sh", ".yml", ".yaml", ".toml",
  ".css", ".html", ".sql",
]);