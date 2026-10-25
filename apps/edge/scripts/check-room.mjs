import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
const files = [
  "src/room.ts",
  ...readdirSync("src/room")
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/room/${f}`),
];
let failed = false;
for (const file of files) {
  const source = readFileSync(file, "utf8"),
    ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let maximum = 0;
  function visit(node) {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      console.error(`${file}: any 类型`);
      failed = true;
    }
    if (
      (ts.isMethodDeclaration(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)) &&
      node.body
    ) {
      const lines =
        ast.getLineAndCharacterOfPosition(node.end).line -
        ast.getLineAndCharacterOfPosition(node.getStart(ast)).line +
        1;
      maximum = Math.max(maximum, lines);
      if (lines > 80) {
        console.error(`${file}: ${node.name?.getText(ast) || "callback"} ${lines} 行`);
        failed = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  console.log(`${file}: ${source.trimEnd().split(/\r?\n/).length} 行，函数最多 ${maximum} 行`);
}
process.exitCode = failed ? 1 : 0;
