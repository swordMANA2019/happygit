import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverSkills, skillDirs, type SkippedSkill } from "../src/skills.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "skills-test-"));
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skills-out-"));
const base = path.join(root, ".agent", "skills");
after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); });

const mk = (rel: string, file: string, content: string) => {
  const d = path.join(base, rel);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, file), content, "utf8");
};

mk("plain", "SKILL.md", "---\nname: plain\ndescription: Plain one-line description\nverify: {python} \"{skill_dir}/check.py\" {changed}\nverify_ext: .pptx, .docx\n---\nbody text\n");
mk("crlf", "SKILL.md", "---\r\nname: crlf\r\ndescription: Windows line endings\r\n---\r\nbody\r\n");
mk("folded", "SKILL.md", "---\nname: folded\ndescription: >\n  A long description written\n  over several lines\nverify_ext: .md\n---\nbody\n");
mk("folded-strip", "SKILL.md", "---\nname: folded-strip\ndescription: >-\n  Strip chomping\n\n  with a blank line inside\n---\nbody\n");
mk("literal", "SKILL.md", "---\nname: literal\ndescription: |\n  Block scalar description\n---\nbody\n");
mk("continued", "SKILL.md", "---\nname: continued\ndescription: Starts here\n  and continues indented\n---\nbody\n");
mk("leading-blank", "SKILL.md", "\n\n---\nname: leadingblank\ndescription: blank lines before the frontmatter\n---\nbody\n");
mk("quoted", "SKILL.md", "---\nname: \"quoted\"\ndescription: 'single quoted desc'\n---\nbody\n");
mk("bom", "SKILL.md", "\uFEFF---\nname: bom\ndescription: has a BOM\n---\nbody\n");
mk("no-name", "SKILL.md", "---\ndescription: name defaults to the folder name\n---\nbody\n");
mk("lowercase-file", "skill.md", "---\nname: lowercase\ndescription: file is named skill.md\n---\nbody\n");
// problems that must be reported, not silently ignored
mk("no-desc", "SKILL.md", "---\nname: nodesc\n---\nbody\n");
mk("no-frontmatter", "SKILL.md", "# just markdown\n");
mk("group/inner", "SKILL.md", "---\nname: inner\ndescription: nested one level too deep\n---\nbody\n");
mk("empty-dir", "README.txt", "not a skill");

test("discoverSkills reads the common SKILL.md layouts", async () => {
  const skipped: SkippedSkill[] = [];
  const found = new Map((await discoverSkills(root, skipped)).filter((s) => s.source === "project").map((s) => [s.name, s]));
  const d = (n: string) => found.get(n)?.description;

  assert.equal(d("plain"), "Plain one-line description");
  assert.equal(d("crlf"), "Windows line endings");
  assert.equal(d("folded"), "A long description written over several lines", "description: > must not become the literal '>'");
  assert.equal(d("folded-strip"), "Strip chomping with a blank line inside");
  assert.equal(d("literal"), "Block scalar description", "description: | must not become the literal '|'");
  assert.equal(d("continued"), "Starts here and continues indented");
  assert.equal(d("leadingblank"), "blank lines before the frontmatter");
  assert.equal(d("quoted"), "single quoted desc");
  assert.equal(d("bom"), "has a BOM");
  assert.equal(d("no-name"), "name defaults to the folder name");
  assert.equal(d("lowercase"), "file is named skill.md");

  // verify / verify_ext survive (values contain quotes, braces and colons)
  const plain = found.get("plain")!;
  assert.equal(plain.verify, "{python} \"{skill_dir}/check.py\" {changed}");
  assert.deepEqual(plain.verifyExt, [".pptx", ".docx"]);
  assert.deepEqual(found.get("folded")!.verifyExt, [".md"]);
  assert.equal(found.get("plain")!.body.trim(), "body text");

  for (const bad of ["nodesc", "inner"]) assert.equal(found.has(bad), false, `${bad} must not be loaded`);
});

test("skipped candidates are reported with an actionable reason", async () => {
  const skipped: SkippedSkill[] = [];
  await discoverSkills(root, skipped);
  const why = (name: string) => skipped.find((s) => path.basename(s.dir) === name)?.reason ?? "";
  assert.match(why("no-desc"), /缺少 description/);
  assert.match(why("no-frontmatter"), /缺少 description/);
  assert.match(why("group"), /一层/, "nested skill: tell the user to move it up one level");
  assert.match(why("group"), /inner/);
  assert.match(why("empty-dir"), /没有 SKILL\.md/);
  assert.equal(skipped.some((s) => path.basename(s.dir) === "plain"), false, "good skills are not reported");
});

test("a symlink / junction to a skill folder is followed", async (t) => {
  fs.mkdirSync(path.join(outside, "shared-skill"));
  fs.writeFileSync(path.join(outside, "shared-skill", "SKILL.md"), "---\nname: shared\ndescription: reached through a link\n---\nbody\n");
  try { fs.symlinkSync(path.join(outside, "shared-skill"), path.join(base, "linked"), "junction"); }
  catch { t.skip("cannot create symlinks/junctions here"); return; }
  const found = (await discoverSkills(root)).find((s) => s.name === "shared");
  assert.ok(found, "linked skill folder is discovered");
  assert.equal(found!.description, "reached through a link");
});

test("search locations are listed in priority order", async () => {
  const dirs = skillDirs(root);
  assert.deepEqual(dirs.map((l) => l.source), ["builtin", "user", "project", "project"]);
  assert.equal(dirs[2].dir, path.join(root, ".agent", "skills"));
  assert.equal(dirs[3].dir, path.join(root, ".cursor", "skills"));
});

test("regression: the built-in skills still parse (name, description, verify)", async () => {
  const builtin = (await discoverSkills(root)).filter((s) => s.source === "builtin");
  const names = builtin.map((s) => s.name);
  for (const n of ["pptx", "blackbox-testing"]) assert.ok(names.includes(n), `built-in skill ${n} is loaded`);
  for (const s of builtin) {
    assert.ok(s.description.length > 5 && !/^[>|]$/.test(s.description), `${s.name}: sane description (${JSON.stringify(s.description)})`);
    assert.ok(s.body.trim().length > 20, `${s.name}: has a body`);
  }
  const pptx = builtin.find((s) => s.name === "pptx")!;
  assert.ok(pptx.verify && pptx.verify.includes("{skill_dir}"), "pptx keeps its verify command");
});
