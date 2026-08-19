/**
 * scripts/lib/validate.mjs
 *
 * 友链校验共享模块。
 * 同时被 PR 路径（auto-pr.yml → validate-pr.mjs）和 Issue 路径
 * （issue-bot.yml → validate-issue.mjs）引用，保证两套校验规则一致。
 *
 * 模块导出：
 *   - SITE_URL             本站规范地址
 *   - SCHEMA_FIELDS        字段定义
 *   - isPublicUrl          SSRF 防护
 *   - verifyBacklink       回链字符串匹配
 *   - fetchPage            静态抓取
 *   - fetchWithPlaywright  Playwright 渲染抓取（兜底动态页面）
 *   - checkUrlReachable    URL/头像可达性
 *   - verifyDnsTxt          DNS TXT 验证
 *   - verifyFile            文件验证
 *   - validateFields       字段 schema 校验
 *   - checkBacklink        整体回链检查（静态+Playwright 兜底）
 *   - sleep
 *   - getHostname
 *
 * 仅依赖 node 内置模块和项目已声明的 @playwright/test。
 */

// 本站规范地址。回链验证以此为准。
export const SITE_URL = 'https://blog.945426.xyz';

// 字段定义（顺序也用于标准化输出）
export const SCHEMA_FIELDS = {
  name:        { required: true,  type: 'nonEmptyString' },
  url:         { required: true,  type: 'httpUrl' },
  backlink:    { required: true,  type: 'httpUrl' },
  avatar:      { required: false, type: 'nullOrString' },
  description: { required: false, type: 'string' },
};

// 文件名规则：英文/数字/下划线/短横线，可选 .json 后缀
export const FILENAME_RE = /^[A-Za-z0-9_-]+(?:\.json)?$/;

// ========== 工具 ==========
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export function getHostname(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return null;
  }
}

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

// ========== SSRF 防护 ==========
export function isPublicUrl(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return { ok: false, reason: 'URL 无效' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { ok: false, reason: `协议必须是 http/https（当前：${u.protocol}）` };
  }
  if (u.username || u.password) {
    return { ok: false, reason: 'URL 不能包含用户名/密码' };
  }

  let hostname = u.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return { ok: false, reason: `拒绝 localhost：${hostname}` };
  }

  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    hostname = hostname.slice(1, -1);
  }

  let ipv4 = null;
  if (hostname.includes(':')) {
    if (hostname.includes('ffff:')) {
      return { ok: false, reason: `拒绝 IPv4-mapped IPv6：${hostname}` };
    }
    const normalized = hostname.replace(/(^|:)0+(?=:|$)/g, '$1').replace(/^0+:/, '0:');
    if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
      return { ok: false, reason: `拒绝 IPv6 回环：${hostname}` };
    }
    if (normalized.startsWith('fe80:') || normalized.startsWith('fc') || normalized.startsWith('fd')) {
      return { ok: false, reason: `拒绝 IPv6 链路本地/唯一本地：${hostname}` };
    }
    if (normalized.startsWith('ff')) {
      return { ok: false, reason: `拒绝 IPv6 多播：${hostname}` };
    }
    if (normalized === '::' || normalized === '0:0:0:0:0:0:0:0') {
      return { ok: false, reason: `拒绝 IPv6 未指定地址：${hostname}` };
    }
  } else {
    ipv4 = hostname;
  }

  if (ipv4) {
    const m = ipv4.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (m) {
      const [a, b] = [parseInt(m[1]), parseInt(m[2])];
      if (m.slice(1).some(s => parseInt(s) > 255)) {
        return { ok: false, reason: `IPv4 字段超范围：${ipv4}` };
      }
      if (a === 127) return { ok: false, reason: `拒绝回环地址：${ipv4}` };
      if (a === 10) return { ok: false, reason: `拒绝私有地址 10.0.0.0/8：${ipv4}` };
      if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: `拒绝私有地址 172.16.0.0/12：${ipv4}` };
      if (a === 192 && b === 168) return { ok: false, reason: `拒绝私有地址 192.168.0.0/16：${ipv4}` };
      if (a === 169 && b === 254) return { ok: false, reason: `拒绝链路本地 169.254.0.0/16：${ipv4}` };
      if (a === 0) return { ok: false, reason: `拒绝 0.0.0.0/8：${ipv4}` };
      if (a === 100 && b >= 64 && b <= 127) return { ok: false, reason: `拒绝 CGNAT 100.64.0.0/10：${ipv4}` };
      if (a === 192 && b === 0 && parseInt(m[3]) === 2) return { ok: false, reason: `拒绝 TEST-NET-1 192.0.2.0/24：${ipv4}` };
      if (a === 192 && b === 0 && parseInt(m[3]) === 0) return { ok: false, reason: `拒绝 IETF 协议分配 192.0.0.0/24：${ipv4}` };
      if (a === 198 && (b === 51 && parseInt(m[3]) === 100)) return { ok: false, reason: `拒绝 TEST-NET-2 198.51.100.0/24：${ipv4}` };
      if (a === 203 && b === 0 && parseInt(m[3]) === 113) return { ok: false, reason: `拒绝 TEST-NET-3 203.0.113.0/24：${ipv4}` };
      if (a === 198 && (b === 18 || b === 19)) return { ok: false, reason: `拒绝基准测试 198.18.0.0/15：${ipv4}` };
      if (a >= 224) return { ok: false, reason: `拒绝多播/保留地址：${ipv4}` };
    }
  }
  return { ok: true };
}

// ========== 可达性检查 ==========
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  'Mozilla/5.0 (compatible; Googlebot/2.1; +https://www.google.com/bot.html)',
];

export async function fetchPage(url, { timeout = 15000 } = {}) {
  const errors = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const ua = USER_AGENTS[attempt % USER_AGENTS.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let currentUrl = url;
      let finalRes = null;
      let hops = 0;

      while (hops < 5) {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), timeout);
        const res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: c.signal,
          headers: {
            'User-Agent': ua,
            'Accept': 'text/html,application/xhtml+xml,*/*',
          },
        });
        clearTimeout(t);

        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.get('location');
          if (!location) break;
          const nextUrl = new URL(location, currentUrl).href;
          const ssrfCheck = isPublicUrl(nextUrl);
          if (!ssrfCheck.ok) {
            return { ok: false, errors: [`SSRF 拦截：重定向到 ${nextUrl}（${ssrfCheck.reason}）`] };
          }
          currentUrl = nextUrl;
          hops++;
          continue;
        }

        finalRes = res;
        break;
      }

      if (finalRes && finalRes.status >= 200 && finalRes.status < 400) {
        const text = await finalRes.text();
        return { ok: true, status: finalRes.status, text, finalUrl: currentUrl };
      }
      errors.push(`HTTP ${finalRes ? finalRes.status : 'unknown'}`);
    } catch (e) {
      clearTimeout(timer);
      errors.push(e.name === 'AbortError' ? `超时(${timeout / 1000}s)` : e.message);
    }
    if (attempt < 2) await sleep(500 * Math.pow(3, attempt));
  }
  return { ok: false, errors };
}

// ========== Playwright 渲染抓取（兜底动态页面） ==========
let playwrightInstalled = false;

async function ensurePlaywrightBrowser() {
  if (playwrightInstalled) return;
  const { execFileSync } = await import('node:child_process');
  console.log('📦 安装 Playwright 浏览器（约 20 秒）...');
  execFileSync('npx', ['playwright', 'install', 'chromium', '--with-deps'], {
    stdio: 'inherit',
    timeout: 120000,
  });
  playwrightInstalled = true;
  console.log('✓ Playwright 浏览器安装完成');
}

export async function fetchWithPlaywright(url) {
  await ensurePlaywrightBrowser();

  const { execFileSync } = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'moara-pw-'));
  const scriptPath = path.join(tmpDir, 'fetch-pw.mjs');
  const script = `
    import { createRequire } from 'module';
    const require = createRequire('${process.cwd()}/');
    const { chromium } = require('@playwright/test');
    const targetUrl = process.argv[2];

    const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

    async function fetchOnce() {
      let browser;
      try {
        browser = await chromium.launch({
          headless: true,
          args: ['--disable-blink-features=AutomationControlled'],
        });
        const context = await browser.newContext({
          userAgent: CHROME_UA,
          locale: 'zh-CN',
          timezoneId: 'Asia/Shanghai',
          viewport: { width: 1920, height: 1080 },
          extraHTTPHeaders: {
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          },
        });

        await context.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
          window.chrome = { runtime: {} };
        });

        const page = await context.newPage();

        const response = await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        try {
          await page.waitForLoadState('networkidle', { timeout: 5000 });
        } catch {}

        const body = await page.content();
        const finalUrl = page.url();
        const status = response ? response.status() : 0;
        await browser.close();
        return { ok: status >= 200 && status < 400, status, text: body, finalUrl };
      } catch (e) {
        if (browser) await browser.close();
        return { ok: false, error: e.message };
      }
    }

    let result = await fetchOnce();
    if (!result.ok) {
      await new Promise(r => setTimeout(r, 2000));
      result = await fetchOnce();
    }
    console.log(JSON.stringify(result));
  `;
  fs.writeFileSync(scriptPath, script);

  try {
    const output = execFileSync('node', [scriptPath, url], {
      cwd: tmpDir,
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const result = JSON.parse(output.trim().split('\n').pop());
    if (result.ok) {
      return { ok: true, status: result.status, text: result.text, finalUrl: result.finalUrl };
    }
    return { ok: false, errors: [result.error || '未知错误'] };
  } catch (e) {
    return { ok: false, errors: [e.message] };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

export async function checkUrlReachable(url, { requireImage = false } = {}) {
  const errors = [];
  const redirects = [];

  for (let attempt = 0; attempt < 3; attempt++) {
    const ua = USER_AGENTS[attempt % USER_AGENTS.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': ua,
          'Accept': requireImage ? 'image/*' : '*/*',
          'Range': 'bytes=0-1023',
          'Accept-Encoding': 'identity',
        },
      });
      clearTimeout(timer);

      let finalRes = res;
      let location = res.headers.get('location');
      let hops = 0;
      while ([301, 302, 303, 307, 308].includes(finalRes.status) && location && hops < 5) {
        const nextUrl = new URL(location, url).href;
        const redirectCheck = isPublicUrl(nextUrl);
        if (!redirectCheck.ok) {
          return { ok: false, errors: [`SSRF 拦截：重定向到 ${nextUrl}（${redirectCheck.reason}）`], redirects, attempts: attempt + 1 };
        }
        redirects.push(`${finalRes.status} → ${nextUrl}`);
        const c2 = new AbortController();
        const t2 = setTimeout(() => c2.abort(), 15000);
        finalRes = await fetch(nextUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: c2.signal,
          headers: {
            'User-Agent': ua,
            'Accept': requireImage ? 'image/*' : '*/*',
            'Range': 'bytes=0-1023',
            'Accept-Encoding': 'identity',
          },
        });
        clearTimeout(t2);
        location = finalRes.headers.get('location');
        hops++;
      }

      if (finalRes.status >= 200 && finalRes.status < 400) {
        if (requireImage) {
          const ct = (finalRes.headers.get('content-type') || '').toLowerCase();
          if (!ct.startsWith('image/')) {
            errors.push(`Content-Type 不是 image/* (实际: ${ct || '空'})`);
            await sleep(500 * Math.pow(3, attempt));
            continue;
          }
        }
        return {
          ok: true,
          status: finalRes.status,
          contentType: finalRes.headers.get('content-type'),
          redirects,
          attempts: attempt + 1,
        };
      }

      if (finalRes.status === 405 || finalRes.status === 403 || finalRes.status === 416) {
        const c3 = new AbortController();
        const t3 = setTimeout(() => c3.abort(), 15000);
        const r3 = await fetch(url, {
          method: 'GET',
          redirect: 'follow',
          signal: c3.signal,
          headers: {
            'User-Agent': ua,
            'Accept': requireImage ? 'image/*' : '*/*',
          },
        });
        clearTimeout(t3);
        if (r3.status >= 200 && r3.status < 400) {
          if (requireImage) {
            const ct = (r3.headers.get('content-type') || '').toLowerCase();
            if (!ct.startsWith('image/')) {
              errors.push(`Content-Type 不是 image/* (实际: ${ct || '空'})`);
              await sleep(500 * Math.pow(3, attempt));
              continue;
            }
          }
          return {
            ok: true,
            status: r3.status,
            contentType: r3.headers.get('content-type'),
            redirects,
            attempts: attempt + 1,
            fallback: true,
          };
        }
        errors.push(`HTTP ${r3.status}`);
      } else {
        errors.push(`HTTP ${finalRes.status}`);
      }
    } catch (e) {
      clearTimeout(timer);
      errors.push(e.name === 'AbortError' ? '超时(15s)' : e.message);
    }
    if (attempt < 2) await sleep(500 * Math.pow(3, attempt));
  }

  return { ok: false, errors, redirects, attempts: 3 };
}

// ========== 回链字符串匹配 ==========
export function verifyBacklink(html, expected) {
  if (!html || !expected) return { found: false, reason: 'empty input' };
  const target = expected.replace(/\/$/, '').toLowerCase();
  const normalized = html.toLowerCase()
    .replaceAll('\\/', '/')
    .replaceAll('&amp;', '&')
    .replace(/\/+(['"\s>])/g, '$1');
  const patterns = [
    /href\s*=\s*["']([^"']+)["']/gi,
    /href\s*=\s*([^\s>]+)/gi,
  ];
  const foundLinks = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(normalized)) !== null) {
      const href = (m[1] || '').trim();
      if (!href.startsWith('http')) continue;
      foundLinks.push(href);
      const linkNorm = href.replace(/\/$/, '');
      if (linkNorm === target) {
        return { found: true, matchedHref: href, links: foundLinks };
      }
    }
  }
  return { found: false, links: foundLinks, target };
}

/**
 * 完整回链检查：先静态 fetch，未命中再用 Playwright 兜底
 * @returns { ok, reason, usedPlaywright }
 */
export async function checkBacklink(backlinkUrl, { log = console.log } = {}) {
  const pageRes = await fetchPage(backlinkUrl);
  if (!pageRes.ok) {
    return { ok: false, reason: 'unreachable', errors: pageRes.errors, status: null };
  }

  let backlinkResult = verifyBacklink(pageRes.text, SITE_URL);
  let usedPlaywright = false;

  if (!backlinkResult.found) {
    log?.(`⚠️ 静态 HTML 未找到回链，尝试用 Playwright 渲染（处理 JS 动态页面）...`);
    const pwRes = await fetchWithPlaywright(backlinkUrl);
    if (pwRes.ok) {
      log?.(`✓ Playwright 渲染成功 (${pwRes.text.length} bytes)`);
      backlinkResult = verifyBacklink(pwRes.text, SITE_URL);
      usedPlaywright = true;
    } else {
      log?.(`Playwright 渲染失败：${(pwRes.errors || []).join('；')}`);
    }
  }

  if (!backlinkResult.found) {
    return { ok: false, reason: 'not_found', usedPlaywright, status: pageRes.status };
  }

  return {
    ok: true,
    usedPlaywright,
    status: pageRes.status,
    matchedHref: backlinkResult.matchedHref,
  };
}

// ========== 域名所有权验证（仅 PR 路径用，但保留在 lib 里以便复用） ==========
export async function verifyDnsTxt(hostname, expectedCode) {
  const dns = (await import('node:dns')).promises;
  const domains = [hostname, `_moara-friends.${hostname}`];
  for (const d of domains) {
    try {
      const records = await dns.resolveTxt(d);
      const flat = records.flat();
      if (flat.some(t => t.includes(expectedCode))) {
        return d;
      }
    } catch {}
  }
  return null;
}

export async function verifyFile(hostname, expectedCode) {
  const initialCheck = isPublicUrl(`https://${hostname}/`);
  if (!initialCheck.ok) return { error: `SSRF 拦截：${initialCheck.reason}` };

  for (const proto of ['https', 'http']) {
    let currentUrl = `${proto}://${hostname}/.moara-friends-verify.txt`;
    let hops = 0;

    while (hops < 5) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        const res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: { 'User-Agent': 'moara-friends-bot/1.0' },
        });
        clearTimeout(timer);

        if ([301, 302, 303, 307, 308].includes(res.status)) {
          const location = res.headers.get('location');
          if (!location) break;
          const nextUrl = new URL(location, currentUrl).href;
          const ssrfCheck = isPublicUrl(nextUrl);
          if (!ssrfCheck.ok) return { error: `SSRF 拦截：重定向到 ${nextUrl}（${ssrfCheck.reason}）` };
          currentUrl = nextUrl;
          hops++;
          continue;
        }

        if (res.status >= 200 && res.status < 400) {
          const text = await res.text();
          if (text.includes(expectedCode)) {
            return { url: currentUrl };
          }
        }
        break;
      } catch {
        break;
      }
    }
  }
  return null;
}

// ========== 字段校验 ==========
/**
 * 校验单条友链字段
 * @returns { ok: boolean, errors: string[] }
 */
export function validateFields(data) {
  const errs = [];

  if (!isNonEmptyString(data.name)) errs.push('`name` 必填且为非空字符串');
  if (!isNonEmptyString(data.url)) errs.push('`url` 必填且为非空字符串');
  else if (!isHttpUrl(data.url)) errs.push('`url` 必须是 `http://` 或 `https://` URL');
  if (data.avatar !== undefined && !isNullOrString(data.avatar))
    errs.push('`avatar` 必须是字符串或 `null`（或省略）');
  if (data.description !== undefined && typeof data.description !== 'string')
    errs.push('`description` 必须是字符串（或省略）');

  if (!isNonEmptyString(data.backlink)) {
    errs.push('`backlink` 必填且为非空字符串（你的友链页 URL）');
  } else if (!isHttpUrl(data.backlink)) {
    errs.push('`backlink` 必须是 `http://` 或 `https://` URL');
  }

  return errs.length ? { ok: false, errors: errs } : { ok: true, errors: [] };
}

/**
 * SSRF 防护：批量检查 url / avatar / backlink
 * @returns string[] 错误列表（空数组表示通过）
 */
export function checkSsrf(data) {
  const ssrfErrors = [];

  const urlSsrf = isPublicUrl(data.url);
  if (!urlSsrf.ok) ssrfErrors.push(`\`url\`：${urlSsrf.reason}`);

  if (typeof data.avatar === 'string' && data.avatar.trim()) {
    const avSsrf = isPublicUrl(data.avatar);
    if (!avSsrf.ok) ssrfErrors.push(`\`avatar\`：${avSsrf.reason}`);
  }

  const blSsrf = isPublicUrl(data.backlink);
  if (!blSsrf.ok) ssrfErrors.push(`\`backlink\`：${blSsrf.reason}`);

  return ssrfErrors;
}

/**
 * 检查回链域名一致性（url 和 backlink 必须同 host）
 * @returns string|null 错误描述，null 表示通过
 */
export function checkBacklinkDomainConsistency(data) {
  const urlHost = getHostname(data.url);
  const backlinkHost = getHostname(data.backlink);
  if (urlHost && backlinkHost && urlHost !== backlinkHost) {
    return {
      title: '回链域名不一致',
      lines: [
        `你的 url：\`${urlHost}\``,
        `你的 backlink：\`${backlinkHost}\``,
        '两者必须一致（backlink 必须是你自己网站的友链页）',
      ],
    };
  }

  const siteHost = getHostname(SITE_URL);
  if (backlinkHost && siteHost && backlinkHost === siteHost) {
    return {
      title: 'backlink 指向本站',
      lines: [
        'backlink 字段应填写你自己网站的友链页 URL，不能指向本站',
        `本站 URL：\`${SITE_URL}\``,
      ],
    };
  }

  return null;
}

/**
 * 标准化输出对象（用于写入 JSON 文件，避免字段顺序不一致产生 diff 噪音）
 */
export function standardizeFriendData(data) {
  const out = {
    name: data.name,
    url: data.url,
  };
  if (data.avatar !== undefined) out.avatar = data.avatar;
  if (data.description !== undefined) out.description = data.description;
  return out;
}

/**
 * 校验文件名规则
 * @returns string|null 错误描述，null 表示通过
 */
export function validateFilename(filename) {
  if (!filename) return '文件名不能为空';
  if (filename.toLowerCase() === '.json') return '文件名不能只有 .json';
  if (!FILENAME_RE.test(filename)) return '文件名只能包含英文字母、数字、短横线和下划线';
  return null;
}

/**
 * 标准化文件名：如果没有 .json 后缀，自动补上
 */
export function normalizeFilename(filename) {
  if (!filename) return filename;
  return filename.endsWith('.json') ? filename : `${filename}.json`;
}

/**
 * URL 归一化（用于去重检查）
 * 仅去末尾斜杠 + 转小写（与 buildFriendIndex 中保持一致）
 */
export function normalizeUrlForDedup(urlStr) {
  if (!urlStr) return '';
  return urlStr.replace(/\/$/, '').toLowerCase();
}

/**
 * 建立去重索引（仅 2 次 API 调用，与友链数量无关）：
 * - byFilename：列 data/friends/ 目录拿所有 .json 文件名（不读文件内容）
 * - byUrl：读仓库根目录的 friends.json 聚合文件，从中提取所有友链的 url
 *
 * friends.json 是 build.js 在每次合并/写入后自动重建的产物，
 * 包含所有友链的 name/url/avatar/description（不含文件名，不含 backlink）。
 * 用它做 URL 去重，不需要再逐个读 data/friends/*.json 文件。
 *
 * @param {object} octokit - @octokit/rest 实例
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{byUrl: Object, byFilename: Object}>}
 *   - byUrl: { [normalizedUrl]: true }
 *   - byFilename: { [filename]: true }
 */
export async function buildFriendIndex(octokit, owner, repo) {
  const index = { byUrl: {}, byFilename: {} };

  // 1. 列 data/friends/ 目录拿文件名（不读内容）
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

  // 2. 读 friends.json（聚合文件）拿 url 列表
  try {
    const fileRes = await octokit.rest.repos.getContent({ owner, repo, path: 'friends.json' });
    if (fileRes.data && fileRes.data.content) {
      const raw = Buffer.from(fileRes.data.content, fileRes.data.encoding || 'base64').toString('utf-8');
      const friends = JSON.parse(raw);
      if (Array.isArray(friends)) {
        for (const f of friends) {
          if (f.url) {
            const urlNorm = normalizeUrlForDedup(f.url);
            if (urlNorm) index.byUrl[urlNorm] = true;
          }
        }
      }
    }
  } catch (e) {
    console.warn(`buildFriendIndex: read friends.json failed: ${e.message}`);
  }
  return index;
}
