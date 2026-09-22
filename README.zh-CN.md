# SillyTavern 跨设备设置同步

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md)

让同一个 SillyTavern 账户在手机、桌面及其他设备之间，手动同步扩展设置和可移植浏览器设置。

当前版本：**1.5.1**。升级后必须**重启 SillyTavern 服务器插件**；只刷新浏览器不会加载新的备份 API。

## 功能

- 纯手动同步，上传与下载前均有确认弹窗。加载页面不下载、不上传、不轮询、不备份。
- 同一账户共享五个完整 localStorage 备份插槽，最新在前。
- WizTree 风格树状清单与容量方块图，支持搜索、多选、排序，以及完整／文件夹／单键导入、导出和删除。
- 导入预览、合并或限定范围替换、变更前检查、写入失败回滚。
- 显示总用量估算、选中容量和本地清理建议；支持桌面／手机布局与繁体中文、简体中文、英文。

## 安装与升级

需要 SillyTavern 1.14.0+、Node.js 18+，并启用 Server Plugins。1.5.0 已在独立的 SillyTavern 1.14.0、Node.js 22、Edge Chromium 中验证前后端集成、手机尺寸及三语界面。既有同步功能曾验证 SillyTavern 1.18.0；不代表本次测试了所有版本或实体手机。CI 覆盖 Node.js 18、20、24。

1. 在「扩展 → 安装扩展」中输入：

   ```text
   https://github.com/VanillaMilk00/sillytavern-device-settings-sync
   ```

2. 在 SillyTavern 的 `config.yaml` 设置 `enableServerPlugins: true`。
3. 在 SillyTavern 根目录运行（同样适用于 Windows PowerShell）：

   ```bash
   node public/scripts/extensions/third-party/sillytavern-device-settings-sync/install-server-plugin.mjs .
   ```

   如果是「为自己安装」，请使用 `data/<账户>/extensions/` 下的安装脚本。

4. 重启 SillyTavern。以后通过扩展管理器更新时，服务器端代码也会更新，但仍需重启才能生效。

官方 Docker 容器名为 `sillytavern` 时，可以在宿主机运行自动检测命令，兼容全局与账户专属安装：

```bash
docker exec sillytavern sh -lc 'set -eu; for script in /home/node/app/public/scripts/extensions/third-party/sillytavern-device-settings-sync/install-server-plugin.mjs /home/node/app/data/*/extensions/sillytavern-device-settings-sync/install-server-plugin.mjs; do if [ -f "$script" ]; then exec node "$script" /home/node/app; fi; done; echo "找不到扩展，请先在 SillyTavern 中安装" >&2; exit 1'
```

如果 `plugins/device-settings-sync` 已是普通目录，安装器会拒绝覆盖；请先自行备份并移走旧目录。出现 HTTP 404 时请检查插件链接、更新并重启服务器／容器。如果安装扩展时提示 `Directory already exists`，说明前端已安装，请使用扩展管理器的**更新**，不要重复安装或直接删除原目录。

### Android（Termux）

如果 SillyTavern 在 Android 手机的 **Termux** 中运行，请在 Termux 终端输入以下命令，**不要使用 Docker 或 PowerShell 命令，也不是在浏览器控制台执行**。先确认 `config.yaml` 已设置 `enableServerPlugins: true`；如果酒馆占用当前终端，可先按 `Ctrl+C` 停止。

以下假设酒馆位于 `~/SillyTavern`。如果使用启动器或其他路径，请改为实际 SillyTavern 根目录（包含 `config.yaml`、`start.sh` 和 `src/users.js`）。根据前端扩展的安装方式，**选择一组**执行：

「为所有用户安装」：

```bash
cd ~/SillyTavern && node public/scripts/extensions/third-party/sillytavern-device-settings-sync/install-server-plugin.mjs .
```

「为自己安装」，使用默认账户 `default-user`：

```bash
cd ~/SillyTavern && node data/default-user/extensions/sillytavern-device-settings-sync/install-server-plugin.mjs .
```

其他账户请将 `default-user` 替换为实际账户文件夹名称；如果修改过 `dataRoot`，也要调整 `data/` 路径。若提示找不到安装脚本，先确认扩展是全局安装还是账户专属安装，不要删除重装。

看到 `Linked server plugin` 或 `Server plugin link is already correct` 后，在酒馆根目录重新启动：

```bash
bash start.sh
```

Termux 的酒馆目录和启动方式可参考 [SillyTavern 官方 Android 说明](https://docs.sillytavern.app/installation/android-%28termux%29/)。如果手机只是通过浏览器连接电脑／云端酒馆，**手机不需要执行安装命令**；请在实际运行 SillyTavern 的服务器上安装插件并重启。

## 同步与五格备份

在来源设备按「上传本机设置」，其他设备登录同一账户后按「从服务器同步」。下载完成自动刷新。上传会同步移除那些远端存在、但来源设备已删除的可移植键。

两种同步操作均在确认后、修改前保存**当前设备的完整 localStorage 快照**。取消不备份；备份失败中止同步；后续同步失败仍保留救援快照。第六份成功写入后才淘汰最旧备份，使用原子替换与账户内串行化保护并发写入。网络重试沿用操作标识，即使原备份已淘汰也不重复占格。索引保留不含设置值的操作标识、备份 ID 和摘要哈希，以支持淘汰及重启后的重试去重；快照内容仍只保留五份。

打开「管理 localStorage → 备份插槽」才加载列表。每格显示时间、设备、原因、键数、估算容量和 JSON 大小，支持浏览、导出及恢复；选中时才读取内容。「导入、恢复或删除本机数据前也自动备份」默认**关闭**。

**备份只包含 localStorage**，不包含账户设置文件、服务器聊天文件、角色、Cookie、sessionStorage 或 IndexedDB。完整快照包含 localStorage 中的缓存、历史、大型值和凭证，不应用普通同步排除规则。日常跨设备同步仍使用原有排除规则与大小限制。

## 管理与导入导出

键名按 `:`、`/`、`.` 分层；没有这些分隔符时，以第一个 `_` 前缀分组，保留连字符。文件夹只是原始键前缀的虚拟分组，一个完整键就是一个文件，不拆解值内的 JSON 字段。

- 可导出全部、文件夹、单键或多选项目。树与方块图共用搜索和选中状态；手机上下排列并可滚动。
- 选文件后先显示可勾选导入树、新增／覆盖／删除数量及删除清单。主树已有选择时导入限制在该范围；否则使用文件声明范围。恢复使用同一预览流程。
- 默认「合并」保留其他键。「替换指定范围」只删除授权范围内、文件未包含的键。未勾选的传入键保持不变，选单键不会获得整个文件夹的删除权限，局部文件不会清空其他数据。
- 同步器内部键可见且参与备份／导出，但修改时默认跳过。只有明确勾选包含内部键才复制或删除设备标识。
- 删除前确认受影响的键数、容量和清单。管理操作只修改本机；要反映到普通服务器同步数据，需要手动上传。

修改操作共用锁，应用前核对当前存储与预览。其他标签页发生改动时，必须重新扫描。写入失败会尝试回滚本次已修改的键，并明确报告结果；完成后可点击重新加载按钮。普通服务器下载仍自动刷新。

## 文件格式与限制

备份和导出使用统一 JSON 格式，保留原始字符串：

```json
{
  "format": "sillytavern-localstorage-backup",
  "version": 1,
  "createdAt": "2026-09-22T00:00:00.000Z",
  "source": { "origin": "https://your-tavern.example", "deviceId": "device_example" },
  "scope": { "kind": "prefix", "prefix": "extension:" },
  "entries": [{ "key": "extension:theme", "value": "dark" }]
}
```

范围支持 `{"kind":"full"}`、`{"kind":"prefix","prefix":"extension:"}` 或 `{"kind":"keys","keys":["extension:theme"]}`。也接受全部值为字符串的普通 JSON 对象，例如 `{"extension:theme":"dark"}`；此类文件只授权列出的完整键，不视为完整快照。

JSON 文件／备份请求限制 **32 MiB**，超限拒绝且不修改原数据。完整快照不受普通同步的单键限制，但浏览器自身存储配额仍可能阻止导入。请只导入可信文件。

## 容量、清理与安全

用量估算为全部 `(键.length + 值.length) × 2`，包括同步排除项；JSON 文件字节数另算。依据 [MDN 的 UTF-16 存储格式说明](https://developer.mozilla.org/en-US/docs/Web/API/Window/localStorage)，此估算不是浏览器配额，也不使用网站整体配额推测 localStorage 上限。

清理分析完全在本机进行，列出最大的十项与疑似缓存／临时／调试／日志项目，附上原因和容量。历史、草稿、聊天、凭证及内部键需人工判断。被同步排除不等于可以安全删除；不推测最后使用时间，也不自动清理。

备份位于账户私有 `device-settings-sync-backups/` 目录，与 `device-settings-sync.json` 分开。文件设置 `0600` 权限（Windows 仍依赖 ACL），但**没有额外加密**。请保护服务器与下载文件，其中可能包含 OAuth token 或其他凭证。扩展不能读取 HttpOnly／登录 Cookie，新设备仍须登录 SillyTavern。

所有 API 沿用登录工作阶段和 CSRF 防护，前缀为 `/api/plugins/device-settings-sync`：

- `GET /backups`：最多五份摘要，不包含设置值。
- `POST /backups`：`{ operationId, reason, archive }`，原因为 `upload`、`download`、`import`、`restore`、`delete`。
- `GET /backups/:id`：仅访问当前账户保留中的指定快照。

### 一键分析、容量上限与扩展名（1.5.0）

- 「清理建议 → 立即分析」扫描全部键，按容量排序并标记最大的十项。绿色为疑似缓存／临时／调试／日志，黄色需人工判断，红色受批量清理保护。仅按键名分类，不是 AI，也不能证明数据已经无用。
- 保护规则优先：凭证、历史、草稿、聊天、设置及内部键，即使名称含 `cache` 也不会被推荐。`tt:` 命名空间需人工判断。红色不能批量勾选；确有需要时请使用「本机数据」的普通删除功能。
- 默认不选中任何项目。「选中推荐项」仅选绿色，黄色可手动选择。「备份并清理」先确认键列表、数量和容量，再**强制创建完整服务器备份**，不受普通操作自动备份开关影响。取消、备份失败或预览过期均不删除；写入失败尝试回滚，成功后显示清理前后用量与释放量。只修改本机。
- 显示 **5 MiB 参考上限**，并非本机实测值；环境和计量方式可能不同。没有直接查询 localStorage 上限的标准 API，网站整体配额不能代替。[MDN 配额说明](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
- 手动确认「实测容量」后，只新增一个临时键并逐步测试，最后移除，显示 UTF-16 估算范围和时间。测试值最多 16 MiB；达到安全界线仍未满时仅报告下限。**可能短暂阻塞页面或使其他标签页写入失败，请先导出重要数据并暂停其他操作。**不会自动测试、清空或覆盖原键；发现其他数据变化即中止，临时键无法安全移除时明确提示。结果不保证永久有效。
- 新增「扩展名／值类型」列：已知后缀取自原键，否则显示推测的 `.json`／`.txt`。识别 JSON 对象／数组、文本、Data URI 和 Blob URL；超过 1 Mi 字符的值不解析 JSON。仅作提示，**不改键名**，导出始终为原始字符串键值的 JSON 封装。

## 开发与测试

运行 `npm test` 与 `npm run check`。可重现的隔离浏览器、账户隔离和 CSRF 测试见 [TESTING.md](TESTING.md)。脚本会修改测试账户和 localStorage，**只能用于一次性测试安装**，不能指向日常使用的数据。不完整工作区的模块测试不能替代 SillyTavern 实际集成验证。

## 许可

[MIT](LICENSE)
