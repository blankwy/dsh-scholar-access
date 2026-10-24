# 校园网学术通道加速 · dsh-scholar-access

[![check](https://github.com/blankwy/dsh-scholar-access/actions/workflows/check.yml/badge.svg)](https://github.com/blankwy/dsh-scholar-access/actions/workflows/check.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> 让 **DeepSeek Harness 自己**在校园网里走通 GitHub、Hugging Face、npm、PyPI —— 包括 DSH 的插件、模型请求、插件市场索引源，以及 agent 派生的 `git` / `npm` / `pip` 子进程。

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that carries DSH's own international traffic over the CERNET academic channel (`scholar.edu.cn`) using its DoH resolver and reverse proxy — with explicit, revocable, per-process certificate trust instead of a machine-wide install.

---

## 这是什么

很多高校通过 CERNET 的「国际学术资源访问专用通道」开放 GitHub、Hugging Face、arXiv 等站点。官方做法是下载 `scholartools.exe` / 专用浏览器，它会：

1. 把系统 DNS 指向通道的 DoH 解析；
2. 把通道反向代理的根证书装进**本机证书库**（整台机器所有程序都信任它）；
3. 每次访问都要保持客户端在跑。

这个插件把 1、2 两步搬进 DSH 进程内部，并且**只对 DSH 自己生效**：

| 层 | 通道侧 | 本插件 |
|---|---|---|
| 名字解析 | `https://doh.scholar.work/dns-query`，白名单域名解析到 `205.164.0.0/16` | 进程内 DoH 客户端，命中通道段才接管，其余域名原样直连 |
| 加密信任 | 反向代理出示 `Scholar Service` ← `Scholar Root CA v1` | 从真实握手链抓取并 **pin** 根证书，只在与通道地址通信时并入信任库 |
| 出口 | 反向代理集群 | ① 接管宿主 `fetch` ② 本地转发代理 ③ 子进程环境变量 |

**关键点：没有本地中间人。** 本地代理只做 TCP 隧道（`CONNECT`），TLS 端到端到通道反向代理；不存在插件自己签发证书。

---

## 特性

- **不需要 scholartools.exe 常驻**，也不改系统 DNS、不写系统证书库。
- **默认不信任证书**：先做一次不校验的握手，算出链上根指纹与内置 pin 比对，确认「指纹匹配」后由你点「信任证书」。
- **一键注销**：停用并删除本地 PEM，通道立即失效。
- **系统信任开关**：如果 scholartools 已经把根证书装进了本机库，插件能扫出来，并可用 `Disallowed`（不信任证书）库**停用而不删除**——用 scholartools 时再一键恢复。
- **可访问性测试**：逐域名返回状态码、落地 IP、是否走通道、耗时、证书指纹是否匹配。
- **接管统计**：真实记录宿主进程里有多少请求走了通道、多少直连、多少失败，按域名明细——不是口号。
- 开关、模式、证书信任全部在 **设置 → 插件 → 校园网学术通道加速** 一页里。

---

## 安装

### 从 GitHub 安装

在 DSH 里让 agent 执行：

```
plugin_manager { action: "install_bundle", target: "github:blankwy/dsh-scholar-access" }
```

若你的 DSH 版本不接受 GitHub spec，克隆到本地后按下面的「本地目录」方式安装即可。

### 本地目录（开发/自用）

```
git clone https://github.com/blankwy/dsh-scholar-access.git D:/path/to/dsh-scholar-access
plugin_manager { action: "install_bundle", target: "D:/path/to/dsh-scholar-access" }
```

### 装完必须重启一次 DSH

新 bundle 的 patch 由 Loader 在启动时组合，安装阶段只会写入 profile 的 `package.json` 与 bundle 列表（返回 `application: "restart-required"` 属正常）。之后修改插件代码同样需要重启。

---

## 自检（不需要起 DSH）

装之前可以先确认这台机器能不能用：

```bash
node scripts/verify.mjs                 # github.com / huggingface.co / registry.npmjs.org
node scripts/verify.mjs pypi.org arxiv.org
```

它会依次做：DoH 解析 → 连到通道地址 → 用内置 pin 校验证书 → 打印 `status / ip / channel / pin`。全部通过退出码为 0。

---

## 首次使用

1. 打开 **设置 → 插件 → 已安装 → 校园网学术通道加速**。
2. 点「检查系统证书库」——看看 scholartools 有没有把根证书装到本机级。
3. 点「测试可访问性」——此时**不校验证书**，但会把链上根指纹和内置 pin 比对，应显示「指纹匹配」。
4. 确认无误后点「信任证书」——通道立即生效。
5. 想关掉：点「注销证书」，或直接关右上角总开关。

---

## 使用

### 设置页

| 区域 | 说明 |
|---|---|
| 总开关 | 即时生效，写盘持久化 |
| 运行状态 | DoH 健康、本地代理地址、宿主 fetch 是否接管、注入了多少环境变量、实测接管次数 |
| 证书信任（主动） | 信任 / 注销、本地 PEM 路径、pin 指纹、系统证书库扫描与开关 |
| 接管范围 | `自动`：只接管已知国际站点；`全量`：所有域名先经 DoH 解析 |
| 可访问性测试 | 逐域名结果，含「通道/直连」与「指纹匹配」标记 |

### Agent 工具

| 工具 | 用途 |
|---|---|
| `scholar_access_test` | 批量测可达性，可传 `targets` |
| `scholar_access_status` | 开关、DoH 健康、代理、注入的环境变量、证书指纹、接管统计 |
| `scholar_resolve` | 单域名 DoH 解析，看是否落进通道段 |

### 命令行子进程

开启后，agent 派生的子进程会继承（关闭时精确恢复原值）：

```
HTTPS_PROXY / HTTP_PROXY / NO_PROXY
SSL_CERT_FILE / CURL_CA_BUNDLE / GIT_SSL_CAINFO / REQUESTS_CA_BUNDLE
NODE_EXTRA_CA_CERTS
```

```powershell
git ls-remote --heads https://github.com/nodejs/node
npm view react version
```

已经打开的旧终端继承的是旧环境，需要新开会话。

> **为什么没有 `NODE_USE_ENV_PROXY`**：Node 24 在该变量存在时会让 `http(s).request` 也走环境代理，而本插件的通道请求就在同一个宿主进程里——那会把它们绕回插件自己的本地代理。所以插件不注入它；需要代理的 Node 脚本请自行开启（`$env:NODE_USE_ENV_PROXY=1`，并已自动带上 `NODE_EXTRA_CA_CERTS`）。

---

## 作用范围

**覆盖**

- 宿主进程里所有走 `globalThis.fetch` 的代码：插件网络调用、模型请求、插件市场索引源、web 工具。
- agent 派生的子进程：`git`、`npm`/`pnpm`、`pip`、`huggingface-cli`，以及自行开启 `NODE_USE_ENV_PROXY` 的 Node 脚本。

**不覆盖**

- 直接 `net.Socket()` / 自带 DNS 的程序。
- 开启前已建立的长连接。
- 通道白名单之外的域名——按设计直连，走不动属于校园网出口限制。

---

## 证书与隐私（重要）

| 位置 | 本插件是否写入 | 说明 |
|---|---|---|
| Windows `CurrentUser\Root` / `CA` | **否** | 从不写 |
| Windows `LocalMachine\Root` / `CA` | **否** | 从不写（也不申请提权） |
| `$DSH_HOME/scholar-access/ca-bundle.pem` | 仅「已信任」期间 | 注销时删除 |
| `$DSH_HOME/scholar-access/scholar-root.pem` | 仅「已信任」期间 | 注销时删除 |
| `lib/scholar-ca.js` | 随包分发 | 只是一段 PEM 文本，不被引用就不产生信任 |

信任只发生在两处，且都随开关消失：连接通道地址时把该根并入 Node 的 `ca:` 列表；子进程里通过环境变量指向那两个 PEM。

**要说明的风险**：通道反向代理对经通道的 HTTPS 流量做 TLS 终止，具备内容审计与实时改写能力（这是该通道的公开设计，不是本插件引入的）。插件能做的是把范围收窄、把事实摊开——默认不信任、只对通道地址生效、pin 指纹每次校验、状态页可见、一键注销。

**关于系统信任开关**：`scholartools.exe` 会把同一个根证书装进本机级证书库（全机器所有程序都信任），这与本插件无关。插件页可以扫出它，并用 Windows 的 `Disallowed` 库**停用而不删除**——证书仍在 `Root` 里，只是整机判定不受信任；恢复时从 `Disallowed` 移除即可。两个方向都需要管理员权限（会弹 UAC）。注意：走 Windows 证书库的浏览器（Edge / Chrome / Open 等）会受影响，Firefox 用自己的证书库不受影响。

---

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关初值（页面开关会覆盖并持久化） |
| `dohEndpoint` | `https://doh.scholar.work/dns-query` | DoH 解析地址，可换成自建 |
| `mode` | `auto` | `auto` / `always` |
| `patchHostFetch` | `true` | 是否接管宿主 `fetch` |
| `startProxy` | `true` | 是否启动本地转发代理 |
| `proxyPort` | `0` | 0 = 自动分配 |
| `injectEnv` | `true` | 是否注入子进程环境变量 |
| `extraHosts` | `[]` | 额外强制走通道的域名 |
| `testHosts` | 见默认值 | 测试列表 |

> 证书信任不是配置项，而是页面上的运行时状态（默认关闭），存在 `state.json` 里。

---

## 数据与卸载

`$DSH_HOME/scholar-access/`（默认 `C:\Users\<你>\.dsh\scholar-access\`）：

- `state.json` — 开关、模式、是否已信任
- `ca-bundle.pem` — Mozilla 根 + 通道根（仅信任期间）
- `scholar-root.pem` — 仅通道根（仅信任期间）

卸载：`plugin_manager { action: "remove_bundle", target: "dsh-scholar-access" }`，然后删掉上面整个目录、重启 DSH。若曾点过「信任证书」，先点「注销证书」把 PEM 清掉。

---

## 排错

| 现象 | 排查 |
|---|---|
| 测试失败且 `channel:false` | DoH 没命中通道：确认在校园网内、`dohHealth.ok` 为 `true`；用 `scholar_resolve github.com` 看返回 IP |
| 全部失败，`error: fetch failed` | 校园网未开通该通道或出口限制 |
| 子进程仍不走通道 | 看 `scholar_access_status` 的 `env.injected`；新开终端会话 |
| 根证书「指纹不匹配」 | 通道换了证书。先关开关，抓新链更新 pin，不要直接信任 |
| `curl` 报 `schannel: AcquireCredentialsHandle failed` | Windows 自带 curl 是 schannel 构建，不认 PEM 形式的 CA。用 `git` / `npm` / `node` / `python`，或换 OpenSSL 版 curl |
| 某功能变慢 | 把 `mode` 切回 `auto`，或临时关总开关对比 |

---

## 已知限制

- 只在**已开通该通道**的校园网内有效。
- 通道白名单由运营方维护，名单外的域名仍然直连。
- `always` 模式会给每个新域名加一次 DoH 查询（有缓存），非必要不用。
- 证书 pin 需要随通道换证更新：`lib/scholar-ca.js` 里是实测抓取的根证书与指纹。

---

## 开发

```
index.js           Host 插件：配置、工具、路由、生命周期
client.js          Client 卡片：设置页 UI
lib/network.js     DoH 客户端、通道 fetch、证书链读取
lib/proxy.js       本地转发代理（CONNECT 隧道）
lib/certstore.js   Windows 证书库扫描 / Disallowed 开关
lib/scholar-ca.js  pin 的根证书与指纹
cordis.patch.yml   bundle patch（插入插件行）
scripts/verify.mjs 独立自检脚本（DoH + 通道 + pin，不需要 DSH）
```

改完先 `npm run check`（等价于逐个 `node --check`），再重启 DSH 验证。

---

## 声明

本项目只做本地网络路径与信任管理：不绕过任何身份认证，不修改通道侧策略，不内置账号或密钥。使用前请确认所在学校已开通该通道并允许此类用法；因使用本插件产生的账号、合规或网络后果由使用者自负。

证书相关：仓库内的根证书是**公开证书**，从真实握手链抓取并用于 pin，不含任何私钥。

## License

MIT
