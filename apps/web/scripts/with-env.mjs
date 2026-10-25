// 跨平台设置环境变量后运行命令：node scripts/with-env.mjs KEY=VAL [KEY2=VAL2] -- cmd args...
import { spawn } from "node:child_process";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0 || sep === argv.length - 1) {
  console.error("用法：with-env.mjs KEY=VAL -- 命令 参数...");
  process.exit(2);
}
const env = { ...process.env };
for (const pair of argv.slice(0, sep)) {
  const i = pair.indexOf("=");
  env[pair.slice(0, i)] = pair.slice(i + 1);
}
const [cmd, ...args] = argv.slice(sep + 1);
const child = spawn(cmd, args, {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 1));
