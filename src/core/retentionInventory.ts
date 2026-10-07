// 파기 대상 목록 투영 + 파기 스윕 — 설계서 §8.2(보존·파기)·§8.1(이벤트가 유일한 원천)·
// §10.3(마스킹)·§11.1(테넌트 격리)·§13-3(실측만)·§9.3(부분 실패를 통째 실패로 만들지 않는다).
//
// 왜 이 파일이 필요한가. §8.2 경로는 양쪽 끝이 다 있다 — `retention.ts` 가 분류·정책 검증·만료
// 판정·계획 산출(`planDisposition`)을 갖추고, `executeDisposition.ts` 가 그 계획을 받아 저장소
// 파기 포트를 부른다. 그런데 **그 사이에 들어갈 `RetainedRecord[]` 를 만드는 코드가 저장소 전체에
// 0줄이었다.** `planDisposition(records, policy, now)` 의 `records` 를 채우는 곳은 테스트뿐이고,
// 그러면 스윕은 **언제 돌려도 빈 목록을 돈다.**
//
// 이 미배선이 조용한 방식은 (30)의 상호작용 조회보다 한 단계 더 나쁘다. 조회는 0건이 "통화가
// 없었다"로 보였지만, 파기는 0건이 **"지울 것이 없었다"로 보이면서 동시에 장부에는 스윕이 정상
// 완료로 남는다**(`ok: true` · `failed 0` · `blocked 0`). 즉 **보존기간이 지난 개인정보가 그대로
// 남아 있는 상태**가 "오늘도 깨끗함"으로 보고된다. §8.2 머리말이 "지우는 절차가 있다가 아니라
// 기한이 되면 자동으로 지워진다여야 한다"고 적어 둔 바로 그 실패이며, 드러나는 시점은 개인정보
// 실태 점검이고 그때 되돌릴 방법은 없다.
//
// 이 파일이 막는 사고는 취향이 아니라 정해져 있다.
//
//  1) **파기 단위를 이벤트 1건으로 잡는 것.** 타입만 보면 이벤트마다 레코드를 만드는 것이 가장
//     촘촘해 보이는데, 그러면 한 통화가 분류마다 수백 건으로 쪼개지고 — 무엇보다 **한 통화의
//     이벤트가 절반만 지워진 상태**가 정상 결과로 남는다(나머지는 다음 스윕, 그 사이에 실패하면
//     영구히). 반쪽 원장은 민원 대응에도 못 쓰고 개인정보는 여전히 남아 있다. 그래서 파기 단위는
//     **(분류 × 상호작용)** 이고, 레코드 id 는 `retainedRecordId` 하나가 만든다(호스트가 자기
//     형식을 따로 만들면 `disposed` 장부와 키가 어긋나 **매 스윕이 같은 건을 다시 지운다**).
//
//  2) **기산 시점을 세션 시작으로 잡는 것.** 보존기간은 수집 시각부터인데 한 통화의 수집은
//     마지막 턴까지 이어진다. `session.started` 시각을 쓰면 긴 통화·늦게 끝난 통화의 뒷부분이
//     기한보다 **먼저** 지워지고, 턴별 시각을 각자 쓰면 (1)의 반쪽 전문이 된다. 그래서 기산
//     시점은 **그 세션에서 관측된 가장 늦은 시각**이다 — 보수적인 쪽이며, 없는 시각을 만들지
//     않는다(§13-3).
//
//  3) **잘린 투영으로 파기를 돌리는 것.** 수집 상한·기간 경계에 걸려 **그 세션의 마지막
//     이벤트를 못 본** 투영은 (2)의 기산 시점을 실제보다 이르게 계산한다 — 아직 끝나지도 않은
//     통화가 만료로 잡힌다. 파기는 되돌릴 수 없으므로(QUALITY_BAR §3) 상한에 걸린 투영은
//     **레코드를 만들지 않고**(`usable: false`) 그 사실을 적는다. 기간을 잘라 읽는 경우에는
//     호스트가 `observedThrough`(관측 종료 경계)를 선언하면 경계에 닿은 세션만 빼고 나머지는
//     그대로 돈다 — 선언이 없으면 검사하지 않고(§13-3) 그 사실을 경고로 드러낸다.
//
//  4) **근거 없는 레코드를 만드는 것.** §8.1 이벤트가 증명할 수 있는 것은 **이벤트·전문·개인정보
//     흔적**뿐이다. 녹취·RAG 색인·동의 이력·감사로그가 저장됐는지는 원장에 적혀 있지 않다.
//     없는 레코드를 만들어 두면 포트는 "그런 것 없다"로 거절하거나(매 스윕 실패) 조용히 성공을
//     돌려주고, 후자면 **장부에만 파기로 남는다**(`executeDisposition` 의 4번과 같은 결말).
//     그래서 원장이 모르는 분류는 **만들지 않고 `classesWithoutEvidence` 로 드러낸다** —
//     호스트가 `declared` 로 선언하면 그 선언이 유일한 근거다(선언도 격리·형식 검사를 지난다).
//
//  5) **개인정보가 든 식별자로 파기 목록을 만드는 것.** 통화 id 에 발신번호를 쓰는 호스트는
//     흔하다. 그 id 는 레코드 id 가 되어 파기 요청과 **감사로그 `targetId`** 로 나간다 —
//     원문을 쓰면 §10.3 위반이고, 마스킹해 보내면 저장소가 그 레코드를 못 찾아 **전건 실패**한다.
//     둘 다 조용히 틀리므로 그 세션은 **목록에 넣지 않고 건수로 드러낸다**((30)의 워크스페이스
//     스코프와 같은 모양의 결론이다 — 지원하지 않는다고 적는 쪽이 낫다).
//
//  6) **종료되지 않은 세션을 빼는 것.** 폴백·누수로 `session.ended` 가 없는 통화를 건너뛰면
//     하필 그 통화들의 개인정보가 영구히 남는다. (2)의 기산 시점이 마지막 관측 시각이므로
//     진행 중인 통화는 애초에 기한에 걸리지 않는다 — 빼야 할 이유가 없다. 건수로만 적는다.
//
//  7) **정책에 규칙이 없는 분류를 미리 걸러 내는 것.** 그러면 `decide` 가 `blocked` 로 드러낼
//     기회가 사라져 **"해소할 설정이 없음"** 으로 보인다(§8.2 가 그 상태를 운영이 반드시 해소해야
//     한다고 적어 둔 바로 그 건이다). 그래서 투영은 정책을 보지 않는다 — 판정은 `decide` 하나다(§2).
//
// **판정하지 않는다.** 만료·보류·승인 판정은 `retention.ts`, 실행·감사는 `executeDisposition.ts`
// 하나씩이다. 이 파일에 보존일수도 임계값도 없다.
// **시계를 만들지 않는다.** 기산 시점은 전부 관측된 이벤트 시각이고, 실행 시각은 주입이다(§13-3).
// **저장하지 않는다.** 투영 결과·스윕 결과를 어디에도 적지 않는다(§6.2).
import type { ChannelKind } from '../domain/types.ts';
import type { InteractionEvent, TurnCompletedEvent } from '../events/schema.ts';
import type { EventLog, ReadOptions } from '../events/store.ts';
import { isZonedIso } from '../events/periodLedger.ts';
import { assertTenantScope, type TenantScope } from './tenancy.ts';
import { maskPii } from './policyGuard.ts';
import {
  DATA_CLASSES, planDisposition, validateRetentionPolicy,
  type DataClass, type DispositionPlan, type RetainedRecord, type RetentionPolicy,
} from './retention.ts';
import {
  executeDisposition,
  type DispositionAuditBinding, type DisposalActivation, type DisposalPort,
  type ExecuteDispositionResult,
} from './executeDisposition.ts';

export const RETENTION_INVENTORY_CONTRACT_VERSION = 1;

/**
 * §8.1 이벤트가 **존재를 증명할 수 있는** 분류.
 * - `interaction_event`: 이벤트가 원장에 있다는 것이 곧 근거다.
 * - `transcript_masked`: 비어 있지 않은 `utterance_masked` 가 한 턴이라도 있을 때.
 * - `pii_field`: `pii_masked`·`pii_kinds` 로 **개인정보가 지나갔다는 관측**이 있을 때(아래 한계 참조).
 */
export const LEDGER_EVIDENCED_CLASSES: readonly DataClass[] = ['interaction_event', 'transcript_masked', 'pii_field'];

/** 원장에 근거가 없는 분류. 호스트 선언(`declared`)만이 근거다(위 4번). */
export const LEDGER_BLIND_CLASSES: readonly DataClass[] = [
  'recording', 'consent_record', 'audit_log', 'vector_index', 'aggregate_metric',
];

/**
 * 검사하지 못하는 범위를 숨기지 않는다. `maskPii` 가 잡는 종류(주민등록번호·카드·계좌·연락처)만
 * 이벤트에 흔적이 남으므로, 이름·주소처럼 규칙이 잡지 않는 수집 슬롯은 **원장에 흔적이 없어**
 * 이 목록에 나타나지 않는다. 그 슬롯까지 지우려면 슬롯 저장소가 `declared` 로 선언해야 한다.
 */
export const PII_EVIDENCE_LIMIT_KO =
  '원장에는 마스킹 규칙이 잡는 종류(주민등록번호·카드·계좌·연락처)만 개인정보 흔적으로 남는다 — 이름·주소처럼 규칙이 잡지 않는 수집 슬롯은 흔적이 없어 이 목록에 나타나지 않는다 (설계서 §8.2·§10.3)';

/**
 * 워크스페이스 단위 파기를 지원하지 않는 이유. §8.1 이벤트에는 `workspace_id` 가 없고 원장의
 * `append` 도 테넌트만 검사한다 — 워크스페이스 스코프로 만든 원장에도 같은 테넌트의 다른
 * 워크스페이스 이벤트가 들어온다. 조회에서는 그 오류가 "0건"이었지만(§7 2.2) 파기에서는
 * **다른 워크스페이스의 데이터를 지우는 것**이고 되돌릴 수 없다. 그래서 거절한다 **[승인 필요]**.
 */
export const WORKSPACE_DISPOSAL_UNSUPPORTED_KO =
  '§8.1 이벤트에 워크스페이스 식별자가 없어 워크스페이스 단위 파기 목록을 만들지 않는다 — 테넌트 범위로 투영하라 (설계서 §11.1·§8.2)';

export const RECORD_ID_SEPARATOR = ':';

/**
 * 레코드 id. **호스트가 자기 형식을 따로 만들지 않게** 한 곳에서 만든다 —
 * `disposed` 장부와 키가 어긋나면 이미 지운 건이 매 스윕마다 다시 `due` 로 올라오고,
 * 감사로그의 파기 건수가 통화 수보다 많아진다(§13-3 의 "실측"이 깨진다).
 */
export function retainedRecordId(dataClass: DataClass, interactionId: string): string {
  return `${dataClass}${RECORD_ID_SEPARATOR}${interactionId}`;
}

/**
 * 원장이 모르는 분류의 레코드 선언. **테넌트는 싣지 않는다** — 호스트가 테넌트를 주장하지
 * 못하게 하는 것은 브리지와 같은 규칙이고(§11.1), 스코프는 투영이 가진 것을 쓴다.
 */
export interface DeclaredRetainedRecord {
  /** 저장소가 그 값으로 지울 수 있는 식별자. */
  id: string;
  dataClass: DataClass;
  /** 기산 시점(ISO8601, 오프셋 명시). 수집 시각이며 Core 가 만들지 않는다(§13-3). */
  createdAt: string;
  /** 분쟁·수사로 파기 보류된 건. */
  legalHold?: boolean;
}

export interface RetentionInventoryOptions {
  scope: TenantScope;
  /**
   * 수집 상한. 기본값 없음(§13-3). 상한에 걸리면 **레코드를 만들지 않는다**(위 3번) —
   * 조용히 반쪽 계획을 내놓는 것보다 아무것도 내놓지 않는 쪽이 낫다.
   */
  maxEvents?: number;
  /**
   * 관측 종료 경계(ISO8601, 오프셋 명시). 이 시각 이후 이벤트가 더 올 수 있다는 뜻이므로,
   * 마지막 관측 시각이 경계에 닿은 세션은 목록에 넣지 않는다. 미선언 시 검사하지 않는다(§13-3).
   */
  observedThrough?: string;
  /** 법적 보류 상호작용 id. 법무·수사 대응으로 사람이 선언한다 — Core 가 판단하지 않는다. */
  legalHold?: readonly string[];
  /** 이미 처리된 레코드: `retainedRecordId` 결과 → 처리 시각(ISO8601). 호스트 장부다. */
  disposed?: Readonly<Record<string, string>>;
  /** 원장이 모르는 분류의 레코드(녹취·색인·동의 이력·감사로그). */
  declared?: readonly DeclaredRetainedRecord[];
}

export interface RetentionInventoryCounters {
  /** 투영에 들어간 이벤트 수. */
  eventsCounted: number;
  /** 같은 `event_id` 재전송(§8.1 멱등). */
  duplicatesDropped: number;
  /** 다른 테넌트 이벤트. 0 이 아니면 원장·전달 경로 버그다(§11.1). */
  foreignTenantDropped: number;
  /** `event_id`·`interaction_id` 가 없는 이벤트. 세션으로 묶을 수 없다(§8.1). */
  eventsRejected: number;
  /** 시각을 읽을 수 없어 **근거로도 쓰지 않은** 이벤트(오프셋 없는 ISO 포함). */
  timestampsRejected: number;
  /** 상한을 넘겨 보지 않은 이벤트 수. */
  eventsSkipped: number;
  /** 상한에 걸려 잘렸는가. true 면 레코드를 만들지 않는다(위 3번). */
  truncated: boolean;
  /** 투영에서 본 세션 수(레코드를 만들지 못한 세션 포함). */
  sessionsSeen: number;
  /** `session.ended` 를 못 본 세션. 빼지 않고 건수로만 적는다(위 6번). */
  sessionsWithoutEnd: number;
  /** 쓸 수 있는 시각이 한 건도 없어 목록에 넣지 못한 세션. */
  sessionsWithoutUsableTime: number;
  /** 관측 경계에 닿아 보류한 세션(`observedThrough` 선언 시에만). */
  sessionsAtBoundary: number;
  /** 식별자에 개인정보 패턴이 있어 목록에 넣지 못한 세션(위 5번·§10.3 사고 신호). */
  identifiersRejected: number;
  /** 만든 레코드 수(이미 처리된 건 포함). */
  recordsBuilt: number;
  /** 호스트 장부에 이미 처리됨으로 적힌 레코드. `decide` 가 `disposed` 로 넘긴다. */
  recordsAlreadyDisposed: number;
  /** 법적 보류가 적용된 레코드. */
  recordsOnLegalHold: number;
  /** 어느 세션에도 걸리지 않은 보류 선언. 오타 하나가 분쟁 건을 기한대로 지운다. */
  holdsUnmatched: number;
  /** 형식·격리·중복으로 받지 않은 선언 레코드. */
  declaredRejected: number;
  /** 받은 선언 레코드. */
  declaredAccepted: number;
  /** 쓸 수 없는 처리 시각(`disposed` 값). "처리됐다"로도 "안 됐다"로도 적지 않는다. */
  disposedMarksRejected: number;
}

export interface RetentionInventoryResult {
  /** 스코프. `runRetentionSweep` 이 정책 테넌트와 대조한다(§11.1). */
  scope: TenantScope;
  /** `planDisposition` 에 그대로 넘긴다. 복사본이다. */
  records: RetainedRecord[];
  counters: RetentionInventoryCounters;
  /**
   * 이 목록을 파기의 근거로 쓸 수 있는가. false 면 `runRetentionSweep` 이 실행하지 않는다 —
   * 기산 시점을 보장할 수 없는 목록으로 되돌릴 수 없는 동작을 하지 않는다(위 3번).
   */
  usable: boolean;
  /** 원장에 근거가 없고 선언도 없는 분류. 그 분류는 이 목록으로 **파기되지 않는다**. */
  classesWithoutEvidence: DataClass[];
  /** 검사하지 못하는 범위. 숨기면 "전부 지운다"로 읽힌다. */
  limitsKo: string[];
  /** 받지 않은 선언 레코드의 사유(라벨만 — 호스트 값은 되싣지 않는다, §10.3). */
  declaredRejectionsKo: string[];
  /** 화면·로그에 그대로 쓸 한 줄. 없으면 undefined. */
  noteKo?: string;
}

function newCounters(): RetentionInventoryCounters {
  return {
    eventsCounted: 0,
    duplicatesDropped: 0,
    foreignTenantDropped: 0,
    eventsRejected: 0,
    timestampsRejected: 0,
    eventsSkipped: 0,
    truncated: false,
    sessionsSeen: 0,
    sessionsWithoutEnd: 0,
    sessionsWithoutUsableTime: 0,
    sessionsAtBoundary: 0,
    identifiersRejected: 0,
    recordsBuilt: 0,
    recordsAlreadyDisposed: 0,
    recordsOnLegalHold: 0,
    holdsUnmatched: 0,
    declaredRejected: 0,
    declaredAccepted: 0,
    disposedMarksRejected: 0,
  };
}

// 오프셋이 명시된 ISO8601 만 시각으로 받는다. 오프셋이 없으면 서버 시간대에 따라 기산 시점이
// 몇 시간 움직이고, 그만큼 일찍 지워지거나 늦게 지워진다 — 보존기간 경계에서는 그것이 곧 위반이다.
// 판정은 `events/periodLedger.ts` 하나다(§2) — 같은 규칙을 두 곳에 두면 한쪽만 고쳐진다.

interface SessionAcc {
  id: string;
  /** 관측된 가장 늦은 시각(쓸 수 있는 것만). 하나도 없으면 undefined. */
  lastAt?: string;
  lastAtMs: number;
  sawEnd: boolean;
  channels: ChannelKind[];
  hasTranscript: boolean;
  hasPiiTrace: boolean;
}

/**
 * §8.1 이벤트 → §8.2 파기 대상 목록.
 *
 * 순수 함수이며 순서가 곧 안전장치다: **격리 → 멱등 → 상한 → 시각 → 근거 수집 → 레코드 생성**.
 * 레코드를 마지막에 만들기 때문에 앞 단계에서 걸린 세션은 어떤 파기 요청에도 실리지 않는다.
 */
export function projectRetainedRecords(
  events: readonly InteractionEvent[],
  opts: RetentionInventoryOptions,
): RetentionInventoryResult {
  assertTenantScope(opts.scope);
  if (opts.scope.workspaceId !== undefined) throw new Error(WORKSPACE_DISPOSAL_UNSUPPORTED_KO);
  if (opts.maxEvents !== undefined && (!Number.isInteger(opts.maxEvents) || opts.maxEvents <= 0)) {
    throw new Error(`수집 상한(maxEvents)은 1 이상의 정수여야 한다: ${String(opts.maxEvents)} (설계서 §13-3)`);
  }
  if (opts.observedThrough !== undefined && !isZonedIso(opts.observedThrough)) {
    throw new Error(
      `관측 종료 경계(observedThrough)가 오프셋 명시 ISO8601 이 아니다: ${JSON.stringify(opts.observedThrough)} — ` +
      '경계를 잘못 읽으면 아직 진행 중인 통화가 만료로 잡힌다 (설계서 §13-3)',
    );
  }

  const counters = newCounters();
  const seenEvents = new Set<string>();
  const byId = new Map<string, SessionAcc>();
  const boundaryMs = opts.observedThrough === undefined ? undefined : Date.parse(opts.observedThrough);

  for (const e of events) {
    // 격리를 가장 먼저 본다. 남의 테넌트 이벤트는 상한에도 세지 않는다 — 세면 잘린 사유가 흐려진다.
    if (!e.tenant_id || e.tenant_id !== opts.scope.tenantId) {
      counters.foreignTenantDropped += 1;
      continue;
    }
    if (!e.event_id || !e.interaction_id) {
      counters.eventsRejected += 1;
      continue;
    }
    if (seenEvents.has(e.event_id)) {
      counters.duplicatesDropped += 1;
      continue;
    }
    seenEvents.add(e.event_id);
    if (opts.maxEvents !== undefined && counters.eventsCounted >= opts.maxEvents) {
      counters.eventsSkipped += 1;
      counters.truncated = true;
      continue;
    }
    counters.eventsCounted += 1;

    let acc = byId.get(e.interaction_id);
    if (!acc) {
      acc = {
        id: e.interaction_id,
        lastAtMs: Number.NEGATIVE_INFINITY,
        sawEnd: false,
        channels: [],
        hasTranscript: false,
        hasPiiTrace: false,
      };
      byId.set(e.interaction_id, acc);
    }

    // 시각을 읽을 수 없는 이벤트는 **근거로도 쓰지 않는다** — 시간 위에 놓을 수 없는 이벤트로
    // 레코드를 만들면 관측하지 않은 기산 시점을 적는 것이 된다(§13-3). 건수로 드러낸다.
    if (!isZonedIso(e.occurred_at)) {
      counters.timestampsRejected += 1;
      continue;
    }
    const ms = Date.parse(e.occurred_at);
    if (ms > acc.lastAtMs) {
      acc.lastAtMs = ms;
      acc.lastAt = e.occurred_at;
    }
    if (!acc.channels.includes(e.channel)) acc.channels.push(e.channel);

    // 개인정보 흔적은 **턴에 한정하지 않는다** — 이관 요약(§2)에도 마스킹이 걸린다.
    if (e.pii_masked === true || (Array.isArray(e.pii_kinds) && e.pii_kinds.length > 0)) {
      acc.hasPiiTrace = true;
    }
    if (e.type === 'turn.completed') {
      const t = e as TurnCompletedEvent;
      if (typeof t.utterance_masked === 'string' && t.utterance_masked.length > 0) acc.hasTranscript = true;
    } else if (e.type === 'session.ended') {
      acc.sawEnd = true;
    }
  }

  counters.sessionsSeen = byId.size;
  for (const acc of byId.values()) if (!acc.sawEnd) counters.sessionsWithoutEnd += 1;

  const limitsKo: string[] = [];
  const declaredRejectionsKo: string[] = [];
  const records: RetainedRecord[] = [];
  const holdSet = new Set(opts.legalHold ?? []);
  const takenIds = new Set<string>();
  const declaredClasses = new Set<DataClass>();
  let voiceSessions = 0;

  // (3) 잘린 투영은 기산 시점을 보장할 수 없다 — 레코드를 만들지 않는다.
  if (!counters.truncated) {
    for (const acc of byId.values()) {
      if (acc.channels.includes('voice')) voiceSessions += 1;
      if (acc.lastAt === undefined) {
        counters.sessionsWithoutUsableTime += 1;
        continue;
      }
      if (boundaryMs !== undefined && acc.lastAtMs >= boundaryMs) {
        counters.sessionsAtBoundary += 1;
        continue;
      }
      // (5) 식별자에 개인정보가 있으면 목록에 넣지 않는다.
      if (maskPii(acc.id).masked) {
        counters.identifiersRejected += 1;
        continue;
      }
      const hold = holdSet.has(acc.id);
      for (const dataClass of LEDGER_EVIDENCED_CLASSES) {
        if (dataClass === 'transcript_masked' && !acc.hasTranscript) continue;
        if (dataClass === 'pii_field' && !acc.hasPiiTrace) continue;
        const id = retainedRecordId(dataClass, acc.id);
        if (takenIds.has(id)) continue;
        takenIds.add(id);
        records.push(buildRecord(id, opts.scope.tenantId, dataClass, acc.lastAt, hold, opts.disposed, counters));
      }
    }
  }

  // 선언 레코드. 잘린 투영과 무관하므로(세션 묶음에 의존하지 않는다) 그대로 받는다.
  for (const d of opts.declared ?? []) {
    const defect = declaredDefect(d);
    if (defect !== undefined) {
      counters.declaredRejected += 1;
      if (!declaredRejectionsKo.includes(defect)) declaredRejectionsKo.push(defect);
      continue;
    }
    if (takenIds.has(d.id)) {
      counters.declaredRejected += 1;
      const dup = '같은 레코드 id 중복 — 한 번만 받았다';
      if (!declaredRejectionsKo.includes(dup)) declaredRejectionsKo.push(dup);
      continue;
    }
    takenIds.add(d.id);
    declaredClasses.add(d.dataClass);
    counters.declaredAccepted += 1;
    records.push(buildRecord(d.id, opts.scope.tenantId, d.dataClass, d.createdAt, d.legalHold === true, opts.disposed, counters));
  }

  for (const id of holdSet) {
    if (!byId.has(id)) counters.holdsUnmatched += 1;
  }

  // 오프셋이 섞인 시각을 문자열로 비교하면 순서가 뒤집힌다(`+09:00` 과 `Z`).
  records.sort((a, b) => (Date.parse(a.createdAt) - Date.parse(b.createdAt)) || a.id.localeCompare(b.id));
  counters.recordsBuilt = records.length;

  const classesWithoutEvidence = LEDGER_BLIND_CLASSES.filter((c) => !declaredClasses.has(c));
  if (counters.sessionsSeen > 0) limitsKo.push(PII_EVIDENCE_LIMIT_KO);
  if (opts.observedThrough === undefined && counters.sessionsSeen > 0) {
    limitsKo.push(
      '관측 종료 경계(observedThrough)가 선언되지 않았다 — 기간을 잘라 읽은 원장이라면 뒷부분이 다음 조각에 있는 세션이 기한보다 일찍 만료로 잡힌다 (설계서 §13-3)',
    );
  }
  if (voiceSessions > 0 && !declaredClasses.has('recording')) {
    limitsKo.push(
      `음성 세션 ${voiceSessions}건이 있으나 녹취 레코드 선언이 없다 — 원장만으로는 녹취 저장 여부를 알 수 없어, 기한이 지난 녹취가 이 목록에 잡히지 않는다 (설계서 §8.2)`,
    );
  }

  const note = inventoryNoteKo(counters);
  return {
    scope: opts.scope.workspaceId === undefined ? { tenantId: opts.scope.tenantId } : { ...opts.scope },
    records,
    counters,
    usable: !counters.truncated,
    classesWithoutEvidence,
    limitsKo,
    declaredRejectionsKo,
    ...(note !== undefined ? { noteKo: note } : {}),
  };
}

function buildRecord(
  id: string,
  tenantId: string,
  dataClass: DataClass,
  createdAt: string,
  legalHold: boolean,
  disposed: Readonly<Record<string, string>> | undefined,
  counters: RetentionInventoryCounters,
): RetainedRecord {
  const rec: RetainedRecord = { id, tenantId, dataClass, createdAt };
  if (legalHold) {
    rec.legalHold = true;
    counters.recordsOnLegalHold += 1;
  }
  const at = disposed?.[id];
  if (at !== undefined) {
    if (isZonedIso(at)) {
      rec.disposedAt = at;
      counters.recordsAlreadyDisposed += 1;
    } else {
      // "처리됐다"로도 "안 됐다"로도 적지 않는다 — 다음 스윕이 다시 본다(§13-3).
      counters.disposedMarksRejected += 1;
    }
  }
  return rec;
}

/** 선언 레코드의 결함. 사유 문구는 호스트 값을 되싣지 않는다(§10.3). */
function declaredDefect(d: DeclaredRetainedRecord): string | undefined {
  if (!d || typeof d.id !== 'string' || d.id.trim() === '') return 'id 누락';
  if (maskPii(d.id).masked) return '식별자에 개인정보 패턴';
  if (!DATA_CLASSES.some((s) => s.id === d.dataClass)) return '알 수 없는 데이터 분류';
  if (!isZonedIso(d.createdAt)) return '기산 시점이 오프셋 명시 ISO8601 이 아님';
  return undefined;
}

/** 투영에서 숨기면 안 되는 사실만 한 줄로. 판정·점수는 만들지 않는다(§13-3). */
export function inventoryNoteKo(c: RetentionInventoryCounters): string | undefined {
  const parts: string[] = [];
  if (c.truncated) {
    parts.push(`수집 상한에 걸려 ${c.eventsSkipped}건을 보지 않았다 — 기산 시점을 보장할 수 없어 레코드를 만들지 않았다`);
  }
  if (c.foreignTenantDropped > 0) parts.push(`다른 테넌트 이벤트 ${c.foreignTenantDropped}건 제외(§11.1 — 전달 경로를 점검하라)`);
  if (c.eventsRejected > 0) parts.push(`식별자 없는 이벤트 ${c.eventsRejected}건 제외(§8.1)`);
  if (c.duplicatesDropped > 0) parts.push(`중복 이벤트 ${c.duplicatesDropped}건 제외`);
  if (c.timestampsRejected > 0) parts.push(`시각을 읽을 수 없는 이벤트 ${c.timestampsRejected}건 제외(오프셋 명시 ISO8601 이어야 한다)`);
  if (c.sessionsWithoutUsableTime > 0) parts.push(`쓸 수 있는 시각이 없어 목록에 넣지 못한 세션 ${c.sessionsWithoutUsableTime}건 — 그 세션의 데이터는 파기되지 않는다`);
  if (c.identifiersRejected > 0) parts.push(`식별자에 개인정보가 있어 목록에 넣지 못한 세션 ${c.identifiersRejected}건(§10.3 — 통화 id 생성 규칙을 점검하라)`);
  if (c.sessionsAtBoundary > 0) parts.push(`관측 경계에 닿아 보류한 세션 ${c.sessionsAtBoundary}건(다음 투영이 본다)`);
  if (c.sessionsWithoutEnd > 0) parts.push(`종료 기록이 없는 세션 ${c.sessionsWithoutEnd}건(목록에서 빼지 않았다)`);
  if (c.recordsOnLegalHold > 0) parts.push(`법적 보류 ${c.recordsOnLegalHold}건`);
  if (c.holdsUnmatched > 0) parts.push(`어느 세션에도 걸리지 않은 보류 선언 ${c.holdsUnmatched}건 — 보류 id 를 확인하라`);
  if (c.recordsAlreadyDisposed > 0) parts.push(`이미 처리된 레코드 ${c.recordsAlreadyDisposed}건`);
  if (c.disposedMarksRejected > 0) parts.push(`쓸 수 없는 처리 시각 ${c.disposedMarksRejected}건 거부`);
  if (c.declaredRejected > 0) parts.push(`받지 않은 선언 레코드 ${c.declaredRejected}건`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * 원장에서 바로 투영한다. 스코프는 **원장이 가진 것**을 쓴다 —
 * 호스트가 테넌트를 주장하지 못하게 하는 것은 브리지와 같은 규칙이다(§11.1).
 */
export function projectRetainedRecordsFromLog(
  log: EventLog,
  opts: Omit<RetentionInventoryOptions, 'scope'> = {},
  read?: ReadOptions,
): RetentionInventoryResult {
  return projectRetainedRecords(log.read(read).map((r) => r.event), { ...opts, scope: log.scope });
}

// ── 스윕(투영 → 계획 → 실행) ───────────────────────────────────────────────────

export type RetentionSweepStatus =
  | 'refused'    // 목록·설정을 믿을 수 없어 계획조차 만들지 않았다
  | 'empty'      // 목록이 비었다 — "0건 처리"와 구분한다
  | 'dry_run'    // 활성화 전 [승인 필요]
  | 'executed';  // 포트를 부를 수 있는 상태로 돌았다

export interface RetentionSweepParams {
  /** `projectRetainedRecords`·`projectRetainedRecordsFromLog` 결과 **그대로**. 배열만 뽑아 넘기지 않는다. */
  inventory: RetentionInventoryResult;
  policy: RetentionPolicy;
  port: DisposalPort;
  /** 실행 시각 = 만료 판정 기준(ISO8601, 오프셋 명시). 시계를 만들지 않는다(§13-3). */
  at: string;
  /** 미지정이면 드라이런 [승인 필요]. */
  activation?: DisposalActivation;
  limit?: number;
  timeoutMs?: number;
  audit?: DispositionAuditBinding;
}

export interface RetentionSweepResult {
  status: RetentionSweepStatus;
  /** 화면·로그에 그대로 쓸 한 줄. */
  messageKo: string;
  /** 실행하지 않은 이유. 비어 있지 않으면 저장소를 건드리지 않았다. */
  refusalsKo: string[];
  /** 실행은 했지만 숨기면 안 되는 사실(정책 결함·투영 주의). */
  warningsKo: string[];
  /** 검사하지 못하는 범위(투영에서 그대로 옮긴다). */
  limitsKo: string[];
  /** 이 스윕으로 **파기되지 않는** 분류. */
  classesWithoutEvidence: DataClass[];
  plan?: DispositionPlan;
  execution?: ExecuteDispositionResult;
}

/**
 * 투영 → `planDisposition` → `executeDisposition`. 세 호출을 호스트가 손으로 꿰면
 * 잘못 꿰는 방식이 정해져 있다(잘린 목록을 그대로 넘김 · 다른 테넌트 정책 · 계획에서 배열만 뽑음).
 *
 * **판정을 복사하지 않는다**: 만료는 `decide`, 활성화·규약·감사는 `executeDisposition` 하나다.
 * **정책 결함으로 스윕 전체를 멈추지 않는다**: 멈추면 기한이 지난 개인정보가 설정이 고쳐질
 * 때까지 남는다. 규칙이 없거나 미승인인 분류는 `decide` 가 `blocked` 로 드러내고(§8.2) 나머지는
 * 그대로 지워진다 — 정책 검증 결과는 **경고로** 함께 돌려준다.
 * **던지는 것은 테넌트 격리 위반 하나뿐이다**(§11.1).
 */
export async function runRetentionSweep(p: RetentionSweepParams): Promise<RetentionSweepResult> {
  assertTenantScope(p.inventory.scope);
  if (p.policy.tenantId !== p.inventory.scope.tenantId) {
    throw new Error(
      `보존 정책의 테넌트가 파기 목록과 다릅니다: ${p.policy.tenantId} ≠ ${p.inventory.scope.tenantId} (설계서 §11.1)`,
    );
  }

  const refusalsKo: string[] = [];
  const warningsKo: string[] = [];
  const limitsKo = [...p.inventory.limitsKo];
  const classesWithoutEvidence = [...p.inventory.classesWithoutEvidence];

  if (!isZonedIso(p.at)) {
    refusalsKo.push('실행 시각이 오프셋 명시 ISO8601 이 아닙니다 — 만료 판정 기준이 서버마다 달라집니다 (설계서 §13-3)');
  }
  if (!p.inventory.usable) {
    refusalsKo.push(
      `파기 목록을 근거로 쓸 수 없습니다: ${p.inventory.noteKo ?? '투영이 잘렸습니다'} — 기산 시점을 보장할 수 없는 목록으로 지우지 않습니다 (설계서 §8.2)`,
    );
  }
  if (refusalsKo.length > 0) {
    return {
      status: 'refused',
      messageKo: '파기를 실행하지 않았습니다 — 저장소를 건드리지 않았습니다.',
      refusalsKo,
      warningsKo,
      limitsKo,
      classesWithoutEvidence,
    };
  }

  // 정책 결함은 경고다(위 설명). `decide` 가 분류별로 `blocked` 를 적는다.
  for (const e of validateRetentionPolicy(p.policy)) warningsKo.push(`보존 정책 결함: ${e}`);
  if (classesWithoutEvidence.length > 0) {
    warningsKo.push(
      `원장에 근거가 없어 이 스윕에 포함되지 않는 분류: ${classesWithoutEvidence.join(', ')} — 해당 저장소가 레코드를 선언해야 파기됩니다 (설계서 §8.2)`,
    );
  }
  if (p.inventory.declaredRejectionsKo.length > 0) {
    warningsKo.push(`받지 않은 선언 레코드 사유: ${p.inventory.declaredRejectionsKo.join(' · ')}`);
  }
  if (p.inventory.noteKo !== undefined) warningsKo.push(`파기 목록: ${p.inventory.noteKo}`);

  const plan = planDisposition(p.inventory.records, p.policy, p.at);

  if (p.inventory.records.length === 0) {
    return {
      status: 'empty',
      messageKo: `파기 목록이 비었습니다 — 투영 범위에 근거가 없었습니다(이벤트 ${p.inventory.counters.eventsCounted}건 · 세션 ${p.inventory.counters.sessionsSeen}건). "지울 것이 없음"과 다릅니다.`,
      refusalsKo,
      warningsKo,
      limitsKo,
      classesWithoutEvidence,
      plan,
    };
  }

  const execution = await executeDisposition({
    scope: p.inventory.scope,
    plan,
    port: p.port,
    at: p.at,
    ...(p.activation !== undefined ? { activation: p.activation } : {}),
    ...(p.limit !== undefined ? { limit: p.limit } : {}),
    ...(p.timeoutMs !== undefined ? { timeoutMs: p.timeoutMs } : {}),
    ...(p.audit !== undefined ? { audit: p.audit } : {}),
  });
  warningsKo.push(...execution.warnings);

  const c = execution.counts;
  return {
    // 활성화 판정은 `executeDisposition` 의 것을 읽는다 — 여기서 다시 세면 §2 다.
    status: execution.activation === 'enabled' ? 'executed' : 'dry_run',
    messageKo:
      `파기 대상 ${c.due}건 · 처리 ${c.disposed}건 · 실패 ${c.failed}건 · 미지원 ${c.unsupported}건 · ` +
      `드라이런 ${c.dryRun}건 · 막힘 ${c.blocked}건 · 보류 ${c.held}건 (목록 ${p.inventory.records.length}건)`,
    refusalsKo,
    warningsKo,
    limitsKo,
    classesWithoutEvidence,
    plan,
    execution,
  };
}
