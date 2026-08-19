# moara-friends

沫然Blog 的友链仓库。提交 PR 或 Issue 即可添加友链，自动校验。

## 怎么添加友链

提供两种申请方式，任选其一：

- **方式一：网页表单（推荐，无需 Fork 仓库）** —— 在线填写表单 → 登录 GitHub 提交 Issue → 自动校验
- **方式二：PR**（适合熟悉 Git 的用户）—— Fork 仓库 → 编辑 JSON → 提交 PR → 自动校验合并

---

### 方式一：网页表单（推荐）

#### 1. 先在你的友链页加上我的链接

在你的网站的友链页面，添加一个指向本站的链接：`https://blog.945426.xyz`

**这一步必须先做**——提交后会自动抓取你的友链页检查是否已添加本站链接。

#### 2. 打开申请表单

打开 [`apply.html`](./apply.html)（直接点击或在浏览器中访问 `https://github.com/moaradc/moara-friends/blob/main/apply.html` 后点右上角「Raw」或下载到本地用浏览器打开）。

#### 3. 填写并提交

表单会校验字段格式，生成一个 GitHub Issue 草稿链接：

1. 勾选「我已在友链页添加本站链接」
2. 填写：站点名称 / 站点 URL / 友链页 URL / 头像（可选）/ 简介（可选）/ 文件名
3. 点「登录 GitHub 并提交」→ 跳转到 GitHub Issue 创建页
4. 在 GitHub 页面确认内容，点 **Submit new issue** 正式提交

#### 4. 等待自动审核

提交后 `issue-bot` workflow 会自动处理（约 1-2 分钟）：

- **校验通过**：自动写入 `data/friends/<filename>.json`，触发构建，CDN 刷新后即可在本站友链页看到
- **校验失败**：会在 Issue 中评论失败原因，Issue 关闭。**无需新建 Issue**，按下方触发重新校验即可

#### 5. 校验失败后如何重新校验

修改 Issue 正文，然后触发重新校验：

- **方式 A：重新打开 Issue** —— 在 Issue 页底部点「Reopen issue」按钮，等待自动重新校验
- **方式 B：评论 `/recheck`** —— 在该 Issue 评论区直接输入 `/recheck` 并提交，等待自动重新校验（即使 Issue 已关闭也可以用这种方式，会自动帮你打开）

> 失败评论底部自带一个「🔄 重新校验」折叠块，展开即可看到这两种方式的说明
>
> 已通过的 Issue 不会被重复触发。已失败的 Issue 可重新校验，直到通过或放弃
>
> **权限**：只有 Issue 创建者和仓库管理员能触发 `/recheck`。陌生人评论 `/recheck` 会被拒绝并提示
> 
> 为避免频繁邮件打扰，所有状态更新会合并到同一条评论
> 
> 修改/删除已有友链请走下方 PR 流程（需域名所有权验证）。Issue 路径仅支持新增。

---

### 方式二：PR（适合熟悉 Git 的用户）

#### 1. 先在你的友链页加上我的链接

在你的网站的友链页面，添加一个指向本站的链接：`https://blog.945426.xyz`

**这一步必须先做**——提交 PR 时会自动检查你的友链页有没有我的链接，没有会被拒绝

#### 2. Fork 仓库

点右上角 Fork，把仓库复制到你的账号下

#### 3. 新建友链文件

在你的 Fork 里，进入 `data/friends/` 目录，新建一个 JSON 文件。文件名随意，建议用你的站点名（如 `example.json`）

#### 4. 填写友链信息

按下面的模板填写：

```json
{
  "name": "站点名称",
  "avatar": "https://.../头像.png",
  "description": "简介/描述",
  "url": "https://你的站点",
  "backlink": "https://你的站点/友链页地址"
}
```

最小可用：

```json
{
  "name": "站点名称",
  "url": "https://你的站点",
  "backlink": "https://你的站点/友链页地址"
}
```

#### 5. 提交 PR

提交代码，创建 Pull Request

校验通过 → 自动合并，CDN 缓存刷新后友链就会出现在我的博客上

校验失败 → 会在 PR 里评论告诉你哪里不对，改完 push 到该 PR 或者关闭重新打开会重新校验

## 怎么更新友链

> 更新/删除已收录的友链只走 PR 路径（需域名所有权验证）。Issue 路径仅支持新增

修改你自己的友链信息（如换头像、改名字、改简介），提 PR：

1. Fork 仓库（如果之前 Fork 过，先 Sync fork 与本仓库同步）
2. 修改 `data/friends/` 下你自己的 JSON 文件
3. 提交 PR

**更新操作需要域名所有权验证**，因为涉及修改已有数据。验证方式任选其一：

### 方式 A：DNS TXT 记录

在你的域名下添加 DNS TXT 记录：

- 主机记录：`@`（根域名）或 `_moara-friends`
- 记录类型：TXT
- 记录内容：`moara-friends=<PR编号>`

例如你的 PR 编号是 42，记录内容就是 `moara-friends=42`

### 方式 B：文件验证

在你的网站根目录上传文件 `.moara-friends-verify.txt`：

- 文件内容：`moara-friends=<PR编号>`

例如你的 PR 编号是 42，文件内容就是 `moara-friends=42`

文件需要能通过 `https://你的域名/.moara-friends-verify.txt` 直接访问。

> 两种方式任选其一，验证通过后即可合并。验证码绑定 PR 编号，每次 PR 不同

## 怎么删除友链

删除你自己的友链，同样提 PR：

1. Fork 仓库（如果之前 Fork 过，先 Sync fork 与本仓库同步）
2. 删除 `data/friends/` 下你自己的 JSON 文件
3. 提交 PR

删除操作同样需要域名所有权验证（方式同上）

## 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 站点名称 |
| `url` | ✅ | 站点地址，以 `https://` 开头 |
| `backlink` | ✅ | 你的友链页地址 |
| `avatar` | ❌ | 头像图片地址 |
| `description` | ❌ | 简介/描述 |

> `backlink` 填你自己网站上那个友链页的地址，不是首页。比如你的友链页是`https://example.com/links`，就填这个

## 常见问题

**Q: 校验提示"回链验证未通过"怎么办？**

A: 说明在你的友链页里没找到我的链接。请确认：
1. 链接已经添加到友链页
2. 链接地址是 `https://blog.945426.xyz` 或 `https://blog.945426.xyz/`
3. 添加后可能需要等几分钟让 CDN 缓存刷新

**Q: 更新/删除友链提示"域名所有权验证失败"怎么办？**

A: 修改或删除已有友链需要验证你拥有该域名。任选一种方式：
- DNS TXT 记录：在域名下添加 `moara-friends=<PR编号>` 的 TXT 记录
- 文件验证：在网站根目录放 `.moara-friends-verify.txt`，内容为 `moara-friends=<PR编号>`

**Q: PR 提交后多久能合并？**

A: 校验通过会立即自动合并，CDN 缓存刷新就能在我的博客看到

**Q: PR 被关闭了怎么重新校验？**

A: 关闭的 PR 可以重新打开触发校验，或者开新 PR。如果 PR 有冲突，先 Sync fork 同步最新代码再修改

**Q: Issue 校验失败后怎么重新申请？**

A: **不需要新建 Issue**。修改 Issue 正文后，任选一种方式触发重新校验：
- 重新打开 Issue（点 Reopen 按钮）
- 在该 Issue 评论 `/recheck`

bot 会自动重新校验。已通过的 Issue 不会被重复触发；已失败的 Issue 可无限次重试。

**Q: 想批量重试失败的 Issue 怎么办？**

A: 仓库维护者可在 Actions 页面手动触发 `issue-bot` workflow（`workflow_dispatch`），会扫描所有开放的 `[Friend Link]` Issue 并重试处理。

**Q: Issue 提交后多久能合并？**

A: 校验通过会立即写入文件并触发构建，CDN 缓存刷新后即可在本站友链页看到，通常 1-2 分钟内完成。
