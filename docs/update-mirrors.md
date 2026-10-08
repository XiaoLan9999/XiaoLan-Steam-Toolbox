# 更新下载候选线路

核对日期：2026-10-09（客户端日期）。以下是公开 GitHub Release 文件的 HTTPS 前缀代理候选池。它们是第三方传输线路；是否采用某条线路，由客户端每次检查时的签名清单验证和下载探测结果决定。

前缀用法：`https://代理域名/` + 完整 GitHub Release 下载 URL。只代理本工具箱公开发布的更新清单和安装包，不传 Steam 账号、Cookie 或 GitHub Token。

## 本次候选核对

本次对 [0.3.0 的 SHA256SUMS.txt](https://github.com/XiaoLan9999/XiaoLan-Steam-Toolbox/releases/download/v0.3.0/SHA256SUMS.txt) 做匿名 GET：最多 3 个并发，每次最多 8 秒，正文超过 4 KiB 就取消。官方响应是 221 字节；下列 10 条线路均返回 HTTP 200，正文与官方逐字节一致。

| HTTPS 前缀 | 运营站或项目说明 | 本次样本结果 |
| --- | --- | --- |
| `https://gh-proxy.com/` | [Release 使用说明](https://gh-proxy.com/docs/github-accelerator) | 221 字节一致 |
| `https://gh-proxy.org/` | [同服务的前缀说明](https://gh-proxy.com/docs/quick-start) | 221 字节一致 |
| `https://ghfast.top/` | [运营站首页](https://ghfast.top/) | 221 字节一致 |
| `https://ghproxy.net/` | [首页明确列出 Release 文件](https://ghproxy.net/) | 221 字节一致 |
| `https://gh.monlor.com/` | [首页明确列出 Release 文件](https://gh.monlor.com/) | 221 字节一致 |
| `https://ghproxy.imciel.com/` | [首页明确列出 Release 文件](https://ghproxy.imciel.com/) | 221 字节一致 |
| `https://fastgit.cc/` | [首页明确列出 Release 文件](https://fastgit.cc/) | 221 字节一致 |
| `https://github.ednovas.xyz/` | [首页明确列出 Release 文件](https://github.ednovas.xyz/) | 221 字节一致 |
| `https://proxy.vvvv.ee/` | [运营站](https://proxy.vvvv.ee/)使用 [HubProxy](https://github.com/sky22333/hubproxy)，项目文档列出 Release 前缀 | 221 字节一致 |
| `https://ghp.keleyaa.com/` | [首页提供 GitHub 文件加速](https://ghp.keleyaa.com/) | 221 字节一致，但本次最终重定向 GitHub 官方资产域名 |

`ghp.keleyaa.com` 本次没有证明能绕开官方资产域名的连通问题，适合放在后备位置。上述记录没有下载约 100 MiB 的 EXE，不能据此声称完整安装包下载已验证；只有成功取到签名清单并通过安装包完整大小和 SHA-256 校验后，软件才允许安装。

GH-Proxy 的运营文档声明支持大文件，未设置人为文件大小限制。其他候选首页在本次可见说明中没有发现小于本工具箱安装包大小的明确限额；安装包下载仍可能受站点配额、运营变动或用户网络影响。[GH-Proxy 文件说明](https://gh-proxy.com/docs/github-accelerator)

## 未纳入候选池的样本

| 域名 | 本次结果或排除原因 |
| --- | --- |
| `gh.jasonzeng.dev` | 连接失败 |
| `github.akams.cn` | Release 前缀请求返回超过 4 KiB 的网页；首页是代理节点聚合界面 |
| `ghproxy.cxkpro.top` | Release 前缀请求返回超过 4 KiB 的网页；另一次首页请求 HTTP 429 |
| `gh.idayer.com` | Release 前缀请求返回超过 4 KiB 的网页；另一次首页请求 HTTP 429 |
| `proxy.yaoyaoling.net` | 8 秒超时 |
| `gh.chjina.com` | 首页有 Release 示例，但本工具箱样本返回 HTTP 404 |
| `mirror.houlang.cloud` | 返回 HTML；[运营站](https://mirror.houlang.cloud/)介绍的是 Docker 镜像服务 |

这些是单次、单个网络环境的结果，不代表各省或运营商的长期连通情况。发现更多站点时，先核对该站自己的 HTTPS Release 前缀说明，再用同一个公开小文件验证；仅支持 Git Clone / Raw、要求私有 Token、存在不足以传输当前安装包的文件限额、返回验证码或 HTML 的线路不应加入自动更新候选池。

软件信任的是内置公钥签名以及签名清单中明确给出的安装包大小、SHA-256 和本仓库下载路径。第三方线路提供的公钥、执行路径、其他仓库文件或网页内容均不能作为更新依据。
