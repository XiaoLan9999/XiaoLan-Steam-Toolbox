# 小蓝Steam工具箱 / XiaoLan Steam Toolbox

Windows 桌面端 Steam 工具箱，由 [XiaoLan9999](https://xiaolan9999.net) 开发。提供艺术作品长图上传助手、静态背景裁剪、多账号好友管理、独立分组和黑名单、昵称与解除好友历史、Steam 表情及资料页留言。

> 当前 MVP 的“留言”指 **Steam 好友个人资料页的公开评论**，不是 Steam 私聊消息。

## 已实现

- Steam 手机应用二维码登录
- 艺术作品长图控制台代码预览、复制和上传页入口
- 静态 PNG/JPEG 背景的本地裁剪预览、普通双图与精选作品尺寸预设、PNG 导出
- 账号密码 + Steam Guard 备用登录（密码和验证码不落盘）
- Windows DPAPI 加密 refresh token，下次启动自动登录最后使用的账号
- 多 Steam 账号添加、切换和删除；同一好友在不同账号中完全隔离
- 好友列表、昵称、头像和在线状态同步
- 优先一次读取 Steam 好友页资料；缺失项小批补齐，部分失败保留已同步资料和旧缓存
- 本地好友分组 CRUD 与批量移动
- 拖动跨行多选、Shift 连选、筛选结果全选/反选
- 每个账号独立黑名单，编辑器和实际发送时均排除
- 每个账号独立的“已解除好友”记录，成功同步后自动记录消失的好友，重新加回时标记恢复
- 每个账号独立的“昵称变化”历史，保存旧昵称、新昵称和发现时间
- 可暂停/继续/取消的只读留言权限检查任务，逐条读取资料页，不发送测试留言
- 设置中切换中文 / English，并导出不含登录令牌的完整 SQLite 备份
- 当前账号 `EmoticonList` 表情选择器，点击插入 `:name:` token
- `{friend}`、`{account}` 个性化占位符
- 发送前最终确认，冻结账号、收件人和正文快照
- 单线程持久队列，默认 15 秒间隔并增加 0–3 秒抖动
- 暂停、继续、取消、逐好友结果与 Steam comment id
- 请求结果不确定时标记 `uncertain`，不自动重发
- 异常退出后自动暂停批次；原先正在请求的任务标记待核对
- Electron 安全边界：sandbox、context isolation、关闭 Node integration、窄化 IPC、CSP

## 运行

环境要求：Windows 10/11 x64、Node.js 22.12 或更高版本。

```powershell
git clone https://github.com/XiaoLan9999/XiaoLan-Steam-Toolbox.git
cd XiaoLan-Steam-Toolbox
npm.cmd install
npm.cmd run dev
```

构建应用：

```powershell
npm.cmd run build
```

生成 NSIS 安装包和 portable 版本：

```powershell
npm.cmd run dist
```

安装版和便携版可从 [GitHub Releases](https://github.com/XiaoLan9999/XiaoLan-Steam-Toolbox/releases) 下载。为延续旧版数据，内部包名和数据目录仍使用 `steam-friend-commenter`。

## 艺术作品与背景适配

侧栏“艺术作品与小工具”无需登录本应用也可使用。

### 长图上传助手

1. 打开工具内的 Steam 艺术作品上传页，在浏览器登录 Steam。
2. 选择自己的图片，等待页面读入图片。
3. 在工具中查看并复制长图代码，在该 Steam 上传页的浏览器控制台执行。
4. 填写作品信息，确认作者声明并保存。
5. 上传完成后，在 Steam 个人资料编辑中选择对应艺术作品展柜和作品。

代码将当前上传表单的 `image_width` / `image_height` 元数据设为 `1000` / `1`，并移除这两个字段的 DOM `id`，避免被页面逻辑覆盖。图片内容保持原尺寸；脚本只操作这两个表单字段，上传和作品信息由你确认。文件大小等限制依然以 Steam 上传页为准。

做法来自 [ASH / MightyG3 的原作者指南](https://steamcommunity.com/sharedfiles/filedetails/?id=748624905&l=english)。这是社区上传流程，尚未代替真实账号完成上传验收；Steam 页面改变时，脚本会在找不到字段或页面错误时停止。

### 静态背景裁剪

导入本地 PNG/JPEG 背景，选择普通双图或精选作品预设，调整起点和高度，查看裁剪框并导出 PNG。普通主图宽 506、侧图宽 100、内容间隙 9；精选作品宽 630。默认起点为 `x = floor(backgroundWidth / 2) - 467`、`y = 256`。

尺寸和坐标依据 [Steam.Design 的公开实现](https://github.com/sapic/sapic/blob/0abb62f34b47fbc65b22e47950849c28c1946873/src/stores/index.ts)，工具使用自己的本地裁剪实现。预设针对原始大小、居中显示的背景；展柜排列和背景缩放会影响位置，需按自己的页面调整。动画背景和 GIF 处理可从工具打开 [Steam.Design](https://steam.design/)。

### English

Open **Artwork & tools** to preview/copy the long-artwork console script and crop a local static PNG/JPEG background. Select the image on Steam's upload page first, run the reviewed code before saving, then assign the uploaded artwork to a showcase. Standard artwork uses 506px + 100px with a 9px gap; featured artwork uses 630px. Adjust coordinates for your profile layout. Animated image conversion is available through Steam.Design. These tools also work without signing in to this desktop app.

仅生成未安装目录用于快速检查：

```powershell
npm.cmd run dist:dir
```

## 使用流程

1. 点击“添加 Steam 账号”，优先用 Steam 手机应用扫码并确认。
2. 登录完成后应用自动同步好友和已拥有表情。
3. 在“好友与分组”创建本地分组，勾选好友并移动到目标分组。
4. 在“批量留言”选择好友/分组、输入正文，并从“Steam 表情”面板插入表情。
5. 设置基础发送间隔，检查最终账号、好友和正文后确认发送。
6. 在右侧控制当前批次，在“发送记录”检查每位好友的结果。

单批最多 30 位好友，基础间隔范围 1–300 秒。应用不会在重启后自动恢复未完成批次。若无法发送，编辑器会显示原因；超出 30 人可点击“只选前 30 位”拆分处理。最小间隔不代表 Steam 承诺接受该频率，收到限流会暂停。

## 本地数据与凭据

数据库位于 Electron 的 `userData` 目录，Windows 默认类似：

```text
%APPDATA%\steam-friend-commenter\steam-friend-commenter.sqlite3
```

- 账号元数据、好友缓存、分组、草稿和发送记录保存在 SQLite。
- refresh token 先通过 Electron `safeStorage` 使用当前 Windows 用户的 DPAPI 加密，再写入数据库。
- Steam 密码、Steam Guard code、Community Cookie 和 sessionid 不写入数据库或日志。
- 本地导入的背景只在裁剪工具内处理，不进入好友数据库或源码仓库。
- 同一时刻只保留一个活动账号会话，切号时正在运行的旧账号批次会先暂停。

### 备份与迁移

点击侧栏“设置 / 语言 / 导出数据”，其中“打开数据目录”可打开本机实际目录。安装版和便携版都使用该目录，**不是 EXE 所在目录**。

**推荐：设置 → 导出数据。** 可在软件运行时导出一致的 SQLite 快照，包含完整业务数据，并在副本中移除全部自动登录令牌。新电脑先启动同版或更新版并打开数据目录，再退出软件；备份并移开该目录的旧文件，把导出文件放入空数据目录并重命名为 `steam-friend-commenter.sqlite3`。重新启动、重新登录原账号即可。不要将导出文件与目的电脑已有的 `-wal` / `-shm` 文件混放。软件不会自动覆盖或合并另一台电脑的数据。

也可以手动备份整个原始目录（此方式会保留 DPAPI 加密令牌，但换电脑通常仍需重新登录）：

1. 在旧电脑打开数据目录，暂停任务后完全退出软件。
2. 复制整个数据目录作备份；主要数据文件为 `steam-friend-commenter.sqlite3`。不要在运行时单独复制数据库，SQLite 的 `-wal` / `-shm` 文件可能仍包含尚未合并的数据。
3. 新电脑先运行同版或更新版软件，打开其数据目录，然后退出软件。
4. 先备份新电脑原数据目录，再用旧备份替换。不要将两份数据库或不同时间的 WAL 文件混合；此方式是整体替换，不是合并账号数据。
5. 重新启动，在需要时重新登录原 Steam 账号。程序按 SteamID 关联原数据，分组、黑名单、检查结果、草稿和任务进度会保留。

自动登录令牌由原 Windows 用户的 DPAPI 加密。换电脑、重装系统或换 Windows 用户后通常不能解密，需要重新扫码；不要通过“忘记账号”解决，否则会删除该账号的本地数据。已有检查任务重启后保持暂停，需手动继续。检查结果只代表检查时页面状态，迁移或过一段时间后建议重新检查。

备份包含好友和留言记录等个人数据，请私下保管，不要上传到源码仓库。软件目前不提供跨数据库合并或明文登录凭据导出。设置导出的文件不包含自动登录令牌；直接复制整个原始目录与此不同。

### English interface and backups

Open **Settings / Language / Export** in the sidebar to choose **English (ENG)**. The choice is saved locally. **Export data** creates a complete SQLite backup without login tokens. On another computer, run the same or a newer version, open its data directory, and quit. Back up and move aside the destination data, then copy the export into the empty directory as `steam-friend-commenter.sqlite3`. Do not mix it with old WAL/SHM files. Sign in again to the original Steam accounts; groups, blacklists, checks and history remain. This replaces data; it does not merge databases.

## 批量选择、黑名单与检查任务

- 单击好友行或复选框只切换该好友，保留其他勾选。按住并跨行拖动会重新选择范围；Ctrl / Cmd 拖动追加或减选，Shift 选择连续范围，也可筛选后全选或反选。
- 黑名单仅是本软件的本地“禁止留言”名单，不会删除 Steam 好友或在 Steam 上拉黑。每个账号独立保存；加入黑名单后，尚未发送的留言会被阻止，已经发出的网络请求无法撤回。
- 检查任务仅 GET 读取资料页，默认每条间隔 10 秒，可设置 5–60 秒。1000 人可能耗时数小时，可暂停后继续，重启不会自动继续。
- “页面允许”不保证实际发送一定成功；隐私、好友关系、限流及 Steam 风控都可能变化。“页面禁止”需要明确证据；无法确定的页面显示“未知”，不会自动拉黑。
- 可以筛选“页面禁止”后全选并加入黑名单；未知项可单独复查。检查任务支持千人名单，但留言发送仍维持每批最多 30 人的独立限制。

## Steam 适配层

认证使用 [`steam-session`](https://github.com/DoctorMcKay/node-steam-session)。Community 操作由 `src/main/community-client.ts` 中的窄化客户端完成，不加载远程页面，也不把 Cookie 暴露给 renderer。

当前调用路径：

- `GET /textfilter/ajaxgetfriendslist`：当前账号好友关系
- `GET /profiles/<当前账号 SteamID64>/friends/`：一次读取好友页已有的昵称、头像和状态，只采纳当前好友关系中的 ID；只允许有限次数的 HTTPS SteamCommunity 站内跳转
- `GET /actions/ajaxresolveusers?steamids=...`：仅补齐好友页缺失的资料，每批最多 100 人、批次间隔 5 秒；遇到限流或请求失败立即停止，不自动重试
- `GET /actions/EmoticonList`：当前账号可用资料页表情
- `POST /comment/Profile/post/<SteamID64>/-1/`：资料页留言

这些 Community 路径不是 Valve 承诺稳定的公开留言 API，接口变更、账号隐私设置、禁评或频率控制都可能导致失败。自动化行为还受当前 [Steam Subscriber Agreement](https://store.steampowered.com/subscriber_agreement/) 约束；发布或长期使用前应自行确认适用规则。

## 验证

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd audit --omit=dev
npm.cmd run build
```

测试覆盖消息/收件人校验、账号分组隔离、DPAPI 抽象、持久队列崩溃恢复、Steam 好友/表情响应解析、1005 位好友同步、部分资料失败保留、并发同步合并、会话切换隔离、安全重定向、留言表单和登录失效识别。

## 0.1.1 同步修复

- 不再依赖大批量资料解析请求；优先从 Steam 好友页获取完整资料。
- 任一补齐请求失败时保留此前成功的资料，不再将整个批次结果丢弃。
- 完整成功和部分完成使用不同提示，失败原因会明确展示；HTTP 429 时请稍后再手动同步，不要反复点击。
- 自动同步与手动同步合并执行，切换账号或登录会话后旧结果不会回写。
- 更新不改变数据库路径或数据结构，已有账号和本地分组不需要删除。退出旧版后启动新版，再点击“同步好友”即可。

## 0.2.1 已解除好友

- 好友关系完整同步成功后，对比上次本地名单。消失的好友不再计入当前好友总数，并进入“好友与分组 → 已解除好友”。
- 记录上次缓存的昵称、头像、SteamID、发现时间；这个时间是软件发现关系变化的时间，不是精确删除时间。无法仅凭名单判断是你删除了对方，还是对方删除了你。
- 默认显示尚未恢复的好友，可切换查看全部历史并搜索。重新加回会记录恢复时间；以后再次解除会新增一条记录，重复刷新不会重复记录。
- 该页面只读，不会把已解除好友加入留言、检查或分组选择。已经排入留言队列、但尚未发送的已解除好友也会跳过。
- 网络、认证错误或不完整的关系响应不会生成解除记录；只有昵称/头像获取失败时会保留当前好友关系，不视为解除。
- 升级前已有的失效好友缓存会以“旧版缓存，时间未知”显示；无法找回软件从未同步过或已经被清除的历史。
- 记录按 Steam 账号独立保存，包含在设置导出的 SQLite 备份中。

### Removed friends (English)

After a successful complete friend-list sync, missing friends leave the active count and appear under **Friends & groups → Removed friends**. Records retain their cached identity and the time the change was detected, not the exact deletion time or who initiated it. Re-added friends are marked restored; repeated syncs do not duplicate removal events. Legacy inactive cache entries have an unknown detection time. This read-only history is account-scoped and included in data exports.

## 0.2.2 单击与拖选修复

单击好友行不再清空原来的多选，只添加或取消当前好友。鼠标按下时不改选择，移动超过拖动阈值后才进入范围拖选；轻微抖动仍按单击处理。原有拖选、Ctrl / Cmd 加减选、Shift 连选与复选框功能保留。

Clicking a friend row now toggles only that friend without clearing other selections. Mouse-down alone does not change the selection; range selection starts only after the drag threshold is exceeded. Small pointer jitter remains a click. Drag, Ctrl / Cmd add/subtract, Shift range selection and checkboxes retain their behavior.

## 0.2.3 昵称变化历史

在“好友与分组 → 昵称变化”查看旧昵称、新昵称、SteamID 和发现时间，也可用旧名、新名或 SteamID 搜索。重复刷新不重复记录；连续更名和改回旧名会分别保留，记录按 Steam 账号独立保存并包含在导出备份中。

仅同步到可靠的新昵称时才比较并记录。第一次获取昵称会建立基线，资料获取失败时不会把 SteamID 占位文字当成更名。升级会从已有昵称建立基线，软件无法追溯此前未记录的改名；发现时间是本次同步时间。

数据保存在 Electron 的本机 `userData` 目录，安装版和便携版均使用它。可在“设置 → 打开数据目录”查看实际路径，主要文件为 `steam-friend-commenter.sqlite3`；设置导出的备份包含昵称变化历史，不含登录令牌。

**Friends & groups → Name changes** shows the old name, new name, SteamID and detection time. Search by either name or SteamID. Only newly resolved names are compared against a trusted baseline; first-time data and failed lookups do not create false changes. History is account-scoped, retained through repeated renames, and included in SQLite exports.

## 0.3.0 小蓝Steam工具箱

应用更名为“小蓝Steam工具箱”，增加艺术作品长图助手和本地静态背景裁剪。原有账号、分组、黑名单、好友历史、语言和导出功能继续使用原数据目录。作品助手提供上传前代码，实际上传与展柜设置在 Steam 浏览器页面完成。

## 当前边界

- 未在仓库内放置或使用真实 Steam 凭据。
- 自动测试不会向任何 Steam 账号发送留言；真实投递必须由用户登录并最终确认。
- Steam 私聊是另一条 API 链路。如果需求实际是批量私聊，应新增独立 delivery adapter，而不是复用资料页评论接口。
