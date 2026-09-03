// IA↔화면 매핑 문서 생성기. 문서는 손으로 적지 않는다 — src/portal/screenMap.ts 가 원본이다.
//
// 사용: node scripts/screen-map.mjs [--check]
//   (기본) PORTAL_SCREEN_MAP.md 를 갱신한다.
//   --check  파일이 생성 결과와 다르면 종료코드 1. CI 에서 "문서가 썩었는지"를 잡는다.
// 종료코드: 0=일치·갱신 완료, 1=매핑 검사 실패 또는 문서 불일치
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  PORTAL_SCREEN_MAP, validateScreenMap, screenMapOk, renderScreenMapMarkdown, formatScreenMapReport,
} from '../src/portal/screenMap.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'PORTAL_SCREEN_MAP.md');

const issues = validateScreenMap(PORTAL_SCREEN_MAP);
console.log(formatScreenMapReport(issues));
if (!screenMapOk(issues)) process.exit(1);

const md = renderScreenMapMarkdown(PORTAL_SCREEN_MAP);
if (process.argv.includes('--check')) {
  const cur = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  if (cur !== md) {
    console.error('PORTAL_SCREEN_MAP.md 가 매핑과 어긋난다. `node scripts/screen-map.mjs` 로 다시 생성할 것.');
    process.exit(1);
  }
  console.log('PORTAL_SCREEN_MAP.md 최신 상태');
} else {
  writeFileSync(OUT, md, 'utf8');
  console.log(`PORTAL_SCREEN_MAP.md 생성 완료 (${md.split('\n').length}줄)`);
}
