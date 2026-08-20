# moara-friends

沫然Blog 的友链仓库。提交 Issue 或 PR 即可添加友链，自动校验

## 一张表看懂

两种方式做同一件事，选一种就行：

| 你想做什么 | 方式一：Issue | 方式二：PR |
|---|---|---|
| 添加友链 | 标题 `[Friend Link] 站点名`，正文填完整资料 | 新建 `data/friends/你的文件.json` |
| 修改友链 | 标题 `[Edit] 站点名`，正文填修改后的完整资料 | 改你自己的那个 JSON 文件 |
| 删除友链 | 标题 `[Delete] 文件名`，正文只填文件名 | 删你自己的那个 JSON 文件 |

- **Issue 最省事**：打开 [apply.html](./apply.html) 表单，选好操作模式，标题正文全部自动生成，登录 GitHub 点提交就行
- **PR 适合熟悉 Git 的人**：本地改文件、走常规 PR 流程

---

# 方式一：Issue

不用 Fork 仓库，登录 GitHub 提个 Issue 就行。三种操作对应三种标题前缀，bot 看到标题就知道该干什么，一提交就自动处理

## 添加友链

### 第 1 步：先把我的链接挂到你的友链页

在你的友链页加上：`https://blog.945426.xyz`

**这步必须先做**——提交后会去抓你的友链页，找不到我的链接就直接拒绝

### 第 2 步：提交 Issue

两种办法任选：

- **用表单（推荐）**：打开 [apply.html](./apply.html)，选「申请友链」，填好点「登录 GitHub 并提交」，在 GitHub 页面点 **Submit new issue** 就行
- **手动提**：新建 Issue，标题以 `[Friend Link]` 开头，正文按这个格式填：

```markdown
## Friend Link Application

- Site Name: 示例博客
- Avatar URL: https://example.com/avatar.png
- Site URL: https://example.com
- Friend Page URL: https://example.com/friends
- Short Description: 一两句话介绍
- Filename: example.json
```

其中 Avatar URL、Cover URL、Short Description 是可留空的，其他必填。Filename 是你的友链在仓库里的文件名，建议用你的域名

### 第 3 步：等结果（约 1-2 分钟）

bot 会自动校验：

- **通过**：自动写入仓库、触发构建，CDN 刷新后就能在本站友链页看到
- **失败**：bot 会评论具体原因

## 修改友链

比如换头像、改名、改简介。两种办法任选：

- **用表单（推荐）**：打开 [apply.html](./apply.html)，切到「修改友链」模式
- **手动提**：新建 Issue，标题以 `[Edit]` 开头，正文格式和添加友链一样，但 Filename 必须填**已收录的那个文件名**（去 `data/friends/` 目录找你的文件）

**注意：修改是整体替换**。正文里填什么，文件就变成什么样。比如你留空了头像，改完后头像就没了——所以要把完整信息都填上，不是只填变化的部分

也可以直接在之前的 `[Friend Link]` Issue 里操作：编辑正文为新的信息，然后评论 `/edit`

修改已有友链需要**域名所有权验证**（防止别人乱改你的资料），见后文专门一节

## 删除友链

- **用表单（推荐）**：打开 [apply.html](./apply.html)，切到「删除友链」模式，只需填文件名
- **手动提**：新建 Issue，标题以 `[Delete]` 开头，正文只要一个字段：

```markdown
## Friend Link Delete

- Filename: example.json
```

也可以直接在之前的 `[Friend Link]` Issue 里操作：编辑正文为新的信息，然后评论 `/delete`

删除同样需要**域名所有权验证**

## 添加友链时校验失败怎么办

**不用新建 Issue**。两个动作：

1. 编辑 Issue 正文，把错的地方改掉
2. 在该 Issue 评论 `/recheck`

bot 会重新校验。Issue 已关闭也行，会自动重新打开。

## 评论命令速查

| 命令 | 作用 |
|---|---|
| `/recheck` | 重新校验（针对新添加友链） |
| `/edit` | 触发修改流程（针对已有友链） |
| `/delete` | 触发删除流程（针对已有友链） |

三条说明：

- 只在标题以 `[Friend Link]` / `[Edit]` / `[Delete]` 开头的 Issue 上生效
- 只有 Issue 创建者和仓库管理员能用，陌生人评论会被拒绝
- 所有状态更新合并显示在同一条评论里

---

# 方式二：PR

适合熟悉 Git 的用户：Fork 仓库 → 在 `data/friends/` 下改文件 → 提 PR → 校验通过自动合并

## 添加友链

第 1 步：在你的友链页加上：`https://blog.945426.xyz`

然后在你的 Fork 里新建一个 JSON 文件，建议用域名命名（如 `example.json`）：

```json
{
  "name": "站点名称",
  "cover": "https://.../封面.jpg",
  "avatar": "https://.../头像.png",
  "url": "https://你的站点",
  "description": "简介/描述",
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

只有 `name`、`url`、`backlink` 必填，其余可选

## 修改友链

直接改你自己的那个 JSON 文件，提交 PR

## 删除友链

直接删掉你自己的那个 JSON 文件，提交 PR

## PR 的校验说明

- 一个 PR 只能改**一个文件**，且必须在 `data/friends/` 目录下
- 不能带 `vip` 字段
- 修改/删除需要**域名所有权验证**
- 校验失败会在 PR 里评论原因；改完关闭重新打开以重新校验
- 之前 Fork 过，先 Sync fork 与本仓库完全同步，避免冲突

---

# 两种方式共用的规则

## 域名所有权验证（修改/删除必看）

修改和删除动的是仓库里已有的数据，得先确认你是这个网站的所有者。确认方式二选一：

| 方式 | 怎么做 |
|---|---|
| DNS TXT 记录 | 在你的域名（`@` 或 `_moara-friends`）下加 TXT 记录，内容为验证码 |
| 上传验证文件 | 在网站根目录放一个 `.moara-friends-verify.txt` 文件，内容为验证码，要求能直接访问 |

**验证码**即 `moara-friends=<编号>`，结尾的数字就是 Issue（或 PR）的编号。bot 也会在失败的评论里给出完整的验证码，照抄就行。**用完记得删除！**

**流程**：你可以提前写好，否则第一次必然失败（因为还没做验证）。bot 评论里带详细指引 → 你按指引配好 DNS 或传好文件 → 回到该 Issue 评论：新添加友链写`/recheck`, 已有友链写 `/edit` → 通过后自动生效

## 字段说明

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 站点名称 |
| `url` | ✅ | 站点地址 |
| `backlink` | ✅ | 友链页地址 |
| `avatar` | ❌ | 头像图片地址 |
| `cover` | ❌ | 封面图地址 |
| `description` | ❌ | 简介/描述 |

> `backlink` 填你自己网站上那个友链页的地址。比如友链页是 `https://example.com/links`，就填这个

> Issue 表单里的 Filename 字段对应仓库 `data/friends/` 下的文件名，只能用英文、数字、短横线、下划线

## 常见问题

**Q: 提示「回链验证未通过」？**

你的友链页里没找到我的链接。检查三点：

1. 链接确实加到友链页了
2. 链接地址是 `https://blog.945426.xyz`
3. 等几分钟让 CDN 缓存刷新，再评论命令重试

**Q: 提示「域名所有权验证失败」？**

按上面「域名所有权验证」一节操作。核心就一句话：把 bot 评论里给的验证码，用 DNS 或文件的方式放到你的网站上，然后评论命令重试

**Q: 提交后多久生效？**

校验通过立即写入仓库并触发构建，CDN 缓存刷新后可见

**Q: PR 有冲突怎么办？**

Sync fork 与本仓库完全同步再修改
