// 엔진 기동 계획 판정기 — 설계서 §6.2·§9.3·§10.3·§13-3.
//
// 왜 이 파일이 필요한가:
// `startEngines` 는 설정이 틀렸으면 기동 시점에 던진다. 그런데 **그 기동 시점은 첫 고객이
// 회선에 들어오는 배포 직후**다. 지금까지 그 전에 확인할 방법은 TypeScript 로 Core 를
// import 해서 직접 불러 보는 것뿐이었고, 그건 호스트·운영·CI 가 할 일이 아니다.
//
// 그리고 승인 게이트가 남겨 둔 빈 자리가 하나 더 있다: **"지금 무엇을 부르게 되어 있나"를
// 승인 전에 사람이 읽는 경로**다(`build now, activate on approval`). 활성화를 켜는 변경은
// 코드 한 글자(`dry_run` → `live`)이고, 그 한 글자는 리뷰에서 가장 눈에 띄지 않는 종류의
// 변경이면서 결과는 **실고객 발화가 외부 엔진으로 나가는 것**이다.
//
// 그래서 CI 한 줄로 줄인다. 이 파일은 판정만 하고(순수 함수) 모듈 로드·출력·종료코드는
// `scripts/engine-plan.mjs` 가 한다 — 적합성 실행기(`channels/harness.ts`)와 같은 분업이다.
//
// 고정하는 것:
//  - **활성화 기대값(`--expect-activation`)을 주지 않으면 판정보류(2)** 다. 건너뛴 검사는
//    통과의 근거가 아니다(§13-3) — 기대값이 없으면 실수로 `live` 가 된 선언이 "통과"로 적힌다.
//  - **모듈을 못 읽으면 판정보류**다. 통과로 적지 않는다(선언 파일 경로 오타가 초록으로 남는다).
//  - **선언이 성립하지 않으면 실패(1)** 다. 그 사유는 마스킹·자격증명 제거를 지난 문장만 싣는다.
//  - **설정 원문을 싣지 않는다.** 출력은 기동 결과에서 나온 사실(활성화·residency·슬롯 출처·
//    컴포넌트·승인 대기·한계)뿐이다. `resolveSecret` 이 돌려주는 값은 애초에 여기까지 오지 않고,
//    `apiKeyEnv` 같은 참조 이름도 로그에 올릴 이유가 없다.
//  - **한계(`limitsKo`)는 실패가 아니다.** 헬스 미배선·단조 시계 없음은 선언의 결함이 아니라
//    그 선언으로 돌렸을 때 확인되지 않는 범위다 — 숨기지 않고 적되 게이트를 막지는 않는다.
import type { Activation } from './http.ts';
import type { EngineRuntime } from './executeEngines.ts';
import type { ComponentId } from '../ops/fallback.ts';
import { maskPii } from '../core/policyGuard.ts';
import { shortenPaths, stripSecrets } from '../obs/errorMonitor.ts';

export const ENGINE_PLAN_CONTRACT_VERSION = 1;

export const ENGINE_PLAN_USAGE_KO = [
  '사용법: node scripts/engine-plan.mjs --declaration <모듈> --expect-activation <dry_run|live> [--json]',
  '',
  '  --declaration        엔진 기동 선언을 export 하는 ESM 모듈(default · declaration · engines 중 하나).',
  '                       함수를 export 하면 호출해서 선언을 받는다.',
  '  --expect-activation  CI 가 기대하는 활성화. 주지 않으면 판정보류(2) — 실수로 live 가 된 선언이',
  '                       통과로 적히지 않게 한다 [승인 필요].',
  '  --json               판정을 JSON 으로 출력.',
  '',
  '종료코드: 0 통과 · 1 실패(선언이 성립하지 않거나 활성화가 기대와 다름) · 2 판정보류(검사를 돌리지 못함).',
  '엔진을 부르지 않는다 — 계획만 확인한다.',
].join('\n');

export type PlanVerdict = 'pass' | 'fail' | 'indeterminate';

export interface EnginePlanArgs {
  declarationModule: string;
  /** 주지 않으면 판정보류다(위 주석). */
  expectActivation?: Activation;
  json: boolean;
  /** 인자 해석 중 발견한 문제. 하나라도 있으면 아무것도 돌리지 않는다. */
  issuesKo: string[];
}

export interface EnginePlanReport {
  contractVersion: number;
  verdict: PlanVerdict;
  exitCode: number;
  /** 기동에 성공했을 때만 채운다. 실패·판정보류면 **필드 자체가 없다**(§13-3). */
  activation?: Activation;
  residency?: EngineRuntime['residency'];
  candidates?: string[];
  /** `stt=whisper@audio(onprem)` 형태. 설정과 실제가 어긋나면 여기서 보인다. */
  slots?: string[];
  components?: EngineRuntime['components'];
  approvalPending?: EngineRuntime['approvalPending'];
  /**
   * 복구 프로브를 **선언했을 때만** 채운다(§9.3). 빈 배열은 "선언했는데 하나도 만들어지지
   * 않았다"이고 필드 부재는 "선언하지 않았다"다 — 둘을 같게 적으면 승인 전 테넌트의
   * "확인할 길이 없음"이 "확인 안 하기로 했음"과 구분되지 않는다.
   */
  probes?: ComponentId[];
  /** 만들어지지 않은 컴포넌트와 사유(`stt: not_activated` 형태). */
  probeSkipped?: string[];
  /** 그 선언으로 확인되지 않는 범위. 실패가 아니다. */
  limitsKo: string[];
  /** 판정 사유. 이미 마스킹·자격증명 제거를 지났다(§10.3). */
  reasonsKo: string[];
}

/**
 * 예외·오류 원문을 CI 로그에 올려도 되는 형태로 바꾼다(§10.3).
 * 개인정보 · 자격증명 · 배포 디렉터리 구조를 지운다 — 모듈 로드 실패 메시지에는 실행 경로가
 * 통째로 실려 나온다. 세 규칙 모두 **다른 곳에 있는 것을 그대로 쓴다**(§2) — 여기서 다시 적으면
 * 한쪽만 고쳐지고, 고쳐지지 않은 쪽이 곧 유출이다.
 */
export function safePlanReason(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return maskPii(stripSecrets(shortenPaths(raw))).text;
}

/**
 * argv 해석. 값 없는 플래그·모르는 활성화 값을 **조용히 기본값으로 바꾸지 않는다** —
 * 바꾸면 "돌렸는데 아무것도 검사하지 않은" CI 가 초록으로 뜬다.
 */
export function parseEnginePlanArgs(argv: readonly string[]): EnginePlanArgs {
  const issuesKo: string[] = [];
  const args: EnginePlanArgs = { declarationModule: '', json: false, issuesKo };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--declaration':
        if (value === undefined || value.startsWith('--')) issuesKo.push('--declaration 값이 없습니다');
        else { args.declarationModule = value; i += 1; }
        break;
      case '--expect-activation':
        if (value === 'dry_run' || value === 'live') { args.expectActivation = value; i += 1; }
        else issuesKo.push(`--expect-activation 값이 dry_run·live 가 아닙니다: ${JSON.stringify(value ?? null)}`);
        break;
      case '--json':
        args.json = true;
        break;
      default:
        issuesKo.push(`알 수 없는 인자: ${JSON.stringify(flag ?? null)}`);
    }
  }
  if (args.declarationModule === '') issuesKo.push('--declaration 이 없습니다 — 무엇을 확인할지 지정해야 합니다');
  return args;
}

export interface JudgeEnginePlanInput {
  args: EnginePlanArgs;
  /** 기동에 성공했을 때만 넘긴다. */
  runtime?: EngineRuntime;
  /** 모듈 로드·선언 조회 실패. 이 경우는 **판정보류**다(검사를 못 돌렸다). */
  loadErrorKo?: string;
  /** 기동 거절(설정 오류). 이 경우는 **실패**다(선언이 성립하지 않는다). */
  startErrorKo?: string;
}

/** 판정. 던지지 않는다 — CI 게이트가 예외로 죽으면 그 게이트는 없는 것과 같다. */
export function judgeEnginePlan(input: JudgeEnginePlanInput): EnginePlanReport {
  const base = { contractVersion: ENGINE_PLAN_CONTRACT_VERSION, limitsKo: [] as string[] };
  const hold = (reasonsKo: string[]): EnginePlanReport =>
    ({ ...base, verdict: 'indeterminate', exitCode: 2, reasonsKo });

  if (input.args.issuesKo.length > 0) return hold(input.args.issuesKo.map((x) => safePlanReason(x)));
  if (input.loadErrorKo !== undefined) {
    return hold([`선언 모듈을 읽지 못했습니다: ${input.loadErrorKo}`, '검사를 돌리지 못한 것은 통과가 아닙니다(§13-3)']);
  }
  if (input.startErrorKo !== undefined) {
    return {
      ...base,
      verdict: 'fail',
      exitCode: 1,
      reasonsKo: [`엔진 기동 선언이 성립하지 않습니다: ${input.startErrorKo}`],
    };
  }
  const rt = input.runtime;
  if (rt === undefined) {
    return hold(['기동 결과가 없습니다 — 실행기가 선언을 넘기지 않았습니다']);
  }

  const facts = {
    activation: rt.activation,
    residency: rt.residency,
    candidates: [...rt.candidates],
    slots: rt.origins.map((o) => maskPii(`${o.slot}=${o.engineName}@${o.source}(${o.residency})`).text),
    components: [...rt.components],
    approvalPending: [...rt.approvalPending],
    // 복구 프로브는 **선언하지 않은 것과 0건 만들어진 것이 다르다**. 미선언이면 필드 자체가 없고
    // (빈 배열은 "확인하고 있다"로 읽힌다), 선언했는데 0건이면 그 사유가 `probeSkipped` 에 있다.
    ...(rt.probes === undefined ? {} : {
      probes: rt.probes.probes.map((p) => p.component),
      probeSkipped: rt.probes.skipped.map((s) => `${s.component}: ${s.reason}`),
    }),
    limitsKo: [...rt.limitsKo],
  };

  if (input.args.expectActivation === undefined) {
    // 활성화는 승인 사항이다. 기대값 없이 통과시키면 `live` 로 바뀐 선언이 초록으로 지나간다.
    return {
      ...facts,
      contractVersion: ENGINE_PLAN_CONTRACT_VERSION,
      verdict: 'indeterminate',
      exitCode: 2,
      reasonsKo: [
        '--expect-activation 을 주지 않아 활성화를 검사하지 않았습니다 — 건너뛴 검사는 통과의 근거가 아닙니다(§13-3)',
        `선언된 활성화는 ${rt.activation} 입니다 [승인 필요]`,
      ],
    };
  }
  if (rt.activation !== input.args.expectActivation) {
    return {
      ...facts,
      contractVersion: ENGINE_PLAN_CONTRACT_VERSION,
      verdict: 'fail',
      exitCode: 1,
      reasonsKo: [
        `활성화가 기대와 다릅니다: 선언 ${rt.activation} ≠ 기대 ${input.args.expectActivation}`
        + ' — live 전환은 승인 근거가 있어야 합니다 [승인 필요]',
      ],
    };
  }
  return {
    ...facts,
    contractVersion: ENGINE_PLAN_CONTRACT_VERSION,
    verdict: 'pass',
    exitCode: 0,
    reasonsKo: [`${rt.candidates.length}개 후보 · ${rt.components.length}개 컴포넌트 · 활성화 ${rt.activation}`],
  };
}

/** 사람이 읽을 출력. 지어낸 수치·진행률을 만들지 않고 사실과 건수만 적는다(§13-3). */
export function formatEnginePlan(r: EnginePlanReport): string {
  const head = r.verdict === 'pass' ? '엔진 기동 계획: 통과'
    : r.verdict === 'fail' ? '엔진 기동 계획: 실패'
      : '엔진 기동 계획: 판정보류';
  const lines = [head];
  if (r.activation !== undefined) {
    lines.push(`활성화 ${r.activation}${r.activation === 'live' ? '' : '(실호출 없음)'} · residency ${r.residency ?? '미상'}`);
    lines.push(`후보 ${(r.candidates ?? []).join('>')}`);
    for (const s of r.slots ?? []) lines.push(`  ${s}`);
    lines.push(`§9.3 컴포넌트: ${(r.components ?? []).join(', ') || '없음'}`);
    if ((r.approvalPending ?? []).length > 0) {
      lines.push(`승인 전(샘플을 읽지 않음): ${(r.approvalPending ?? []).join(', ')} [승인 필요]`);
    }
    if (r.probes !== undefined) {
      // 0건을 "없음"으로만 적지 않는다 — 사유가 같이 나와야 운영이 무엇을 고칠지 안다.
      lines.push(`복구 프로브: ${r.probes.join(', ') || '0건'}`);
      for (const s of r.probeSkipped ?? []) lines.push(`  미생성 ${s}`);
    }
  }
  for (const x of r.reasonsKo) lines.push(`- ${x}`);
  for (const x of r.limitsKo) lines.push(`(한계) ${x}`);
  return lines.join('\n');
}
