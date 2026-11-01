const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", ".github", "workflows", "docker.yml");
const text = fs.readFileSync(file, "utf8");
const lines = text.split("\n");

let problems = [];
lines.forEach((l, i) => {
  if (l.includes("\t")) problems.push(`第 ${i + 1} 行含制表符`);
  const m = l.match(/^(\s*)- name: (.*)$/);
  if (m) {
    const indent = m[1].length;
    if (indent % 2 !== 0) problems.push(`第 ${i + 1} 行 step 缩进不是偶数: ${indent}`);
  }
});

// 只统计 GitHub 表达式 ${{ ... }}，排除 Go 模板与 docker inspect 的字面量 {{...}}
const exprRe = /\$\{\{[\s\S]*?\}\}/g;
const exprCount = (text.match(exprRe) || []).length;
// 去掉已知字面量模式后再检查是否有残留的未闭合表达式
const leftover = text
  .replace(exprRe, "")
  .replace(/\{\{[^}]*\}\}/g, "") // Go 模板 {{version}} / {{major}}.{{minor}}
  .replace(/'\{\{[^}]*\}\}'/g, "") // docker inspect -f '{{.RestartCount}}'
  .match(/\}\}/g) || [];

console.log("结构问题:", problems.length ? problems.join("; ") : "无");
console.log(`GitHub 表达式: ${exprCount} 个，残留未闭合: ${leftover.length} ${leftover.length === 0 ? "✓" : "✗"}`);

// GitHub Actions 禁止在步骤级 if 条件里引用 secrets 上下文，
// 会让整个 workflow 解析失败（run 瞬间失败、没有任何 job）。
lines.forEach((l, i) => {
  if (/^\s*if:/.test(l) && /secrets\./.test(l)) {
    problems.push(`第 ${i + 1} 行在 if 里引用了 secrets（GitHub Actions 禁止，会导致 workflow 解析失败）`);
  }
});
console.log("secrets-in-if 检查:", problems.some((p) => p.includes("if 里引用")) ? "✗ 存在违规" : "✓ 无违规");

console.log("\n--- jobs ---");
lines.forEach((l) => {
  const m = l.match(/^  ([a-z-]+):$/);
  if (m) console.log("  job:", m[1]);
});

console.log("\n--- steps ---");
lines.forEach((l) => {
  const m = l.match(/^\s*- name: (.*)$/);
  if (m) console.log("  -", m[1]);
});

console.log("\n--- 关键字段 ---");
["REGISTRY:", "DOCKERHUB_IMAGE:", "DOCKERHUB_USERNAME", "DOCKERHUB_TOKEN", "steps.images.outputs.list", "secrets.GITHUB_TOKEN"].forEach((k) => {
  const n = (text.match(new RegExp(k.replace(/[.$]/g, "\\$&"), "g")) || []).length;
  console.log(`  ${k} 出现 ${n} 次`);
});

// YAML 解析（js-yaml 若可用）
try {
  const yaml = require("js-yaml");
  const doc = yaml.load(text);
  console.log("\n✓ YAML 解析成功");
  console.log("  jobs:", Object.keys(doc.jobs).join(", "));
  console.log("  publish.steps:", doc.jobs.publish.steps.length, "步");
  console.log("  test.steps:", doc.jobs.test.steps.length, "步");
} catch (e) {
  console.log("\n(js-yaml 不可用，跳过解析校验:", e.message.split("\n")[0] + ")");
}
