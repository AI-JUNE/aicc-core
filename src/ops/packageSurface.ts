// 패키지 공개 표면 — 채널 저장소가 Core 를 **무엇으로** import 하는가를 고정한다.
//
// 왜 필요한가:
// 지금 채널 저장소(Callbot·챗봇·D-ARS)는 `<core>/src/channels/basePort.ts` 같은 **소스 상대경로**로
// Core 를 부른다. 이 방식은 파일을 옮기는 순간 저장소 3곳이 동시에 깨지고, 깨진 곳을 Core 의 CI 가
// 알 수 없다. 그래서 "채널이 부를 수 있는 경로"를 package.json 의 exports 맵에 명시하고,
// 그 맵이 실제 파일과 어긋나지 않는지를 이 모듈이 검사한다.
//
// 이 파일이 지키는 것 세 가지:
//  1) **채널 계약 경로는 이름으로 고정한다.** 와일드카드로 열면 채널이 아무 내부 모듈이나 부르게 되고,
//     그 순간 Core 리팩터링이 채널 3개를 인질로 잡는다.
//  2) **호스트용 경로는 내부(internal) 네임스페이스로만 연다.** 열되, 이름에 "내부"라고 적어 둔다 —
//     안정 계약이 아니라는 사실이 import 문에 보여야 한다.
//  3) **배포(publish)는 승인 사항이다.** `private: true` 를 푸는 변경은 승인 근거 없이는 통과시키지 않는다.
//
// 순수 함수다. 파일 존재 확인은 주입받는다(fs 를 직접 만지지 않는다 — §6.2 취지).

/** package.json 중 이 검사가 보는 부분만. 나머지 필드는 관심 밖이다. */
export interface PackageManifest {
  name?: unknown;
  type?: unknown;
  private?: unknown;
  exports?: unknown;
}

export type SurfaceIssueCode =
  | 'E_NO_EXPORTS'        // exports 맵 자체가 없음 — 소스 상대경로로만 소비 가능한 상태
  | 'E_SHAPE'             // exports 맵 형식이 문자열 매핑이 아님
  | 'E_MISSING_TARGET'    // 선언한 경로가 가리키는 파일이 없음
  | 'E_OUTSIDE'           // src·scripts 밖을 가리킴
  | 'E_REQUIRED_MISSING'  // 채널 계약 경로 누락
  | 'E_REQUIRED_TARGET'   // 채널 계약 경로가 다른 파일을 가리킴
  | 'E_UNDECLARED'        // 허용 목록에 없는 경로가 열려 있음
  | 'E_WILDCARD'          // 내부 네임스페이스 밖의 와일드카드
  | 'E_TYPE'              // ESM 선언 누락
  | 'E_PUBLISH_UNAPPROVED'; // 승인 없이 private 해제

export interface SurfaceIssue {
  code: SurfaceIssueCode;
  severity: 'error' | 'warning';
  subpath?: string;
  messageKo: string;
}

/**
 * 채널 저장소가 부르는 안정 계약 경로. 여기 있는 것만 "바꾸면 채널이 깨진다"고 취급한다.
 * 늘리기는 쉬워도 줄이기는 어렵다 — 새 경로를 추가할 때는 정말 채널이 필요한지 먼저 본다.
 */
export const CHANNEL_SUBPATHS: Readonly<Record<string, string>> = Object.freeze({
  './channels/contract': './src/channels/contract.ts',
  './channels/basePort': './src/channels/basePort.ts',
  './channels/conformance': './src/channels/conformance.ts',
  './channels/profiles': './src/channels/profiles.ts',
  './channels/runtime': './src/channels/runtime.ts',
  './flow/types': './src/flow/types.ts',
  './conformance-runner': './scripts/channel-conformance.mjs',
});

/** 호스트(관리 포털·배치)용. 안정 계약이 아니며 이름으로 그 사실을 알린다. */
export const INTERNAL_SUBPATH = './internal/*';
export const INTERNAL_TARGET = './src/*.ts';

/** package.json 이 정확히 이 집합을 열어야 한다. */
export function expectedExports(): Record<string, string> {
  return { ...CHANNEL_SUBPATHS, [INTERNAL_SUBPATH]: INTERNAL_TARGET };
}

export interface SurfaceOptions {
  /** 대상 파일 존재 확인. 저장소 루트 기준 상대경로('./src/x.ts')로 불린다. */
  fileExists: (relPath: string) => boolean;
  /** private 해제(=배포 의사)를 승인한 근거. 없으면 해제 자체가 결함이다 — [승인 필요] */
  publishApprovalRef?: string;
}

function isPlainStringMap(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string');
}

function insideRepo(target: string): boolean {
  return (target.startsWith('./src/') || target.startsWith('./scripts/')) && !target.includes('..');
}

/**
 * 검사. 던지지 않고 항목 단위로 돌려준다 — CI 출력에서 "무엇이 왜 틀렸는지"가 바로 보여야 한다.
 * 파일 존재는 와일드카드가 아닌 경로에 대해서만 본다(와일드카드는 대상이 하나가 아니다).
 */
export function validatePackageSurface(pkg: PackageManifest, opts: SurfaceOptions): SurfaceIssue[] {
  const issues: SurfaceIssue[] = [];

  if (pkg.type !== 'module') {
    issues.push({ code: 'E_TYPE', severity: 'error', messageKo: 'package.json 의 type 이 "module" 이어야 한다(Core 는 ESM 전용).' });
  }

  // private 해제는 곧 배포 의사다. 승인 근거 없이는 통과시키지 않는다.
  if (pkg.private !== true && opts.publishApprovalRef === undefined) {
    issues.push({
      code: 'E_PUBLISH_UNAPPROVED',
      severity: 'error',
      messageKo: 'private 이 해제되어 있으나 배포 승인 근거(publishApprovalRef)가 없다. 레지스트리 배포는 [승인 필요].',
    });
  }

  if (pkg.exports === undefined) {
    issues.push({
      code: 'E_NO_EXPORTS',
      severity: 'error',
      messageKo: 'exports 맵이 없다. 채널 저장소가 소스 상대경로로만 Core 를 부르게 되어, 파일을 옮기는 순간 저장소 3곳이 깨진다.',
    });
    return issues;
  }
  if (!isPlainStringMap(pkg.exports)) {
    issues.push({ code: 'E_SHAPE', severity: 'error', messageKo: 'exports 는 "경로 → 파일" 문자열 맵이어야 한다(조건부 exports 는 쓰지 않는다).' });
    return issues;
  }

  const map = pkg.exports;
  const allowed = expectedExports();

  for (const [subpath, target] of Object.entries(map)) {
    if (!insideRepo(target)) {
      issues.push({ code: 'E_OUTSIDE', severity: 'error', subpath, messageKo: `${subpath} 가 저장소 밖(${target})을 가리킨다.` });
      continue;
    }
    if (subpath.includes('*')) {
      if (subpath !== INTERNAL_SUBPATH || target !== INTERNAL_TARGET) {
        issues.push({
          code: 'E_WILDCARD',
          severity: 'error',
          subpath,
          messageKo: `와일드카드는 내부 네임스페이스(${INTERNAL_SUBPATH} → ${INTERNAL_TARGET})에만 허용된다. 채널 계약 경로를 와일드카드로 열면 내부 모듈까지 계약이 된다.`,
        });
      }
      continue; // 와일드카드는 대상이 하나가 아니므로 존재 확인 대상이 아니다.
    }
    if (!(subpath in allowed)) {
      issues.push({ code: 'E_UNDECLARED', severity: 'error', subpath, messageKo: `${subpath} 는 공개 표면 목록에 없다. 새 경로를 열려면 CHANNEL_SUBPATHS 에 먼저 등록한다.` });
      continue;
    }
    if (!opts.fileExists(target)) {
      issues.push({ code: 'E_MISSING_TARGET', severity: 'error', subpath, messageKo: `${subpath} 가 가리키는 ${target} 가 없다.` });
    }
  }

  for (const [subpath, target] of Object.entries(CHANNEL_SUBPATHS)) {
    if (!(subpath in map)) {
      issues.push({ code: 'E_REQUIRED_MISSING', severity: 'error', subpath, messageKo: `채널 계약 경로 ${subpath} 가 열려 있지 않다.` });
    } else if (map[subpath] !== target) {
      issues.push({ code: 'E_REQUIRED_TARGET', severity: 'error', subpath, messageKo: `${subpath} 는 ${target} 를 가리켜야 한다(현재 ${map[subpath]}).` });
    }
  }

  if (!(INTERNAL_SUBPATH in map)) {
    issues.push({
      code: 'E_REQUIRED_MISSING',
      severity: 'warning',
      subpath: INTERNAL_SUBPATH,
      messageKo: '호스트용 내부 경로가 닫혀 있다. 관리 포털·배치가 Core 를 소비할 방법이 없어진다.',
    });
  }

  return issues;
}

export function surfaceOk(issues: readonly SurfaceIssue[]): boolean {
  return !issues.some((i) => i.severity === 'error');
}

export function formatSurfaceReport(issues: readonly SurfaceIssue[]): string {
  if (issues.length === 0) return '패키지 공개 표면: 이상 없음';
  return issues
    .map((i) => `[${i.severity === 'error' ? '오류' : '경고'}] ${i.code}${i.subpath ? ` (${i.subpath})` : ''} — ${i.messageKo}`)
    .join('\n');
}
