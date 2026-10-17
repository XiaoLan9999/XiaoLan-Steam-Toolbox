# 小蓝Steam工具箱 / XiaoLan Steam Toolbox

Windows 桌面端 Steam 工具箱，由 [XiaoLan9999](https://xiaolan9999.net) 开发。提供本地截图导入、艺术作品长图上传助手、静态背景裁剪、多账号好友管理、独立分组和黑名单、昵称与解除好友历史、Steam 表情及资料页留言。

> 当前 MVP 的“留言”指 **Steam 好友个人资料页的公开评论**，不是 Steam 私聊消息。

## 已实现

- Steam 手机应用二维码登录
- 天蓝与茶色搭配的轻简浅色界面，中文 / English
- 内置 Steam 截图工具：用户与游戏名称识别、启动自动刷新、手动刷新、图片预览、JPEG 与缩略图转换、安全备份和截图索引登记
- 当前账号的只读登录状态刷新检查，显示核验时间与失败原因，不发送测试留言
- 工具箱内置艺术作品上传、展柜配置与一键长图设置，无需外部浏览器或控制台
- 静态 PNG/JPEG 背景的本地裁剪预览、普通双图与精选作品尺寸预设、PNG 导出
- 读取当前账号已装备及已拥有的资料背景，选择静态原图后自动生成主图 / 侧图并准备到内置上传页
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

## Steam 截图工具

侧栏的“Steam 截图工具”参考 [SteaScree](https://github.com/awthwathje/SteaScree) 的本地截图准备流程，使用独立 TypeScript 实现，不捆绑原 Qt 程序或复制其源码。无需在工具箱登录，也不需要启动游戏：选择本地 Steam 用户、目标游戏和图片，即可准备 Steam 能读取的 JPEG、缩略图及 `screenshots.vdf` 记录，最后从 Steam 客户端自行确认上传与可见性。详细实现及恢复说明见 [截图工具说明](docs/steam-screenshots.md)。

1. 启动时自动读取一次 Steam 安装位置、`userdata`、登录用户名称、各游戏库清单和已有截图记录。可手动选择目录并记住，下次无需重新定位。
2. 用户选项同时显示昵称、AccountID 与 SteamID64。游戏支持按名称 / AppID 搜索，已发现的非 Steam 64 位 GameID 也会保留，不要求玩家自己换算 ID。
3. 缺失的游戏名称通过 Steam 官方 Store 域名查询；用户名称通过公开 Steam 资料补全。后台最多 3 个匿名请求，不携带登录令牌或 Cookie。启动与手动刷新会重新拉取，离线保留本地资料和名称缓存；查名失败仍可按有效 AppID 使用，不擅自替换为其它游戏。
4. 添加 PNG / JPEG / WebP / BMP 图片，检查预览、目标用户 / 游戏、JPEG 质量及大图自动缩放。源图不修改；图片一次最多 100 张、单张 32 MiB，以限制内存占用，这与好友发送数量没有关系。
5. **先完全退出 Steam 客户端**，再确认“备份并准备本地截图”。工具会再次检查进程、备份原始索引、同步写入新 JPEG 与缩略图，最后原子提交索引。处理失败不删除已有截图，也不会强行关闭 Steam。
6. 启动 Steam，在该游戏的截图管理器中选择新图片，再自行确认云端上传。工具箱的“已准备”只表示本地文件已写好，不表示已经上传到 Steam Cloud。

图片转换在不含应用 preload / Node API 的隔离内存窗口中进行，禁止访问网络。目标目录、索引、源图变化及符号链接会在写入前检查。原始索引和事务清单位于目标用户 `760/.xiaolan-screenshot-backups/`，需手动恢复时先退出 Steam 并备份当前索引。

名称缓存和选中目录分别位于工具箱数据目录的 `screenshot-catalog-names.json` 与 `screenshot-preferences.json`；它们不是登录凭据，删除后可重新识别。图片队列只保存在内存中；准备完成的截图与原索引备份保存在 Steam 的 `userdata` 中，不属于工具箱 SQLite 导出文件。

**English:** Open **Steam screenshots**, choose the named local user and game, add images, review the destination and prepare them with Steam fully exited. The toolbox creates local JPEGs, thumbnails and screenshot metadata with a backup; use Steam's screenshot manager for the final cloud upload. Names refresh once at startup and manually, with anonymous official-host lookups and offline caching. The queue is local and source images stay unchanged.

## 账号状态检查

侧栏“当前账号状态 → 刷新检查”会只读核验当前账号的 Steam 网页登录身份，显示检查时间与结果。网络失败或普通 403 会显示“未能核验”，不会因此假定登录已失效；明确的认证拒绝仍沿用安全恢复流程。检查不会发送测试留言、自动扫码或切换到其它账号，也不会重启已暂停的发送任务。检查通过仅证明网页身份匹配，不证明该好友允许留言，也不代表 Steam 客户端正在运行。

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

点击“获取当前账号背景”，复用工具箱当前登录会话读取已装备及已拥有背景（包括积分商店资料背景）。选择静态背景后会读取完整原图，自动按普通展柜生成 506 px 主图和 100 px 侧图，中间间隙 9 px；仍可调整裁剪坐标。点击对应裁片的准备上传按钮，工具箱会打开新上传表单并选中该 PNG、等待预览、应用长图尺寸。主图保存后可以继续准备侧图，不需要先保存到磁盘再手动选择文件。标题、可见性、版权和 Steam 最终保存依然由你确认。

图库和原图按当前账号隔离，切账号、退出或关闭工具会作废旧操作。必要的 Web API token 仅在主进程内用于固定 Steam API；图片从允许的 Steam HTTPS CDN 匿名读取，不携带登录 Cookie。上传临时 PNG 位于数据目录内的 `artwork-upload-temp`，关闭页面、下一次准备或退出时清理，不进入数据库备份。获取不完整或不支持的背景会明确标注，不把库存缩略图当原图。动画背景仍通过内置动画工具处理，不会将其静态封面自动输出成动画裁片。

导入本地 PNG/JPEG 背景，选择普通双图或精选作品预设，调整起点和高度，查看裁剪框并导出 PNG。普通主图宽 506、侧图宽 100、内容间隙 9；精选作品宽 630。默认起点为 `x = floor(backgroundWidth / 2) - 467`、`y = 256`。

尺寸和坐标依据 [Steam.Design 的公开实现](https://github.com/sapic/sapic/blob/0abb62f34b47fbc65b22e47950849c28c1946873/src/stores/index.ts)，工具使用自己的本地静态裁剪实现。预设针对原始大小、居中显示的背景；展柜排列和背景缩放会影响位置，需按自己的页面调整。动画背景、GIF 和 WebM 使用工具箱内置的 [Steam.Design 在线页面](https://steam.design/)，仍需要联网，不会跳到外部浏览器，也不宣称是离线动画转换。

### English

Open **Artwork & tools** to crop a local static PNG/JPEG background, upload artwork and configure showcases inside the toolbox. Sign in to the app for the embedded Steam forms, select your file, wait for its preview, then apply the long-artwork dimensions with the toolbar button. Confirm ownership and save the artwork yourself. Standard artwork uses 506px + 100px with a 9px gap; featured artwork uses 630px. Animation tools run in an embedded Steam.Design online page without opening an external browser or sharing Steam cookies. Local crops and the animation page are available without signing in.

## 内置更新与公共镜像

0.4.0 起，设置中的“软件更新”支持检查、下载、取消和确认重启更新。0.3.x 及更早版本需先手动安装 0.4.1 或更新版本，此后可在软件内获取后续版本。默认启动后检查，并在软件运行期间每 4 小时检查；可以关闭自动检查。检测的是正式 GitHub Release，不会把普通源码提交当作可安装版本。

0.9.1 起，发现新版或更新检查失败时，侧栏显示可关闭的持久通知卡，点击即可进入设置查看版本和线路结果；不会自动下载、安装或打断当前任务。同一运行期间关闭的同版本提醒不会重复出现，发现下一个版本时重新提醒。旧版仅有设置入口的 `NEW` 角标，没有弹窗。当前版本已是最新时不会显示新版提醒。

手动启动新便携版前须先退出旧程序，否则单实例保护会唤起仍在运行的旧窗口，而不会替换该进程。可在设置中确认正在运行的版本；同一 Windows 用户下，新旧版本沿用相同数据目录，不必重新创建任务。

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
5. 设置基础发送间隔及自动重试开关，检查最终账号、好友、正文和恢复设置后确认发送。
6. 在右侧控制当前批次，在“任务列表”查看持久进度、分页明细并继续未完成任务。

单批不设置人为好友数量上限，确认时会将当前选中的全部有效好友加入持久队列，不截断或要求拆批。基础间隔可手动填写 0.1–300 秒，支持小数。默认仍为 15 秒，并保留 0–3 秒随机抖动，因此填写的是基础间隔而不是严格的实际投递耗时。应用不会在重启后自动恢复未完成批次。若无法发送，编辑器会显示原因。收到限流仍会暂停，不会并发发送或自动重发不确定结果，黑名单和已移除好友仍会被排除。

### 持久任务列表与异常恢复

- 创建任务时先以事务保存全部目标和最终正文；每条投递结果、错误和数量也以事务落盘，并非只保存在界面内存中。
- “任务列表”可查看当前账号的全部历史任务，每页 25 条摘要，好友明细每页 50 条，可按任务状态和投递结果筛选。
- 分开显示尚未发送、发送中、已确认、已接受但未确认、失败、待核对和已取消数量。“完成”指已处理对象，不能等同于成功发送数量。
- 暂停任务可在登录原账号后确认继续，只发送 `pending` 对象。已确认、已接受、历史失败和待核对记录不会自动重发；本轮明确被拒绝的可恢复请求可退回待发并按策略重试。不要重新全选创建相同任务来恢复。
- 重启后运行任务保持暂停，未确定结果的在途请求转为“待核对”。界面异常退出也会暂停任务；重新加载界面不自动发送。突然断电或系统内存耗尽时，仍可能有已提交但来不及写入结果的请求，因此不能保证恰好一次投递。
- 同一账号仍只允许一个未完成任务；取消后旧请求未结束时，不创建新任务或启动更新安装，避免请求重叠。

### 自动继续、有限重试与停止原因

- 新建留言任务默认开启自动重试，可在发送前取消勾选。旧版本任务升级后默认关闭，需在任务卡片点击“开启自动重试并继续待发”并确认；升级不会擅自发送已有任务。
- 任务详情和编辑器的当前任务卡片持续显示停止原因、来源、发生时间、下一次重试时间、倒计时和本轮连续重试次数。恢复后仍可查看最近停止原因；旧版没有保存的原因不会被猜测补写。
- 明确的 403、429 或未登录拒绝，且能确定未被接受的请求，才可退回待发再次尝试；没有提交留言的准备失败也保留待发。不确定是否到达 Steam 的超时、断流、5xx 和会话切换结果保留“待核对”，不会重发该对象，只可冷却后处理其他待发。
- 0.8.1 起 HTTP 403 至少冷却 5 分钟，仅自动重试一次；再次被拒绝即停止自动计划，不再叠加数小时等待。当前对象和剩余好友保留待发，不据此断言好友封禁、跳过换人或认定登录失效。冷却后的恢复先通过当前会话只读核验身份；核验通过并不保证留言权限，核验本身被拒绝也停止自动继续。
- 403 响应计数与最早可再试时间持久保存；手动继续、重启或开关自动重试不会清零、提前绕过冷却，只有收到成功的留言结果后才重置。403 的有效 `Retry-After` 可延长冷却；过长的服务端提示转人工等待，不缩短后强行发送。新的只读核验拒绝可延长冷却，但不增加 POST 计数。
- 429 及一般网络恢复从 60 秒开始，临时会话准备从 30 秒开始，最多连续排定 5 次自动重试；真正取得发送进展后重新计数。遵守有效 `Retry-After`；超过 24 小时的等待转人工。基础发送间隔与错误冷却是两套独立设置。
- 诊断仅增加接口类别、403 响应形态（JSON / HTML / 验证页面）、小整数协议码和等待时间，不保存响应正文、URL、好友身份、Cookie 或令牌。验证页面只作提示，不自动完成验证；没有证据时不猜测具体拦截原因。
- 手动暂停、取消、关闭自动重试、切换账号和软件退出会撤销对应自动计划。重启默认保持暂停，不自动补跑过期计划；重新扫码也不会擅自启动没有计划的旧任务。
- 自动继续保持串行，等待已有 POST 和会话准备落定；已确认及已接受的留言不重复。关闭自动重试不影响正在正常运行的任务，但下一次停止类错误不会自动恢复；需要立即停止发送时请点击“暂停任务”。

### 大任务内存与本地诊断

队列等待只读数量摘要，进度事件只推送轻量摘要；界面不再反复复制最近 20 批的全部好友正文。明细按需分页读取，快照和任务页刷新合并为单个在途请求与一个后续刷新意图。Community 响应按流式字节限制为 5 MiB，过大响应立即取消；请求完成后清理定时器。

数据目录中的 `diagnostics/runtime-current.jsonl` 与 `runtime-previous.jsonl` 每分钟记录工具箱自身主进程及子进程内存指标、任务计数，并记录界面异常退出、会话恢复和 HTTP 错误分类。仅保留两份文件，每份最多 1 MiB；不包含账号、好友、留言正文、URL、Cookie 或登录令牌，不上传。日志可用于下次长任务故障前后的趋势对比，但不包含全机其他程序的内存历史。

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

### 登录、网页 Cookie 与保活

- 登录与自动恢复会先取得网页 Cookie，并用一次只读 GET 核验当前账号身份，不发送测试留言。按 Steam WebBrowser 登录类型使用 [`getWebCookies()`](https://github.com/DoctorMcKay/node-steam-session#getwebcookies)，不误用不适用于该类型的 `refreshAccessToken()`。
- 0.9.1 起，登录、网页 Cookie 续期和后续 Community 请求使用同一 User-Agent，避免登录与请求的浏览器标识不一致。这是请求一致性修正，并不表示所有 HTTP 403 都已解决；网页能向同一好友留言而工具箱失败时，应继续核对具体会话和网络请求，不直接归因为好友权限或登录失效。
- 默认每 10 分钟单飞续期；收到可信认证失败时暂停任务并尝试用已有加密令牌恢复，不立即强制重新扫码。网络、限流、暂时无法核验等错误按 1 / 2 / 5 分钟退避，不能因此认定令牌已被撤销。
- 普通 HTTP 403 只表示该请求被拒绝，不再直接清空登录。HTTP 429 单独归类为限流；两者均先暂停，并仅在任务启用自动重试时按冷却计划恢复，不会通过重复扫码绕过 Steam 限制。
- 可信 401、登录重定向或明确未登录结果会启动恢复；只有登录服务明确拒绝已保存令牌时才提示重新登录。会话恢复成功后的发送安排由任务自动重试设置决定，手动暂停和无计划任务不会被登录流程启动。
- 吸收受信同域响应里的 Cookie 更新，保持 CSRF 字段与发送 Cookie 一致。后台续期不丢弃同账号在途请求的真实成功结果，旧 Cookie 的迟到失败不能注销新会话。
- 发送前等待会话准备；如果尚未提交留言就准备失败，保留待发对象而非记成失败。已经提交但结果不确定的请求不会自动重发。单个登录 HTTP 请求设 30 秒上限，切号、取消登录和退出会清理对应连接、重试与定时器。
- 新版诊断只记录固定分类和 HTTP 状态码，便于区分认证、频率、访问和网络问题。旧版本仅保存“会话失效”的统一文案，不能据此追溯当时的原 HTTP 状态。

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
- 检查任务仅 GET 读取资料页，默认每条间隔 10 秒，可手动填写 0.1–60 秒，支持小数并保留当前账号最近任务的设置。请求耗时也会影响总时长；可暂停后继续，重启不会自动继续。会话失效或限流时暂停，不把登录失败批量标成好友不可留言。
- 暂停中的任务可以修改检查间隔并单独保存，任务保持暂停；直接点击“继续”会先保存输入的新间隔。恢复按新间隔从最近一次请求结束时计算，已完成结果和待检查好友不重置。运行中需先暂停再修改。
- “页面允许”不保证实际发送一定成功；隐私、好友关系、限流及 Steam 风控都可能变化。“页面禁止”需要明确证据；无法确定的页面显示“未知”，不会自动拉黑。
- 可以筛选“页面禁止”后全选并加入黑名单；未知项可单独复查。检查和留言队列均支持千人名单，不设置人为单批人数上限。

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

## 0.6.0 账号背景与快速间隔

增加当前账号背景图库、静态原图自动主 / 侧裁片和内置文件上传准备。修复 Steam 的 `span` 评论提交入口被误判为未知的问题，并识别资料页中明确的已退出 / 他账号会话。旧的“无法判断”结果不会静默改写，升级后请重新检查。检查与发送最低基础间隔均为 0.1 秒，默认节奏和已有串行、限流、暂停保护保持不变。

## 0.6.1 暂停修改间隔与取消人数上限

暂停的检查任务可保存新的 0.1–60 秒间隔，继续前自动保存，延迟返回的旧请求不会覆盖新间隔或改写已作废结果。取消单批 30 位好友上限；发送前仍冻结完整预览快照，所有有效目标进入同一串行队列，已有暂停、取消、黑名单和不确定结果保护不变。

## 0.7.0 持久任务中心与有界内存读取

增加完整历史任务列表、状态统计和分页投递明细，支持确认后仅继续未发好友。队列状态检查、进度推送和界面刷新改为轻量有界读取，修复退出后的迟到请求写库及取消在途请求的调度边界。增加流式响应上限、界面崩溃暂停与本地轮换内存诊断。已有数据库与投递进度保留，不自动恢复发送；这些修复不代表已经证明某次系统内存耗尽由工具箱引起。

## 0.7.1 登录判定与自动保活

修复普通 403 被误判为登录失效，以及网页 Cookie 缺少续期与响应更新的问题。增加单飞保活、可信失效后的自动恢复、失败退避、登录请求超时和跨账号异步隔离；取消扫码、退出或旧恢复不能覆盖新会话。尚未提交的目标继续保留待发，恢复不自动续发、不重放留言；HTTP 403 / 429 仍会暂停任务。会话诊断保留安全分类，已有数据和任务记录不变。

## 0.8.0 自动恢复与可见停止原因

新增任务级自动继续/重试、常驻停止原因及倒计时。403 / 429、临时会话和网络问题有限退避，尊重 `Retry-After`，最多连续 5 次；只重试明确未接受的对象，不重发已确认、已接受或结果不确定的留言。手动操作、账号切换、退出与重启保护优先于自动计划。升级保留原数据，旧任务需明确开启自动重试。

## 0.8.1 持续 403 熔断与诊断

修复持续拒绝时同一对象反复退避、数小时无进展的问题。403 冷却后仅允许一次自动重试，再次拒绝停止自动计划，保留当前及剩余待发；恢复前只读核验当前登录身份，不强制换凭据。拒绝计数及冷却期限持久保存，覆盖手动继续、开关重试、重启和过时请求的竞态。增加不含原始响应或凭据的响应形态诊断及双语提示。本次修复不表示已经解除 Steam 端的拒绝或确认其具体原因。

## 0.9.0 截图工具与轻简界面

加入完整本地截图导入流程、可读用户与游戏选择、启动及手动刷新、匿名名称补全和离线缓存；加入当前账号的只读状态检查。全工具箱改为天蓝与茶色搭配的浅色界面，保留中英文和原有好友、任务、艺术作品及签名更新功能。截图最终上传仍由用户在 Steam 客户端确认；此前的持续 HTTP 403 若仍发生，需依据实际响应继续定位，不能以新工具完成代替访问问题已解决。

## 当前边界

- 未在仓库内放置或使用真实 Steam 凭据。
- 自动测试不会向任何 Steam 账号发送留言；真实投递必须由用户登录并最终确认。
- Steam 私聊是另一条 API 链路。如果需求实际是批量私聊，应新增独立 delivery adapter，而不是复用资料页评论接口。
