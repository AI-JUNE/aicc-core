// 참조 클라이언트 복사본 드리프트 검사 실행기.
// 판정 로직은 src/ops/clientDrift.ts 에 있고 테스트로 덮여 있다. 여기서는 argv·파일 읽기·해시·종료코드만 다룬다.
// 종료코드 0/1/2 를 그대로 게이트로 쓴다. 대상 디렉터리가 없으면 판정보류(2) — 통과로 적지 않는다(§13-3).
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve as resolvePath, join } from 'node:path';
import { compareClientCopies, parseDriftArgs, formatDriftReport, DRIFT_USAGE_KO } from '../src/ops/clientDrift.ts';

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.log(DRIFT_USAGE_KO);
  process.exitCode = argv.length === 0 ? 1 : 0;
} else {
  const args = parseDriftArgs(argv);
  const readDir = (dir) => {
    if (!dir) return undefined;
    const abs = resolvePath(process.cwd(), dir);
    if (!existsSync(abs) || !statSync(abs).isDirectory()) return undefined;
    return readdirSync(abs)
      .filter((n) => statSync(join(abs, n)).isFile())
      .map((n) => ({ relPath: n, content: readFileSync(join(abs, n), 'utf8') }));
  };
  const source = readDir(args.source) ?? [];
  const target = readDir(args.target);
  const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
  const report = compareClientCopies(source, target, { hash, files: args.files });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatDriftReport(report));
  process.exitCode = report.exitCode;
}
