// 패키지 공개 표면 — 채널 저장소가 부르는 경로가 실제 파일과 어긋나지 않는지 본다.
//
// 이 테스트가 없으면, 파일을 옮기고도 Core CI 는 초록으로 남고 저장소 3곳이 배포 때 깨진다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CHANNEL_SUBPATHS, INTERNAL_SUBPATH, INTERNAL_TARGET, expectedExports,
  validatePackageSurface, surfaceOk, formatSurfaceReport,
} from '../src/ops/packageSurface.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const fileExists = (rel) => existsSync(join(ROOT, rel));
const codes = (issues) => issues.map((i) => i.code).sort();

// ── 실제 저장소 ──────────────────────────────────────────────────────────────

test('실제 package.json 이 공개 표면 규약을 지킨다', () => {
  const issues = validatePackageSurface(pkg, { fileExists });
  assert.equal(surfaceOk(issues), true, formatSurfaceReport(issues));
});

test('선언한 채널 계약 경로의 대상 파일이 모두 실재한다', () => {
  const missing = Object.entries(CHANNEL_SUBPATHS).filter(([, t]) => !fileExists(t)).map(([s]) => s);
  assert.deepEqual(missing, [], `대상 파일이 없는 경로: ${missing.join(', ')}`);
});

test('package.json 이 정확히 기대 집합만 연다', () => {
  assert.deepEqual(pkg.exports, expectedExports());
});

test('배포는 승인 사항이므로 private 이 켜져 있다', () => {
  assert.equal(pkg.private, true);
});

// ── 실패 경로 ────────────────────────────────────────────────────────────────

const base = { name: 'aicc-core', type: 'module', private: true };
const allTrue = { fileExists: () => true };

test('exports 가 없으면 결함이다 — 소스 상대경로 소비는 계약이 아니다', () => {
  const issues = validatePackageSurface({ ...base }, allTrue);
  assert.deepEqual(codes(issues), ['E_NO_EXPORTS']);
  assert.equal(surfaceOk(issues), false);
});

test('조건부 exports(중첩 객체)는 형식 위반으로 잡는다', () => {
  const issues = validatePackageSurface({ ...base, exports: { './x': { import: './src/x.ts' } } }, allTrue);
  assert.deepEqual(codes(issues), ['E_SHAPE']);
});

test('대상 파일이 없으면 잡는다', () => {
  const issues = validatePackageSurface(
    { ...base, exports: expectedExports() },
    { fileExists: (p) => p !== './src/channels/basePort.ts' },
  );
  assert.deepEqual(codes(issues), ['E_MISSING_TARGET']);
  assert.equal(issues[0].subpath, './channels/basePort');
});

test('채널 계약 경로가 빠지면 잡는다', () => {
  const exp = expectedExports();
  delete exp['./channels/runtime'];
  const issues = validatePackageSurface({ ...base, exports: exp }, allTrue);
  assert.deepEqual(codes(issues), ['E_REQUIRED_MISSING']);
  assert.equal(issues[0].subpath, './channels/runtime');
});

test('채널 계약 경로가 다른 파일을 가리키면 잡는다', () => {
  const exp = { ...expectedExports(), './channels/runtime': './src/channels/contract.ts' };
  const issues = validatePackageSurface({ ...base, exports: exp }, allTrue);
  assert.deepEqual(codes(issues), ['E_REQUIRED_TARGET']);
});

test('허용 목록에 없는 경로를 열면 잡는다', () => {
  const exp = { ...expectedExports(), './core/session': './src/core/session.ts' };
  const issues = validatePackageSurface({ ...base, exports: exp }, allTrue);
  assert.deepEqual(codes(issues), ['E_UNDECLARED']);
});

test('내부 네임스페이스 밖의 와일드카드는 막는다', () => {
  const exp = { ...expectedExports(), './channels/*': './src/channels/*.ts' };
  const issues = validatePackageSurface({ ...base, exports: exp }, allTrue);
  assert.deepEqual(codes(issues), ['E_WILDCARD']);
});

test('내부 와일드카드가 다른 대상을 가리켜도 막는다', () => {
  const exp = { ...expectedExports(), [INTERNAL_SUBPATH]: './scripts/*.mjs' };
  const issues = validatePackageSurface({ ...base, exports: exp }, allTrue);
  assert.deepEqual(codes(issues), ['E_WILDCARD']);
});

test('저장소 밖·상위 경로 탈출을 막는다', () => {
  const exp = { ...expectedExports(), './internal/*': '../other/*.ts' };
  const issues = validatePackageSurface({ ...base, exports: exp }, allTrue);
  assert.deepEqual(codes(issues), ['E_OUTSIDE']);
});

test('ESM 선언이 빠지면 잡는다', () => {
  const issues = validatePackageSurface({ ...base, type: 'commonjs', exports: expectedExports() }, allTrue);
  assert.deepEqual(codes(issues), ['E_TYPE']);
});

test('승인 근거 없이 private 을 풀면 막는다', () => {
  const issues = validatePackageSurface({ ...base, private: false, exports: expectedExports() }, allTrue);
  assert.deepEqual(codes(issues), ['E_PUBLISH_UNAPPROVED']);
});

test('승인 근거가 있으면 private 해제를 통과시킨다', () => {
  const issues = validatePackageSurface(
    { ...base, private: false, exports: expectedExports() },
    { fileExists: () => true, publishApprovalRef: 'APPROVAL-2026-09-03' },
  );
  assert.deepEqual(issues, []);
});

test('호스트용 내부 경로가 닫히면 경고하되 오류로는 세지 않는다', () => {
  const exp = { ...CHANNEL_SUBPATHS };
  const issues = validatePackageSurface({ ...base, exports: exp }, allTrue);
  assert.deepEqual(codes(issues), ['E_REQUIRED_MISSING']);
  assert.equal(issues[0].severity, 'warning');
  assert.equal(surfaceOk(issues), true);
});

test('빈 exports 객체도 형식은 통과하되 필수 누락으로 잡힌다', () => {
  const issues = validatePackageSurface({ ...base, exports: {} }, allTrue);
  assert.equal(issues.filter((i) => i.code === 'E_REQUIRED_MISSING' && i.severity === 'error').length,
    Object.keys(CHANNEL_SUBPATHS).length);
  assert.equal(surfaceOk(issues), false);
});

test('보고서는 사람이 읽을 수 있는 한 줄씩을 낸다', () => {
  assert.equal(formatSurfaceReport([]), '패키지 공개 표면: 이상 없음');
  const text = formatSurfaceReport(validatePackageSurface({ ...base, exports: {} }, allTrue));
  assert.match(text, /\[오류\] E_REQUIRED_MISSING/);
});

test('와일드카드 대상은 존재 확인 대상이 아니다 — 대상이 하나가 아니기 때문', () => {
  const issues = validatePackageSurface(
    { ...base, exports: expectedExports() },
    { fileExists: (p) => p !== INTERNAL_TARGET },
  );
  assert.deepEqual(issues, []);
});
