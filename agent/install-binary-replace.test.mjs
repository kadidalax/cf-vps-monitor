import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// --- 回归锁：安装脚本替换二进制不得直接覆写目标文件 ---
// Linux 上以 O_TRUNC 打开正在执行的可执行文件会返回 ETXTBSY（Text file busy），
// 裸 `cp "$src" "$dst"` 因此在「agent 正在运行」这一最常见的升级场景下 100% 失败。
//
// 2026-08-14 在 test2-LXC（Debian 11 LXC，systemd）实测复现：
//   cp: cannot create regular file '/opt/cf-vps-monitor/<id>/cf-vps-monitor-agent': Text file busy
// 而安装路径全程没有任何 stop 动作（stop 只出现在 uninstall 分支）。
//
// 这原本是相对旧脚本的回退：install-linux.sh 用的是 `install -m 0755`，
// GNU install 会先 unlink 目标再写，正是为了能替换运行中的二进制；
// 统一到 install.sh 时换成 cp，把这个性质丢掉了。
//
// 正确做法只有两类：
//   1. 写同目录临时文件后 mv（rename 原子替换，只解绑旧 inode，不受 ETXTBSY 限制）
//   2. install -m 0755（先 unlink 再写）
// 本锁禁止回退到裸 cp 直写目标。

const AGENT_DIR = fileURLToPath(new URL('./', import.meta.url));

/** 取出某个 sh 函数的函数体（假定以 `name() {` 开头、以列首 `}` 结束）。 */
function extractFunction(source, name) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^${name}\\(\\)\\s*\\{`).test(l.trim()));
  assert.notEqual(start, -1, `未找到函数 ${name}()，安装脚本结构已变，回归锁需同步更新`);
  const end = lines.findIndex((l, i) => i > start && /^\}\s*$/.test(l));
  assert.notEqual(end, -1, `函数 ${name}() 缺少收尾大括号`);
  return lines.slice(start, end + 1).join('\n');
}

const installSh = readFileSync(new URL('./install.sh', import.meta.url), 'utf8');
const body = extractFunction(installSh, 'copy_binary_to');

// 1) 禁止裸 cp 把源直接写到目标（`cp "$src" "$dst"`，dst 后不接 .new/.tmp 之类后缀）
const bareCopy = /\bcp\s+(-[A-Za-z]+\s+)*"\$src"\s+"\$dst"\s*$/m;
assert.ok(
  !bareCopy.test(body),
  'copy_binary_to() 又在直接 cp 覆写目标二进制：agent 运行时会 ETXTBSY，升级路径必然失败',
);

// 2) 必须走「暂存 + 原子替换」或 install(1) 其中一条
const stagedMove = /\bmv\s+(-[A-Za-z]+\s+)*"\$tmp"\s+"\$dst"/.test(body);
const usesInstall = /\binstall\s+-m\s+0?755\b/.test(body);
assert.ok(
  stagedMove || usesInstall,
  'copy_binary_to() 必须用「临时文件 + mv 原子替换」或 install -m 0755 替换二进制',
);

// 3) 暂存路径必须与目标同目录，否则 mv 跨文件系统退化成 copy+unlink，重新撞上 ETXTBSY
if (stagedMove) {
  assert.match(
    body,
    /tmp="\$\{dst\}[^"]*"/,
    '临时文件必须以 $dst 为前缀（同目录），跨文件系统的 mv 不是原子 rename',
  );
}

// 4) 失败路径必须清理暂存文件，不能在安装目录里留下半个二进制
if (stagedMove) {
  assert.match(body, /rm\s+-f\s+"\$tmp"/, '失败分支必须清理临时文件');
}

// 5) 旧脚本 install-linux.sh 若仍在仓库中，其 install -m 0755 的写法也不许退化成裸 cp
try {
  const linuxSh = readFileSync(new URL('./install-linux.sh', import.meta.url), 'utf8');
  if (/copy_binary/.test(linuxSh) || /cf-vps-monitor-agent"\s*$/m.test(linuxSh)) {
    assert.ok(
      /\binstall\s+-m\s+0?755\b/.test(linuxSh) || /\bmv\s+(-[A-Za-z]+\s+)*"[^"]*\.new/.test(linuxSh),
      'install-linux.sh 也必须用 install -m 0755 或暂存后 mv 来替换二进制',
    );
  }
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

console.log(`ok - ${AGENT_DIR}install.sh 的二进制替换不会撞上 ETXTBSY`);
