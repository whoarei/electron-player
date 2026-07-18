---
name: release
description: electron-player 版本发布工作流。当用户说"发版本/做个 release/打 tag/上线新版本/publish a release"等意图时触发。要求用户提供版本号；未指定时用 question 工具询问并说明 semver 格式（含 prerelease 规则）。执行流程：检查 git 状态 -> 校验版本号 -> bump package.json 的 version + versionCode -> 提交推送 -> 用 gh release create 创建带 v 前缀 tag 的 GitHub Release -> 触发 .github/workflows/release.yml 自动构建 deb/snap/exe。
---

# Release 工作流（electron-player）

## 触发条件

用户表达以下任一意图：
- "发版本" / "做个 release" / "publish a release" / "打个 tag" / "上线新版本"
- 明确说要发布 electron-player 的新版本

## 必需输入：版本号

**版本号必须由用户提供，不能自行猜测。**

### 已提供版本号

如果用户原始消息中已明确给出（如 "发布 4.0.8" / "release 4.0.8-beta.1"）：
- 用本 skill 的"版本号校验规则"做合法性检查
- 合法 -> 直接进入执行步骤
- 非法 -> 停下来向用户报告错误原因，等待重新指定

### 未提供版本号

如果用户没有指定版本号，**必须**调用 `question` 工具询问。

调用 question 工具时，**问题文本必须包含**下面的版本号格式说明，让用户知道格式要求：

```
请提供本次发布的版本号。

版本号必须符合 semver 规范：
- 正式版格式：MAJOR.MINOR.PATCH，例如 4.0.8
- 预发布版格式：MAJOR.MINOR.PATCH-identifier，例如 4.0.8-beta.1

identifier（预发布标识）规则：
- 只能含字母数字和连字符 [0-9A-Za-z-]
- 不能有空格、下划线 _、加号 +、冒号 :
- 不能有前导零：-01 非法，用 -1
- 建议统一用小写（Debian 包不接受大写）

合法示例：4.0.8、4.0.8-beta.1、4.0.8-rc.1、4.0.8-alpha.2
非法示例：4.0.8-beta_1（下划线）、4.0.8-01（前导零）、4.0.8-Beta（大写）
```

`options` 选项里可以根据当前 package.json 的 version 给出推荐项（label 简短，5 词以内；description 说明用途）：

- 第一个选项 label="下一个 patch"（Recommended），description = "基于当前 version 的 PATCH +1，如 4.0.8 -> 4.0.9"
- 第二个选项 label="prerelease"，description = "预发布版，格式 MAJOR.MINOR.PATCH-beta.1"
- 第三个选项 label="release candidate"，description = "发布候选，格式 MAJOR.MINOR.PATCH-rc.1"
- 用户也可以自己输入其他版本号

用户回复后，再次按"版本号校验规则"做合法性检查，非法则继续询问。

## 版本号校验规则

收到用户版本号后，按以下顺序校验：

1. **正则匹配**：`^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`
   - 不匹配 -> 报错：版本号不符合 semver 格式
2. **prerelease identifier 检查**（如有）：
   - 含 `_` `+` `:` 或空格 -> 报错
   - 段落含前导零（如 `-01`）-> 报错
   - 含大写字母 -> 警告：Debian 包不接受大写，建议改小写
3. **tag 冲突检查**：用 `git tag -l "v<version>"` 看是否已存在同名 tag
   - 已存在 -> 报错，要求用户重新指定

## 执行步骤

所有 `bash` 命令都在 `electron-player/` 目录下执行（用 `workdir` 参数指定，不要用 `cd &&`）。

### 1. 检查当前状态

并行执行：
- `git rev-parse --abbrev-ref HEAD` - 当前分支
- `git status -s` - 未提交变更
- `git log --oneline -3` - 最近提交
- `grep -E '"version"|"versionCode"' package.json` - 当前版本
- `git tag -l | tail -5` - 最近 tag

处理策略：
- 工作区有未提交变更：用 question 工具问用户是否一起提交，或先 stash
- 当前分支不是 `master`/`develop`/`main` 或带 `4.0.x-ans` 这类发布分支：警告用户，让其确认是否继续
- 存在 vim swap 文件（`.release.yml.swp` 等）：提醒用户清理

### 2. 校验版本号

按上面"版本号校验规则"做一遍。验证 prerelease 标签可选用：
```bash
node -e "const v='<version>'; const m=v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/); if(!m){console.error('invalid');process.exit(1)} console.log(JSON.stringify({major:+m[1],minor:+m[2],patch:+m[3],prerelease:m[4]||null}))"
```

### 3. bump 版本号

编辑 `electron-player/package.json`：
- `version` 字段：改为新版本号
- `versionCode` 字段：原值 +1（prerelease 也 +1，保持单调递增）

**不要**手动改 `snap/snapcraft.yaml`：CI 中的 `scripts/set-snap-version.cjs` 会自动同步。

### 4. 提交并推送

```bash
git add package.json
git commit -m "Release v<version>"
git push origin <current-branch>
```

### 5. 创建 GitHub Release（关键步骤，触发 workflow）

```bash
gh release create v<version> \
  --target <commit-sha-of-just-pushed> \
  --title "v<version>" \
  --notes "Release v<version>" \
  [--prerelease if version has -xxx suffix]
```

规则：
- tag 名 = `v` + package.json 的 version（如 version=`4.0.8-beta.1` -> tag=`v4.0.8-beta.1`）
- 版本号带 prerelease 后缀时，加 `--prerelease` flag
- **不要**用 `--draft`：草稿 release 不会触发 `release: [created]` 事件，workflow 不会跑
- `--notes` 内容可以让用户自定义，未指定时用 "Release v<version>"

### 6. 观察 Actions（可选）

```bash
gh run watch
```

三个 Job 并行跑：
- `build-linux` - ubuntu-latest，产出 `.deb` + `.snap`，发布到 Snap Store edge
- `build-linux-arm64` - ubuntu-24.04-arm 原生 runner
- `build-windows` - windows-latest，产出 `.exe`/`.msi`

## 注意事项

- `.github/workflows/release.yml` 触发器：`on.release.types: [created]`，仅 GitHub Release 创建时触发，**不会在 push/PR 时自动跑**。
- ARM64 Job 用 `ubuntu-24.04-arm` runner，public fork 可能没有 ARM runner 配额。如不可用，提醒用户临时移除该 Job。
- Snap 发布依赖 secret `SNAPCRAFT_LOGIN`，缺失会导致 `Publish to Snap Store` 步骤失败（deb 仍能正常产出）。可在 fork 仓库 Settings -> Secrets and variables -> Actions 里配置。
- 版本号单一来源是 `package.json`：`electron.vite.config.js` 注入为 `__APP_VERSION__`，`scripts/set-snap-version.cjs` 同步到 snap。
- workflow 没有手动物料同步：版本号、tag 名、Release title 三者必须严格对应，否则上传的 asset 找不到对应 release。

## 完成后报告

向用户简短报告（不要展开解释）：
- 已创建的 tag 名
- GitHub Release URL
- workflow 运行 URL（或提示用户用 `gh run watch` 观察）
- 如有 ARM runner / Snap secret 缺失的提醒
