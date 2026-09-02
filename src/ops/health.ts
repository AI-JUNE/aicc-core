// 헬스체크 — 설계서 §9.3(장애 인지·폴백)·§13-3(실측만)·§10.3(민감정보 미노출).
//
// 왜 이 파일이 필요한가:
// "살아 있다"와 "일할 수 있다"는 다르다. 프로세스는 떠 있는데 DB가 끊긴 상태에서 200을 돌려주면
// 로드밸런서는 계속 트래픽을 밀어 넣고, 사용자는 빈 화면을 본다(품질기준 §1).
// 그래서 두 가지를 분리한다.
//   - liveness  : 프로세스가 응답하는가. 의존성을 건드리지 않는다(여기서 DB를 찌르면 DB 장애가 곧 재시작 폭풍이 된다).
//   - readiness : 지금 요청을 받아도 되는가. 의존성을 실제로 점검하고, 필수 의존성이 죽으면 503 을 낸다.
//
// 무엇을 하지 않는가:
//  - 점검 자체를 구현하지 않는다. 프로브는 호스트가 주입한다(§6.2 — Core 에 DB·엔진 종속 코드를 넣지 않는다).
//  - 응답에 접속 문자열·키·내부 호스트명을 넣지 않는다. /health 는 사실상 공개 엔드포인트다.
//  - 소요시간을 만들어 넣지 않는다. clock 주입이 없으면 비운다(§13-3).
//  - "정상 99.9%" 같은 수치를 내지 않는다. 이 파일이 아는 것은 방금 점검한 결과뿐이다.
import { maskPii } from '../core/policyGuard.ts';
import { stripSecrets } from '../obs/errorMonitor.ts';

/** up: 정상 · degraded: 동작하나 성능·기능 저하 · down: 사용 불가 */
export type HealthStatus = 'up' | 'degraded' | 'down';

export type DependencyKind = 'db' | 'cache' | 'queue' | 'storage' | 'engine' | 'external_api' | 'internal';

export type ProbeFailureCode =
  | 'E_TIMEOUT'      // 제한 시간 안에 답하지 않음
  | 'E_UPSTREAM'     // 의존성이 오류를 돌려줌
  | 'E_INTERNAL'     // 프로브 자체가 터짐
  | 'E_PROTOCOL';    // 프로브가 규약을 어긴 값을 반환

export interface ProbeOutcome {
  status: HealthStatus;
  /** 사람이 읽을 짧은 설명. 마스킹·비밀 제거를 거쳐 실린다. */
  detail?: string;
  code?: ProbeFailureCode;
}

export interface DependencyProbe {
  name: string;
  kind: DependencyKind;
  /**
   * 이것이 죽으면 서비스가 성립하지 않는가.
   * false 면 down 이어도 전체는 degraded 로만 내려간다(부분 실패 허용).
   */
  critical: boolean;
  /** 이 프로브에만 적용할 제한 시간. 없으면 전체 기본값을 쓴다. */
  timeoutMs?: number;
  check(): Promise<ProbeOutcome>;
}

export interface DependencyResult {
  name: string;
  kind: DependencyKind;
  critical: boolean;
  status: HealthStatus;
  code?: ProbeFailureCode;
  detail?: string;
  /** 실측 소요(ms). 시계 주입이 없으면 비운다. */
  durationMs?: number;
}

export interface BuildInfo {
  version?: string;
  /** 커밋 해시. 12자로 줄여 노출한다. 해시 형태가 아니면 싣지 않는다. */
  commit?: string;
  /** 빌드 시각(ISO). 호스트가 주입한다 — 여기서 만들어내지 않는다. */
  builtAt?: string;
  environment?: string;
}

export interface HealthReport {
  status: HealthStatus;
  /** liveness 는 의존성을 보지 않은 결과라는 뜻. readiness 와 섞어 읽지 않도록 표시한다. */
  kind: 'liveness' | 'readiness';
  checkedAt?: string;
  build?: BuildInfo;
  dependencies: DependencyResult[];
  /** 상태를 그대로 옮긴 HTTP 상태코드. 저장소마다 다르게 매기지 않도록 여기서 정한다. */
  httpStatus: number;
  /** 사람이 먼저 읽을 한 줄. 지어낸 수치 없이 사실만 적는다. */
  summaryKo: string;
}

/** degraded 는 200 이다 — 부분 저하로 인스턴스를 통째로 빼면 남은 기능까지 잃는다. */
export function httpStatusFor(status: HealthStatus): number {
  return status === 'down' ? 503 : 200;
}

const MAX_DETAIL_LEN = 160;

/** 응답에 나갈 설명은 개인정보·비밀값·긴 문자열을 걷어낸 뒤에만 싣는다. */
export function sanitizeDetail(detail: string | undefined): string | undefined {
  if (detail === undefined) return undefined;
  const out = maskPii(stripSecrets(detail)).text
    .replace(/(?:file:\/\/)?(?:[A-Za-z]:)?[\\/](?:[^\s()\\/:]+[\\/]){2,}([^\s()\\/:]+)/g, '…/$1')
    .trim();
  if (out.length === 0) return undefined;
  return out.length > MAX_DETAIL_LEN ? `${out.slice(0, MAX_DETAIL_LEN)}…` : out;
}

function shortCommit(commit: string | undefined): string | undefined {
  if (!commit) return undefined;
  const t = commit.trim();
  return /^[0-9a-fA-F]{7,40}$/.test(t) ? t.slice(0, 12).toLowerCase() : undefined;
}

export function sanitizeBuild(build: BuildInfo | undefined): BuildInfo | undefined {
  if (!build) return undefined;
  const commit = shortCommit(build.commit);
  const out: BuildInfo = {
    ...(build.version ? { version: build.version } : {}),
    ...(commit ? { commit } : {}),
    ...(build.builtAt ? { builtAt: build.builtAt } : {}),
    ...(build.environment ? { environment: build.environment } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 전체 판정.
 *  - 필수 의존성이 하나라도 down → down (요청을 받으면 안 된다)
 *  - 그 밖에 down·degraded 가 하나라도 있으면 → degraded (부분 실패는 감추지 않는다)
 */
export function aggregateStatus(results: readonly DependencyResult[]): HealthStatus {
  if (results.some(r => r.critical && r.status === 'down')) return 'down';
  if (results.some(r => r.status !== 'up')) return 'degraded';
  return 'up';
}

function summarize(status: HealthStatus, results: readonly DependencyResult[]): string {
  if (results.length === 0) {
    return status === 'up' ? '점검할 의존성이 등록되지 않았다(프로세스 응답만 확인).' : '의존성 점검 결과 없음.';
  }
  const bad = results.filter(r => r.status !== 'up');
  if (bad.length === 0) return `의존성 ${results.length}건 모두 정상.`;
  const names = bad.map(r => `${r.name}(${r.status})`).join(', ');
  return status === 'down'
    ? `필수 의존성 장애로 요청을 받을 수 없다: ${names}`
    : `일부 의존성 저하: ${names}`;
}

/** setTimeout 대체 주입점. 테스트에서 시간을 손으로 돌리기 위해 필요하다. */
export type Scheduler = (ms: number, run: () => void) => () => void;

const defaultScheduler: Scheduler = (ms, run) => {
  const id = setTimeout(run, ms);
  return () => clearTimeout(id);
};

export interface HealthCheckOptions {
  /** 프로브별 지정이 없을 때 쓰는 제한 시간. 운영 합의값을 넣는다 — 권장값을 코드에 박지 않는다(§13-3). */
  timeoutMs: number;
  clock?: () => number;
  build?: BuildInfo;
  scheduler?: Scheduler;
}

/** 제한 시간 안에 못 오면 그 프로브만 timeout 으로 끊는다. 한 곳이 늦다고 전체가 멈추지 않는다. */
function withTimeout(
  probe: DependencyProbe,
  timeoutMs: number,
  scheduler: Scheduler,
): Promise<ProbeOutcome> {
  return new Promise<ProbeOutcome>((resolve) => {
    let settled = false;
    const cancel = scheduler(timeoutMs, () => {
      if (settled) return;
      settled = true;
      resolve({ status: 'down', code: 'E_TIMEOUT', detail: `${timeoutMs}ms 안에 응답 없음` });
    });
    const done = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      cancel();
      resolve(outcome);
    };
    try {
      probe.check().then(
        (outcome) => done(
          outcome && (outcome.status === 'up' || outcome.status === 'degraded' || outcome.status === 'down')
            ? outcome
            // 규약을 어긴 반환값을 정상으로 해석하면 장애가 조용히 묻힌다.
            : { status: 'down', code: 'E_PROTOCOL', detail: '프로브가 알 수 없는 결과를 반환했다' },
        ),
        (err: unknown) => done({
          status: 'down',
          code: 'E_UPSTREAM',
          detail: err instanceof Error ? err.message : String(err),
        }),
      );
    } catch (err) {
      // check() 가 Promise 를 만들기도 전에 동기로 터지는 경우.
      done({ status: 'down', code: 'E_INTERNAL', detail: err instanceof Error ? err.message : String(err) });
    }
  });
}

/**
 * readiness. 모든 프로브를 **동시에** 돌린다 — 순차로 돌리면 제한 시간이 프로브 수만큼 곱해진다.
 * 실패한 프로브가 있어도 던지지 않는다. 헬스체크가 예외로 죽으면 그 자체가 장애다.
 */
export async function checkHealth(
  probes: readonly DependencyProbe[],
  opts: HealthCheckOptions,
): Promise<HealthReport> {
  const scheduler = opts.scheduler ?? defaultScheduler;
  const seen = new Set<string>();

  const results: DependencyResult[] = await Promise.all(
    probes.map(async (probe): Promise<DependencyResult> => {
      const started = opts.clock?.();
      const limit = probe.timeoutMs ?? opts.timeoutMs;
      const outcome = limit > 0
        ? await withTimeout(probe, limit, scheduler)
        : { status: 'down' as HealthStatus, code: 'E_INTERNAL' as ProbeFailureCode, detail: '제한 시간이 설정되지 않았다' };
      const ended = opts.clock?.();
      const detail = sanitizeDetail(outcome.detail);
      return {
        name: probe.name,
        kind: probe.kind,
        critical: probe.critical,
        status: outcome.status,
        ...(outcome.code ? { code: outcome.code } : {}),
        ...(detail !== undefined ? { detail } : {}),
        ...(started !== undefined && ended !== undefined ? { durationMs: ended - started } : {}),
      };
    }),
  );

  // 이름이 겹치면 대시보드에서 서로 덮어써 장애를 놓친다. 조용히 지우지 말고 드러낸다.
  for (const r of results) {
    if (seen.has(r.name)) r.detail = [r.detail, '이름이 중복된 프로브'].filter(Boolean).join(' · ');
    seen.add(r.name);
  }

  const status = aggregateStatus(results);
  const build = sanitizeBuild(opts.build);
  return {
    status,
    kind: 'readiness',
    ...(opts.clock ? { checkedAt: new Date(opts.clock()).toISOString() } : {}),
    ...(build ? { build } : {}),
    dependencies: results,
    httpStatus: httpStatusFor(status),
    summaryKo: summarize(status, results),
  };
}

/** liveness. 의존성을 건드리지 않는다 — 프로세스가 응답한다는 사실만 알린다. */
export function livenessReport(opts: { clock?: () => number; build?: BuildInfo } = {}): HealthReport {
  const build = sanitizeBuild(opts.build);
  return {
    status: 'up',
    kind: 'liveness',
    ...(opts.clock ? { checkedAt: new Date(opts.clock()).toISOString() } : {}),
    ...(build ? { build } : {}),
    dependencies: [],
    httpStatus: 200,
    summaryKo: '프로세스가 응답한다(의존성 미점검).',
  };
}

/**
 * 승인 전 기능의 프로브. 실제 연결을 시도하지 않고 "아직 켜지 않았다"를 명시한다.
 * 이것을 down 으로 두면 승인 전 환경이 영구 장애로 보이고, up 으로 두면 켜진 줄 착각한다. 그래서 degraded 다.
 */
export function approvalPendingProbe(name: string, kind: DependencyKind): DependencyProbe {
  return {
    name,
    kind,
    critical: false,
    check: async () => ({ status: 'degraded', detail: '[승인 필요] 활성화 전 — 연결을 시도하지 않았다' }),
  };
}
