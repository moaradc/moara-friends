/**
 * scripts/validate-issue.mjs
 *
 * Issue 路径校验脚本，被 .github/workflows/issue-bot.yml 调用。
 * 监听 issues.opened（标题以 [Friend Link] 开头），解析 Issue body 中固定字段，
 * 校验通过后直接 git push 写入 data/friends/<filename>.json，并触发 build.yml。
 *
 * 设计原则：
 *   - 浏览器只生成预填 Issue 草稿 URL，不持有仓库写权限
 *   - 字段、SSRF、可达性、回链校验规则与 PR 路径完全一致（复用 lib/validate.mjs）
 *   - 仅支持「新增」友链；「修改/删除」仍走 PR 路径
 *   - 用 Issue 评论里的隐藏 marker 实现幂等，防止事件重复投递
 *   - bot 以 github-actions[bot] 身份提交，使用仓库默认 GITHUB_TOKEN
 *
 * 入口：runIssueBot({ mode, github, core, context, env })
 *   - mode: 'opened' | 'review'
 *     · opened：处理刚提交的 Issue（确认评论 + 立即校验）
 *     · review：扫描所有开放 Issue 并处理（手动 dispatch 用）
 *
 * Issue body 字段格式（由 apply.html 生成）：
 *   ## Friend Link Application
 *
 *   - Site Name: 站点名称
 *   - Site URL: https://example.com
 *   - Friend Page URL: https://example.com/friends
 *   - Avatar URL: https://example.com/avatar.png
 *   - Short Description: 站点简介
 *   - Filename: example.json
 *   - Reciprocal Link Added: yes
 */

import {
  SITE_URL,
  isPublicUrl,
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
// 标题前缀：支持 [Friend Link]（新增）、[Edit]（修改）、[Delete]（删除）
const ISSUE_TITLE_PREFIXES = ['[Friend Link]', '[Edit]', '[Delete]'];
// 兼容旧代码
const ISSUE_TITLE_PREFIX = '[Friend Link]';

// 判断标题是否以任一支持的前缀开头
function hasSupportedPrefix(title) {
  if (!title) return false;
  return ISSUE_TITLE_PREFIXES.some(p => title.startsWith(p));
}

// 从标题推断 action（[Edit]→edit, [Delete]→delete, 其他→add）
function inferActionFromTitle(title) {
  if (!title) return 'add';
  if (title.startsWith('[Edit]')) return 'edit';
  if (title.startsWith('[Delete]')) return 'delete';
  return 'add';
}

const MARKER_INITIAL = '<!-- moara-friends-bot:initial -->';
const MARKER_ACCEPTED = '<!-- moara-friends-bot:accepted -->';
const MARKER_REJECTED = '<!-- moara-friends-bot:rejected -->';
// 状态卡片 marker：用于查找本 Issue 中 bot 的「主评论」
// 后续状态更新会编辑这条评论（编辑评论不会触发邮件通知）
const MARKER_STATUS_CARD = '<!-- moara-friends-bot:status-card -->';

// 冷却等待（毫秒）。0 = 不等待。
// 预留位置：如果未来发现用户提交 Issue 后回链还没生效（CDN 缓存慢），
// 把这个值调大（如 10 * 60 * 1000 = 10 分钟）即可。
const COOLDOWN_MS = 0;

// 最大处理 Issue 数（防止单 run 处理过多超时）
const MAX_ISSUES_PER_RUN = 50;

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
    action:         (values['action'] || '').toLowerCase(),  // add | edit | delete（可被标题/评论命令覆盖）
    name:           values['site name'] || '',
    url:            values['site url'] || '',
    friendPageUrl:  values['friend page url'] || '',
    avatar:         values['avatar url'] || '',
    cover:          values['cover url'] || '',
    description:    values['short description'] || '',
    filename:       values['filename'] || '',
    reciprocalLinkAdded: values['reciprocal link added'] || '',
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

// 权限校验：检查用户是否有权触发 /recheck
// 允许：Issue 创建者 + 仓库 owner/admin
async function checkRecheckPermission(octokit, owner, repo, username, issueAuthor) {
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

// ========== 列出现有 data/friends/*.json ==========
async function listExistingFriends(octokit, owner, repo) {
  const friends = [];
  try {
    const res = await octokit.rest.repos.getContent({ owner, repo, path: 'data/friends' });
    if (Array.isArray(res.data)) {
      for (const item of res.data) {
        if (item.type === 'file' && item.name.endsWith('.json')) {
          friends.push(item.name);
        }
      }
    }
  } catch (e) {
    console.warn(`listExistingFriends failed: ${e.message}`);
  }
  return friends;
}

// 列出 data/friends/ 目录拿所有 .json 文件名（不读文件内容，1 次 API 调用）
// 用于文件名重复检查
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

// ========== Git 操作：写入文件并推送 ==========
function gitExec(args, { cwd, env } = {}) {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function commitAndPushFriendFile({ filename, content, targetBranch, workspace }) {
  const filePath = path.join(workspace, 'data', 'friends', filename);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');

  gitExec(['add', filePath], { cwd: workspace });

  // 检查是否有改动（幂等：内容相同则跳过）
  const status = gitExec(['status', '--porcelain'], { cwd: workspace });
  if (!status.trim()) {
    return { pushed: false, reason: 'no_changes' };
  }

  gitExec([
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `feat: add friend link via issue (#${process.env.ISSUE_NUMBER || 'manual'})`,
  ], { cwd: workspace });

  // push 重试：处理两种失败
  // 1. 网络抖动：直接重试
  // 2. non-fast-forward（并发场景：另一个 workflow run 同时 push 了）
  //    → git pull --rebase 拿到远端最新状态，再 push
  //    → rebase 不会冲突（每个 Issue 写不同文件名，data/friends/*.json 互不重叠）
  //    → 但 friends.json 可能被 build.yml 修改，rebase 时若冲突用 -X ours 保留我们的版本
  //      （friends.json 反正会被 build.yml 重建，谁的版本都无所谓）
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
        // 并发冲突：pull --rebase 拿到远端最新状态
        // 用 -X ours 策略：rebase 冲突时保留我们的改动
        // （实际上每个 Issue 写不同文件名，data/friends/*.json 不会冲突；
        //  唯一可能冲突的是 friends.json，但 build.yml 会重建，谁的版本都行）
        try {
          gitExec([
            '-c', 'user.name=github-actions[bot]',
            '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
            '-c', 'rerere.enabled=false',  // 不记录 reuse 记录，避免污染
            'pull', '--rebase', '-X', 'ours', 'origin', targetBranch,
          ], { cwd: workspace });
          // rebase 后重试 push（不走 sleep，直接进下一轮循环）
        } catch (rebaseErr) {
          // rebase 失败：abort rebase，避免污染工作目录
          try { gitExec(['rebase', '--abort'], { cwd: workspace }); } catch {}
          lastErr = `rebase failed: ${rebaseErr.message}`;
          await sleep(2000 * Math.pow(2, i));
        }
      } else {
        // 网络抖动：等待后重试
        await sleep(2000 * Math.pow(2, i));
      }
    }
  }
  if (!pushOk) throw new Error(`git push failed: ${lastErr}`);

  // 取 commit SHA
  const sha = gitExec(['rev-parse', 'HEAD'], { cwd: workspace });
  return { pushed: true, sha };
}

// 删除 data/friends/<filename> 并 push（用于 delete 操作）
async function deleteAndPushFriendFile({ filename, targetBranch, workspace }) {
  const filePath = path.join(workspace, 'data', 'friends', filename);
  if (!fs.existsSync(filePath)) {
    return { pushed: false, reason: 'file_not_found' };
  }
  fs.unlinkSync(filePath);
  gitExec(['rm', filePath], { cwd: workspace });

  gitExec([
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-m', `feat: delete friend link via issue (#${process.env.ISSUE_NUMBER || 'manual'})`,
  ], { cwd: workspace });

  // push 重试（同 commitAndPushFriendFile 逻辑，含 rebase）
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
            'pull', '--rebase', '-X', 'ours', 'origin', targetBranch,
          ], { cwd: workspace });
        } catch (rebaseErr) {
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

  const sha = gitExec(['rev-parse', 'HEAD'], { cwd: workspace });
  return { pushed: true, sha };
}

// 读取 main 上已存在的友链文件内容（用于 edit/delete 时拿 originalUrl）
async function readExistingFriendFile(octokit, owner, repo, filename) {
  try {
    const res = await octokit.rest.repos.getContent({
      owner, repo, path: `data/friends/${filename}`,
    });
    if (res.data && res.data.content) {
      const raw = Buffer.from(res.data.content, res.data.encoding || 'base64').toString('utf-8');
      const parsed = JSON.parse(raw);
      return { exists: true, data: parsed, raw };
    }
  } catch (e) {
    if (e.status === 404) return { exists: false };
    console.warn(`readExistingFriendFile failed: ${e.message}`);
  }
  return { exists: false };
}

// 域名所有权验证（同 PR 路径，验证码用 Issue 编号）
// 验证码：moara-friends=<issue_number>（与 PR 路径保持一致）
// 方式 A：DNS TXT 记录（hostname 或 _moara-friends.<hostname>）
// 方式 B：文件验证（https://<hostname>/.moara-friends-verify.txt 内容包含验证码）
async function verifyDomainOwnership(hostname, verificationCode) {
  // A：DNS TXT 记录
  const dnsResult = await verifyDnsTxt(hostname, verificationCode);
  if (dnsResult) {
    return { verified: true, method: `DNS TXT (${dnsResult})` };
  }

  // B：文件验证
  const fileResult = await verifyFile(hostname, verificationCode);
  if (fileResult && fileResult.error) {
    return { verified: false, error: `SSRF 拦截：${fileResult.error}` };
  }
  if (fileResult && fileResult.url) {
    return { verified: true, method: `文件验证 (${fileResult.url})` };
  }

  return { verified: false };
}

// ========== 评论构造 ==========
// 统一的状态卡片格式：所有 bot 状态更新走同一条评论
// 首次 create（发邮件），后续 update（不发邮件）

function buildStatusCard({ phase, title, body, marker, reprocess = false }) {
  // phase: 'pending' | 'success' | 'fail'
  // marker: '' | MARKER_ACCEPTED | MARKER_REJECTED
  const phaseIcon = phase === 'success' ? '✅' : phase === 'fail' ? '❌' : '🔄';
  const lines = [
    `${MARKER_STATUS_CARD}`,
    `## ${phaseIcon} ${title}${reprocess ? '（重新校验）' : ''}`,
    '',
  ];
  if (body) lines.push(body);
  if (marker) lines.push(marker);
  return lines.join('\n');
}

// pending 状态（处理中）
function buildPendingBody({ reprocess = false } = {}) {
  return buildStatusCard({
    phase: 'pending',
    title: '友链申请处理中',
    body: [
      '正在校验以下内容：',
      '- 字段格式',
      '- SSRF 防护',
      '- 回链域名一致性',
      '- URL 与头像可达性',
      '- 回链验证（你的友链页是否已添加本站链接）',
      '',
      '校验通常在 1-2 分钟内完成，请稍候。',
    ].join('\n'),
    reprocess,
  });
}

// success 状态
function buildSuccessBody({ filename, sha, usedPlaywright, reprocess = false }) {
  return buildStatusCard({
    phase: 'success',
    title: '友链申请已通过',
    body: [
      `已自动写入 \`${filename}\`，commit \`${sha ? sha.slice(0, 7) : 'unknown'}\`。`,
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
      '如需修改或删除，请走 PR 流程并完成域名所有权验证（详见 README）。',
    ].join('\n'),
    marker: MARKER_ACCEPTED,
    reprocess,
  });
}

// fail 状态
function buildFailBody(title, lines, { reprocess = false } = {}) {
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
      '<summary><b>🔄 重新校验</b></summary>',
      '',
      '修复上述问题后，在本 Issue 评论 `/recheck` 触发重新校验（**仅 Issue 创建者和管理员可触发**）。',
      '',
      '> 修改 Issue 正文（编辑上方描述）后，再评论 `/recheck` 即可，无需新建 Issue。',
      '',
      '</details>',
      '',
      `如对审核结果有疑问，可[联系 moara](mailto:moara@foxmail.com)。`,
    ].join('\n'),
    marker: MARKER_REJECTED,
    reprocess,
  });
}

// ========== 修改友链流程（Action: edit）==========
// 安全机制（同 PR 路径）：
// 1. 必须指定要修改的文件名（filename）
// 2. 该文件必须在 main 已存在
// 3. 通过域名所有权验证（DNS TXT 或文件验证），验证码 moara-friends=<Issue编号>
// 4. 新字段值需要通过字段校验 + SSRF + 可达性 + 回链验证（同 add）
async function processEdit({ octokit, owner, repo, issue, issue_number, app, workspace, targetBranch, core, forceReprocess }) {
  const log = (msg) => core?.info?.(msg) ?? console.log(msg);
  log(`\n========== 修改友链 Issue #${issue_number} ==========`);

  // 0. 发布 pending 评论
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildStatusCard({
      phase: 'pending',
      title: '修改友链申请处理中',
      body: '正在校验：\n- 文件名是否存在\n- 域名所有权验证\n- 字段格式 / SSRF / 可达性 / 回链',
      reprocess: forceReprocess,
    }));

  // 1. 检查 filename 必填
  if (!app.filename) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '缺少文件名',
      ['修改操作必须指定要修改的文件名（Filename 字段）'],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'no_filename' };
  }

  // 2. 文件名校验
  const filenameErr = validateFilename(app.filename);
  if (filenameErr) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '文件名不符合规则',
      [filenameErr, '', '文件名只能包含英文字母、数字、短横线和下划线，可选 `.json` 后缀。'],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'filename_invalid' };
  }
  const filename = normalizeFilename(app.filename);

  // 3. 检查文件是否存在 + 拿 originalUrl
  const existing = await readExistingFriendFile(octokit, owner, repo, filename);
  if (!existing.exists) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '文件不存在',
      [`要修改的文件 \`${filename}\` 在 main 分支不存在`, '', '如果是新增友链，请用 [Friend Link] 标题'],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'file_not_found' };
  }

  const originalUrl = existing.data.url;
  if (!originalUrl) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '无法读取原始 URL',
      [`文件 \`${filename}\` 没有 url 字段，无法进行域名验证`],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'no_original_url' };
  }

  // 4. 域名所有权验证（验证码用 Issue 编号，同 PR 路径格式 moara-friends=<编号>）
  let hostname = null;
  try { hostname = new URL(originalUrl).hostname; } catch {}

  if (!hostname) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '无法解析域名',
      [`无法从原始 URL \`${originalUrl}\` 解析 hostname`],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'no_hostname' };
  }

  const verificationCode = `moara-friends=${issue_number}`;
  log(`域名验证: hostname=${hostname}, code=${verificationCode}`);
  const verifyResult = await verifyDomainOwnership(hostname, verificationCode);

  if (!verifyResult.verified) {
    const failLines = [
      '你正在修改现有的友链数据。为了防止恶意改动，请完成域名所有权验证（以下两种方式任选其一）：',
      '',
      '**A：DNS TXT 记录**',
      `在域名 \`${hostname}\` 或 \`_moara-friends.${hostname}\` 下添加 DNS TXT 记录`,
      `记录内容：\`${verificationCode}\``,
      '',
      '**B：文件验证**',
      `在 \`${originalUrl}\` 网站根目录上传文件 \`.moara-friends-verify.txt\``,
      `文件内容：\`${verificationCode}\``,
      '',
      '> 验证码绑定 Issue 编号，验证通过后评论 `/recheck` 即可',
    ];
    if (verifyResult.error) {
      failLines.push('', `⚠️ ${verifyResult.error}`);
    }
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '域名所有权验证失败', failLines, { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'domain_verify_failed' };
  }

  log(`✓ 域名验证通过: ${verifyResult.method}`);

  // 5. 构造新 data + 字段校验
  // edit 时允许部分字段更新（用 Issue body 里的新值覆盖原值，未填的保留原值）
  const data = {
    name: app.name || existing.data.name,
    url: app.url || existing.data.url,
    backlink: app.friendPageUrl || existing.data.backlink || existing.data.url,
  };
  if (app.avatar) data.avatar = app.avatar;
  else if (existing.data.avatar !== undefined) data.avatar = existing.data.avatar;
  if (app.cover) data.cover = app.cover;
  else if (existing.data.cover !== undefined) data.cover = existing.data.cover;
  if (app.description) data.description = app.description;
  else if (existing.data.description !== undefined) data.description = existing.data.description;

  const fieldResult = validateFields(data);
  if (!fieldResult.ok) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '字段校验未通过', fieldResult.errors, { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'field_invalid' };
  }

  // 6. SSRF 防护
  const ssrfErrors = checkSsrf(data);
  if (ssrfErrors.length) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      'URL 不合法',
      ['检测到不可访问的地址：', '', ...ssrfErrors, '', '禁止使用：localhost、私有 IP、链路本地、云元数据端点等。'],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'ssrf' };
  }

  // 7. 回链域名一致性
  const domainErr = checkBacklinkDomainConsistency(data);
  if (domainErr) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      domainErr.title, domainErr.lines, { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'domain_mismatch' };
  }

  // 8. URL + avatar 可达性（同 add）
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
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '可达性检查未通过', lines, { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'unreachable' };
  }

  // 9. 回链验证（同 add）
  log(`🔗 正在抓取友链页面检查回链：${data.backlink}`);
  const backlinkResult = await checkBacklink(data.backlink, { log });

  if (!backlinkResult.ok) {
    const lines = backlinkResult.reason === 'unreachable'
      ? [`backlink URL：\`${data.backlink}\``, `抓取失败：${(backlinkResult.errors || []).join('；')}`, '', '请确认你的友链页 URL 正确且可公开访问。']
      : ['未检测到本站友链链接', '', `**需要添加的链接**：\`${SITE_URL}\``, `**你的友链页面**：\`${data.backlink}\``, '', '**常见原因**：', '- 友链页还没添加本站链接', '- CDN 缓存返回了旧版本', '', '**解决方法**：', `1. 在你的友链页添加：<a href="${SITE_URL}">沫然Blog</a>`, '2. 等待 CDN 刷新'];
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '回链验证未通过', lines, { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'backlink_not_found' };
  }

  log(`✓ 回链验证通过${backlinkResult.usedPlaywright ? '（Playwright 渲染）' : '（静态 HTML）'}`);

  // 10. 写入新内容（覆盖原文件）
  const stdData = standardizeFriendData(data);
  const content = JSON.stringify(stdData, null, 2) + '\n';

  let pushResult;
  try {
    process.env.ISSUE_NUMBER = String(issue_number);
    pushResult = await commitAndPushFriendFile({
      filename, content, targetBranch, workspace,
    });
  } catch (e) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '写入文件失败',
      [`错误：${e.message}`, '', '校验已通过但写入仓库失败。请稍后重试，或[联系 moara](mailto:moara@foxmail.com)。'],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'push_failed', error: e.message };
  }

  log(`✅ 修改成功：${filename} @ ${pushResult.sha.slice(0, 7)}`);

  // 11. 成功评论 + 关闭 + 触发 build
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildStatusCard({
      phase: 'success',
      title: '友链修改已通过',
      body: [
        `已修改 \`${filename}\`，commit \`${pushResult.sha ? pushResult.sha.slice(0, 7) : 'unknown'}\`。`,
        '',
        `**域名验证**：${verifyResult.method} ✓`,
        `**校验结果**：`,
        `- 字段格式 ✓`,
        `- SSRF 防护 ✓`,
        `- 回链域名一致性 ✓`,
        `- URL 与头像可达性 ✓`,
        `- 回链验证 ✓${backlinkResult.usedPlaywright ? '（Playwright 渲染）' : '（静态 HTML）'}`,
        '',
        '稍后 build workflow 会重建 `friends.json`，CDN 缓存刷新后即可在本站友链页看到。',
      ].join('\n'),
      marker: MARKER_ACCEPTED,
      reprocess: forceReprocess,
    }));

  await ensureLabel(octokit, owner, repo, '友链', '0e8a16');
  await ensureLabel(octokit, owner, repo, '已互链', '0e8a16');
  await addLabels(octokit, owner, repo, issue_number, ['友链', '已互链']);
  await closeIssue(octokit, owner, repo, issue_number, 'completed');

  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: 'build.yml', ref: targetBranch,
    });
    log('✅ build workflow 已触发');
  } catch (e) {
    log(`⚠️  trigger build workflow failed: ${e.message}`);
  }

  return { ok: true, filename, sha: pushResult.sha, action: 'edit' };
}

// ========== 删除友链流程（Action: delete）==========
// 安全机制（同 PR 路径）：
// 1. 必须指定要删除的文件名（filename）
// 2. 该文件必须在 main 已存在
// 3. 通过域名所有权验证，验证码 moara-friends=<Issue编号>
async function processDelete({ octokit, owner, repo, issue, issue_number, app, workspace, targetBranch, core, forceReprocess }) {
  const log = (msg) => core?.info?.(msg) ?? console.log(msg);
  log(`\n========== 删除友链 Issue #${issue_number} ==========`);

  // 0. 发布 pending 评论
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildStatusCard({
      phase: 'pending',
      title: '删除友链申请处理中',
      body: '正在校验：\n- 文件名是否存在\n- 域名所有权验证',
      reprocess: forceReprocess,
    }));

  // 1. 检查 filename 必填
  if (!app.filename) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '缺少文件名',
      ['删除操作必须指定要删除的文件名（Filename 字段）'],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'no_filename' };
  }

  // 2. 文件名校验
  const filenameErr = validateFilename(app.filename);
  if (filenameErr) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '文件名不符合规则',
      [filenameErr, '', '文件名只能包含英文字母、数字、短横线和下划线，可选 `.json` 后缀。'],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'filename_invalid' };
  }
  const filename = normalizeFilename(app.filename);

  // 3. 检查文件是否存在 + 拿 originalUrl
  const existing = await readExistingFriendFile(octokit, owner, repo, filename);
  if (!existing.exists) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '文件不存在',
      [`要删除的文件 \`${filename}\` 在 main 分支不存在`, '', '可能已被删除，或文件名有误'],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'file_not_found' };
  }

  const originalUrl = existing.data.url;
  if (!originalUrl) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '无法读取原始 URL',
      [`文件 \`${filename}\` 没有 url 字段，无法进行域名验证`],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'no_original_url' };
  }

  // 4. 域名所有权验证
  let hostname = null;
  try { hostname = new URL(originalUrl).hostname; } catch {}

  if (!hostname) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '无法解析域名',
      [`无法从原始 URL \`${originalUrl}\` 解析 hostname`],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'no_hostname' };
  }

  const verificationCode = `moara-friends=${issue_number}`;
  log(`域名验证: hostname=${hostname}, code=${verificationCode}`);
  const verifyResult = await verifyDomainOwnership(hostname, verificationCode);

  if (!verifyResult.verified) {
    const failLines = [
      '你正在删除现有的友链数据。为了防止恶意删除，请完成域名所有权验证（以下两种方式任选其一）：',
      '',
      '**A：DNS TXT 记录**',
      `在域名 \`${hostname}\` 或 \`_moara-friends.${hostname}\` 下添加 DNS TXT 记录`,
      `记录内容：\`${verificationCode}\``,
      '',
      '**B：文件验证**',
      `在 \`${originalUrl}\` 网站根目录上传文件 \`.moara-friends-verify.txt\``,
      `文件内容：\`${verificationCode}\``,
      '',
      '> 验证码绑定 Issue 编号，验证通过后评论 `/recheck` 即可',
    ];
    if (verifyResult.error) {
      failLines.push('', `⚠️ ${verifyResult.error}`);
    }
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '域名所有权验证失败', failLines, { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'domain_verify_failed' };
  }

  log(`✓ 域名验证通过: ${verifyResult.method}`);

  // 5. 删除文件 + push
  let pushResult;
  try {
    process.env.ISSUE_NUMBER = String(issue_number);
    pushResult = await deleteAndPushFriendFile({
      filename, targetBranch, workspace,
    });
  } catch (e) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '删除文件失败',
      [`错误：${e.message}`, '', '校验已通过但删除仓库文件失败。请稍后重试，或[联系 moara](mailto:moara@foxmail.com)。'],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'push_failed', error: e.message };
  }

  log(`✅ 删除成功：${filename} @ ${pushResult.sha.slice(0, 7)}`);

  // 6. 成功评论 + 关闭 + 触发 build
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildStatusCard({
      phase: 'success',
      title: '友链删除已通过',
      body: [
        `已删除 \`${filename}\`，commit \`${pushResult.sha ? pushResult.sha.slice(0, 7) : 'unknown'}\`。`,
        '',
        `**域名验证**：${verifyResult.method} ✓`,
        '',
        '稍后 build workflow 会重建 `friends.json`，该友链将从本站友链页移除。',
      ].join('\n'),
      marker: MARKER_ACCEPTED,
      reprocess: forceReprocess,
    }));

  await ensureLabel(octokit, owner, repo, '友链', '0e8a16');
  await ensureLabel(octokit, owner, repo, '已删除', '6f42c1');
  await addLabels(octokit, owner, repo, issue_number, ['友链', '已删除']);
  await closeIssue(octokit, owner, repo, issue_number, 'completed');

  try {
    await octokit.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: 'build.yml', ref: targetBranch,
    });
    log('✅ build workflow 已触发');
  } catch (e) {
    log(`⚠️  trigger build workflow failed: ${e.message}`);
  }

  return { ok: true, filename, sha: pushResult.sha, action: 'delete' };
}

// ========== 单个 Issue 处理流程 ==========
async function processIssue({ octokit, owner, repo, issue, workspace, targetBranch, core, forceReprocess = false }) {
  const issue_number = issue.number;
  const log = (msg) => core?.info?.(msg) ?? console.log(msg);

  log(`\n========== 处理 Issue #${issue_number}: ${issue.title}${forceReprocess ? ' (强制重新校验)' : ''} ==========`);

  // 幂等检查：
  // - forceReprocess=true（recheck 触发）：只跳过已 accepted 的，允许重新处理 rejected 的
  // - forceReprocess=false（opened/review 触发）：accepted 和 rejected 都跳过
  try {
    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner, repo, issue_number, per_page: 100,
    });
    const allBodies = comments.map(c => c.body || '').join('\n');
    const hasAccepted = allBodies.includes(MARKER_ACCEPTED);
    const hasRejected = allBodies.includes(MARKER_REJECTED);

    if (hasAccepted) {
      log(`⏭️  Issue #${issue_number} 已通过（accepted），跳过`);
      return { skipped: true, reason: 'already_accepted' };
    }
    if (hasRejected && !forceReprocess) {
      log(`⏭️  Issue #${issue_number} 之前被拒（rejected），跳过；如需重试请评论 /recheck`);
      return { skipped: true, reason: 'already_rejected' };
    }
    if (hasRejected && forceReprocess) {
      log(`🔄 Issue #${issue_number} 之前被拒，现在重新校验`);
    }
  } catch (e) {
    core?.warning?.(`检查已有评论失败: ${e.message}`);
  }

  // 标题前缀检查（支持 [Friend Link] / [Edit] / [Delete]）
  if (!hasSupportedPrefix(issue.title)) {
    log(`⏭️  Issue #${issue_number} 标题不以支持的任一前缀开头，跳过`);
    return { skipped: true };
  }

  // ── 0. 发布初始确认评论（首次创建会发邮件，后续 recheck 时编辑同一条评论不发邮件）──
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildPendingBody({ reprocess: forceReprocess }));

  // ── 1. 解析 Issue body ──
  const app = parseApplication(issue.body || '');
  log(`解析字段: ${JSON.stringify(app, null, 2)}`);

  // 根据 action 分流（优先级：标题前缀 > body 的 Action 字段 > 默认 add）
  // - 标题 [Edit] → 强制 action=edit
  // - 标题 [Delete] → 强制 action=delete
  // - 标题 [Friend Link] → 用 body 的 Action 字段（默认 add）
  const titleAction = inferActionFromTitle(issue.title);
  if (titleAction !== 'add') {
    app.action = titleAction;
    log(`从标题推断 action: ${titleAction}`);
  }
  const action = ['add', 'edit', 'delete'].includes(app.action) ? app.action : 'add';
  if (action === 'edit') {
    return await processEdit({
      octokit, owner, repo, issue, issue_number, app, workspace, targetBranch, core,
      forceReprocess,
    });
  }
  if (action === 'delete') {
    return await processDelete({
      octokit, owner, repo, issue, issue_number, app, workspace, targetBranch, core,
      forceReprocess,
    });
  }

  // ===== 以下为 add 流程（原有逻辑） =====

  // 检查必要字段是否全部非空（filename 除外，可以由 name 推断）
  const missingFields = [];
  if (!app.name) missingFields.push('Site Name');
  if (!app.url) missingFields.push('Site URL');
  if (!app.friendPageUrl) missingFields.push('Friend Page URL');
  if (!app.filename) missingFields.push('Filename');
  if (missingFields.length) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      'Issue 内容不完整',
      [
        `缺少必要字段：${missingFields.join(', ')}`,
        '',
        '请使用申请表单（apply.html 或博客 /friends 页面）生成的草稿提交，不要手工编辑 Issue 正文。',
        '完整字段包括：Site Name / Site URL / Friend Page URL / Avatar URL（可选） / Short Description（可选） / Filename。',
      ],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'incomplete' };
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
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '字段校验未通过',
      fieldResult.errors,
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'field_invalid' };
  }

  // ── 3. 文件名校验 ──
  const filenameErr = validateFilename(app.filename);
  if (filenameErr) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '文件名不符合规则',
      [
        filenameErr,
        '',
        '文件名只能包含英文字母、数字、短横线和下划线，可选 `.json` 后缀。',
        '示例：`example.json`、`my-blog.json`、`demo-blog`。',
      ],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'filename_invalid' };
  }
  const filename = normalizeFilename(app.filename);

  // ── 4. SSRF 防护 ──
  const ssrfErrors = checkSsrf(data);
  if (ssrfErrors.length) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      'URL 不合法',
      [
        '检测到不可访问的地址：',
        '',
        ...ssrfErrors,
        '',
        '禁止使用：localhost、私有 IP、链路本地、云元数据端点等。',
      ],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'ssrf' };
  }

  // ── 5. 回链域名一致性 ──
  const domainErr = checkBacklinkDomainConsistency(data);
  if (domainErr) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      domainErr.title,
      domainErr.lines,
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'domain_mismatch' };
  }

  // ── 6. 去重检查（文件名）──
  const index = await buildFriendIndex(octokit, owner, repo);

  if (index.byFilename[filename]) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '文件名已被占用',
      [
        `你申请的文件名：\`${filename}\``,
        '该文件名已存在，请换一个。',
        '建议用站点域名做文件名，如 `example.json`。',
      ],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'filename_exists' };
  }

  // ── 7. URL + avatar 可达性 ──
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
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody('可达性检查未通过', lines, { reprocess: forceReprocess }));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'unreachable' };
  }

  // ── 8. 回链验证（静态 + Playwright 兜底）──
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
          '3. 等待 CDN 刷新后重新提交 Issue',
        ];
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody('回链验证未通过', lines, { reprocess: forceReprocess }));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'backlink_not_found' };
  }

  log(`✓ 回链验证通过${backlinkResult.usedPlaywright ? '（Playwright 渲染）' : '（静态 HTML）'}`);

  // ── 9. 写入文件并 push ──
  const stdData = standardizeFriendData(data);
  const content = JSON.stringify(stdData, null, 2) + '\n';

  let pushResult;
  try {
    process.env.ISSUE_NUMBER = String(issue_number);
    pushResult = await commitAndPushFriendFile({
      filename,
      content,
      targetBranch,
      workspace,
    });
  } catch (e) {
    await upsertStatusComment(octokit, owner, repo, issue_number, buildFailBody(
      '写入文件失败',
      [
        `错误：${e.message}`,
        '',
        '校验已通过但写入仓库失败。请稍后重试，或[联系 moara](mailto:moara@foxmail.com)。',
      ],
      { reprocess: forceReprocess },
    ));
    await closeIssue(octokit, owner, repo, issue_number, 'not_planned');
    await addLabels(octokit, owner, repo, issue_number, ['友链', '未通过']);
    return { ok: false, reason: 'push_failed', error: e.message };
  }

  if (!pushResult.pushed) {
    // 内容相同（幂等），仍然算成功
    log(`⚠️  文件内容与现有相同，未触发 push（幂等）`);
  } else {
    log(`✅ 写入成功：${filename} @ ${pushResult.sha.slice(0, 7)}`);
  }

  // ── 10. 成功评论（编辑主评论）+ 关闭 Issue + 触发 build ──
  await upsertStatusComment(octokit, owner, repo, issue_number,
    buildSuccessBody({
      filename,
      sha: pushResult.sha,
      usedPlaywright: backlinkResult.usedPlaywright,
      reprocess: forceReprocess,
    }));

  await ensureLabel(octokit, owner, repo, '友链', '0e8a16');
  await ensureLabel(octokit, owner, repo, '已互链', '0e8a16');
  await addLabels(octokit, owner, repo, issue_number, ['友链', '已互链']);

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

  if (mode === 'opened') {
    // 处理刚打开的 Issue（首次申请）
    const issue = context.payload.issue;
    if (!issue) {
      core.warning('未找到 issue payload');
      return;
    }
    await processIssue({
      octokit: github, owner, repo, issue, workspace, targetBranch, core,
      forceReprocess: false,
    });
    return;
  }

  if (mode === 'recheck') {
    // 处理 issue_comment 事件中的 /recheck 斜杠命令
    const comment = context.payload.comment;
    const issue = context.payload.issue;
    if (!comment || !issue) {
      core.warning('未找到 comment 或 issue payload');
      return;
    }

    // 二次校验评论内容（防止 workflow_dispatch 误触发）
    const body = (comment.body || '').trim();
    if (!body.startsWith('/recheck')) {
      core.info(`评论内容不是 /recheck 命令，跳过：${body.slice(0, 50)}`);
      return;
    }

    // 标题前缀检查（支持 [Friend Link] / [Edit] / [Delete]）
    if (!hasSupportedPrefix(issue.title)) {
      core.info(`Issue #${issue.number} 标题不以支持的任一前缀开头，跳过`);
      return;
    }

    // 权限校验：仅 Issue 创建者 + 仓库 owner/admin 可触发 /recheck
    const commenter = comment.user?.login;
    const issueAuthor = issue.user?.login;
    core.info(`权限校验: commenter=${commenter}, issueAuthor=${issueAuthor}`);
    const perm = await checkRecheckPermission(github, owner, repo, commenter, issueAuthor);
    if (!perm.allowed) {
      core.warning(`用户 @${commenter} 无权触发 /recheck（reason=${perm.reason}）`);
      await createComment(github, owner, repo, issue.number, [
        `> @${commenter} 无权触发 \`/recheck\`。`,
        `> 仅 Issue 创建者（@${issueAuthor || '?'}）和仓库管理员可触发重新校验。`,
        `> 如需重新校验，请让 Issue 创建者操作，或[联系 moara](mailto:moara@foxmail.com)。`,
      ].join('\n'));
      return;
    }
    core.info(`✓ 权限通过: @${commenter} (${perm.reason})`);

    // 如果 Issue 处于关闭状态，先重新打开（这样 processIssue 才会真正执行）
    // 但如果 Issue 已 accepted，processIssue 内部会直接跳过；
    // 此时若我们已 reopen，需要把它 close 回去以保持 completed 状态
    let reopenedByUs = false;
    if (issue.state === 'closed') {
      core.info(`Issue #${issue.number} 处于关闭状态，重新打开以进行校验`);
      try {
        await github.rest.issues.update({
          owner, repo, issue_number: issue.number, state: 'open',
        });
        reopenedByUs = true;
      } catch (e) {
        core.warning(`重新打开 Issue 失败: ${e.message}`);
      }
    }

    // 触发处理（强制重新校验）
    const result = await processIssue({
      octokit: github, owner, repo, issue, workspace, targetBranch, core,
      forceReprocess: true,
    });

    // 处理 processIssue 跳过的情况（已 accepted）
    // 不管是不是我们 reopen 的，只要被跳过且原因是 already_accepted：
    // 1. 如果 Issue 当前是 open 状态 → close 回去（保持 completed）
    // 2. 评论一条提示「无需重新校验」
    // 这样用户评论 /recheck 后能看到明确反馈，而不是「无反应」
    if (result?.skipped && result?.reason === 'already_accepted') {
      core.info(`Issue #${issue.number} 已 accepted，处理跳过逻辑`);

      // 1. 如果当前是 open，close 回去
      if (issue.state === 'open' || reopenedByUs) {
        core.info(`Issue #${issue.number} 当前是 open 状态，关闭为 completed`);
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
      await createComment(github, owner, repo, issue.number, [
        `> 此 Issue 已通过校验（友链已写入仓库），无需重新校验。`,
        `> 如需修改友链信息，请走 PR 流程或评论 /edit /delete 命令。`,
      ].join('\n'));
    }
    return;
  }

  if (mode === 'comment_edit' || mode === 'comment_delete') {
    // 处理 issue_comment 事件中的 /edit /delete 斜杠命令
    // 在符合标题前缀（[Friend Link]/[Edit]/[Delete]）的 Issue 中评论触发
    const action = mode === 'comment_edit' ? 'edit' : 'delete';
    const command = mode === 'comment_edit' ? '/edit' : '/delete';
    const comment = context.payload.comment;
    const issue = context.payload.issue;
    if (!comment || !issue) {
      core.warning('未找到 comment 或 issue payload');
      return;
    }

    const body = (comment.body || '').trim();

    // 标题前缀检查（支持 [Friend Link] / [Edit] / [Delete]）
    if (!hasSupportedPrefix(issue.title)) {
      core.info(`Issue #${issue.number} 标题不以支持的任一前缀开头，跳过`);
      return;
    }

    // 权限校验：仅 Issue 创建者 + 仓库 owner/admin 可触发
    const commenter = comment.user?.login;
    const issueAuthor = issue.user?.login;
    core.info(`权限校验: commenter=${commenter}, issueAuthor=${issueAuthor}, action=${action}`);
    const perm = await checkRecheckPermission(github, owner, repo, commenter, issueAuthor);
    if (!perm.allowed) {
      core.warning(`用户 @${commenter} 无权触发 ${command}（reason=${perm.reason}）`);
      await createComment(github, owner, repo, issue.number, [
        `> @${commenter} 无权触发 \`${command}\`。`,
        `> 仅 Issue 创建者（@${issueAuthor || '?'}）和仓库管理员可触发。`,
        `> 如需操作，请让 Issue 创建者操作，或[联系 moara](mailto:moara@foxmail.com)。`,
      ].join('\n'));
      return;
    }
    core.info(`✓ 权限通过: @${commenter} (${perm.reason})`);

    // 解析评论中的模板字段（模板格式同 Issue body）
    // 评论必须同时包含「命令 + 完整模板」才触发，防止恶意篡改
    // 模板至少需要包含 Filename 字段（否则无法定位要操作的文件）
    const commentApp = parseApplication(body);

    // 检查评论是否包含命令
    const hasCommand = body.toLowerCase().startsWith(command);
    // 检查评论是否包含模板（至少有 Filename 字段）
    const hasTemplate = !!commentApp.filename;

    if (!hasCommand && !hasTemplate) {
      // 既没命令也没模板 → 不是 /edit /delete 触发，静默跳过
      core.info(`评论既不含 ${command} 命令也不含模板，跳过`);
      return;
    }

    if (hasCommand && !hasTemplate) {
      // 只有命令没模板 → 留评论提示
      await createComment(github, owner, repo, issue.number, [
        `> 收到 \`${command}\` 命令，但评论中未包含完整模板。`,
        `>`,
        `> **模板格式**（在评论中粘贴以下格式，填入字段值）：`,
        '```',
        `${command}`,
        `- Filename: 你的文件名.json`,
        mode === 'comment_edit' ? `- Site Name: 新名称（可选，留空保留原值）` : '',
        mode === 'comment_edit' ? `- Site URL: https://新URL（可选）` : '',
        mode === 'comment_edit' ? `- Friend Page URL: https://新友链页（可选）` : '',
        '```',
        '',
        `> 填好后重新评论即可触发。`,
      ].filter(Boolean).join('\n'));
      return;
    }

    if (!hasCommand && hasTemplate) {
      // 只有模板没命令 → 留评论提示
      await createComment(github, owner, repo, issue.number, [
        `> 检测到模板内容，但评论中未包含 \`${command}\` 命令。`,
        `>`,
        `> 请在评论开头加上 \`${command}\` 命令后再提交，例如：`,
        '```',
        `${command}`,
        `- Filename: ${commentApp.filename}`,
        '```',
        '',
        `> 这样才会触发${action === 'edit' ? '修改' : '删除'}流程。`,
      ].join('\n'));
      return;
    }

    // 命令 + 模板都齐全 → 触发 edit/delete 流程
    core.info(`✓ 评论包含 ${command} 命令 + 模板，触发 ${action} 流程`);

    // 如果 Issue 处于关闭状态，先重新打开
    if (issue.state === 'closed') {
      core.info(`Issue #${issue.number} 处于关闭状态，重新打开以进行处理`);
      try {
        await github.rest.issues.update({
          owner, repo, issue_number: issue.number, state: 'open',
        });
      } catch (e) {
        core.warning(`重新打开 Issue 失败: ${e.message}`);
      }
    }

    // 构造 app 对象（用评论解析的字段 + 强制 action）
    const app = { ...commentApp, action };

    // 调用 processEdit / processDelete
    const result = action === 'edit'
      ? await processEdit({
          octokit: github, owner, repo, issue, issue_number: issue.number,
          app, workspace, targetBranch, core, forceReprocess: true,
        })
      : await processDelete({
          octokit: github, owner, repo, issue, issue_number: issue.number,
          app, workspace, targetBranch, core, forceReprocess: true,
        });

    // 如果 processEdit/Delete 跳过（已 accepted），提示
    if (result?.skipped && result?.reason === 'already_accepted') {
      await createComment(github, owner, repo, issue.number, [
        `> 此 Issue 已处理过，无需重复操作。`,
      ].join('\n'));
    }
    return;
  }

  if (mode === 'review') {
    // 扫描所有开放的友链 Issue（[Friend Link] / [Edit] / [Delete]）
    core.info('🔍 扫描开放的友链 Issue...');
    const openIssues = await github.paginate(github.rest.issues.listForRepo, {
      owner, repo, state: 'open', per_page: 100,
    });

    const friendLinkIssues = openIssues.filter(
      (i) => hasSupportedPrefix(i.title)
    );

    core.info(`找到 ${friendLinkIssues.length} 个开放的友链 Issue`);

    let processed = 0;
    for (const issue of friendLinkIssues.slice(0, MAX_ISSUES_PER_RUN)) {
      try {
        await processIssue({ octokit: github, owner, repo, issue, workspace, targetBranch, core });
        processed++;
      } catch (e) {
        core.warning(`处理 Issue #${issue.number} 时异常: ${e.message}`);
      }
    }

    core.info(`\n========== 本轮处理完毕：${processed}/${friendLinkIssues.length} ==========`);
    return;
  }

  throw new Error(`未知 mode: ${mode}`);
}
