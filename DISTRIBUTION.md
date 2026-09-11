# Mechanics CLI 发布流程

此流程发布 npm 上的 `@veewo/mechanics` CLI（命令为 `mech`）。发布包只包含 CLI 运行所需的源码、Schema、内置 skill、文档和示例；游戏项目的 `.mechanics` 数据、草稿、锁和本地开发状态不属于发行物。

## 发布前提

- 使用 Node.js 24 或更高版本。
- 已登录具有 `@veewo/mechanics` 发布权限的 npm 账号：`npm whoami`。
- 确认本次改动均已纳入工作区；`npm publish` 不会替代 Git 提交或推送。

## 标准发布

1. 先安装锁定依赖并运行完整发行验收：

   ```sh
   npm ci
   npm run release:check
   ```

   `check:package` 会执行 `npm pack --dry-run`、实际打出 tarball，并在隔离目录安装该 tarball，验证 CLI、内置 skill 注册、查询、写入和本地网页服务。

2. 查询 registry 的当前版本，并在 `package.json` 设定一个尚未发布的语义化版本。首次发布可使用当前版本；后续兼容修复使用 patch，新增兼容能力使用 minor，不兼容协议变更使用 major。

   ```sh
   npm view @veewo/mechanics version
   npm version patch --no-git-tag-version
   ```

   版本号变更也必须经过上一步发行验收。

3. 将本次发布源码提交并推送。发布的 package.json、源码与测试必须位于同一个 Git 提交；先推送能确保 registry 上的版本始终有可追溯的远端源码：

   ```sh
   git status --short
   git add -- .npmignore README.md DISTRIBUTION.md package.json package-lock.json docs schemas scripts skills src tests workspace-tools examples/card-game
   git commit -m "release: mechanics v<本次版本>"
   git push origin HEAD
   ```

   不要在 push 失败后继续发布 npm。若工作区还有本次发布之外的改动，先将发布范围整理清楚；不要用 `git add -A` 将未知文件带入发布提交。

4. 发布公开包：

   ```sh
   npm publish
   ```

5. 从 registry 回读版本，并用临时 npx 安装验证实际可执行文件：

   ```sh
   npm view @veewo/mechanics version
   npx -y @veewo/mechanics@<本次版本> --version
   ```

6. 按团队约定创建 Git tag 或 Release。tag 必须指向已推送、且已通过 registry 回读的发布提交。

## 失败处理

- 校验、提交、push、打包或发布任一步失败即停止；不要跳过失败项后继续发布。
- 如果版本已存在，提升版本号后重新执行完整的 `npm run release:check`。
- 如果 npm 拒绝权限或双因素认证，完成账号验证后从 `npm publish` 重新执行；不要改用 tarball 作为公开发布替代品。
