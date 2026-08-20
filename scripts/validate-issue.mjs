/**
 * scripts/validate-issue.mjs
 *
 * Issue 路径校验脚本，被 .github/workflows/issue-bot.yml 调用。
 * 按 Issue 标题前缀路由操作：[Friend Link] 新增 / [Edit] 修改 / [Delete] 删除。
 * 修改/删除需域名所有权验证（验证码 moara-friends=<Issue编号>）。
 * 评论命令 /recheck、/edit、/delete 仅在上述三种前缀的 Issue 上生效
 * （仅 Issue 创建者和管理员可触发），在其余 Issue / PR 上无任何作用。
 *
 * 入口：runIssueBot({ mode, github, core, context, env })
 *   - opened：处理刚提交的 Issue（按标题前缀自动路由，无需评论）
 *   - command：处理 Issue 评论中的斜杠命令
 *   - review：扫描所有开放友链 Issue（手动 dispatch 用）
 *
 * 校验规则与 PR 路径（validate-pr.mjs）一致，共享 lib/validate.mjs。
 * 幂等靠评论里的隐藏 marker；bot 以 github-actions[bot] 身份提交。
 *
 * Issue body 由 apply.html 生成。新增/修改共用申请模板（Site Name / Site URL /
 * Friend Page URL / Avatar URL / Cover URL / Short Description / Filename），
 * 删除只需 Filename 一个字段。
 */

import {
  SITE_URL,
  validateFields,
  checkSsrf,
  checkBacklinkDomainConsistency,
  checkUrlReachable,
  checkBacklink,
  validateFilename,
  normalizeFilename,
  standardizeFriendData,
  verifyDnsTxt,
  verifyFile,
  sleep,
  getHostname,
} from './lib/validate.mjs';

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// ========== 常量 ==========
// Issue 标题前缀 → 操作类型
const ISSUE_TITLE_PREFIXES = {
  add: '[Friend Link]',
  edit: '[Edit]',
  delete: '[Delete]',
};
const MARKER_ACCEPTED = '<!-- moara-friends-bot:accepted -->';
const MARKER_EDITED = '<!-- moara-friends-bot:edited -->';
const MARKER_DELETED = '<!-- moara-friends-bot:deleted -->';
const MARKER_REJECTED = '<!-- moara-friends-bot:rejected -->';
// 状态卡片 marker：用于查找本 Issue 中 bot 的「主评论」
// 后续状态更新会编辑这条评论（编辑评论不会触发邮件通知）
const MARKER_STATUS_CARD = '<!-- moara-friends-bot:status-card -->';

// 每种操作「已完成」的 marker（幂等检查用）
const DONE_MARKERS = {
  add: MARKER_ACCEPTED,
  edit: MARKER_EDITED,
  delete: MARKER_DELETED,
};

// 冷却等待（毫秒）。0 = 不等待。
// 预留位置：如果未来发现用户提交 Issue 后回链还没生效（CDN 缓存慢），
// 把这个值调大（如 10 * 60 * 1000 = 10 分钟）即可。
const COOLDOWN_MS = 0;

// 最大处理 Issue 数（防止单 run 处理过多超时）
const MAX_ISSUES_PER_RUN = 50;

// ========== 标题路由 ==========
/**
 * 根据 Issue 标题前缀判断操作类型
 * @returns 'add' | 'edit' | 'delete' | null
 */
export function getIssueAction(title) {
  if (!title) return null;
  if (title.startsWith(ISSUE_TITLE_PREFIXES.add)) return 'add';
  if (title.startsWith(ISSUE_TITLE_PREFIXES.edit)) return 'edit';
  if (title.startsWith(ISSUE_TITLE_PREFIXES.delete)) return 'delete';
  return null;
}

// ========== Issue body 解析 ==========
/**
 * 解析 Issue body 中的固定字段
 * 容忍 "- Site URL:" 这类无空格冒号；重复标签取首次出现；
 * 支持缩进续行折叠
 */
export function parseApplication(body = '') {
  const lines = String(body ?? '').split(/\r?\n/);
  const values = {};
  let currentLabel = null;

  for (const rawLine of lines) {
    const fieldMatch = rawLine.match(/^\s{0,3}-\s*([^:\n]+?)\s*:\s*(.*)$/);
    if (fieldMatch) {
      const label = fieldMatch[1].trim().toLowerCase();
      const value = fieldMatch[2].trim();
      currentLabel = label;
      if (value && !values[label]) values[label] = value;
      continue;
    }
    // 缩进续行折叠进当前字段值（子列表项不折叠）
    if (currentLabel && /^\s{2,}\S/.test(rawLine) && !/^\s{2,}[-*>\d.]\s/.test(rawLine)) {
      const continuation = rawLine.trim();
      if (values[currentLabel]) values[currentLabel] = ` ${values[currentLabel]} ${continuation}`.trim();
    } else {
      currentLabel = null;
    }
  }

  return {
    name:           values['site name'] || '',
    url:            values['site url'] || '',
    friendPageUrl:  values['friend page url'] || '',
    avatar:         values['avatar url'] || '',
    cover:          values['cover url'] || '',
    description:    values['short description'] || '',
    filename:       values['filename'] || '',
  };
}

// ========== 工具：调用 GitHub API ==========
// 通用重试包装：处理瞬时网络抖动（如 fetch failed）
// 对 5xx 和网络错误重试 3 次，4xx 立即失败
async function withRetry(fn, { name = 'api', retries = 3 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const status = e.status || e.response?.status || 0;
      // 4xx (除 429/408) 不重试
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) break;
      if (i < retries - 1) {
        const wait = 1000 * Math.pow(2, i);  // 1s, 2s, 4s
        console.warn(`${name} 失败(${status || 'network'}): ${e.message}，${wait}ms 后重试...`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

async function createComment(octokit, owner, repo, issue_number, body) {
  try {
    await withRetry(
      () => octokit.rest.issues.createComment({ owner, repo, issue_number, body }),
      { name: 'createComment' }
    );
  } catch (e) {
    console.warn(`createComment 最终失败: ${e.message}`);
  }
}

async function closeIssue(octokit, owner, repo, issue_number, state_reason = 'completed') {
  try {
    await withRetry(
      () => octokit.rest.issues.update({ owner, repo, issue_number, state: 'closed', state_reason }),
      { name: 'closeIssue' }
    );
  } catch (e) {
    console.warn(`closeIssue 最终失败: ${e.message}`);
  }
}

async function addLabels(octokit, owner, repo, issue_number, labels) {
  try {
    await withRetry(
      () => octokit.rest.issues.addLabels({ owner, repo, issue_number, labels }),
      { name: 'addLabels' }
    );
  } catch (e) {
    console.warn(`addLabels 最终失败: ${e.message}`);
  }
}

// 状态标签互斥管理：「已互链」「未通过」「已删除」只允许同时存在一个
// 「友链」标签始终保留
// 颜色与 PR 路径（validate-pr.mjs 的 labelColors）保持一致
// 调用方式：syncStatusLabels(octokit, owner, repo, issue_number, '未通过')
//   → add「友链」+「未通过」，remove「已互链」+「已删除」
const STATUS_LABEL_COLORS = {
  '友链': '0e8a16',
  '已互链': '0e8a16',
  '未通过': 'd73a4a',
  '已删除': '6f42c1',
};
const ALL_STATUS_LABELS = ['已互链', '未通过', '已删除'];

async function syncStatusLabels(octokit, owner, repo, issue_number, activeLabel) {
  // 确保 label 存在（友链 + 所有状态标签）
  for (const name of ['友链', activeLabel, ...ALL_STATUS_LABELS]) {
    await ensureLabel(octokit, owner, repo, name, STATUS_LABEL_COLORS[name] || 'ededed');
  }

  // add「友链」+ activeLabel
  const addList = ['友链', activeLabel].filter(l => ALL_STATUS_LABELS.includes(l) ? l !== activeLabel : true);
  // 去重 + 确保包含 activeLabel
  const addSet = new Set(['友链', activeLabel]);
  try {
    await withRetry(
      () => octokit.rest.issues.addLabels({
        owner, repo, issue_number, labels: Array.from(addSet),
      }),
      { name: `addLabels(${Array.from(addSet).join(',')})` }
    );
  } catch (e) {
    console.warn(`syncStatusLabels addLabels 失败: ${e.message}`);
  }

  // remove 互斥的其他状态标签
  const removeList = ALL_STATUS_LABELS.filter(l => l !== activeLabel);
  for (const name of removeList) {
    try {
      await withRetry(
        () => octokit.rest.issues.removeLabel({ owner, repo, issue_number, name }),
        { name: `removeLabel(${name})` }
      );
      console.log(`✓ 删除 tag: ${name}`);
    } catch (e) {
      // 404 = 标签不存在（正常情况），静默跳过
      if (e.status !== 404) {
        console.warn(`removeLabel ${name} 失败: ${e.message}`);
      }
    }
  }
}

// 查找本 Issue 中 bot 发的「状态卡片」主评论（带 MARKER_STATUS_CARD）
// 返回 comment id 或 null
async function findStatusCardComment(octokit, owner, repo, issue_number) {
  try {
    const comments = await withRetry(
      () => octokit.paginate(octokit.rest.issues.listComments, {
        owner, repo, issue_number, per_page: 100,
      }),
      { name: 'listComments' }
    );
    // 倒序找最近一条带 marker 的 bot 评论
    for (let i = comments.length - 1; i >= 0; i--) {
      const c = comments[i];
      if (c.user?.login === 'github-actions[bot]' || c.user?.type === 'Bot') {
        if (c.body && c.body.includes(MARKER_STATUS_CARD)) {
          return c.id;
        }
      }
    }
  } catch (e) {
    console.warn(`findStatusCardComment failed: ${e.message}`);
  }
  return null;
}

// 创建或更新「状态卡片」主评论
// - 首次（找不到主评论）：创建（会触发邮件通知）
// - 后续（找到主评论）：编辑同一条评论（不触发邮件通知）
async function upsertStatusComment(octokit, owner, repo, issue_number, body) {
  const commentId = await findStatusCardComment(octokit, owner, repo, issue_number);
  if (commentId) {
    // 编辑已有评论（不触发邮件）
    try {
      await withRetry(
        () => octokit.rest.issues.updateComment({ owner, repo, comment_id: commentId, body }),
        { name: 'updateComment' }
      );
      return { action: 'updated', commentId };
    } catch (e) {
      console.warn(`updateComment 失败（fallback 到 create）：${e.message}`);
    }
  }
  // 创建新评论（触发邮件）
  try {
    await withRetry(
      () => octokit.rest.issues.createComment({ owner, repo, issue_number, body }),
      { name: 'createComment' }
    );
    return { action: 'created' };
  } catch (e) {
    console.warn(`createComment 最终失败: ${e.message}`);
    return { action: 'failed', error: e.message };
  }
}

// 权限校验：检查用户是否有权触发斜杠命令（/recheck、/edit、/delete）
// 允许：Issue 创建者 + 仓库 owner/admin/write
async function checkCommandPermission(octokit, owner, repo, username, issueAuthor) {
  // 1. Issue 创建者直接通过
  if (username === issueAuthor) {
    return { allowed: true, reason: 'issue_author' };
  }

  // 2. 检查仓库 collaborator 权限（owner/admin/write 都允许）
  try {
    const { data } = await octokit.rest.repos.getCollaboratorPermissionLevel({
      owner, repo, username,
    });
    // permission: "admin" | "write" | "read" | "none"
    if (data.permission === 'admin' || data.permission === 'write') {
      return { allowed: true, reason: `repo_${data.permission}` };
    }
  } catch (e) {
    console.warn(`getCollaboratorPermissionLevel failed: ${e.message}`);
  }

  return { allowed: false, reason: 'not_authorized' };
}

async function ensureLabel(octokit, owner, repo, name, color) {
  try {
    await octokit.rest.issues.getLabel({ owner, repo, name });
  } catch (e) {
    if (e.status === 404) {
      try {
        await octokit.rest.issues.createLabel({ owner, repo, name, color });
      } catch (createErr) {
        // 忽略创建失败（可能并发创建）
      }
    }
  }
}

// ========== 读取 data/friends/ 现有文件 ==========
// 列出 data/friends/ 目录拿所有 .json 文件名（不读文件内容，1 次 API 调用）
// 用于文件名存在性检查
async function buildFriendIndex(octokit, owner, repo) {
  const index = { byFilename: {} };
  try {
    const dirRes = await octokit.rest.repos.getContent({ owner, repo, path: 'data/friends' });
    if (Array.isArray(dirRes.data)) {
      for (const item of dirRes.data) {
        if (item.type === 'file' && item.name.endsWith('.json')) {
          index.byFilename[item.name] = true;
        }
      }
    }
  } catch (e) {
    console.warn(`buildFriendIndex: list data/friends/ failed: ${e.message}`);
  }
  return index;
}

// 读取 data/friends/<filename> 当前内容（API 读取，反映远端最新状态）
// 返回解析后的对象；不存在或读取失败返回 null
async function readFriendFile(octokit, owner, repo, filename) {
  try {
    const res = await withRetry(
      () => octokit.rest.repos.getContent({ owner, repo, path: `data/friends/${filename}` }),
      { name: `readFriendFile(${filename})` }
    );
    if (!Array.isArray(res.data) && res.data.content) {
      const raw = Buffer.from(res.data.content, res.data.encoding || 'base64').toString('utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    if (e.status !== 404) {
      console.warn(`readFriendFile(${filename}) failed: ${e.message}`);
    }
  }
  return null;
}

// ========== Git 操作：写入/删除文件并推送 ==========
function gitExec(args, { cwd, env } = {}) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function commitAndPushFriendFile({ filename, content, targetBranch, workspace, action = 'write', verb = 'add' }) {
  const filePath = path.join(workspace, 'data', 'friends', filename);

  if (action === 'remove') {
    // 删除操作：文件不在本地工作区（可能被并发处理）时视为幂等成功
    if (!fs.existsSync(filePath)) {
      return { pushed: false, reason: 'file_missing' };
    }
    gitExec(['rm', filePath], { cwd: workspace });
  } else {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    gitExec(['add', filePath], { cwd: workspace });
  }

  // 检查是否有改动（幂等：内容相同则跳过）
  const status = gitExec(['status', '--porcelain'], { cwd: workspace });
  if (!status.trim()) {
    return { pushed: false, reason: 'no_changes' };
  }

  gitExec([
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `feat: ${verb} friend link via issue (#${process.env.ISSUE_NUMBER || 'manual'})`,
  ], { cwd: workspace });

  // push 重试：网络抖动直接重试；non-fast-forward（并发 push）时
  // pull --rebase 后重试。rebase 用 -X ours：各 Issue 写不同文件不会冲突，
  // 唯一可能冲突的 friends.json 反正会被 build.yml 重建，谁的版本都行
  let pushOk = false;
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      gitExec(['push', 'origin', `HEAD:${targetBranch}`], { cwd: workspace });
      pushOk = true;
      break;
    } catch (e) {
      lastErr = e.message;
      const isNonFastForward = /non-fast-forward|fetch first|rejected/i.test(e.message);

      if (isNonFastForward) {
        try {
          gitExec([
            '-c', 'user.name=github-actions[bot]',
            '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
            '-c', 'rerere.enabled=false',
            'pull', '--rebase', '-X', 'ours', 'origin', targetBranch,
          ], { cwd: workspace });
        } catch (rebaseErr) {
          // rebase 失败：abort 以免污染工作目录
          try { gitExec(['rebase', '--abort'], { cwd: workspace }); } catch {}
          lastErr = `rebase failed: ${rebaseErr.message}`;
          await sleep(2000 * Math.pow(2, i));
        }
      } else {
        await sleep(2000 * Math.pow(2, i));
      }
    }
  }
  if (!pushOk) throw new Error(`git push failed: ${lastErr}`);

  // 取 commit SHA
  const sha = gitExec(['rev-parse', 'HEAD'], { cwd: workspace });
  return { pushed: true, sha };
}

// ========== 评论构造 ==========
// 状态卡片：所有流程状态走同一条评论（首次 create 发邮件，后续 update 不发）
// phase: 'pending' | 'success' | 'fail'；marker 为该次操作的完成标记（幂等用）
function buildStatusCard({ phase, title, body, marker, reprocess = false }) {
  const phaseIcon = phase === 'success' ? '✅' : phase === 'fail' ? '❌' : '🔄';
  const lines = [
    `${MARKER_STATUS_CARD}`,
    `## ${phaseIcon} ${title}${reprocess ? '（重新处理）' : ''}`,
    '',
  ];
  if (body) lines.push(body);
  if (marker) lines.push(marker);
  return lines.join('\n');
}

// pending 状态（处理中）
function buildPendingBody({ reprocess = false, action = 'add' } = {}) {
  const titles = {
    add: '友链申请处理中',
    edit: '友链修改处理中',
    delete: '友链删除处理中',
  };
  const checkItems = {
    add: [
      '字段格式',
      'SSRF 防护',
      '回链域名一致性',
      'URL 与头像可达性',
      '回链验证（你的友链页是否已添加本站链接）',
    ],
    edit: [
      '字段格式',
      'SSRF 防护',
      '回链域名一致性',
      '域名所有权验证（防止恶意修改）',
      'URL 与头像可达性',
      '回链验证（你的友链页是否已添加本站链接）',
    ],
    delete: [
      '文件存在性',
      '域名所有权验证（防止恶意删除）',
    ],
  };
  return buildStatusCard({
    phase: 'pending',
    title: titles[action] || titles.add,
    body: [
      '正在校验以下内容：',
      ...(checkItems[action] || checkItems.add).map((item) => `- ${item}`),
      '',
      '校验通常在 1-2 分钟内完成，请稍候。',
    ].join('\n'),
    reprocess,
  });
}

// success 状态
function buildSuccessBody({ filename, sha, usedPlaywright, reprocess = false, action = 'add', verifiedVia = null } = {}) {
  const shaShort = sha ? sha.slice(0, 7) : 'unknown';

  if (action === 'delete') {
    return buildStatusCard({
      phase: 'success',
      title: '友链已删除',
      body: [
        `已删除 \`${filename}\`，commit \`${shaShort}\`。`,
        '',
        `**校验结果**：`,
        `- 域名所有权验证 ✓${verifiedVia ? `（${verifiedVia}）` : ''}`,
        '',
        '稍后 build workflow 会重建 `friends.json`，CDN 缓存刷新后该友链将从本站友链页移除。',
      ].join('\n'),
      marker: MARKER_DELETED,
      reprocess,
    });
  }

  if (action === 'edit') {
    return buildStatusCard({
      phase: 'success',
      title: '友链信息已更新',
      body: [
        `已更新 \`${filename}\`，commit \`${shaShort}\`。`,
        '',
        `**校验结果**：`,
        `- 域名所有权验证 ✓${verifiedVia ? `（${verifiedVia}）` : ''}`,
        `- 字段格式 ✓`,
        `- SSRF 防护 ✓`,
        `- 回链域名一致性 ✓`,
        `- URL 与头像可达性 ✓`,
        `- 回链验证 ✓${usedPlaywright ? '（Playwright 渲染）' : '（静态 HTML）'}`,
        '',
        '稍后 build workflow 会重建 `friends.json`，CDN 缓存刷新后生效。',
        '',
        '如需再次修改，可编辑本 Issue 正文后评论 `/edit`；如需删除，评论 `/delete`（需域名所有权验证）。',
      ].join('\n'),
      marker: MARKER_EDITED,
      reprocess,
    });
  }

  return buildStatusCard({
    phase: 'success',
    title: '友链申请已通过',
    body: [
      `已自动写入 \`${filename}\`，commit \`${shaShort}\`。`,
      '',
      `**校验结果**：`,
      `- 字段格式 ✓`,
      `- SSRF 防护 ✓`,
      `- 回链域名一致性 ✓`,
      `- URL 与头像可达性 ✓`,
      `- 回链验证 ✓${usedPlaywright ? '（Playwright 渲染）' : '（静态 HTML）'}`,
      '',
      '稍后 build workflow 会重建 `friends.json`，CDN 缓存刷新后即可在本站友链页看到。',
      '',
      '如需修改：编辑本 Issue 正文后评论 `/edit`，或提交 `[Edit]` 标题的新 Issue',
      '如需删除：在本 Issue 评论 `/delete`，或提交 `[Delete]` 标题的新 Issue',
      '（修改/删除需完成域名所有权验证，详见 README）',
    ].join('\n'),
    marker: MARKER_ACCEPTED,
    reprocess,
  });
}

// fail 状态
function buildFailBody(title, lines, { reprocess = false, retryCommand = '/recheck' } = {}) {
  return buildStatusCard({
    phase: 'fail',
    title,
    body: [
      ...lines.map((l) => {
        if (l === '') return '';
        if (l.startsWith('```') || l.startsWith('    ')) return l;
        if (/^\s*([-*+]|\d+\.)\s/.test(l)) return l;
        return `- ${l}`;
      }),
      '',
      '---',
      '',
      '<details>',
      '<summary><b>🔄 重新处理</b></summary>',
      '',
      `修复上述问题后，在本 Issue 评论 \`${retryCommand}\` 触发重新处理（**仅 Issue 创建者和管理员可触发**）。`,
      '',
      `> 修改 Issue 正文（编辑上方描述）后，再评论 \`${retryCommand}\` 即可，无需新建 Issue。`,
      '',
      '</details>',
      '',
      `如对审核结果有疑问，可[联系 moara](mailto:moara@foxmail.com)。`,
    ].join('\n'),
    marker: MARKER_REJECTED,
    reprocess,
  });
}

// ========== 失败处理 ==========
// 统一的失败出口：更新状态卡片 + 关闭 Issue + 打标签
async function failAndClose({ octokit, owner, repo, issue_number, core, title, lines, retryCommand = '/recheck', reprocess = false, reason = 'failed' }) {
  const log = (msg) => core?.info?.(msg) ?? console.log(msg);
  log(`❌ ${title}`);
  for (const l of lines) log(`  - ${l}`);
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildFailBody(title, lines, { retryCommand, reprocess }));
  await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
  await syncStatusLabels(octokit, owner, repo, issue_number, '未通过');
  return { ok: false, reason };
}

// ========== 域名所有权验证（修改/删除共用，与 validate-pr.mjs 规则一致）==========
// 验证码绑定 Issue 编号（PR 路径绑定 PR 编号，规则相同）
// 两种方式任选其一：DNS TXT 记录、网站根目录验证文件
// 安全注意：method 只返回方式名称，不暴露具体 URL / 域名（防止泄露验证文件地址）
async function verifyDomainOwnership(hostname, verificationCode) {
  // A：DNS TXT 记录
  const dnsResult = await verifyDnsTxt(hostname, verificationCode);
  if (dnsResult) {
    return { verified: true, method: 'DNS TXT' };
  }

  // B：文件验证（.moara-friends-verify.txt）
  const fileResult = await verifyFile(hostname, verificationCode);
  if (fileResult && fileResult.error) {
    return { verified: false, ssrfError: fileResult.error };
  }
  if (fileResult && fileResult.url) {
    return { verified: true, method: '文件验证' };
  }

  return { verified: false };
}

function buildOwnershipFailLines(hostname, originalUrl, verificationCode) {
  return [
    '你正在修改/删除现有的友链数据。为了防止恶意改动，请完成域名所有权验证（以下两种方式任选其一）：',
    '',
    '**A：DNS TXT 记录**',
    `在域名 \`${hostname}\` 或 \`_moara-friends.${hostname}\` 下添加 DNS TXT 记录`,
    `记录内容：\`${verificationCode}\``,
    '',
    '**B：文件验证**',
    `在 \`${originalUrl}\` 网站根目录上传文件 \`.moara-friends-verify.txt\``,
    `文件内容：\`${verificationCode}\``,
  ];
}

/**
 * 执行域名所有权验证；失败时发布失败评论并关闭 Issue
 * @returns 通过：{ ok: true, method }
 *          失败：{ ok: false, result }（result 为 failAndClose 返回值，调用方直接 return）
 */
async function verifyOwnershipOrFail({ octokit, owner, repo, issue_number, core, originalData, filename, retryCommand, reprocess }) {
  const log = (msg) => core?.info?.(msg) ?? console.log(msg);
  const verificationCode = `moara-friends=${issue_number}`;

  const originalUrl = originalData?.url;
  if (!originalUrl) {
    log(`⚠️  ${filename} 缺少 url 字段，无法进行域名所有权验证`);
    return {
      ok: false,
      result: await failAndClose({
        octokit, owner, repo, issue_number, core,
        title: '无法进行域名所有权验证',
        lines: [
          `\`${filename}\` 中缺少 url 字段，无法确定待验证的域名。`,
          '',
          '请[联系 moara](mailto:moara@foxmail.com) 处理。',
        ],
        retryCommand, reprocess, reason: 'no_original_url',
      }),
    };
  }

  const hostname = getHostname(originalUrl);
  if (!hostname) {
    log(`⚠️  无法解析 ${originalUrl} 的 hostname，无法进行域名所有权验证`);
    return {
      ok: false,
      result: await failAndClose({
        octokit, owner, repo, issue_number, core,
        title: '无法进行域名所有权验证',
        lines: [
          `无法解析 \`${originalUrl}\` 的域名，无法验证所有权。`,
          '',
          '请[联系 moara](mailto:moara@foxmail.com) 处理。',
        ],
        retryCommand, reprocess, reason: 'no_hostname',
      }),
    };
  }

  log(`🔐 域名所有权验证：${hostname}（验证码 ${verificationCode}）`);
  const verifyResult = await verifyDomainOwnership(hostname, verificationCode);

  if (verifyResult.ssrfError) {
    return {
      ok: false,
      result: await failAndClose({
        octokit, owner, repo, issue_number, core,
        title: '域名所有权验证：SSRF 拦截',
        lines: [
          `在验证 \`${hostname}\` 域名所有权时触发安全防护：`,
          '',
          verifyResult.ssrfError,
          '',
          '该域名的 URL 可能指向内部网络或被重定向到不安全地址',
        ],
        retryCommand, reprocess, reason: 'ownership_ssrf',
      }),
    };
  }

  if (!verifyResult.verified) {
    return {
      ok: false,
      result: await failAndClose({
        octokit, owner, repo, issue_number, core,
        title: '域名所有权验证失败',
        lines: buildOwnershipFailLines(hostname, originalUrl, verificationCode),
        retryCommand, reprocess, reason: 'ownership_failed',
      }),
    };
  }

  log(`✓ 域名所有权验证通过: ${verifyResult.method}`);
  return { ok: true, method: verifyResult.method };
}

// ========== 单个 Issue 处理流程（新增 / 修改）==========
async function processApplicationIssue({ octokit, owner, repo, issue, workspace, targetBranch, core, forceReprocess = false, action = 'add' }) {
  const issue_number = issue.number;
  const log = (msg) => core?.info?.(msg) ?? console.log(msg);
  const retryCommand = action === 'edit' ? '/edit' : '/recheck';

  log(`\n========== 处理 Issue #${issue_number}（${action}）: ${issue.title}${forceReprocess ? ' (强制重新处理)' : ''} ==========`);

  // 幂等检查：
  // - forceReprocess=true（命令触发）：已完成的不重试（edit 例外：允许再次修改）；
  //   rejected 的允许重新处理
  // - forceReprocess=false（opened/review 触发）：已完成和 rejected 都跳过
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number, per_page: 100,
    });
    const allBodies = comments.map(c => c.body || '').join('\n');
    // add 流程的「已完成」要认三种标记：accepted / edited / deleted。
    // 状态卡片每次处理会被整体替换，edit/delete 成功后旧的 accepted 标记就没了；
    // 只认 accepted 的话 /recheck 会在 edit 后误重跑 add（报文件名占用）、
    // 在 delete 后复活已删除的友链
    let hasDone = false;
    let doneReason = null;
    if (action === 'add') {
      if (allBodies.includes(MARKER_DELETED)) { hasDone = true; doneReason = 'already_deleted'; }
      else if (allBodies.includes(MARKER_EDITED) || allBodies.includes(MARKER_ACCEPTED)) { hasDone = true; doneReason = 'already_accepted'; }
    } else if (action === 'edit') {
      // edit 同样要认 deleted：已删除的友链文件已不在仓库，不能再修改
      if (allBodies.includes(MARKER_DELETED)) { hasDone = true; doneReason = 'already_deleted'; }
      else { hasDone = allBodies.includes(MARKER_EDITED); doneReason = 'already_edited'; }
    }
    const hasRejected = allBodies.includes(MARKER_REJECTED);

    if (hasDone) {
      // /edit 允许对「已修改过」的 Issue 再次修改（显式触发；
      // 写入幂等，且每次都会重新做域名所有权验证，安全）。
      // 已删除（deleted）的除外：文件已不在仓库，修改无意义
      const editRetry = action === 'edit' && doneReason === 'already_edited' && forceReprocess;
      if (!editRetry) {
        log(`⏭️  Issue #${issue_number} 已完成（${doneReason}），跳过`);
        return { skipped: true, reason: doneReason };
      }
      log(`🔄 Issue #${issue_number} 之前已修改过，再次执行修改`);
    }
    if (hasRejected && !forceReprocess) {
      log(`⏭️  Issue #${issue_number} 之前被拒（rejected），跳过；如需重试请评论 ${retryCommand}`);
      return { skipped: true, reason: 'already_rejected' };
    }
    if (hasRejected && forceReprocess) {
      log(`🔄 Issue #${issue_number} 之前被拒，现在重新处理`);
    }
  } catch (e) {
    core?.warning?.(`检查已有评论失败: ${e.message}`);
  }

  // 标题前缀检查（调用方已路由，这里做防御性校验：三种前缀任一即可。
  // /edit、/delete 命令允许在 [Friend Link] Issue 上触发，前缀与操作类型不必一致）
  if (!getIssueAction(issue.title)) {
    log(`⏭️  Issue #${issue_number} 标题前缀不受支持，跳过`);
    return { skipped: true };
  }

  // ── 0. 发布初始确认评论（首次创建会发邮件，后续重试时编辑同一条评论不发邮件）──
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildPendingBody({ reprocess: forceReprocess, action }));

  // ── 1. 解析 Issue body ──
  const app = parseApplication(issue.body || '');
  log(`解析字段: ${JSON.stringify(app, null, 2)}`);

  // 检查必要字段是否全部非空
  const missingFields = [];
  if (!app.name) missingFields.push('Site Name');
  if (!app.url) missingFields.push('Site URL');
  if (!app.friendPageUrl) missingFields.push('Friend Page URL');
  if (!app.filename) missingFields.push('Filename');
  if (missingFields.length) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: 'Issue 内容不完整',
      lines: [
        `缺少必要字段：${missingFields.join(', ')}`,
        '',
        '请编辑 Issue 正文补全字段后，评论本 Issue 重新触发。',
        '完整字段包括：Site Name / Site URL / Friend Page URL / Avatar URL（可选） / Cover URL（可选） / Short Description（可选） / Filename。',
      ],
      retryCommand, reprocess: forceReprocess, reason: 'incomplete',
    });
  }

  // ── 2. 构造 data 对象 + 字段校验 ──
  const data = {
    name: app.name,
    url: app.url,
    backlink: app.friendPageUrl,
  };
  if (app.avatar) data.avatar = app.avatar;
  if (app.cover) data.cover = app.cover;
  if (app.description) data.description = app.description;

  const fieldResult = validateFields(data);
  if (!fieldResult.ok) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: '字段校验未通过',
      lines: fieldResult.errors,
      retryCommand, reprocess: forceReprocess, reason: 'field_invalid',
    });
  }

  // ── 3. 文件名校验 ──
  const filenameErr = validateFilename(app.filename);
  if (filenameErr) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: '文件名不符合规则',
      lines: [
        filenameErr,
        '',
        '文件名只能包含英文字母、数字、短横线和下划线，可选 `.json` 后缀。',
        '示例：`example.json`、`my-blog.json`、`demo-blog`。',
      ],
      retryCommand, reprocess: forceReprocess, reason: 'filename_invalid',
    });
  }
  const filename = normalizeFilename(app.filename);

  // ── 4. SSRF 防护 ──
  const ssrfErrors = checkSsrf(data);
  if (ssrfErrors.length) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: 'URL 不合法',
      lines: [
        '检测到不可访问的地址：',
        '',
        ...ssrfErrors,
        '',
        '禁止使用：localhost、私有 IP、链路本地、云元数据端点等。',
      ],
      retryCommand, reprocess: forceReprocess, reason: 'ssrf',
    });
  }

  // ── 5. 回链域名一致性 ──
  const domainErr = checkBacklinkDomainConsistency(data);
  if (domainErr) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: domainErr.title,
      lines: domainErr.lines,
      retryCommand, reprocess: forceReprocess, reason: 'domain_mismatch',
    });
  }

  // ── 6. 文件存在性检查 ──
  // 新增：文件名不得与已有友链重复；修改：文件必须已存在（否则应走新增流程）
  const index = await buildFriendIndex(octokit, owner, repo);

  if (action === 'add' && index.byFilename[filename]) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: '文件名已被占用',
      lines: [
        `你申请的文件名：\`${filename}\``,
        '该文件名已存在。',
        '如需修改已有友链，请编辑本 Issue 正文后评论 `/edit`，或提交 `[Edit]` 标题的新 Issue。',
      ],
      retryCommand, reprocess: forceReprocess, reason: 'filename_exists',
    });
  }

  let originalData = null;
  if (action === 'edit') {
    if (!index.byFilename[filename]) {
      return await failAndClose({
        octokit, owner, repo, issue_number, core,
        title: '文件不存在',
        lines: [
          `data/friends/\`${filename}\` 不存在，无法修改。`,
          '',
          '请确认 Filename 与已收录的友链文件一致（可在仓库 `data/friends/` 目录查看）。',
          '如需新增友链，请提交 `[Friend Link]` 标题的 Issue（可用申请表单生成）。',
        ],
        retryCommand, reprocess: forceReprocess, reason: 'filename_not_found',
      });
    }
    originalData = await readFriendFile(octokit, owner, repo, filename);
    if (!originalData) {
      return await failAndClose({
        octokit, owner, repo, issue_number, core,
        title: '无法读取原友链文件',
        lines: [
          `读取 data/friends/\`${filename}\` 失败。`,
          '',
          '请稍后重试，或[联系 moara](mailto:moara@foxmail.com)。',
        ],
        retryCommand, reprocess: forceReprocess, reason: 'read_original_failed',
      });
    }
  }

  // ── 7. 域名所有权验证（仅修改操作，与 PR 路径规则一致）──
  let verifiedVia = null;
  if (action === 'edit') {
    const own = await verifyOwnershipOrFail({
      octokit, owner, repo, issue_number, core,
      originalData, filename,
      retryCommand, reprocess: forceReprocess,
    });
    if (!own.ok) return own.result;
    verifiedVia = own.method;
  }

  // ── 8. URL + avatar 可达性 ──
  log('🌐 正在并行检查站点 URL 和头像 URL 可达性...');
  const tasks = [
    checkUrlReachable(data.url, { requireImage: false })
      .then((r) => ({ label: '站点 url', url: data.url, result: r })),
  ];
  if (typeof data.avatar === 'string' && data.avatar.trim()) {
    tasks.push(
      checkUrlReachable(data.avatar, { requireImage: true })
        .then((r) => ({ label: '头像 avatar', url: data.avatar, result: r }))
    );
  }
  const results = await Promise.all(tasks);
  const failedChecks = results.filter((r) => !r.result.ok);

  if (failedChecks.length) {
    const lines = [];
    for (const r of results) {
      if (!r.result.ok) {
        lines.push('```');
        lines.push(`✗ ${r.label} 不可达 (${r.url})`);
        lines.push(`  · 尝试 ${r.result.attempts} 次，错误：${r.result.errors.join('；')}`);
        lines.push('```');
        lines.push('');
      }
    }
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: '可达性检查未通过',
      lines,
      retryCommand, reprocess: forceReprocess, reason: 'unreachable',
    });
  }

  // ── 9. 回链验证（静态 + Playwright 兜底）──
  log(`🔗 正在抓取友链页面检查回链：${data.backlink}`);
  const backlinkResult = await checkBacklink(data.backlink, { log });

  if (!backlinkResult.ok) {
    const lines = backlinkResult.reason === 'unreachable'
      ? [
          `backlink URL：\`${data.backlink}\``,
          `抓取失败：${(backlinkResult.errors || []).join('；')}`,
          '',
          '请确认你的友链页 URL 正确且可公开访问。',
        ]
      : [
          `未检测到本站友链链接`,
          '',
          `**需要添加的链接**：\`${SITE_URL}\``,
          `**你的友链页面**：\`${data.backlink}\``,
          '',
          '**常见原因**：',
          '- 友链页还没添加本站链接，或链接 URL 不完全一致',
          '- 友链页需要登录或被防火墙拦截',
          '- CDN 缓存返回了旧版本',
          '',
          '**解决方法**：',
          `1. 在你的友链页添加：<a href="${SITE_URL}">沫然Blog</a>`,
          '2. 确保 href 是绝对链接且 URL 完全一致',
          '3. 等待 CDN 刷新后重新触发',
        ];
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: '回链验证未通过',
      lines,
      retryCommand, reprocess: forceReprocess, reason: 'backlink_not_found',
    });
  }

  log(`✓ 回链验证通过${backlinkResult.usedPlaywright ? '（Playwright 渲染）' : '（静态 HTML）'}`);

  // ── 10. 写入文件并 push ──
  const stdData = standardizeFriendData(data);
  // 修改操作保留原有 vip 标记（vip 仅站主直推数据携带，Issue 申请数据不可能带 vip）
  if (action === 'edit' && originalData?.vip === true) stdData.vip = true;
  const content = JSON.stringify(stdData, null, 2) + '\n';

  let pushResult;
  try {
    process.env.ISSUE_NUMBER = String(issue_number);
    pushResult = await commitAndPushFriendFile({
      filename,
      content,
      targetBranch,
      workspace,
      verb: action === 'edit' ? 'update' : 'add',
    });
  } catch (e) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: '写入文件失败',
      lines: [
        `错误：${e.message}`,
        '',
        '校验已通过但写入仓库失败。请稍后重试，或[联系 moara](mailto:moara@foxmail.com)。',
      ],
      retryCommand, reprocess: forceReprocess, reason: 'push_failed',
    });
  }

  if (!pushResult.pushed) {
    // 内容相同（幂等），仍然算成功
    log(`⚠️  文件内容与现有相同，未触发 push（幂等）`);
  } else {
    log(`✅ 写入成功：${filename} @ ${pushResult.sha.slice(0, 7)}`);
  }

  // ── 11. 成功评论（编辑主评论）+ 关闭 Issue + 触发 build ──
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildSuccessBody({
      filename,
      sha: pushResult.sha,
      usedPlaywright: backlinkResult.usedPlaywright,
      reprocess: forceReprocess,
      action,
      verifiedVia,
    }));

  await syncStatusLabels(octokit, owner, repo, issue_number, '已互链');

  await closeIssue(octokit, owner, repo, issue_number, 'completed');

  // 触发 build workflow（重建 friends.json + 刷 jsDelivr）
  // 注意：GITHUB_TOKEN 的 git push 不会触发 on: push workflow，
  // 必须显式 dispatch build.yml
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: 'build.yml', ref: targetBranch,
    });
    log('✅ build workflow 已触发');
  } catch (e) {
    log(`⚠️  trigger build workflow failed: ${e.message}`);
    log('   友链文件已入库，build 可由后续 push 或定时任务自动重跑');
  }

  return { ok: true, filename, sha: pushResult.sha };
}

// ========== 单个 Issue 处理流程（删除）==========
async function processDeleteIssue({ octokit, owner, repo, issue, workspace, targetBranch, core, forceReprocess = false }) {
  const issue_number = issue.number;
  const log = (msg) => core?.info?.(msg) ?? console.log(msg);
  const retryCommand = '/delete';

  log(`\n========== 处理 Issue #${issue_number}（delete）: ${issue.title}${forceReprocess ? ' (强制重新处理)' : ''} ==========`);

  // 幂等检查：已删除的 Issue 不重复处理（重复删除无意义）
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number, per_page: 100,
    });
    const allBodies = comments.map(c => c.body || '').join('\n');
    const hasDeleted = allBodies.includes(MARKER_DELETED);
    const hasRejected = allBodies.includes(MARKER_REJECTED);

    if (hasDeleted) {
      log(`⏭️  Issue #${issue_number} 已删除（deleted），跳过`);
      return { skipped: true, reason: 'already_deleted' };
    }
    if (hasRejected && !forceReprocess) {
      log(`⏭️  Issue #${issue_number} 之前被拒（rejected），跳过；如需重试请评论 ${retryCommand}`);
      return { skipped: true, reason: 'already_rejected' };
    }
    if (hasRejected && forceReprocess) {
      log(`🔄 Issue #${issue_number} 之前被拒，现在重新处理`);
    }
  } catch (e) {
    core?.warning?.(`检查已有评论失败: ${e.message}`);
  }

  // 标题前缀检查（调用方已路由，这里做防御性校验：三种前缀任一即可）
  if (!getIssueAction(issue.title)) {
    log(`⏭️  Issue #${issue_number} 标题前缀不受支持，跳过`);
    return { skipped: true };
  }

  // ── 0. 发布初始确认评论 ──
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildPendingBody({ reprocess: forceReprocess, action: 'delete' }));

  // ── 1. 解析 Issue body（只需要 Filename 字段）──
  const app = parseApplication(issue.body || '');
  log(`解析字段: ${JSON.stringify(app, null, 2)}`);

  if (!app.filename) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: 'Issue 内容不完整',
      lines: [
        '缺少必要字段：Filename',
        '',
        '请填写要删除的友链文件名（可在仓库 `data/friends/` 目录查看你的文件名）。',
        '可使用申请表单（apply.html）的「删除友链」模式生成草稿。',
      ],
      retryCommand, reprocess: forceReprocess, reason: 'incomplete',
    });
  }

  // ── 2. 文件名校验 ──
  const filenameErr = validateFilename(app.filename);
  if (filenameErr) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: '文件名不符合规则',
      lines: [
        filenameErr,
        '',
        '文件名只能包含英文字母、数字、短横线和下划线，可选 `.json` 后缀。',
      ],
      retryCommand, reprocess: forceReprocess, reason: 'filename_invalid',
    });
  }
  const filename = normalizeFilename(app.filename);

  // ── 3. 文件必须存在 ──
  const index = await buildFriendIndex(octokit, owner, repo);
  if (!index.byFilename[filename]) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: '文件不存在',
      lines: [
        `data/friends/\`${filename}\` 不存在，可能已被删除。`,
        '',
        '请确认 Filename 与已收录的友链文件一致（可在仓库 `data/friends/` 目录查看）。',
      ],
      retryCommand, reprocess: forceReprocess, reason: 'filename_not_found',
    });
  }

  // ── 4. 读取原文件 + 域名所有权验证（与 PR 路径规则一致）──
  const originalData = await readFriendFile(octokit, owner, repo, filename);
  if (!originalData) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: '无法读取原友链文件',
      lines: [
        `读取 data/friends/\`${filename}\` 失败。`,
        '',
        '请稍后重试，或[联系 moara](mailto:moara@foxmail.com)。',
      ],
      retryCommand, reprocess: forceReprocess, reason: 'read_original_failed',
    });
  }

  const own = await verifyOwnershipOrFail({
    octokit, owner, repo, issue_number, core,
    originalData, filename,
    retryCommand, reprocess: forceReprocess,
  });
  if (!own.ok) return own.result;

  // ── 5. 删除文件并 push ──
  let pushResult;
  try {
    process.env.ISSUE_NUMBER = String(issue_number);
    pushResult = await commitAndPushFriendFile({
      filename,
      targetBranch,
      workspace,
      action: 'remove',
      verb: 'remove',
    });
  } catch (e) {
    return await failAndClose({
      octokit, owner, repo, issue_number, core,
      title: '删除文件失败',
      lines: [
        `错误：${e.message}`,
        '',
        '校验已通过但写入仓库失败。请稍后重试，或[联系 moara](mailto:moara@foxmail.com)。',
      ],
      retryCommand, reprocess: forceReprocess, reason: 'push_failed',
    });
  }

  if (!pushResult.pushed) {
    // 文件无改动（可能被并发删除），视为成功（幂等）
    log(`⚠️  文件无改动（可能已被删除），未触发 push（幂等）`);
  } else {
    log(`✅ 删除成功：${filename} @ ${pushResult.sha.slice(0, 7)}`);
  }

  // ── 6. 成功评论 + 关闭 Issue + 触发 build ──
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildSuccessBody({
      filename,
      sha: pushResult.sha,
      reprocess: forceReprocess,
      action: 'delete',
      verifiedVia: own.method,
    }));

  await syncStatusLabels(octokit, owner, repo, issue_number, '已删除');

  await closeIssue(octokit, owner, repo, issue_number, 'completed');

  // 触发 build workflow（重建 friends.json + 刷 jsDelivr）
  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: 'build.yml', ref: targetBranch,
    });
    log('✅ build workflow 已触发');
  } catch (e) {
    log(`⚠️  trigger build workflow failed: ${e.message}`);
    log('   友链文件已删除，build 可由后续 push 或定时任务自动重跑');
  }

  return { ok: true, filename, sha: pushResult.sha };
}

// ========== 主入口 ==========
export async function runIssueBot({ mode, github, core, context, env }) {
  const owner = context.repo.owner;
  const repo = context.repo.repo;
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const targetBranch = env.FRIEND_LINK_TARGET_BRANCH || context.ref?.replace('refs/heads/', '') || 'main';

  core.info(`Issue Bot 启动，mode=${mode}, owner=${owner}/${repo}, branch=${targetBranch}`);

  // 冷却等待（预留位置；当前 COOLDOWN_MS = 0，不等待）
  if (mode === 'opened' && COOLDOWN_MS > 0) {
    core.info(`⏳ 冷却等待 ${COOLDOWN_MS / 1000}s...`);
    await sleep(COOLDOWN_MS);
  }

  // 按 action 分发到对应处理流程
  const runFlow = async (issue, action, forceReprocess) => {
    const base = { octokit: github, owner, repo, issue, workspace, targetBranch, core, forceReprocess };
    if (action === 'delete') {
      return processDeleteIssue(base);
    }
    return processApplicationIssue({ ...base, action });
  };

  if (mode === 'opened') {
    // 处理刚打开的 Issue：按标题前缀自动路由（[Friend Link] / [Edit] / [Delete]）
    const issue = context.payload.issue;
    if (!issue) {
      core.warning('未找到 issue payload');
      return;
    }
    const action = getIssueAction(issue.title);
    if (!action) {
      core.warning(`Issue #${issue.number} 标题前缀不受支持（需为 [Friend Link] / [Edit] / [Delete] 之一），跳过`);
      return;
    }
    await runFlow(issue, action, false);
    return;
  }

  if (mode === 'command') {
    // 处理 issue_comment 事件中的斜杠命令（/recheck、/edit、/delete）
    const comment = context.payload.comment;
    const issue = context.payload.issue;
    if (!comment || !issue) {
      core.warning('未找到 comment 或 issue payload');
      return;
    }

    // 二次校验评论内容（防止 workflow_dispatch 误触发）
    const body = (comment.body || '').trim();
    let command = null;
    if (body.startsWith('/recheck')) command = 'recheck';
    else if (body.startsWith('/edit')) command = 'edit';
    else if (body.startsWith('/delete')) command = 'delete';
    if (!command) {
      core.info(`评论内容不是受支持的命令（/recheck、/edit、/delete），跳过：${body.slice(0, 50)}`);
      return;
    }

    // 仅处理真正的 Issue：PR 评论同样触发 issue_comment 事件，排除
    // （PR 走 auto-pr.yml 校验流程，不归 issue-bot 管）
    if (issue.pull_request) {
      core.info(`评论位于 PR #${issue.number} 上（非 Issue），跳过`);
      return;
    }

    // 标题前缀限制：/recheck、/edit、/delete 仅在
    // [Friend Link] / [Edit] / [Delete] 标题的 Issue 上生效；
    // 其余 Issue 评论命令无任何作用（不处理、不评论、静默跳过）
    const issueAction = getIssueAction(issue.title);
    if (!issueAction) {
      core.info(`Issue #${issue.number} 标题前缀不受支持（需为 [Friend Link] / [Edit] / [Delete] 之一），跳过`);
      return;
    }

    // /recheck 按 Issue 标题前缀触发对应流程；/edit、/delete 直接触发对应功能
    // （在 [Friend Link] Issue 里评论 /edit、/delete 同样有效：
    //   编辑正文后评论 /edit 可修改已收录的友链；评论 /delete 可删除）
    const flow = command === 'recheck' ? issueAction : command;

    // 权限校验：仅 Issue 创建者 + 仓库 owner/admin 可触发命令（与 /recheck 一致）
    const commenter = comment.user?.login;
    const issueAuthor = issue.user?.login;
    core.info(`权限校验: commenter=${commenter}, issueAuthor=${issueAuthor}, command=/${command}, flow=${flow}`);
    const perm = await checkCommandPermission(github, owner, repo, commenter, issueAuthor);
    if (!perm.allowed) {
      core.warning(`用户 @${commenter} 无权触发 /${command}（reason=${perm.reason}）`);
      await createComment(github, owner, repo, issue.number, [
        `> @${commenter} 无权触发 \`/${command}\`。`,
        `> 仅 Issue 创建者（@${issueAuthor || '?'}）和仓库管理员可触发该操作。`,
        `> 如需操作，请让 Issue 创建者评论，或[联系 moara](mailto:moara@foxmail.com)。`,
      ].join('\n'));
      return;
    }
    core.info(`✓ 权限通过: @${commenter} (${perm.reason})`);

    // 如果 Issue 处于关闭状态，先重新打开（这样处理流程才会真正执行）
    let reopenedByUs = false;
    if (issue.state === 'closed') {
      core.info(`Issue #${issue.number} 处于关闭状态，重新打开以进行处理`);
      try {
        await github.rest.issues.update({
          owner, repo, issue_number: issue.number, state: 'open',
        });
        reopenedByUs = true;
      } catch (e) {
        core.warning(`重新打开 Issue 失败: ${e.message}`);
      }
    }

    // 触发处理（强制重新处理）
    const result = await runFlow(issue, flow, true);

    // 处理被跳过的情况（操作已完成）：把 Issue 关回去 + 评论明确反馈，
    // 避免用户评论命令后「无反应」
    if (result?.skipped) {
      const doneMessages = {
        already_accepted: '此 Issue 已通过校验（友链已写入仓库），无需重新校验。如需修改友链信息，可编辑本 Issue 正文后评论 `/edit`；如需删除，评论 `/delete`（均需域名所有权验证）。',
        already_edited: '此 Issue 的修改已应用。如需再次修改，请编辑本 Issue 正文后重新评论 `/edit`。',
        already_deleted: '该友链已删除，无法修改或重复删除。如需重新添加，请提交 `[Friend Link]` 标题的新 Issue。',
      };
      if (doneMessages[result.reason]) {
        core.info(`Issue #${issue.number} 已完成（${result.reason}），处理跳过逻辑`);

        // 1. 如果当前是 open（含我们 reopen 的），close 回去（保持 completed）
        if (issue.state === 'open' || reopenedByUs) {
          try {
            await github.rest.issues.update({
              owner, repo, issue_number: issue.number,
              state: 'closed', state_reason: 'completed',
            });
          } catch (e) {
            core.warning(`关闭 Issue 失败: ${e.message}`);
          }
        }

        // 2. 评论提示
        await createComment(github, owner, repo, issue.number, `> ${doneMessages[result.reason]}`);
      }
    }
    return;
  }

  if (mode === 'review') {
    // 扫描所有开放的友链 Issue（[Friend Link] / [Edit] / [Delete]）
    core.info('🔍 扫描开放的友链 Issue（[Friend Link] / [Edit] / [Delete]）...');
    const openIssues = await github.paginate(github.rest.issues.listForRepo, {
      owner, repo, state: 'open', per_page: 100,
    });

    const targets = openIssues
      .map((i) => ({ issue: i, action: getIssueAction(i.title) }))
      // 排除 PR（issues.listForRepo 会把 PR 一并返回，PR 标题即使带前缀也不归这里处理）
      .filter((t) => t.action && !t.issue.pull_request);

    core.info(`找到 ${targets.length} 个开放的友链 Issue`);

    let processed = 0;
    for (const { issue, action } of targets.slice(0, MAX_ISSUES_PER_RUN)) {
      try {
        await runFlow(issue, action, false);
        processed++;
      } catch (e) {
        core.warning(`处理 Issue #${issue.number} 时异常: ${e.message}`);
      }
    }

    core.info(`\n========== 本轮处理完毕：${processed}/${targets.length} ==========`);
    return;
  }

  throw new Error(`未知 mode: ${mode}`);
}
