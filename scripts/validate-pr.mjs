/**
 * scripts/validate-pr.mjs
 *
 * PR 路径校验脚本，被 .github/workflows/auto-pr.yml 调用。
 * 监听 pull_request_target 事件，校验 data/friends/*.json 变更。
 *
 * 共享校验逻辑（SSRF / 可达性 / 回链 / 域名验证 / 字段校验）
 * 已抽取到 scripts/lib/validate.mjs，本文件仅保留 PR 特有的：
 *   - GitHub PR API 调用（文件清单 / merge / label）
 *   - 单文件变更范围检查
 *   - 修改/删除操作的域名所有权验证
 *   - 自动合并逻辑
 *
 * 入口：runValidation({ owner, repo, pull_number, prHead, prAuthor, runUrl, github, core, baseSha })
 */

import {
  SITE_URL,
  isPublicUrl,
  verifyBacklink,
  fetchPage,
  fetchWithPlaywright,
  checkUrlReachable,
  verifyDnsTxt,
  verifyFile,
  validateFields,
  checkSsrf,
  checkBacklinkDomainConsistency,
  sleep,
  getHostname,
} from './lib/validate.mjs';

// ========== 主校验流程 ==========
export async function runValidation({ owner, repo, pull_number, prHead, prAuthor, runUrl, github, core, baseSha }) {

  // ========== Tag 管理 ==========
  const LABEL_FRIEND = '友链';
  const LABEL_OK = '已互链';
  const LABEL_DELETED = '已删除';
  const LABEL_FAIL = '未通过';

  async function ensureLabel(name, color) {
    try {
      await github.rest.issues.getLabel({ owner, repo, name });
    } catch (e) {
      if (e.status === 404) {
        try {
          await github.rest.issues.createLabel({ owner, repo, name, color });
          core.info(`✓ 创建 label: ${name} (#${color})`);
        } catch (createErr) {
          core.warning(`创建 label ${name} 失败: ${createErr.message}`);
        }
      } else {
        core.warning(`查询 label ${name} 失败: ${e.message}`);
      }
    }
  }

  async function syncLabels({ add = [], remove = [] }) {
    const labelColors = { [LABEL_FRIEND]: '0e8a16', [LABEL_OK]: '0e8a16', [LABEL_DELETED]: '6f42c1', [LABEL_FAIL]: 'd73a4a' };
    for (const name of add) {
      await ensureLabel(name, labelColors[name] || 'ededed');
    }

    if (add.length) {
      try {
        await github.rest.issues.addLabels({
          owner, repo, issue_number: pull_number, labels: add,
        });
        core.info(`✓ 打 tag: ${add.join(', ')}`);
      } catch (e) {
        core.warning(`addLabels 失败: ${e.message}`);
      }
    }

    for (const name of remove) {
      try {
        await github.rest.issues.removeLabel({
          owner, repo, issue_number: pull_number, name,
        });
        core.info(`✓ 删除 tag: ${name}`);
      } catch (e) {
        if (e.status !== 404) {
          core.warning(`removeLabel ${name} 失败: ${e.message}`);
        }
      }
    }
  }

  async function fail(title, lines) {
    core.info(`❌ ${title}`);
    for (const l of lines) core.info(`  - ${l}`);

    const body = [
      `## ❌ ${title}`,
      '',
      ...lines.map((l) => {
        if (l === '') return '';
        if (l.startsWith('```') || l.startsWith('    ')) return l;
        if (/^\s*([-*+]|\d+\.)\s/.test(l)) return l;
        return `- ${l}`;
      }),
      '',
      '---',
      '解决后，关闭并重新打开该 PR 会自动触发重新校验。',
      `[查看 Action 运行日志](${runUrl})；[联系moara](mailto:moara@foxmail.com)`,
    ].join('\n');
    try {
      await github.rest.issues.createComment({ owner, repo, issue_number: pull_number, body });
    } catch (e) {
      core.warning(`createComment failed: ${e.message}`);
    }

    await syncLabels({ add: [LABEL_FRIEND, LABEL_FAIL], remove: [LABEL_OK] });
  }

  // ── 0. 合并冲突检查 ──
  try {
    const prInfo = await github.rest.pulls.get({ owner, repo, pull_number });
    core.info(`pr.mergeable=${prInfo.data.mergeable}, pr.mergeable_state=${prInfo.data.mergeable_state}`);
    if (prInfo.data.mergeable === false) {
      await fail('存在合并冲突', [
        '你的 PR 有冲突，可能是文件名和已有友链重复。',
        '',
        '**解决方法**：',
        '1. 改用不同的文件名',
        '2. Sync fork 与本仓库完全同步，重新修改',
      ]);
      return;
    }
  } catch (e) {
    core.warning(`检查 mergeable 失败: ${e.message}`);
  }

  // ── 1. 文件变更范围校验 ──
  let files = [];
  try {
    for await (const res of github.paginate.iterator(
      github.rest.pulls.listFiles,
      { owner, repo, pull_number, per_page: 100 }
    )) {
      files.push(...res.data);
    }
  } catch (e) {
    await fail('无法读取文件清单', [`错误：${e.message}`]);
    return;
  }

  if (files.length !== 1) {
    await fail('只能包含一个文件变更', [
      `当前变更数：${files.length}`,
      '请保证每个 PR 仅新增/修改/删除 data/friends/ 下单个 .json 文件',
    ]);
    return;
  }

  const file = files[0];
  const FRIENDS_PREFIX = 'data/friends/';
  if (!file.filename.startsWith(FRIENDS_PREFIX)) {
    await fail('文件路径不合法', [
      `检测到文件：${file.filename}`,
      '只允许更改 data/friends/ 下的文件',
    ]);
    return;
  }

  if (!['added', 'modified', 'removed'].includes(file.status)) {
    await fail('不支持的文件操作', [`status: ${file.status}`]);
    return;
  }

  // ── 2. 修改/删除操作：域名所有权验证 ──
  // 如果 main 已有 → 是修改/删除操作 → 需要域名所有权验证
  // 两种方式（任一通过即可）：DNS TXT 记录、文件验证
  let fileExistsInMain = false;
  let originalUrl = null;
  try {
    const baseRes = await github.rest.repos.getContent({
      owner, repo, path: file.filename, ref: baseSha,
    });
    if (!Array.isArray(baseRes.data) && baseRes.data.content) {
      fileExistsInMain = true;
      const raw = Buffer.from(baseRes.data.content, baseRes.data.encoding || 'base64').toString('utf-8');
      const parsed = JSON.parse(raw);
      if (parsed.url) originalUrl = parsed.url;
    }
  } catch (e) {
    if (e.status !== 404) {
      core.warning(`检查 base 文件失败: ${e.message}`);
    }
  }

  if (fileExistsInMain) {
    core.info(`检测到修改/删除操作（已有 ${file.filename}），需要域名所有权验证`);

    if (!originalUrl) {
      core.warning('无法读取原始文件 URL，跳过域名验证');
    } else {
      let hostname = null;
      try { hostname = new URL(originalUrl).hostname; } catch {}

      if (!hostname) {
        core.warning('无法解析原始 URL 的 hostname，跳过域名验证');
      } else {
        const verificationCode = `moara-friends=${pull_number}`;
        let verified = false;
        let verifiedMethod = null;

        // A：DNS TXT 记录
        if (!verified) {
          const dnsResult = await verifyDnsTxt(hostname, verificationCode);
          if (dnsResult) {
            verified = true;
            verifiedMethod = 'DNS TXT';
          }
        }

        // B：文件验证
        if (!verified) {
          const fileResult = await verifyFile(hostname, verificationCode);
          if (fileResult && fileResult.error) {
            await fail('文件验证：SSRF 拦截', [
              `在验证 \`${hostname}\` 域名所有权时触发安全防护：`,
              '',
              fileResult.error,
              '',
              '该域名的 URL 可能指向内部网络或被重定向到不安全地址',
            ]);
            return;
          }
          if (fileResult && fileResult.url) {
            verified = true;
            verifiedMethod = '文件验证';
          }
        }

        if (verified) {
          core.info(`✓ 域名所有权验证通过: ${verifiedMethod}`);
        } else {
          await fail('域名所有权验证失败', [
            '你正在修改/删除现有的友链数据。为了防止恶意改动，请完成域名所有权验证（以下两种方式任选其一）：',
            '',
            '**A：DNS TXT 记录**',
            `在域名 \`${hostname}\` 或 \`_moara-friends.${hostname}\` 下添加 DNS TXT 记录`,
            `记录内容：\`${verificationCode}\``,
            '',
            '**B：文件验证**',
            `在 \`${originalUrl}\` 网站根目录上传文件 \`.moara-friends-verify.txt\``,
            `文件内容：\`${verificationCode}\``,
            '',
          ]);
          return;
        }
      }
    }
  }

  // ── 3. JSON 解析与 schema 校验 ──
  if (file.status === 'removed') {
    core.info('删除操作，跳过校验');
  } else {
    if (!file.filename.endsWith('.json')) {
      await fail('文件类型不合法', [
        `检测到非 .json 文件：${file.filename}`,
        'data/friends/ 下只允许 .json 文件',
      ]);
      return;
    }

    let rawContent = '';
    // 优先用 raw_url 读取完整文件内容
    // file.patch 解析有风险（大文件截断、二进制 diff 等）
    if (file.status === 'added' || file.status === 'modified') {
      try {
        const res = await fetch(file.raw_url, {
          headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        rawContent = await res.text();
      } catch (e) {
        // raw_url 失败时 fallback 到 patch 解析
        if (file.patch) {
          rawContent = file.patch
            .split('\n')
            .filter((line) => !line.startsWith('@@') && !line.startsWith('---') && !line.startsWith('+++'))
            .map((line) => (line.startsWith('+') ? line.slice(1) : line.startsWith(' ') ? line.slice(1) : line))
            .join('\n')
            .trim();
        } else {
          await fail('无法读取文件内容', [`错误：${e.message}`, `raw_url: ${file.raw_url}`]);
          return;
        }
      }
    }

    let data;
    try {
      data = JSON.parse(rawContent);
    } catch (e) {
      const lines = [
        `文件：${file.filename}`,
        `错误：${e.message}`,
        '',
      ];

      if (/["""]/.test(rawContent)) {
        lines.push('**检测到中文全角引号**');
        lines.push('- ❌ 你用了：`"..."`（弯引号，左右配对）');
        lines.push('- ✅ 应改为：`"..."`（直引号，同一个字符）');
        lines.push('');
      }
      if (/[：，]/.test(rawContent)) {
        lines.push('**检测到中文全角标点**');
        lines.push('- ❌ 你用了：`：` 或 `，`（全角）');
        lines.push('- ✅ 应改为：`:` 或 `,`（半角）');
        lines.push('');
      }
      if (/'[^']*'\s*:|:\s*'[^']*'/.test(rawContent)) {
        lines.push('**检测到单引号字符串**');
        lines.push("- ❌ 你用了：`'...'`（单引号）");
        lines.push('- ✅ 应改为：`"..."`（双引号）');
        lines.push('');
      }
      if (/,\s*[}\]]/.test(rawContent)) {
        lines.push('**检测到尾逗号**');
        lines.push('- ❌ 你写了：`{ "a": 1, }`（最后一个属性后有逗号）');
        lines.push('- ✅ 应改为：`{ "a": 1 }`（删除 `}` 前的逗号）');
        lines.push('');
      }
      if (rawContent.charCodeAt(0) === 0xFEFF) {
        lines.push('**检测到 BOM 头**');
        lines.push('- ❌ 文件以 UTF-8 BOM 开头（不可见字符）');
        lines.push('- ✅ 用编辑器另存为「UTF-8（无 BOM）」');
        lines.push('');
      }
      if (/^\s*\/\//m.test(rawContent) || /^\s*\/\*/m.test(rawContent)) {
        lines.push('**检测到注释**');
        lines.push('- ❌ 你写了：`// 注释` 或 `/* 注释 */`');
        lines.push('- ✅ JSON 不支持注释，请删除所有注释');
        lines.push('');
      }

      lines.push('**解决方法**：');
      lines.push('1. 用 [JSONLint](https://jsonlint.com) 校验');
      lines.push('2. 把中文符号替换为英文符号');

      await fail('解析失败', lines);
      return;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      await fail('JSON 类型错误', ['JSON 必须是对象，不能是数组或基本类型']);
      return;
    }

    const fieldErrors = validateFields(data);
    if (fieldErrors.errors.length) {
      await fail('数据校验未通过', [`文件：${file.filename}`, ...fieldErrors.errors]);
      return;
    }

    if (Object.prototype.hasOwnProperty.call(data, 'vip')) {
      await fail('检测到 vip 字段', [
        'vip 字段仅站主直推可用，PR 不可携带',
        `文件：${file.filename}`,
        '请删除 vip 字段',
      ]);
      return;
    }

    // ── 4. SSRF 防护 ──
    const ssrfErrors = checkSsrf(data);
    if (ssrfErrors.length) {
      await fail('URL 不合法', [
        '检测到不可访问的地址：',
        '',
        ...ssrfErrors,
        '',
        '禁止使用：localhost、私有 IP、链路本地、云元数据端点等',
      ]);
      return;
    }

    // ── 5. 回链域名一致性校验 ──
    const domainErr = checkBacklinkDomainConsistency(data);
    if (domainErr) {
      await fail(domainErr.title, domainErr.lines);
      return;
    }

    // ── 6. URL + avatar 可达性检查───
    core.info('🌐 正在并行检查站点 URL 和头像 URL 可达性...');

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
      await fail('可达性检查未通过', lines);
      return;
    }

    // ── 7. 回链验证 ───
    core.info(`🔗 正在抓取友链页面检查回链：${data.backlink}`);

    const pageRes = await fetchPage(data.backlink);
    if (!pageRes.ok) {
      await fail('回链验证：无法访问友链页面', [
        `backlink URL：\`${data.backlink}\``,
        `抓取失败：${pageRes.errors.join('；')}`,
        '',
        '请确认你的友链页 URL 正确且可公开访问',
      ]);
      return;
    }

    core.info(`✓ 友链页面抓取成功 (HTTP ${pageRes.status}, ${pageRes.text.length} bytes)`);

    let backlinkResult = verifyBacklink(pageRes.text, SITE_URL);
    let usedPlaywright = false;

    if (!backlinkResult.found) {
      core.info(`⚠️ 静态 HTML 未找到回链，尝试用 Playwright 渲染（处理 JS 动态页面）...`);
      const pwRes = await fetchWithPlaywright(data.backlink);
      if (pwRes.ok) {
        core.info(`✓ Playwright 渲染成功 (${pwRes.text.length} bytes)`);
        backlinkResult = verifyBacklink(pwRes.text, SITE_URL);
        usedPlaywright = true;
      } else {
        core.warning(`Playwright 渲染失败：${pwRes.errors.join('；')}`);
      }
    }

    if (!backlinkResult.found) {
      const lines = [
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
        '3. 等待 CDN 刷新',
      ];
      await fail('回链验证未通过', lines);
      return;
    }

    core.info(`✓ 回链验证通过：找到匹配链接 ${backlinkResult.matchedHref}${usedPlaywright ? ' （Playwright 渲染）' : ' （静态 HTML）'}`);
  }

  // ── 8. 自动合并 ───
  core.info('✅ 所有校验通过，执行自动合并');

  async function attemptMerge() {
    return github.rest.pulls.merge({
      owner,
      repo,
      pull_number,
      merge_method: 'squash',
      commit_title: `friends: ${file.status} ${file.filename} (#${pull_number})`,
      commit_message: `由 auto-pr workflow 自动合并\n\nCo-authored-by: ${prAuthor}`,
    });
  }

  let mergeRes = null;
  let mergeError = null;

  try {
    mergeRes = await attemptMerge();
  } catch (e) {
    core.warning(`合并第一次失败：${e.message}，3 秒后重试...`);
    mergeError = e;
  }

  if (mergeError) {
    await sleep(3000);
    try {
      mergeRes = await attemptMerge();
      mergeError = null;
    } catch (e2) {
      mergeError = e2;
    }
  }

  if (mergeError) {
    await fail('自动合并失败', [`错误：${mergeError.message}`, '请手动合并此 PR 或[联系 moara](mailto:moara@foxmail.com)']);
    return;
  }

  core.info(`✅ 合并成功：${mergeRes.data.sha}`);

  const isDelete = file.status === 'removed';
  if (isDelete) {
    await syncLabels({ add: [LABEL_FRIEND, LABEL_DELETED], remove: [LABEL_OK, LABEL_FAIL] });
  } else {
    await syncLabels({ add: [LABEL_FRIEND, LABEL_OK], remove: [LABEL_DELETED, LABEL_FAIL] });
  }

  try {
    await github.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: 'build.yml', ref: 'main',
    });
    core.info('✅ build workflow 已触发');
  } catch (e) {
    core.warning(`trigger build workflow failed: ${e.message}`);
  }
}
