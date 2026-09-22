// 파기 실행 오케스트레이터 — 설계서 §8.2(보존·파기)·§10.3(마스킹)·§11.1(테넌트 격리)·
// §9.3(부분 실패를 통째 실패로 만들지 않는다)·§13-3(임의 기본값 금지).
//
// `core/retention.ts` 에는 판정이 다 있다 — 분류(`DATA_CLASSES`)·정책 검증·만료 판정(`decide`)·
// 계획 산출(`planDisposition`). 그런데 **그 계획을 받아 실제로 지우는 자리가 저장소 어디에도 없었다.**
// `planDisposition` 을 부르는 코드는 테스트뿐이고, 머리말에 적힌 "실제 삭제 실행은 별도 워커가 맡는다"의
// 그 워커가 어디에도 없다. (13)(14)(15)(16)(17)(18)(19) 가 메운 것과 정확히 같은 모양의 공백이다.
// 그대로 두면 이벤트·녹취·색인·감사로그를 들고 있는 저장소들이 각자 15줄씩 채우게 되고 —
// **각자 다르게 틀린다.** 그리고 여기서 틀리면 증상이 예외가 아니라 **조용한 오답**이다:
// 지우지 않았는데 지웠다고 적히거나, 아직 지우면 안 되는 것을 지운다. 둘 다 되돌릴 수 없다.
//
// 막는 사고는 취향이 아니라 정해져 있다.
//
//  1) **`plan.decisions` 를 순회한다.** `DispositionPlan` 은 `decisions`(전체)와 `due`(실행 대상)를
//     **둘 다** 들고 있고, 둘 다 `RetentionDecision[]` 이라 어느 쪽을 돌려도 타입이 통과한다.
//     `decisions` 를 돌면 **보존기간 한복판인 레코드와 법적 보류 건까지** 지운다 — 어디서도 안 터지고,
//     증상은 몇 달 뒤 "분쟁 건 녹취가 없다"로 나타난다(executeHandoff 의 `queueId`/`admittedQueueId`
//     와 같은 모양의 함정이다). 그래서 이 모듈은 **계획 객체를 받고** `plan.due` 외에는 손대지 않으며,
//     `due` 에 실린 건이 정말 `status === 'due'` 인지 **한 번 더 확인**한다(손으로 만든 계획 방지).
//
//  2) **승인 전에 진짜로 지운다.** 파기는 되돌릴 수 없는 동작이다(QUALITY_BAR §3). 그래서 활성화는
//     **기본 OFF** 이며 `activation: 'enabled'` + `approvalRef` 가 **둘 다** 있어야 포트를 부른다
//     **[승인 필요]**. 꺼진 상태에서는 포트를 아예 부르지 않고 무엇을 지웠을지만 돌려준다 —
//     "드라이런인데 한 건만 실제로 나갔다"는 사고를 만들지 않기 위해 호출 지점을 하나로 좁혔다.
//
//  3) **`disposition` 을 무시하고 전부 지운다.** `anonymize`·`archive` 는 `delete` 가 아니다.
//     동의 이력을 지우면 "동의받았다는 증거"가 사라지고, 감사로그를 지우면 사고 조사가 불가능해진다.
//     그래서 포트는 **처리 방식별로 메서드가 갈려 있고**, 필요한 메서드가 없으면 그 건은
//     **`unsupported` 로 드러낼 뿐 다른 방식으로 대신 처리하지 않는다**(대신 지우는 것이 제일 나쁘다).
//
//  4) **규약을 어긴 반환값을 성공으로 읽는다.** 포트가 아무것도 돌려주지 않거나(구현을 깜빡한 스텁)
//     모양이 다른 값을 돌려주면, `if (!err) disposed` 식의 코드는 그것을 **성공으로 적는다**.
//     그러면 그 레코드에 `disposedAt` 이 찍혀 **다음 스윕에서 영영 제외**되고, 개인정보는 남은 채
//     장부에만 파기로 기록된다. 그래서 `{ ok: true }` **정확히 그 모양**만 파기로 적고, 나머지는 전부
//     실패다(`ops/recoveryProbe.ts` 가 규약 위반 반환값을 `up` 으로도 `down` 으로도 적지 않은 것과 같다).
//
//  5) **한 건이 실패하면 스윕이 통째로 멈춘다.** 저장소 하나가 죽었다고 나머지 만 건의 파기가
//     밀리면 그날의 보존기간 초과분이 전부 다음 날로 넘어간다. 그래서 **어떤 경우에도 던지지 않고**
//     (격리 위반 하나만 예외) 실패는 건별로 적고 계속 간다. 실패 건은 `disposed` 로 적지 않으므로
//     다음 스윕에서 다시 잡힌다.
//
//  6) **제한 시간 없이 기다린다.** 파기는 배치다 — 저장소 하나가 응답하지 않으면 스윕 전체가
//     매달린 채 다음 실행 시각을 넘긴다. 제한 시간은 **주입이며 기본값이 없고**(§13-3), 시간을 넘긴
//     건은 **성공도 실패도 아닌 '결과 미확인'** 이다(늦게 성공했을 수 있으므로 `disposed` 로 적을 수
//     없고, 그렇다고 안 지워졌다고 단정할 수도 없다). 미확인은 실패로 세어 다음 스윕이 다시 본다.
//
//  7) **같은 레코드를 두 번 부른다.** 계획에 같은 id 가 두 번 실리면(합쳐진 원본, 잘못된 커서)
//     두 번째 호출은 이미 다른 것이 된 자리를 건드린다. 그래서 **id 기준으로 한 번만** 부르고
//     중복은 조용히 버리지 않고 드러낸다.
//
//  8) **실패 사유에 원문이 실린다.** 저장소 오류 메시지에는 지우려던 행의 내용이 그대로 들어 있는
//     경우가 흔하다(`duplicate key: 010-1234-5678`). 이 모듈이 만드는 모든 문구는 `maskPii` 를
//     지난다(§10.3).
//
//  9) **막힌 건·보류 건이 조용히 사라진다.** `blocked`(규칙 미정의·미승인)는 운영이 해소해야 할
//     설정 결함이고, `held`(법적 보류)는 사람이 풀어야 할 건이다. 둘 다 결과에 **건수와 함께** 남긴다 —
//     "오늘 스윕 0건 실패"가 실은 "전부 막혀서 한 건도 시도하지 않았다"인 경우를 구분하기 위해서다.
//
// **판정하지 않는다.** 만료·보류·승인 판정은 `retention.ts` 하나에만 있고 여기서 다시 쓰지 않는다 —
// 두 곳이 서로 다른 규칙을 갖는 순간 §2 의 이중 관리가 파기 규칙에서 재발하며, 그 재발은
// "어떤 경로로 지웠는지에 따라 남는 데이터가 다르다"로 나타난다.
// **시계를 만들지 않는다.** 실행 시각은 주입이다(§13-3).
// **실저장소 연결은 하지 않는다.** 여기 있는 것은 인터페이스와 그 위의 순서뿐이며, 실제 DB·오브젝트
// 스토리지·벡터 색인에 붙이는 일은 **[승인 필요]** 다.
import type { TenantScope } from './tenancy.ts';
import { assertTenantScope } from './tenancy.ts';
import { maskPii } from './policyGuard.ts';
import type {
  DataClass,
  Disposition,
  DispositionPlan,
  RetentionDecision,
} from './retention.ts';
import type { AuditActor, AuditChain, Hasher } from '../audit/log.ts';
import { appendAudit } from '../audit/log.ts';

export const DISPOSITION_EXECUTION_CONTRACT_VERSION = 1;

/**
 * 포트의 응답. **`{ ok: true }` 정확히 이 모양만 파기로 적는다**(위 4번).
 * 지우지 못했으면 `{ ok: false, reasonKo }` 를 돌려주거나 던진다 — 둘 다 실패로 적힌다.
 */
export type DisposalAck = { ok: true } | { ok: false; reasonKo: string };

/**
 * 저장소에 넘기는 최소 정보. **본문도 슬롯도 담지 않는다**(§10.3) —
 * 저장소가 할 일은 자기 레코드 id 를 지우는 것뿐이고, 무엇이 들어 있었는지는 알 필요가 없다.
 */
export interface DisposalRequest {
  scope: TenantScope;
  recordId: string;
  dataClass: DataClass;
  disposition: Disposition;
  /** 판정된 기한(ISO8601). 저장소가 자체 안전장치로 한 번 더 확인할 수 있게 함께 준다. */
  expiresAt?: string;
  /** 실행 시각(ISO8601). 주입값을 그대로 전달한다. */
  at: string;
}

/**
 * 저장소가 구현하는 파기 포트. **처리 방식별로 메서드가 갈려 있는 것이 핵심이다**(위 3번) —
 * 하나의 `dispose(req)` 로 합치면 방식 분기를 저장소마다 다시 쓰게 되고, 거기서 `archive` 가
 * `delete` 로 처리되는 순간 동의 이력·감사로그가 사라진다.
 * 구현하지 않은 방식은 **없는 채로 두면 된다** — 이 모듈이 `unsupported` 로 드러낸다.
 */
export interface DisposalPort {
  readonly name: string;
  delete?(req: DisposalRequest): Promise<DisposalAck> | DisposalAck;
  anonymize?(req: DisposalRequest): Promise<DisposalAck> | DisposalAck;
  archive?(req: DisposalRequest): Promise<DisposalAck> | DisposalAck;
}

/** 활성화 선언. **기본 OFF** — 둘 다 있어야 실제 호출이 나간다 [승인 필요]. */
export interface DisposalActivation {
  activation: 'enabled' | 'disabled';
  /** 법무·개인정보 담당 승인 근거(결재번호 등). 비면 켜지지 않는다. */
  approvalRef?: string;
}

export type DisposalOutcomeStatus =
  | 'disposed'       // 포트가 규약대로 성공을 돌려줬다
  | 'dry_run'        // 활성화 전 — 부르지 않았다
  | 'failed'         // 거절·예외·제한 시간 초과·규약 위반 반환값
  | 'unsupported'    // 포트에 해당 처리 방식이 없다
  | 'duplicate'      // 같은 레코드가 계획에 두 번 실렸다 — 한 번만 불렀다
  | 'not_attempted'; // 이번 회차 상한 밖 — 다음 회차가 본다

export interface DispositionOutcome {
  recordId: string;
  dataClass: DataClass;
  disposition: Disposition;
  status: DisposalOutcomeStatus;
  /** 마스킹을 지난 사유(§10.3). */
  reasonKo: string;
}

export interface DispositionCounts {
  due: number;
  disposed: number;
  dryRun: number;
  failed: number;
  unsupported: number;
  duplicate: number;
  notAttempted: number;
  blocked: number;
  held: number;
}

export interface ExecuteDispositionResult {
  /** 실패·미지원이 하나도 없을 때만 true. **막힌 건(blocked)이 있으면 ok 여도 끝난 게 아니다.** */
  ok: boolean;
  /** 포트를 실제로 불렀는가. 활성화 전이면 false. */
  executed: boolean;
  activation: 'enabled' | 'disabled';
  portName: string;
  outcomes: readonly DispositionOutcome[];
  counts: DispositionCounts;
  /** 규칙 미정의·미승인으로 실행할 수 없는 건(§8.2). 운영이 해소해야 한다. */
  blocked: readonly RetentionDecision[];
  /** 법적 보류 건. 기한이 지나도 건드리지 않는다. */
  held: readonly RetentionDecision[];
  warnings: readonly string[];
  /** `audit` 를 주면 시도 1건당 1레코드가 덧붙은 체인을 돌려준다. */
  chain?: AuditChain;
}

export interface DispositionAuditBinding {
  chain: AuditChain;
  actor: AuditActor;
  hash: Hasher;
  /** 감사 레코드 id 생성기. Core 가 만들면 회차마다 충돌한다(§13-3). */
  newRecordId: (seq: number) => string;
}

export interface ExecuteDispositionParams {
  scope: TenantScope;
  /** `planDisposition` 이 만든 계획 **그대로**. 배열만 뽑아 넘기지 않는다(위 1번). */
  plan: DispositionPlan;
  port: DisposalPort;
  /** 실행 시각(ISO8601, 오프셋 명시). 시계를 만들지 않는다(§13-3). */
  at: string;
  /** 미지정이면 비활성 — 드라이런이다 [승인 필요]. */
  activation?: DisposalActivation;
  /** 이번 회차 처리 상한. 기본값 없음(§13-3) — 주지 않으면 전량을 시도한다. */
  limit?: number;
  /** 포트 1건당 제한 시간(ms). 기본값 없음(§13-3) — 주지 않으면 경고로 드러낸다. */
  timeoutMs?: number;
  audit?: DispositionAuditBinding;
}

function mask(s: string): string {
  return maskPii(s).text;
}

/** 오프셋이 명시된 ISO8601 만 받는다 — 없으면 호스트 로컬 시간대로 해석되어 서버마다 다르게 읽힌다. */
function isZonedIso(s: unknown): boolean {
  return typeof s === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(s.trim()) && !Number.isNaN(Date.parse(s));
}

type CallVerdict =
  | { kind: 'ok' }
  | { kind: 'refused'; reasonKo: string }
  | { kind: 'threw'; reasonKo: string }
  | { kind: 'timeout' }
  | { kind: 'malformed' };

/**
 * 포트 1회 호출. **어떤 경우에도 던지지 않는다**(위 5번) — 이 함수가 던지면 스윕 전체가 멈춘다.
 * 제한 시간을 넘긴 호출은 취소할 수 없으므로(늦게 성공할 수 있다) '결과 미확인'으로 끝낸다.
 */
async function callPort(
  fn: (req: DisposalRequest) => Promise<DisposalAck> | DisposalAck,
  req: DisposalRequest,
  timeoutMs: number | undefined,
): Promise<CallVerdict> {
  let raw: unknown;
  try {
    const call = Promise.resolve(fn(req));
    if (timeoutMs === undefined) {
      raw = await call;
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const TIMED_OUT = Symbol('timeout');
      const guard = new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
      });
      try {
        const r = await Promise.race([call, guard]);
        if (r === TIMED_OUT) return { kind: 'timeout' };
        raw = r;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } catch (e) {
    return { kind: 'threw', reasonKo: e instanceof Error ? e.message : String(e) };
  }
  // (4) 모양이 정확히 맞을 때만 파기로 적는다.
  if (raw !== null && typeof raw === 'object' && 'ok' in (raw as Record<string, unknown>)) {
    const ack = raw as DisposalAck;
    if (ack.ok === true) return { kind: 'ok' };
    if (ack.ok === false) {
      const why = typeof (ack as { reasonKo?: unknown }).reasonKo === 'string' ? (ack as { reasonKo: string }).reasonKo : '';
      return { kind: 'refused', reasonKo: why };
    }
  }
  return { kind: 'malformed' };
}

/**
 * 파기 계획 실행. 순서가 곧 안전장치다:
 * **격리 → 설정 검증 → 활성화 판정 → 건별(중복·상한·방식·호출) → 기록**.
 * 어느 단계에서 걸려도 포트 호출이 먼저 나가는 일은 없다.
 *
 * 던지는 것은 **테넌트 격리 위반 하나뿐**이다(§11.1) — 남의 테넌트 데이터를 지우는 것은
 * 폴백하거나 결과로 내려보낼 사안이 아니다. 나머지는 전부 결과에 담긴다(위 5번).
 */
export async function executeDisposition(p: ExecuteDispositionParams): Promise<ExecuteDispositionResult> {
  assertTenantScope(p.scope);
  if (p.plan.tenantId !== p.scope.tenantId) {
    throw new Error(`파기 계획의 테넌트가 실행 스코프와 다릅니다: ${p.plan.tenantId} ≠ ${p.scope.tenantId} (설계서 §11.1)`);
  }

  const warnings: string[] = [];
  const outcomes: DispositionOutcome[] = [];
  const blocked = [...p.plan.blocked];
  const held = [...p.plan.held];
  const portName = typeof p.port?.name === 'string' && p.port.name !== '' ? p.port.name : '(이름 없는 포트)';

  // ── 설정 검증 ───────────────────────────────────────────────────────────────
  const configIssues: string[] = [];
  if (!isZonedIso(p.at)) {
    configIssues.push('실행 시각이 오프셋 명시 ISO8601 이 아닙니다 — 서버마다 다르게 해석됩니다 (설계서 §13-3)');
  }
  if (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit <= 0)) {
    configIssues.push('처리 상한(limit)은 1 이상의 정수여야 합니다');
  }
  if (p.timeoutMs !== undefined && (!Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0)) {
    configIssues.push('제한 시간(timeoutMs)이 양수가 아닙니다');
  }
  if (p.timeoutMs === undefined) {
    warnings.push('제한 시간(timeoutMs)이 선언되지 않았습니다 — 응답 없는 저장소 하나가 스윕 전체를 붙잡습니다 (설계서 §13-3)');
  }

  const activationOn =
    p.activation?.activation === 'enabled' &&
    typeof p.activation.approvalRef === 'string' &&
    p.activation.approvalRef.trim() !== '';
  if (p.activation?.activation === 'enabled' && !activationOn) {
    configIssues.push('활성화가 켜졌으나 승인 근거(approvalRef)가 없습니다 — 파기는 되돌릴 수 없습니다 [승인 필요]');
  }

  const due = p.plan.due;
  const seen = new Set<string>();
  let attempted = 0;
  let stop = configIssues.length > 0;
  for (const issue of configIssues) warnings.push(mask(issue));

  for (const d of due) {
    // (1) 손으로 만든 계획·잘못 넘긴 배열 방어. `due` 에 due 아닌 것이 실려 있으면 지우지 않는다.
    if (d.status !== 'due' || d.disposition === undefined) {
      outcomes.push({
        recordId: d.recordId,
        dataClass: d.dataClass,
        disposition: 'delete',
        status: 'failed',
        reasonKo: mask(`실행 대상 목록에 파기 대상이 아닌 건이 있습니다(status=${d.status}) — 지우지 않았습니다 (설계서 §8.2)`),
      });
      continue;
    }
    const base = { recordId: d.recordId, dataClass: d.dataClass, disposition: d.disposition };

    if (stop) {
      outcomes.push({ ...base, status: 'not_attempted', reasonKo: '설정 결함으로 이번 회차를 실행하지 않았습니다' });
      continue;
    }
    // (7) 같은 레코드를 두 번 부르지 않는다. 조용히 버리지도 않는다.
    if (seen.has(d.recordId)) {
      outcomes.push({ ...base, status: 'duplicate', reasonKo: '같은 레코드가 계획에 중복 실렸습니다 — 한 번만 처리했습니다' });
      continue;
    }
    seen.add(d.recordId);

    if (p.limit !== undefined && attempted >= p.limit) {
      outcomes.push({ ...base, status: 'not_attempted', reasonKo: `이번 회차 상한(${p.limit}건)을 넘어 다음 회차로 넘깁니다` });
      continue;
    }

    // (3) 처리 방식별 메서드. 없으면 다른 방식으로 대신하지 않는다.
    const fn = p.port?.[d.disposition];
    if (typeof fn !== 'function') {
      outcomes.push({
        ...base,
        status: 'unsupported',
        reasonKo: `포트 '${portName}' 에 ${d.disposition} 처리가 없습니다 — 다른 방식으로 대신하지 않습니다 (설계서 §8.2)`,
      });
      continue;
    }

    // (2) 활성화 전에는 여기서 끝난다 — 포트 호출은 이 아래 한 곳뿐이다.
    if (!activationOn) {
      outcomes.push({ ...base, status: 'dry_run', reasonKo: `활성화 전이라 실행하지 않았습니다(${d.disposition}) [승인 필요]` });
      continue;
    }

    attempted += 1;
    const req: DisposalRequest = {
      scope: p.scope,
      recordId: d.recordId,
      dataClass: d.dataClass,
      disposition: d.disposition,
      expiresAt: d.expiresAt,
      at: p.at,
    };
    const v = await callPort(fn.bind(p.port), req, p.timeoutMs);
    if (v.kind === 'ok') {
      outcomes.push({ ...base, status: 'disposed', reasonKo: `${d.disposition} 완료` });
    } else if (v.kind === 'refused') {
      outcomes.push({ ...base, status: 'failed', reasonKo: mask(`저장소가 거절했습니다: ${v.reasonKo || '사유 없음'}`) });
    } else if (v.kind === 'threw') {
      outcomes.push({ ...base, status: 'failed', reasonKo: mask(`저장소 호출이 실패했습니다: ${v.reasonKo}`) });
    } else if (v.kind === 'timeout') {
      outcomes.push({
        ...base,
        status: 'failed',
        reasonKo: `제한 시간(${p.timeoutMs}ms)을 넘겨 결과를 확인하지 못했습니다 — 파기로 적지 않습니다`,
      });
    } else {
      outcomes.push({
        ...base,
        status: 'failed',
        reasonKo: '저장소가 규약을 어긴 값을 돌려줬습니다 — 파기로 적지 않습니다 (설계서 §8.2)',
      });
    }
  }

  const counts: DispositionCounts = {
    due: due.length,
    disposed: outcomes.filter((o) => o.status === 'disposed').length,
    dryRun: outcomes.filter((o) => o.status === 'dry_run').length,
    failed: outcomes.filter((o) => o.status === 'failed').length,
    unsupported: outcomes.filter((o) => o.status === 'unsupported').length,
    duplicate: outcomes.filter((o) => o.status === 'duplicate').length,
    notAttempted: outcomes.filter((o) => o.status === 'not_attempted').length,
    blocked: blocked.length,
    held: held.length,
  };
  // (9) 막힌 건·보류 건은 건수로 드러낸다 — "0건 실패"와 "한 건도 시도하지 않았다"는 다르다.
  if (counts.blocked > 0) {
    warnings.push(`보존 규칙 미정의·미승인으로 실행할 수 없는 건이 ${counts.blocked}건 있습니다 — 설정에서 해소해야 합니다 (설계서 §8.2)`);
  }
  if (counts.held > 0) {
    warnings.push(`법적 보류로 기한이 지나도 유지되는 건이 ${counts.held}건 있습니다`);
  }
  if (!activationOn && counts.dryRun > 0) {
    warnings.push(`활성화 전이라 ${counts.dryRun}건을 실행하지 않았습니다 [승인 필요]`);
  }

  const result: ExecuteDispositionResult = {
    ok: counts.failed === 0 && counts.unsupported === 0 && !stop,
    executed: activationOn && attempted > 0,
    activation: activationOn ? 'enabled' : 'disabled',
    portName,
    outcomes,
    counts,
    blocked,
    held,
    warnings,
  };

  if (p.audit) {
    result.chain = appendDispositionAudit(p, outcomes, activationOn);
  }
  return result;
}

/**
 * 시도 1건당 감사 레코드 1건. **결과를 안 뒤에 적는다** — 의도만 먼저 적으면 실패한 건이
 * "지웠다"로 남고, 그 장부는 사고 조사에서 정확히 반대 방향을 가리킨다.
 * 드라이런은 `denied` 로 적는다(스윕이 돌았다는 사실은 남기되 파기로 읽히지 않게).
 * 상한 밖·중복 건은 적지 않는다 — 저장소를 건드리지 않았으므로 감사 대상 행위가 아니다.
 */
function appendDispositionAudit(
  p: ExecuteDispositionParams,
  outcomes: readonly DispositionOutcome[],
  activationOn: boolean,
): AuditChain {
  const a = p.audit as DispositionAuditBinding;
  let chain = a.chain;
  let seq = 0;
  for (const o of outcomes) {
    if (o.status === 'not_attempted' || o.status === 'duplicate') continue;
    seq += 1;
    chain = appendAudit(
      chain,
      {
        scope: p.scope,
        recordId: a.newRecordId(seq),
        at: p.at,
        actor: a.actor,
        // 감사 액션에 'archive' 는 없다. 삭제만 'delete' 이고 비식별·보관은 상태 변경이다.
        action: o.disposition === 'delete' ? 'delete' : 'update',
        targetType: o.dataClass,
        targetId: o.recordId,
        result: o.status === 'disposed' ? 'success' : o.status === 'dry_run' ? 'denied' : 'error',
        detail: `${o.disposition}/${o.status}: ${o.reasonKo}${activationOn ? '' : ' (활성화 전)'}`,
      },
      a.hash,
    );
  }
  return chain;
}

// ── 테스트·드라이런용 메모리 포트 ───────────────────────────────────────────────

export interface MemoryDisposalPort extends DisposalPort {
  /** 실제로 호출된 레코드 id — 처리 방식별. 드라이런이 진짜 드라이런인지 확인하는 근거다. */
  readonly calls: { delete: string[]; anonymize: string[]; archive: string[] };
}

/**
 * 메모리 파기 포트. `support` 에 적은 방식만 구현한다 — 적지 않은 방식은 **메서드 자체가 없어서**
 * `unsupported` 로 드러난다(빈 함수를 두면 "지웠다"로 적힌다).
 */
export function createMemoryDisposalPort(opts: {
  name?: string;
  support?: readonly Disposition[];
  /** 지정한 레코드는 거절한다(부분 실패 재현). */
  refuse?: Readonly<Record<string, string>>;
} = {}): MemoryDisposalPort {
  const support = opts.support ?? (['delete', 'anonymize', 'archive'] as const);
  const calls = { delete: [] as string[], anonymize: [] as string[], archive: [] as string[] };
  const make = (kind: Disposition) => (req: DisposalRequest): DisposalAck => {
    calls[kind].push(req.recordId);
    const why = opts.refuse?.[req.recordId];
    return why === undefined ? { ok: true } : { ok: false, reasonKo: why };
  };
  const port: MemoryDisposalPort = { name: opts.name ?? 'memory_disposal', calls };
  for (const k of support) {
    (port as unknown as Record<string, unknown>)[k] = make(k);
  }
  return port;
}
