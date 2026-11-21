import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assetDirs, scanAssets, searchAssets, formatHits } from "../src/assets.js";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppt-assets-"));
  const dir = path.join(root, "assets");
  fs.mkdirSync(path.join(dir, "flowers"), { recursive: true });
  fs.mkdirSync(path.join(dir, "icons"), { recursive: true });
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  for (const f of ["flowers/rose.png", "flowers/sunflower.jpg", "icons/arrow_right.svg", "icons/cat.png", "notes.txt"]) fs.writeFileSync(path.join(dir, f), png);
  fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify([
    { file: "flowers/rose.png", tags: ["flower", "rose", "花", "玫瑰"], description: "红色玫瑰", license: "CC0" },
    { file: "icons/cat.png", tags: "cat,猫", description: "a cat icon" },
  ]));
  return { root, dir };
}

test("assetDirs: default <root>/assets, array and ';' string forms, missing dirs dropped", () => {
  const { root, dir } = fixture();
  assert.deepEqual(assetDirs(root), [dir]);
  assert.deepEqual(assetDirs(root, "assets;nope"), [dir]);
  assert.deepEqual(assetDirs(root, ["assets", path.join(root, "also-missing")]), [dir]);
  assert.deepEqual(assetDirs(path.join(root, "empty")), []);
});

test("scanAssets: images only, index.json metadata attached (array or comma-string tags)", () => {
  const { root } = fixture();
  const all = scanAssets(root);
  assert.deepEqual(all.map((a) => a.rel).sort(), ["flowers/rose.png", "flowers/sunflower.jpg", "icons/arrow_right.svg", "icons/cat.png"]);
  const rose = all.find((a) => a.rel === "flowers/rose.png")!;
  assert.equal(rose.license, "CC0");
  assert.ok(rose.tags.includes("玫瑰"));
  assert.deepEqual(all.find((a) => a.rel === "icons/cat.png")!.tags, ["cat", "猫"]);
});

test("search: tags/filenames/CJK all work and are ranked sensibly", () => {
  const { root } = fixture();
  const all = scanAssets(root);
  const flower = searchAssets(all, "flower");
  assert.equal(flower[0].rel, "flowers/rose.png", "tagged 'flower' beats substring match");
  assert.ok(flower.some((h) => h.rel === "flowers/sunflower.jpg"), "substring (sunflower) still found");
  assert.equal(searchAssets(all, "玫瑰")[0].rel, "flowers/rose.png");
  assert.equal(searchAssets(all, "花")[0].rel, "flowers/rose.png");
  assert.equal(searchAssets(all, "猫 cat")[0].rel, "icons/cat.png");
  assert.equal(searchAssets(all, "arrow")[0].rel, "icons/arrow_right.svg", "file name tokens (split on _)");
  assert.deepEqual(searchAssets(all, "dinosaur"), []);
  assert.deepEqual(searchAssets(all, "   "), []);
  assert.equal(searchAssets(all, "flower", 1).length, 1);
});

test("formatHits shows absolute path, description, tags and license", () => {
  const { root } = fixture();
  const text = formatHits(searchAssets(scanAssets(root), "rose"));
  assert.match(text, /rose\.png/);
  assert.match(text, /红色玫瑰/);
  assert.match(text, /CC0/);
});
