# SillyTavern 跨设备设置同步

[繁體中文](README.md) · [简体中文](README.zh-CN.md) · [English](README.en.md)

让同一个 SillyTavern 账户在手机、桌面及其他设备之间手动同步设置，并可选择自动同步可移植浏览器设置。

当前版本：**1.8.0**。升级后必须**重启 SillyTavern 服务器插件**；只刷新浏览器不会加载新的同步与 IndexedDB 分块 API。

## 功能

- 默认纯手动，上传与下载前均有确认弹窗。两个自动开关均关闭时，加载页面不下载、不上传、不轮询、不备份。
- 自动上传和自动下载分别启用：15 分钟模型请求空闲后上传，以及进入页面时下载检查。
- 同一账户共享五个完整 localStorage 备份插槽，最新在前。
- WizTree 风格树状清单与容量方块图，支持搜索、多选、排序，以及完整／文件夹／单键导入、导出和删除。
- 导入预览、合并或限定范围替换、变更前检查、写入失败回滚。
- 显示总用量估算、选中容量和本地清理建议；支持桌面／手机布局与繁体中文、简体中文、英文。
- localStorage 可选普通、全部或仅同步选中的键／文件夹；明确选中的缓存、历史和大型值也会同步。
- 可选开启 IndexedDB 同步，并在数据库、对象存储和记录层级管理、导入、导出及移除。

## 设置菜单与完整 localStorage 同步

在扩展面板打开「设置」，可调整自动上传／下载、变更前备份、额外排除键及 localStorage 同步范围。范围按网站、账户和设备保存在本地，不传到其他设备。

- **普通设置**（默认）：沿用既有缓存、历史、大型值、凭证和自定义排除规则。
- **只同步选中项**：打开「管理 localStorage」，勾选键或文件夹，再点「将选择用作同步范围」。明确选中的缓存、历史和大型值会包含；同步器内部键始终排除。下载只修改所选范围。
- **同步全部 localStorage**：同步所有非内部键，包括缓存、历史、草稿、大型值及可能的凭证。

选中范围与完整模式使用独立账户同步文件，均限制为 32 MiB JSON。手动及自动同步都遵循该范围；不会在未选择时静默同步全部数据。

完整模式同时用于手动与自动上传／下载，包含缓存、历史、草稿、大型值及可能的凭证；扩展内部的设备标识和调度键保留在本机。完整与普通模式使用不同的账户私有服务器文件，切换模式不会直接以其中一份覆盖另一份。首次数据不同时，自动同步询问来源。完整 JSON 同步文件上限 32 MiB；超限不改动既有服务器数据。应用变更前先保存完整本机救援备份；下载按完整快照替换非内部键，写入失败尝试回滚。

完整模式只涵盖 **localStorage**，不含 IndexedDB、Cookie 或其他浏览器存储。不同设备容量可能不同，一台设备能保存的数据未必能写入另一台。额外排除规则和普通单键上限仅适用于普通模式。

## IndexedDB 同步与管理（可选）

在「设置」中明确开启 IndexedDB 后，现有的手动上传／下载和对应自动开关会一并处理 IndexedDB。此功能默认关闭，配置仅保存在当前网站／账户／设备。

- 范围可选「选中的数据库／项目」或「同源所有数据库」。在「管理 IndexedDB」中选择数据库、对象存储或单条记录，再点「将选择用作同步范围」；也可以单独导入、导出和移除。
- 同步上传与下载均采用合并：相同主键的记录以来源值更新，服务器和本地的额外记录都会保留。同步不会删除记录；删除仅在本地管理界面明确执行。
- 使用独立的五槽账户救援备份。每份归档最多 128 MiB，按 1 MiB 分块传输并校验完整性；浏览器需支持 `indexedDB.databases()`。
- 支持常见结构化值、循环引用、Blob／File 和二进制值。无法安全序列化、数据库结构冲突、锁定或配额错误会中止操作，不会静默跳过。
- 同步前保存完整本地 IndexedDB 快照。跨数据库／对象存储区无法形成单一原子事务；发生部分失败时可从独立备份槽恢复。

`navigator.storage.estimate()` 是整个来源的估算，不是 IndexedDB 专属容量或保证上限。不会自动清空或推测数据是否可删除。

## 独立控制自动上传和下载

两个开关默认**关闭**，开启时需要确认。偏好按网站、账户和浏览器设备保存，不随普通同步传到其他设备。停用取消尚未发送的工作；已发送请求可能完成。

- **仅上传**：最后一个已观测模型请求成功、失败或取消后，连续 15 分钟无新活动才尝试上传；每轮最多成功一次，无变化不占备份槽。单纯修改设置不启动倒计时。
- **仅下载**：新页面或手动刷新时检查，切回标签页不下载。只应用远端单独变化，保留本机单独变化；成功修改后刷新一次，以一次性标记避免循环。
- **同时开启**：独立运行，共享账户范围跨标签页锁。请求活动中或管理窗口打开时延后。
- **冲突**：无基准且数据不同、双方变化，或上传前远端版本改变时，选择「保留本机并上传」「使用服务器数据」「稍后处理」。前两者仅授权当次动作，不开启另一开关；稍后处理暂停自动写入。

自动模式依设置同步普通或完整 localStorage，不再次保存整份酒馆账户／扩展设置，不改变原生保存及手动同步。每次真正写入前强制保存完整 localStorage 服务器救援备份（可能包含凭证），仅开启下载时也一样，不受管理窗口可选备份开关影响。备份或核对失败就停止；下载写入失败尝试回滚。自动上传仍读取服务器版本，但不会因此应用远端设置。

监测原生生成事件、已知生成／Responses／Embedding／Rerank fetch 和 XHR 端点及可访问的同源 iframe。流式请求等待传输结束，不以响应头作为结束，不复制或消费响应流，不检查提示词、响应内容、凭证或查询参数。不能确认结束的请求阻止上传。跨源 iframe、Worker、未知传输及观测启用前的请求存在限制，扩展可通过主页面接口报告生命周期，不传内容：

```js
const activity = globalThis.DeviceSettingsSync.beginModelActivity();
try {
    await yourModelRequest(); // 等到流结束或取消，而非只等响应头。
} finally {
    globalThis.DeviceSettingsSync.endModelActivity(activity);
}
```

自动功能需要 HTTPS／localhost 安全环境、Web Locks、Web Crypto 和 Resource Timing；缺少可靠协调能力时保留手动操作。关闭或休眠浏览器不保证准时上传，不在离开页面时强行传输；返回后核对待办。已关闭标签页遗留的请求保守重新等待 15 分钟，仍存活的休眠标签页继续阻止上传。临时网络失败最多按 1、5、15 分钟重试，随后暂停；权限、版本和冲突错误不反复重试。面板提供暂停、恢复／重试。

偏好、基准、日志和排程属于内部键：普通同步排除，完整备份包含，恢复默认跳过。管理操作只直接改本机，但待办或后续自动上传可能随后上传这些变化。

## 安装与升级

需要 SillyTavern 1.14.0+、Node.js 18+，并启用 Server Plugins。1.6.0 已在独立 SillyTavern 1.14.0、Node.js 22、Edge Chromium 中验证前后端集成、手机尺寸及三语界面；模型传输使用本地测试服务器，未调用付费模型。既有同步功能曾验证 SillyTavern 1.18.0；本次不代表所有模型扩展、版本或实体手机均已验证。CI 覆盖 Node.js 18、20、24。

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

打开「管理 localStorage → 备份插槽」才加载列表。每格显示时间、设备、原因、键数、估算容量和 JSON 大小，支持浏览、导出及恢复；选中时才读取内容。「导入、恢复或删除本机数据前也自动备份」默认**开启**。保留已保存的开关选择；旧版已关闭者，请在管理窗口手动开启。

**localStorage 备份只包含 localStorage**，不包含账户设置文件、服务器聊天文件、角色、Cookie、sessionStorage 或 IndexedDB。完整快照包含 localStorage 中的缓存、历史、大型值和凭证，不应用普通同步排除规则。IndexedDB 使用独立的五槽备份；日常 localStorage 同步仍应用原排除规则与大小限制。

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
- `GET /health`：声明 `backups-v1`、`atomic-sync-v1`、`full-storage-v1`、`indexeddb-sync-v1`、`indexeddb-chunks-v1`；旧后端缺少所需能力时暂停相关功能并提示更新／重启。
- `POST /commit`：`{ operationId, expectedRevision, deviceId, mutations }`，完整验证后原子写入，版本或操作标识冲突返回 HTTP 409；相同请求重试不重复应用。
- `GET /commits/:id`：当前账户的提交收据，用于恢复丢失响应。收据与数据同时写入，计入既有 5 MiB 同步文件上限；单值限制与手动 API 保持兼容。
- `GET /full-state`、`POST /full-commit`、`GET /full-commits/:id`：独立的完整快照、原子版本提交和重试收据；上限 32 MiB JSON，与普通同步和五格救援备份分开。
- `POST /indexeddb/transfers/start`、`PUT /indexeddb/transfers/:id/chunks/:index`、`POST /indexeddb/transfers/:id/finish`：分块上传与原子合并提交，上限 128 MiB，按账户校验版本并以操作标识去重。
- `GET /indexeddb/state` 和 `/indexeddb/state/chunks/:index`：分块读取账户服务器快照。
- `GET /indexeddb/backups`、`GET /indexeddb/backups/:id`、`GET /indexeddb/backups/:id/chunks/:index`：读取独立于 localStorage 的 IndexedDB 五槽救援备份。

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
