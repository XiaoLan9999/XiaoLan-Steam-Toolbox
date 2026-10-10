# 小蓝Steam工具箱 / XiaoLan Steam Toolbox

Windows 桌面端 Steam 工具箱，由 [XiaoLan9999](https://xiaolan9999.net) 开发。提供艺术作品长图上传助手、静态背景裁剪、多账号好友管理、独立分组和黑名单、昵称与解除好友历史、Steam 表情及资料页留言。

> 当前 MVP 的“留言”指 **Steam 好友个人资料页的公开评论**，不是 Steam 私聊消息。

## 已实现

- Steam 手机应用二维码登录
- 工具箱内置艺术作品上传、展柜配置与一键长图设置，无需外部浏览器或控制台
- 静态 PNG/JPEG 背景的本地裁剪预览、普通双图与精选作品尺寸预设、PNG 导出
- 账号密码 + Steam Guard 备用登录（密码和验证码不落盘）
- Windows DPAPI 加密 refresh token，下次启动自动登录最后使用的账号
- 多 Steam 账号添加、切换和删除；同一好友在不同账号中完全隔离
- 好友列表、昵称、头像和在线状态同步
- 优先一次读取 Steam 好友页资料；缺失项小批补齐，部分失败保留已同步资料和旧缓存
- 本地好友分组 CRUD 与批量移动
- 默认保留已有勾选的拖动跨行多选、Shift 连选、筛选结果全选/反选
- 每个账号独立黑名单，编辑器和实际发送时均排除
- 每个账号独立的“已解除好友”记录，成功同步后自动记录消失的好友，重新加回时标记恢复
- 每个账号独立的“昵称变化”历史，保存旧昵称、新昵称和发现时间
- 可暂停/继续/取消的只读留言权限检查任务，逐条读取资料页，不发送测试留言
- 设置中切换中文 / English，并导出不含登录令牌的完整 SQLite 备份
- 内置 GitHub Release 更新：11 条公共线路检测、换路与续传、发布签名及文件哈希验证、安装版/便携版重启更新
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

侧栏“艺术作品与小工具”的本地裁剪、内置动画工具和来源查看无需登录。上传作品和配置展柜使用工具箱当前已登录的 Steam 账号。

### 长图上传助手

1. 在工具箱连接自己的 Steam 账号，然后打开“在工具箱内上传”。
2. 在内置 Steam 表单中选择图片，等待预览加载。
3. 点击工具箱控制栏的“应用长图设置”，无需打开 F12 或粘贴代码。
4. 填写标题、可见性等信息，亲自确认作者声明并点击 Steam 的保存按钮。
5. 点击工具箱中的展柜配置入口，在内置 Steam 页面选择展柜和已上传的作品，再保存。

代码将当前上传表单的 `image_width` / `image_height` 元数据设为 `1000` / `1`，并移除这两个字段的 DOM `id`，避免被页面逻辑覆盖。图片内容保持原尺寸；脚本只操作这两个表单字段，上传和作品信息由你确认。文件大小等限制依然以 Steam 上传页为准。

做法来自 [ASH / MightyG3 的原作者指南](https://steamcommunity.com/sharedfiles/filedetails/?id=748624905&l=english) 及 [Steam.Design 的官方扩展实现](https://github.com/sapic/Steam-Design-Extension/blob/master/src/js/upload.js)。内置页面仍使用 Steam 原表单和文件限制，不自动勾选版权或提交作品；Steam 页面改变时会停止并提示，而不是猜测上传协议。没有使用真实 Steam 账号代替用户上传作品。

Steam 页面运行在工具箱中的隔离 WebContentsView，没有应用 preload、Node 或主进程 API。仅将当前账号必要的 Community 登录 Cookie 放入独立内存会话，不写入磁盘或返回 UI；切账号、删除账号、关闭页面时销毁视图和会话。来源页、动画工具与 Steam 上传页使用隔离会话，不共享 Steam Cookie。设置弹窗打开或离开工具页时隐藏远程视图，避免覆盖本地操作。

内置页面的文件下载使用原生模态保存对话框，在写盘前验证文件类型及最终路径，不重新请求下载资源；请完成或取消保存窗口后继续操作工具箱。

### 静态背景裁剪

导入本地 PNG/JPEG 背景，选择普通双图或精选作品预设，调整起点和高度，查看裁剪框并导出 PNG。普通主图宽 506、侧图宽 100、内容间隙 9；精选作品宽 630。默认起点为 `x = floor(backgroundWidth / 2) - 467`、`y = 256`。

尺寸和坐标依据 [Steam.Design 的公开实现](https://github.com/sapic/sapic/blob/0abb62f34b47fbc65b22e47950849c28c1946873/src/stores/index.ts)，工具使用自己的本地静态裁剪实现。预设针对原始大小、居中显示的背景；展柜排列和背景缩放会影响位置，需按自己的页面调整。动画背景、GIF 和 WebM 使用工具箱内置的 [Steam.Design 在线页面](https://steam.design/)，仍需要联网，不会跳到外部浏览器，也不宣称是离线动画转换。

### English

Open **Artwork & tools** to crop a local static PNG/JPEG background, upload artwork and configure showcases inside the toolbox. Sign in to the app for the embedded Steam forms, select your file, wait for its preview, then apply the long-artwork dimensions with the toolbar button. Confirm ownership and save the artwork yourself. Standard artwork uses 506px + 100px with a 9px gap; featured artwork uses 630px. Animation tools run in an embedded Steam.Design online page without opening an external browser or sharing Steam cookies. Local crops and the animation page are available without signing in.

## 内置更新与公共镜像

0.4.0 起，设置中的“软件更新”支持检查、下载、取消和确认重启更新。0.3.x 及更早版本需先手动安装 0.4.1 或更新版本，此后可在软件内获取后续版本。默认启动后检查，并在软件运行期间每 4 小时检查；可以关闭自动检查。检测的是正式 GitHub Release，不会把普通源码提交当作可安装版本。

内置 GitHub 官方与 10 个公共代理候选：`ghfast.top`、`ghproxy.net`、`gh-proxy.com`、`gh-proxy.org`、`gh.monlor.com`、`ghproxy.imciel.com`、`fastgit.cc`、`github.ednovas.xyz`、`proxy.vvvv.ee`、`ghp.keleyaa.com`。候选来源和匿名校验文件探测记录见 [镜像说明](docs/update-mirrors.md)。这些站点由第三方运营，不代表中国各地均可连接；软件每次按实际响应和延迟检测，下载前只试读最多 64 KiB 来估算线路速度，下载故障会换路并尝试断点续传。

更新清单必须通过应用内固定公钥的 Ed25519 签名验证，版本、文件名、仓库及下载地址也必须符合规则。更新包的完整大小和 SHA-256 匹配后才会进入“可安装”状态，安装前再次校验。镜像提供传输，不能用自己给出的任意 hash 替代发布者签名。所有更新请求匿名，不发送 Steam Cookie 或账号信息。可关闭公共代理，或在高级设置填写最多 5 条自己的 HTTPS 前缀。

安装更新前请保存工作，停止正在发送的批次、等待在途请求结束，并暂停检查任务、完成数据导出。安装版使用已有 NSIS 更新流程；便携版在退出后原子替换原来的 EXE、保留前一版本备份并重启。账号数据库仍位于原数据目录。更新清单签名与 Windows 商业代码签名是不同机制，本项目暂未配置 Authenticode 商业签名。

### 维护者发布后续版本

1. 修改 `package.json` 与锁文件版本，提交源码。
2. 推送匹配的 `v<版本号>` 标签，或在 GitHub Actions 的 **Release** 工作流手动触发。
3. 工作流测试、打包，并从仓库 Secret `UPDATE_SIGNING_PRIVATE_KEY` 读取签名密钥，生成 `update-manifest.json` 和 `SHA256SUMS.txt`。
4. 完整上传双 EXE、签名清单和校验文件后才发布 latest。已发布版本不覆盖，后续更新使用新版本号。

本机签名私钥保存在 Git 已忽略的 `.release-keys` 目录，只用于维护者发布，请妥善备份；它不会进入源码、安装包或用户数据库。应用固定公钥位于 `src/shared/update-public-key.ts`，勿随意重新生成密钥。用户无需配置任何 GitHub token。维护者也可在本机打包后运行 `node scripts/build-update-manifest.mjs --tag v<版本> --key-file .release-keys/update-signing-private.pem`，将生成的公开文件上传到 Release。

**English:** Settings → Software updates checks signed GitHub releases through the official route and ten public proxy candidates. Routes are measured on the user's connection; a sample request reads at most 64 KiB. Failed downloads can switch routes and resume. Only packages matching the publisher-signed manifest, exact size and SHA-256 are installable. Installation is explicit and restarts the app; portable updates retain the previous EXE backup. Releases are created by the repository's Release workflow, not every source commit.

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

- 单击好友行或复选框只切换该好友，保留其他勾选。按住并跨行拖动默认追加范围，保留之前的所有选择；Ctrl / Cmd 从已选行拖动可减选，Shift 连续加选，也可筛选后全选或反选。
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

## 0.4.0 内置更新

新增发布签名、公共镜像线路检测、更新下载/取消/续传和明确的重启更新入口，支持安装版与便携版。公开镜像列表作为运行时候选维护，后续可追加个人镜像。GitHub Release 工作流自动生成并发布签名更新清单。

## 0.4.1 更新线路重定向修复

修复当前 Electron 中 `net.fetch` 手动重定向报错造成的线路误判。改用 Chromium `net.request` 适配更新传输，继续使用系统代理、匿名请求、HTTPS 重定向校验和最多 5 次跳转边界。0.4.0 用户可通过已有可用线路内置升级；新用户直接下载 0.4.1。

## 0.5.0 拖选保留与内置艺术作品流程

修复单选部分好友后长按拖动清空原选择的问题，普通拖动默认叠加已有勾选。将上传、展柜配置、动画工具和来源查看放进工具箱内置页面；当前账号隔离登录、一键长图设置和下载保存仍由本地控制栏管理。作品最终提交保持由用户本人确认。

## 当前边界

- 未在仓库内放置或使用真实 Steam 凭据。
- 自动测试不会向任何 Steam 账号发送留言；真实投递必须由用户登录并最终确认。
- Steam 私聊是另一条 API 链路。如果需求实际是批量私聊，应新增独立 delivery adapter，而不是复用资料页评论接口。
