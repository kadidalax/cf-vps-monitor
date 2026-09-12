import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// --- 回归锁：安装脚本内置的分支常量必须与所属仓库匹配 ---
// 三个安装脚本都内置一对常量：从哪个仓库、哪个分支取源码。显式
// `--build-from-source` 和 Unix/Linux 下载预编译包失败后的源码回退都会用到。
// 默认安装成功时走 releases/latest，所以分支写错了不会立刻暴露。
//
// 2026-09-03 实测：dev 上三个脚本的分支常量都是 `main`，而 dev 的仓库
// `kadidalax/cf-monitor-test` 没有 main 分支（`git ls-remote --heads` 可核对），
// 拼出的 `.../refs/heads/main.tar.gz` 实测 HTTP 404 ——
// dev 分支上 `--build-from-source` 是坏的。
//
// 为什么此前没被发现：前端 `agentInstallCommand.ts` 是**推导**的
//   CF_MONITOR_BRANCH = REPOSITORY === 'kadidalax/cf-monitor-test' ? 'dev' : 'main'
// 且有测试覆盖，所以后台展示的安装命令一直取 dev；而脚本内部是**硬编码**，
// 没有任何测试，两处于是各说各话。
//
// 本锁不写死 `dev`——那样在 main 上必然误报（main 就该是 main）。
// 改为断言与前端同一条推导规则，因此在两个分支上都成立。

/** 前端 `agentInstallCommand.ts` 的规则：测试仓库用 dev，其余用 main。 */
function expectedBranchFor(repository) {
  return repository === 'kadidalax/cf-monitor-test' ? 'dev' : 'main';
}

/** 从源码里取出形如 `NAME="value"` 或 `$name = "value"` 的常量值。 */
function readConstant(source, pattern, label) {
  const m = source.match(pattern);
  assert.ok(m, `未能取到 ${label}，安装脚本结构已变，回归锁需同步更新`);
  return m[1];
}

const targets = [
  {
    file: 'install.sh',
    repo: /^CF_MONITOR_REPOSITORY="([^"]+)"/m,
    branch: /^CF_MONITOR_BRANCH="([^"]+)"/m,
  },
  {
    file: 'install-linux.sh',
    repo: /^CF_MONITOR_REPOSITORY="([^"]+)"/m,
    branch: /^CF_MONITOR_BRANCH="([^"]+)"/m,
  },
  {
    file: 'install-windows.ps1',
    repo: /^\$repository\s*=\s*"([^"]+)"/m,
    branch: /^\$branch\s*=\s*"([^"]+)"/m,
  },
];

const seen = [];

for (const target of targets) {
  const source = readFileSync(new URL(`./${target.file}`, import.meta.url), 'utf8');
  const repository = readConstant(source, target.repo, `${target.file} 的仓库常量`);
  const branch = readConstant(source, target.branch, `${target.file} 的分支常量`);
  const expected = expectedBranchFor(repository);

  assert.equal(
    branch,
    expected,
    `${target.file}: 仓库是 ${repository}，分支常量却是 "${branch}"，应为 "${expected}"。`
      + ` 该值用于 --build-from-source 的源码归档地址，写错会让整条路径 404。`,
  );

  seen.push({ file: target.file, repository, branch });
}

// 三个脚本装的是同一个 agent，仓库与分支必须一致；
// 只改其中一个（此前八处漏改那类问题）同样要报错。
const [first, ...rest] = seen;
for (const other of rest) {
  assert.equal(
    other.repository,
    first.repository,
    `${other.file} 的仓库常量与 ${first.file} 不一致：${other.repository} vs ${first.repository}`,
  );
  assert.equal(
    other.branch,
    first.branch,
    `${other.file} 的分支常量与 ${first.file} 不一致：${other.branch} vs ${first.branch}`,
  );
}

// 与前端保持同源：后台展示的安装命令从该分支拉取 install.sh，
// 脚本再从同一分支拉源码，两者必须指向同一个分支。
// 仓库常量的权威定义在 projectLinks.ts（agentInstallCommand.ts 只是 import 它）。
const frontendSource = readFileSync(
  new URL('../frontend/src/utils/projectLinks.ts', import.meta.url),
  'utf8',
);
const frontendRepo = readConstant(
  frontendSource,
  /CF_MONITOR_REPOSITORY\s*=\s*'([^']+)'/,
  '前端的仓库常量',
);
assert.equal(
  frontendRepo,
  first.repository,
  `前端仓库常量 ${frontendRepo} 与安装脚本 ${first.repository} 不一致`,
);
assert.equal(
  expectedBranchFor(frontendRepo),
  first.branch,
  `前端会从分支 ${expectedBranchFor(frontendRepo)} 拉取 install.sh，`
    + `而脚本内置分支是 ${first.branch}，两者必须一致`,
);
