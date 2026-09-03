// 채널 적합성 실행 하네스 — 설계서 §1.2(Core 단일화)·§5.3(단일 시나리오)·§9.3(장애 폴백)·
// §10.3(마스킹)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// conformance.ts 는 검사기를 준다. 그런데 그것만으로는 채널 저장소 3곳이 실제로 돌리지 않는다 —
// 검사기를 부르려면 Core 를 TypeScript 로 import 하고, 포트를 만들고, 리포트를 해석하고,
// 종료코드를 정하는 네 가지를 각 저장소가 알아서 해야 하기 때문이다. 세 저장소는 스택이 다르고
// (Next.js·Node 스크립트·정적 IVR 도구), 그래서 "나중에 붙이겠다"로 남는다. 그 사이 계약 위반은
// 운영에서 처음 드러난다.
//
// 그래서 소비 지점을 **모듈 경로 하나**로 줄인다. 채널 저장소는 자기 포트를 export 하는 모듈을
// 하나 만들고 CI에서 `node scripts/channel-conformance.mjs --port <경로>` 를 돌리면 끝이다.
// 이 파일은 그 실행기의 순수 로직(설정 해석·모듈에서 포트 꺼내기·판정·출력)을 담는다.
// 파일 읽기·동적 import·프로세스 종료 같은 부작용은 scripts/channel-conformance.mjs 가 맡는다.
//
// 무엇을 하지 않는가 (build now, activate on approval):
//  - 실회선·실메신저에 붙지 않는다. 포트가 드라이런인지 확인하고, live 로 보이면 판정보류로 멈춘다.
//  - 임계값·예산 기본값을 만들어 넣지 않는다(§13-3). timeoutMs 는 준 경우에만 검사한다.
import type { Flow } from '../flow/types.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { ChannelAdapterId, ChannelPort, ChannelRegistration } from './contract.ts';
import { ADAPTER_CHANNEL } from './contract.ts';
import type { ConformanceReport } from './conformance.ts';
import { runChannelConformance } from './conformance.ts';

/** 실행기 종료 판정. 복구 리허설(scripts/recovery-drill.mjs)과 같은 3종 체계를 쓴다. */
export type HarnessVerdict = 'passed' | 'inconclusive' | 'failed';

/** 종료코드 매핑. CI 가 그대로 게이트로 쓴다 — 판정보류를 통과로 넘기지 않는다. */
export const HARNESS_EXIT_CODE: Record<HarnessVerdict, number> = {
  passed: 0,
  failed: 1,
  inconclusive: 2,
};

export interface HarnessConfig {
  /** 포트를 export 하는 모듈 경로. 필수. */
  portModule: string;
  /** 모듈에서 꺼낼 export 이름. 미지정 시 default → port → createPort() 순으로 찾는다. */
  exportName?: string;
  /** 이 채널에서 실제로 돌릴 Flow 배열을 export 하는 모듈 경로(default 또는 flows). */
  flowsModule?: string;
  /** 검사할 채널. 미지정 시 포트의 id 를 믿는다. 주면 어긋날 때 실패로 잡는다. */
  adapter?: ChannelAdapterId;
  /** 호출 하나가 정착해야 하는 예산(ms). 미지정 시 예산 검사를 건너뛴다(§13-3). */
  timeoutMs?: number;
  /** 사람이 읽는 요약 대신 기계용 JSON 을 낸다. */
  json: boolean;
  /** 경고도 실패로 본다. 채널 저장소가 스스로 조일 때 쓴다. */
  strictWarnings: boolean;
  /** 인자 해석 중 발견한 문제. 하나라도 있으면 검사를 돌리지 않는다. */
  issuesKo: string[];
}

export interface HarnessResult {
  verdict: HarnessVerdict;
  exitCode: number;
  /** 검사를 돌린 경우에만 있다. 설정 오류·로드 실패면 없다. */
  report?: ConformanceReport;
  /** 판정 이유. 이미 마스킹을 거쳤다(§10.3). */
  reasonsKo: string[];
  /** 포트가 드라이런임을 스스로 밝혔는가. 밝히지 않으면 판정보류다. */
  dryRunDeclared: boolean;
}

const KNOWN_ADAPTERS: readonly ChannelAdapterId[] = ['callbot', 'chatbot', 'dars'];

function isAdapterId(v: unknown): v is ChannelAdapterId {
  return typeof v === 'string' && (KNOWN_ADAPTERS as readonly string[]).includes(v);
}

/**
 * argv 해석. 빈 입력·값 없는 플래그·음수 예산을 전부 issuesKo 로 모은다 —
 * 잘못된 인자를 조용히 기본값으로 바꾸면 "돌렸는데 아무것도 검사하지 않은" CI 가 초록으로 뜬다.
 */
export function parseHarnessArgs(argv: readonly string[]): HarnessConfig {
  const issuesKo: string[] = [];
  const cfg: HarnessConfig = { portModule: '', json: false, strictWarnings: false, issuesKo };

  const valueOf = (i: number, name: string): string | undefined => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) {
      issuesKo.push(`--${name} 에 값이 없습니다.`);
      return undefined;
    }
    return v;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--port': {
        const v = valueOf(i, 'port');
        if (v !== undefined) { cfg.portModule = v; i += 1; }
        break;
      }
      case '--export': {
        const v = valueOf(i, 'export');
        if (v !== undefined) { cfg.exportName = v; i += 1; }
        break;
      }
      case '--flows': {
        const v = valueOf(i, 'flows');
        if (v !== undefined) { cfg.flowsModule = v; i += 1; }
        break;
      }
      case '--adapter': {
        const v = valueOf(i, 'adapter');
        if (v !== undefined) {
          if (isAdapterId(v)) cfg.adapter = v;
          else issuesKo.push(`--adapter 값이 올바르지 않습니다: 허용값은 ${KNOWN_ADAPTERS.join('·')} 입니다.`);
          i += 1;
        }
        break;
      }
      case '--timeout-ms': {
        const v = valueOf(i, 'timeout-ms');
        if (v !== undefined) {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) cfg.timeoutMs = n;
          else issuesKo.push('--timeout-ms 는 0보다 큰 수여야 합니다.');
          i += 1;
        }
        break;
      }
      case '--json': cfg.json = true; break;
      case '--strict-warnings': cfg.strictWarnings = true; break;
      default:
        if (a.startsWith('--')) issuesKo.push(`알 수 없는 옵션입니다: ${a}`);
        break;
    }
  }

  if (cfg.portModule === '') issuesKo.push('--port <모듈경로> 가 필요합니다. 채널 포트를 export 하는 모듈을 지정하세요.');
  return cfg;
}

export interface PortResolution {
  port?: ChannelPort;
  /** 어디서 꺼냈는지. 실패 원인을 좁히는 데 쓴다. */
  fromKo?: string;
  errorKo?: string;
}

function looksLikePort(v: unknown): v is ChannelPort {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.present === 'function' && typeof o.transfer === 'function' && typeof o.end === 'function';
}

/**
 * 모듈 객체에서 포트를 꺼낸다. 저장소마다 export 관습이 다르므로 세 가지를 받아준다:
 * 지정한 이름 → default → port → createPort()/createChannelPort() 팩토리.
 * 팩토리는 인자 없이 부를 수 있을 때만 쓴다 — 인자를 요구하면 그 저장소가 전용 진입 모듈을 만들어야 한다.
 */
export function resolvePortFromModule(mod: unknown, exportName?: string): PortResolution {
  if (typeof mod !== 'object' || mod === null) {
    return { errorKo: '모듈이 객체가 아닙니다. ESM 모듈을 지정했는지 확인하세요.' };
  }
  const m = mod as Record<string, unknown>;

  if (exportName !== undefined) {
    const picked = m[exportName];
    if (picked === undefined) return { errorKo: `모듈에 '${exportName}' export 가 없습니다.` };
    if (looksLikePort(picked)) return { port: picked, fromKo: `export ${exportName}` };
    if (typeof picked === 'function') {
      const made = tryFactory(picked as (...a: unknown[]) => unknown);
      if (made.port) return { port: made.port, fromKo: `export ${exportName}()` };
      return { errorKo: made.errorKo ?? `'${exportName}' 팩토리가 포트를 돌려주지 않았습니다.` };
    }
    return { errorKo: `'${exportName}' 가 ChannelPort 형태가 아닙니다(present·transfer·end 필요).` };
  }

  for (const key of ['default', 'port', 'channelPort']) {
    const v = m[key];
    if (looksLikePort(v)) return { port: v, fromKo: `export ${key}` };
  }
  for (const key of ['createPort', 'createChannelPort', 'default']) {
    const v = m[key];
    if (typeof v === 'function' && (v as { length: number }).length === 0) {
      const made = tryFactory(v as () => unknown);
      if (made.port) return { port: made.port, fromKo: `export ${key}()` };
    }
  }
  return {
    errorKo: '모듈에서 ChannelPort 를 찾지 못했습니다. default·port 로 내보내거나 --export 로 이름을 지정하세요.',
  };
}

function tryFactory(fn: (...a: unknown[]) => unknown): { port?: ChannelPort; errorKo?: string } {
  try {
    const made = fn();
    if (looksLikePort(made)) return { port: made };
    return { errorKo: '팩토리 반환값이 ChannelPort 형태가 아닙니다.' };
  } catch (e) {
    // 팩토리가 실키·설정을 요구해 던지는 경우다. 원문을 그대로 흘리지 않는다(§10.3).
    return { errorKo: `팩토리 호출이 실패했습니다: ${maskPii(e instanceof Error ? e.message : String(e)).text}` };
  }
}

export interface FlowsResolution {
  flows?: Flow[];
  errorKo?: string;
}

function looksLikeFlow(v: unknown): v is Flow {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.id === 'string' && typeof f.startNodeId === 'string'
    && typeof f.nodes === 'object' && f.nodes !== null;
}

/** 시나리오 모듈에서 Flow 배열을 꺼낸다. 빈 배열은 "검사할 것이 없다"이므로 오류로 잡는다. */
export function resolveFlowsFromModule(mod: unknown): FlowsResolution {
  if (typeof mod !== 'object' || mod === null) return { errorKo: '시나리오 모듈이 객체가 아닙니다.' };
  const m = mod as Record<string, unknown>;
  const candidate = [m.flows, m.default].find((v) => Array.isArray(v));
  if (candidate === undefined) {
    return { errorKo: '시나리오 모듈이 Flow 배열을 내보내지 않습니다(flows 또는 default).' };
  }
  const arr = candidate as unknown[];
  if (arr.length === 0) return { errorKo: '시나리오 배열이 비어 있습니다. 검사할 것이 없으면 --flows 를 빼세요.' };
  const bad = arr.findIndex((f) => !looksLikeFlow(f));
  if (bad !== -1) return { errorKo: `시나리오 ${bad}번이 Flow 형태가 아닙니다(id·startNodeId·nodes 필요).` };
  return { flows: arr as Flow[] };
}

export interface RunHarnessOptions {
  config: HarnessConfig;
  /** 모듈 로더 주입. 실제 CLI 는 dynamic import 를, 테스트는 가짜 모듈을 준다. */
  load: (specifier: string) => Promise<unknown>;
  /** 이 채널에서 실제로 돌릴 시나리오. 주면 §5.3 렌더 가능 여부까지 본다. */
  flows?: Flow[];
  reportsComponents?: ChannelRegistration['reportsComponents'];
}

/**
 * 하네스 본체. 예외를 던지지 않는다 — CI 스크립트가 스택트레이스로 죽으면
 * 무엇이 왜 막혔는지 남지 않고, 그 스택에 경로·설정값이 섞여 나온다(§10.3).
 */
export async function runHarness(opts: RunHarnessOptions): Promise<HarnessResult> {
  const { config } = opts;
  if (config.issuesKo.length > 0) {
    return { verdict: 'failed', exitCode: HARNESS_EXIT_CODE.failed, reasonsKo: config.issuesKo.slice(), dryRunDeclared: false };
  }

  let mod: unknown;
  try {
    mod = await opts.load(config.portModule);
  } catch (e) {
    const why = maskPii(e instanceof Error ? e.message : String(e)).text;
    return {
      verdict: 'failed',
      exitCode: HARNESS_EXIT_CODE.failed,
      reasonsKo: [`포트 모듈을 불러오지 못했습니다: ${why}`],
      dryRunDeclared: false,
    };
  }

  const resolved = resolvePortFromModule(mod, config.exportName);
  if (!resolved.port) {
    return {
      verdict: 'failed',
      exitCode: HARNESS_EXIT_CODE.failed,
      reasonsKo: [resolved.errorKo ?? '포트를 찾지 못했습니다.'],
      dryRunDeclared: false,
    };
  }
  const port = resolved.port;

  const reasonsKo: string[] = [];
  if (config.adapter !== undefined && port.id !== config.adapter) {
    return {
      verdict: 'failed',
      exitCode: HARNESS_EXIT_CODE.failed,
      reasonsKo: [`--adapter 로 ${config.adapter} 를 지정했지만 모듈이 내놓은 포트는 ${String(port.id)} 입니다.`],
      dryRunDeclared: false,
    };
  }

  // 드라이런 선언 확인. 이 하네스는 실회선을 건드리지 않는다는 전제로만 안전하다.
  // 선언이 없으면 "안 건드린다"를 확인할 방법이 없으므로 통과로 적지 않는다 — 판정보류다.
  const activation = (port as unknown as Record<string, unknown>).activation;
  const dryRunFlag = (port as unknown as Record<string, unknown>).dryRun;
  const dryRunDeclared = dryRunFlag === true || activation === 'dry_run';
  if (!dryRunDeclared) {
    reasonsKo.push(
      activation === 'live'
        ? '포트가 live 로 선언되어 있습니다. 적합성 검사는 실회선·실메신저로 나가면 안 됩니다 — 드라이런 포트로 돌리세요 [승인 필요].'
        : '포트가 드라이런임을 밝히지 않았습니다(dryRun===true 또는 activation==="dry_run"). 실전송 여부를 확인할 수 없어 통과로 적지 않습니다.',
    );
  }

  // 시나리오는 선택이지만, 주면 §5.3 렌더 가능 여부까지 본다. 로드 실패를 조용히 건너뛰면
  // "시나리오 검사를 했다"는 착각이 남으므로 실패로 잡는다.
  let flows = opts.flows;
  if (flows === undefined && config.flowsModule !== undefined) {
    let flowsMod: unknown;
    try {
      flowsMod = await opts.load(config.flowsModule);
    } catch (e) {
      const why = maskPii(e instanceof Error ? e.message : String(e)).text;
      return {
        verdict: 'failed', exitCode: HARNESS_EXIT_CODE.failed, dryRunDeclared,
        reasonsKo: [...reasonsKo, `시나리오 모듈을 불러오지 못했습니다: ${why}`],
      };
    }
    const picked = resolveFlowsFromModule(flowsMod);
    if (!picked.flows) {
      return {
        verdict: 'failed', exitCode: HARNESS_EXIT_CODE.failed, dryRunDeclared,
        reasonsKo: [...reasonsKo, picked.errorKo ?? '시나리오를 찾지 못했습니다.'],
      };
    }
    flows = picked.flows;
  }

  let report: ConformanceReport;
  try {
    report = await runChannelConformance({
      port,
      timeoutMs: config.timeoutMs,
      flows,
      reportsComponents: opts.reportsComponents,
    });
  } catch (e) {
    const why = maskPii(e instanceof Error ? e.message : String(e)).text;
    return {
      verdict: 'failed',
      exitCode: HARNESS_EXIT_CODE.failed,
      reasonsKo: [...reasonsKo, `적합성 검사 실행 중 오류: ${why}`],
      dryRunDeclared,
    };
  }

  const channelOfId = ADAPTER_CHANNEL[port.id];
  if (channelOfId !== undefined && report.channel !== channelOfId) {
    reasonsKo.push(`포트 id(${port.id})와 채널(${String(report.channel)})이 어긋납니다.`);
  }

  // 건너뛴 항목은 통과의 근거가 아니다. 예산·시나리오를 주지 않으면 "돌렸다"는 사실만 남고
  // 정작 운영에서 터지는 두 축(무응답·렌더 불가)은 확인되지 않는다. 그래서 통과로 적지 않고
  // 판정보류로 돌린다 — 채널 저장소가 --timeout-ms 와 --flows 를 채우게 만드는 것이 목적이다(§13-3).
  const skipped = report.checks.filter((c) => c.skipped === true);
  if (skipped.length > 0) {
    reasonsKo.push(`검사하지 않은 항목 ${skipped.length}건: ${skipped.map((c) => c.id).join('·')}`);
  }

  const failingWarnings = report.warningCount > 0;
  let verdict: HarnessVerdict;
  if (report.errorCount > 0) verdict = 'failed';
  else if (config.strictWarnings && failingWarnings) verdict = 'failed';
  else if (reasonsKo.length > 0) verdict = 'inconclusive';
  else verdict = 'passed';

  if (verdict === 'failed' && report.errorCount > 0) {
    reasonsKo.push(`오류 심각도 검사 ${report.errorCount}건이 실패했습니다.`);
  }
  if (verdict === 'failed' && config.strictWarnings && failingWarnings) {
    reasonsKo.push(`--strict-warnings 로 경고 ${report.warningCount}건을 실패로 봅니다.`);
  }

  return { verdict, exitCode: HARNESS_EXIT_CODE[verdict], report, reasonsKo, dryRunDeclared };
}

/** 사람이 읽는 CI 로그. 마스킹된 값만 담긴다(§10.3). */
export function formatHarnessResult(r: HarnessResult, cfg: HarnessConfig): string {
  const verdictKo = r.verdict === 'passed' ? '통과' : r.verdict === 'inconclusive' ? '판정보류' : '실패';
  const head = r.report
    ? `[${r.report.adapter}/${r.report.channel}] 채널 계약 v${r.report.contractVersion} 하네스: ${verdictKo} (오류 ${r.report.errorCount} · 경고 ${r.report.warningCount})`
    : `채널 계약 하네스: ${verdictKo}`;
  const lines: string[] = [head];
  lines.push(`  모듈: ${cfg.portModule || '(미지정)'}${cfg.exportName ? ` · export ${cfg.exportName}` : ''}`);
  lines.push(`  드라이런 선언: ${r.dryRunDeclared ? '있음' : '없음'}`);
  if (cfg.flowsModule !== undefined) lines.push(`  시나리오: ${cfg.flowsModule}`);
  if (cfg.timeoutMs !== undefined) lines.push(`  응답 예산: ${cfg.timeoutMs}ms`);
  if (r.report) {
    for (const c of r.report.checks) {
      if (c.passed && c.skipped !== true) continue;
      const tag = c.skipped ? '[건너뜀]' : c.severity === 'error' ? '[오류]' : '[경고]';
      lines.push(`  - ${c.id} ${tag} ${c.messageKo}`);
    }
  }
  for (const why of r.reasonsKo) lines.push(`  ! ${why}`);
  return lines.join('\n');
}

/** 기계용 출력. 채널 저장소가 자기 대시보드에 붙일 때 쓴다. 판단 점수는 만들지 않는다(§13-3). */
export function harnessResultToJson(r: HarnessResult, cfg: HarnessConfig): string {
  return JSON.stringify({
    verdict: r.verdict,
    exitCode: r.exitCode,
    portModule: cfg.portModule,
    exportName: cfg.exportName ?? null,
    flowsModule: cfg.flowsModule ?? null,
    dryRunDeclared: r.dryRunDeclared,
    timeoutMs: cfg.timeoutMs ?? null,
    strictWarnings: cfg.strictWarnings,
    adapter: r.report?.adapter ?? null,
    channel: r.report?.channel ?? null,
    contractVersion: r.report?.contractVersion ?? null,
    errorCount: r.report?.errorCount ?? null,
    warningCount: r.report?.warningCount ?? null,
    checks: r.report?.checks.map((c) => ({
      id: c.id, passed: c.passed, severity: c.severity, skipped: c.skipped === true, messageKo: c.messageKo,
    })) ?? [],
    reasonsKo: r.reasonsKo,
  }, null, 2);
}

/** CLI 사용법. 인자 오류 시 그대로 낸다. */
export const HARNESS_USAGE_KO = [
  '사용: node scripts/channel-conformance.mjs --port <모듈경로> [옵션]',
  '',
  '  --port <경로>        ChannelPort 를 export 하는 ESM 모듈. 필수.',
  '  --export <이름>      모듈에서 꺼낼 export 이름. 미지정 시 default·port·createPort() 순으로 찾습니다.',
  '  --flows <경로>       이 채널에서 돌릴 Flow 배열 모듈(flows 또는 default). 주면 §5.3 렌더 가능 여부까지 봅니다.',
  '  --adapter <id>       callbot|chatbot|dars. 지정하면 포트 id 와 대조합니다.',
  '  --timeout-ms <수>    호출 하나의 응답 예산. 미지정 시 예산 검사를 건너뜁니다.',
  '  --strict-warnings    경고도 실패로 봅니다.',
  '  --json               기계용 JSON 출력.',
  '',
  '종료코드: 0=통과, 1=실패, 2=판정보류(판정보류를 통과로 넘기지 마세요).',
  '이 하네스는 드라이런 포트만 검사합니다. 실회선·실메신저 연결은 [승인 필요].',
].join('\n');
