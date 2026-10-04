// 在 WorkBuddy 自己的 Electron 里以 Node 模式跑，拿原生绑定给的静态密钥。
// 只读，不改任何东西；进程几毫秒结束，不会拉起界面。
//
// 用法: WorkBuddy.exe at-rest-key.cjs <输出文件>
const fs = require('node:fs');

try {
  const out = process.argv[2];
  if (!out) throw new Error('缺少输出文件参数');
  const binding = process._linkedBinding('electron_browser_workbuddy_storage');
  const raw = String(binding.loggerGet());
  JSON.parse(raw); // 校验一下确实是 JSON，坏的别落盘
  fs.writeFileSync(out, raw, 'utf8');
  process.exit(0);
} catch (error) {
  process.stderr.write(`ERR ${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
}
