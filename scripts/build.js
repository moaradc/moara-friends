/**
 * Build script for moara-friends
 *
 * Scans data/friends/*.json, validates, sorts (vip first, then pinyin),
 * and writes friends.json to repo root.
 *
 * Run:  node scripts/build.js
 *
 * Designed to be invoked by .github/workflows/build.yml on every push to main.
 * The workflow commits the regenerated friends.json back to the repo,
 * so jsDelivr can serve it directly without any external hosting.
 *
 * Field schema (per file):
 *   name        string  required  站点名称
 *   cover      string|null  optional  封面
 *   avatar      string|null  optional  头像 URL（缺失时前端可用 favicon 服务兜底）
 *   url         string  required  站点 URL (http/https)
 *   description string  optional  简介/描述
 *   vip         boolean optional  仅站主直推 main 时可设；PR 携带会被 auto-pr.yml 拒绝
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_FRIENDS = path.join(ROOT, 'data', 'friends');
const OUT_FILE = path.join(ROOT, 'friends.json');

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function isNullOrString(v) {
  return v === null || typeof v === 'string';
}
function isHttpUrl(v) {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function loadAndValidate(dir) {
  if (!fs.existsSync(dir)) {
    console.warn(`⚠️  ${dir} not found`);
    return [];
  }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const result = [];
  let errors = 0;

  for (const f of files) {
    const fullPath = path.join(dir, f);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(fullPath, 'utf-8'));
    } catch (e) {
      console.error(`  ❌ ${f}: JSON 解析失败 - ${e.message}`);
      errors++;
      continue;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      console.error(`  ❌ ${f}: JSON 必须是对象`);
      errors++;
      continue;
    }

    const errs = [];
    if (!isNonEmptyString(data.name)) errs.push('name 必填且为非空字符串');
    if (!isNonEmptyString(data.url)) errs.push('url 必填且为非空字符串');
    else if (!isHttpUrl(data.url)) errs.push('url 必须是 http/https URL');
    if (data.avatar !== undefined && !isNullOrString(data.avatar))
      errs.push('avatar 必须是字符串或 null（或省略）');
    if (data.description !== undefined && typeof data.description !== 'string')
      errs.push('description 必须是字符串');
    if (data.cover !== undefined && !isNullOrString(data.cover))
      errs.push('cover 必须是字符串或 null（或省略）');
    if (data.vip !== undefined && typeof data.vip !== 'boolean')
      errs.push('vip 必须是 boolean');
    // backlink 字段：build 不强制要求（PR 校验在 auto-pr.yml 里做），
    // 但若有则必须是字符串。backlink 不会写入输出 friends.json（前端不需要）
    if (data.backlink !== undefined && typeof data.backlink !== 'string')
      errs.push('backlink 必须是字符串');

    if (errs.length) {
      console.error(`  ❌ ${f}: ${errs.join('; ')}`);
      errors++;
      continue;
    }

    // 输出标准化字段顺序，避免 git diff 噪音
    // backlink 不输出（仅用于 PR 反链验证，前端展示不需要）
    const out = {
      name: data.name,
    };
    if (data.cover !== undefined) out.cover = data.cover;
    if (data.avatar !== undefined) out.avatar = data.avatar;
    out.url = data.url;
    if (data.description !== undefined) out.description = data.description;
    if (data.vip === true) out.vip = true;

    result.push(out);
  }

  console.log(`   → ${result.length}/${files.length} friends loaded${errors ? `, ${errors} invalid` : ''}`);
  return result;
}

function sortFriends(arr) {
  // vip 优先；同级按 name 拼音排序（zh-CN）
  return arr.sort((a, b) => {
    if (a.vip && !b.vip) return -1;
    if (!a.vip && b.vip) return 1;
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

console.log('\n📦 Loading friends from data/friends/ ...');
const friends = loadAndValidate(DATA_FRIENDS);
const sorted = sortFriends(friends);

// 如果有无效文件，输出错误信息但不阻断构建（跳过无效文件继续）
// 无效文件不会进入 friends.json，站主需要手动修复
if (friends.length === 0 && sorted.length === 0) {
  console.error('\n❌ 没有有效的友链数据，friends.json 将为空数组');
}

const json = JSON.stringify(sorted, null, 2) + '\n';
fs.writeFileSync(OUT_FILE, json, 'utf-8');

console.log(`\n✅ Wrote ${sorted.length} friends to ${path.relative(ROOT, OUT_FILE)}`);
console.log(`   Size: ${Buffer.byteLength(json, 'utf-8')} bytes`);
console.log(`   jsDelivr URL: https://cdn.jsdelivr.net/gh/moaradc/moara-friends@main/friends.json`);

if (sorted.some((f) => f.vip)) {
  console.log(`   VIP entries: ${sorted.filter((f) => f.vip).map((f) => f.name).join(', ')}`);
}
