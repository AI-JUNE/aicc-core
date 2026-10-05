// 상호작용 조회의 실행 경로 — 설계서 §7 2.2(상호작용 조회)·§8.1(이벤트가 유일한 원천)·
// §10.2(접근·변경 기록)·§10.3(마스킹)·§11.1(테넌트 격리)·§13-3(실측만).
//
// 왜 이 파일이 필요한가. `interactionQuery.ts` 는 조회의 **규약**을 다 갖췄다 — 기간 강제, 스코프 강제,
// 개인정보 검색어 차단, 커서 페이징, 조회 감사 항목. 그런데 그 규약이 기다리는 `InteractionSummary`
// 를 **만드는 코드가 저장소 전체에 0줄**이었다. `validateQuery`·`matchesQuery`·`runQuery`·
// `toStorageFilter` 전부 그 행을 입력으로 받는데, §8.1 이벤트에서 그 행을 뽑는 자리가 없었다.
// 즉 상호작용 조회는 **어떤 세션도 보여준 적이 없다**. 이 미배선은 조용하다: 화면이 비는 것이 아니라
// 화면에서 "그 기간에 통화가 없었다"와 "조회가 한 번도 돈 적이 없다"가 똑같이 0건으로 보인다.
// 드러나는 시점은 민원·감독기관 점검이고, 그때 필요한 것은 지금의 목록이 아니라 지나간 통화의 기록이다.
//
// 두 번째 공백도 같이 메운다. 조회 **기록**이 자동으로 남지 않았다 — `buildQueryAudit` 는 있지만
// 실행(`runQuery`)과 분리돼 있어 화면이 빼먹을 수 있고, 무엇보다 **거부**(권한·테넌트 위반)는
// `recordAccess` 를 지나야 남는데 그 경로가 없었다. `audit/access.ts` 가 "화면마다 손으로 짜면 반드시
// 빠지는 곳이 생기고, 사고 조사 때 하필 그 화면이 비어 있다"고 적어 둔 그 실패를 조회 화면이 그대로
// 반복할 자리였다.
//
// 이 파일이 하지 않는 일:
//  - **판정을 복사하지 않는다(§2)**: 질의 검증은 `validateQuery`, 행 선별은 `runQuery`,
//    권한·기록은 `recordAccess`, 필터 요약 문구는 `buildQueryAudit` 하나씩이다. 여기서 다시 세지 않는다.
//  - **Outcome 을 재판정하지 않는다**: `session.ended.outcome` 을 그대로 적는다. `resolveOutcome` 을
//    다시 부르면 리포트(§7 7.6)와 조회 화면의 결과가 갈린다.
//  - **없는 값을 만들지 않는다(§13-3)**: 종료 시각·결과·통화 길이는 이벤트에 있을 때만 채운다.
//    이벤트 시각 차이로 통화 길이를 계산하면 `reports/aggregate.ts` 의 `sessionsMissingDuration` 과
//    숫자가 갈려 두 화면이 서로 다른 값을 보여준다.
//  - **저장하지 않는다**: 색인·캐시·조회 이력 보관은 호스트 몫이다(§6.2).
import type { ChannelKind, Handoff, Outcome } from '../domain/types.ts';
import type {
  HandoffRequestedEvent,
  InteractionEvent,
  SessionEndedEvent,
  TurnCompletedEvent,
} from '../events/schema.ts';
import type { EventLog, ReadOptions } from '../events/store.ts';
import { assertTenantScope, type TenantScope } from '../core/tenancy.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { AuditChain, AuditRecord, Hasher } from '../audit/log.ts';
import { decideAccess, recordAccess, type AccessActor, type AccessRequest } from '../audit/access.ts';
import {
  buildQueryAudit, runQuery, validateQuery,
  type InteractionQuery, type InteractionSummary, type QueryAuditEntry, type QueryIssue, type QueryLimits,
} from './interactionQuery.ts';

// ── 1) 이벤트 원장 → 조회 행 (투영) ───────────────────────────────────────────

export type TranscriptSpeaker = 'customer' | 'bot' | 'agent';

const SPEAKERS: readonly TranscriptSpeaker[] = ['customer', 'bot', 'agent'];

/**
 * 전문의 화자 표식. 출력 **형식**이므로 Core 가 정한다(검색·화면이 이 모양을 짝으로 읽는다).
 * 표식 없이 이어 붙이면 봇이 한 말이 고객 발화로 검색되는데, 그 오독은 운영 판단을 바꾼다.
 * 대괄호로 싸 두는 이유는 자연스러운 발화 문장과 섞이지 않게 하기 위해서다.
 */
export const SPEAKER_LABEL_KO: Record<TranscriptSpeaker, string> = {
  customer: '[고객]',
  bot: '[봇]',
  agent: '[상담사]',
};

export interface InteractionIndexOptions {
  scope: TenantScope;
  /**
   * 전문에 담을 화자. 주지 않으면 **관측된 그대로 전부** 담는다 —
   * 관측을 적는 것은 정책이 아니다. 빈 목록 선언은 거부한다(전문이 통째로 비면
   * "말이 없던 통화"로 읽힌다).
   */
  transcriptSpeakers?: readonly TranscriptSpeaker[];
  /** 수집 상한. 기본값 없음(§13-3) — 주지 않으면 전수 투영한다. */
  maxEvents?: number;
}

export interface InteractionIndexCounters {
  /** 실제로 투영에 들어간 이벤트 수. */
  eventsCounted: number;
  /** 같은 event_id 재전송(§8.1 멱등). 세지 않으면 전문에 같은 발화가 두 번 들어간다. */
  duplicatesDropped: number;
  /** 다른 테넌트 이벤트. 0 이 아니면 원장·전달 경로 버그다(§11.1) — 조용히 버리지 않는다. */
  foreignTenantDropped: number;
  /** event_id·interaction_id 가 없는 이벤트. 멱등 판정과 세션 묶음이 불가능하므로 담지 않는다(§8.1). */
  eventsRejected: number;
  /** 수집 상한을 넘겨 보지 않은 이벤트 수. 상한이 없으면 0 이다. */
  eventsSkipped: number;
  /** 상한에 걸려 잘렸는가. true 면 아래 세션 통계는 **그 범위 안에서만** 참이다. */
  truncated: boolean;
  /** `session.started` 를 못 본 세션 — 기간 경계에서 잘린 원장 조각이다. */
  sessionsWithoutStart: number;
  /** `session.ended` 를 못 본 세션. 폴백·누수로 끝난 통화가 전부 여기 들어온다. */
  sessionsWithoutEnd: number;
  /** 종료됐는데 `duration_ms` 가 없는 세션(아무도 재지 않았다). */
  sessionsMissingDuration: number;
  /** `duration_ms` 가 왔지만 쓸 수 없는 값이었다(음수·NaN·무한). "안 쟀다"와 대응이 다르다. */
  durationValuesRejected: number;
  /** 이관 요청이 둘 이상인 세션. 조회 행은 사유가 단수이므로 마지막 관측 건을 적는다. */
  sessionsWithMultipleHandoffs: number;
  /**
   * 원장의 발화에 마스킹이 **더** 걸린 턴 수. 0 이 아니면 그 원장에 마스킹을 지나지 않은 값이
   * 들어온 적이 있다는 뜻이다(§10.3 사고 신호). maskPii 는 자기 출력에 멱등이므로
   * 정상적으로 마스킹된 발화는 이 수에 들어오지 않는다.
   */
  turnsRemasked: number;
  /** 규약 밖 화자 등으로 전문에 담지 못한 턴. */
  turnsDropped: number;
}

export interface InteractionIndexResult {
  rows: InteractionSummary[];
  counters: InteractionIndexCounters;
  /** 화면·로그에 그대로 쓸 한 줄. 잘림·격리 위반 같은 사실을 감추지 않는다. 없으면 undefined. */
  noteKo?: string;
}

function newCounters(): InteractionIndexCounters {
  return {
    eventsCounted: 0,
    duplicatesDropped: 0,
    foreignTenantDropped: 0,
    eventsRejected: 0,
    eventsSkipped: 0,
    truncated: false,
    sessionsWithoutStart: 0,
    sessionsWithoutEnd: 0,
    sessionsMissingDuration: 0,
    durationValuesRejected: 0,
    sessionsWithMultipleHandoffs: 0,
    turnsRemasked: 0,
    turnsDropped: 0,
  };
}

interface Acc {
  id: string;
  tenantId: string;
  firstAt: string;
  startedAt?: string;
  endedAt?: string;
  sawStart: boolean;
  sawEnd: boolean;
  outcome?: Outcome;
  durationMs?: number;
  channels: ChannelKind[];
  intents: string[];
  handoffReason?: Handoff['reason'];
  handoffCount: number;
  lines: string[];
}

/**
 * 워크스페이스 단위 조회를 지원하지 않는 이유.
 * §8.1 이벤트에는 `workspace_id` 가 없고, 원장의 `append` 도 테넌트만 검사한다 —
 * 워크스페이스 스코프로 만든 원장에도 같은 테넌트의 다른 워크스페이스 이벤트가 들어온다.
 * 그래서 행에 워크스페이스를 적으면 **근거 없는 주장**이 되고, 워크스페이스 운영자가 테넌트
 * 전체 세션을 보게 된다(§11.1). 반대로 빈 값으로 두면 `matchesQuery` 가 전부 걸러
 * "그 기간에 통화 없음"으로 보인다. 둘 다 조용히 틀리므로 **지원하지 않는다고 적는다**.
 * 이벤트 스키마에 워크스페이스를 넣는 것은 §8.1 계약 변경이라 **[승인 필요]**.
 */
export const WORKSPACE_SCOPE_UNSUPPORTED_KO =
  '§8.1 이벤트에 워크스페이스 식별자가 없어 워크스페이스 단위 상호작용 조회를 지원하지 않는다 — 테넌트 범위로 조회하라 (설계서 §11.1)';

/**
 * §8.1 이벤트 → §7 2.2 조회 행.
 *
 * 순수 함수이며 순서가 곧 안전장치다: **격리 → 멱등 → 상한 → 세션 묶음 → 행 생성**.
 * 행을 마지막에 만들기 때문에 앞 단계에서 걸린 이벤트의 발화는 어떤 행에도 남지 않는다.
 */
export function projectInteractions(
  events: readonly InteractionEvent[],
  opts: InteractionIndexOptions,
): InteractionIndexResult {
  assertTenantScope(opts.scope);
  if (opts.scope.workspaceId !== undefined) throw new Error(WORKSPACE_SCOPE_UNSUPPORTED_KO);
  if (opts.maxEvents !== undefined && (!Number.isInteger(opts.maxEvents) || opts.maxEvents <= 0)) {
    throw new Error(`수집 상한(maxEvents)은 1 이상의 정수여야 한다: ${String(opts.maxEvents)} (설계서 §13-3)`);
  }
  if (opts.transcriptSpeakers !== undefined) {
    if (opts.transcriptSpeakers.length === 0) {
      throw new Error('전문 화자를 빈 목록으로 선언할 수 없다 — 전문이 통째로 비면 "말이 없던 통화"로 읽힌다 (설계서 §7 2.2)');
    }
    const unknown = opts.transcriptSpeakers.filter((s) => !SPEAKERS.includes(s));
    if (unknown.length > 0) {
      throw new Error(`알 수 없는 화자 선언: ${unknown.join(', ')} — 적용되지 않는 선언은 "설정했는데 왜 안 되지"로 끝난다`);
    }
  }

  const wanted = new Set<TranscriptSpeaker>(opts.transcriptSpeakers ?? SPEAKERS);
  const counters = newCounters();
  const seen = new Set<string>();
  const byId = new Map<string, Acc>();

  for (const e of events) {
    // 격리를 가장 먼저 본다. 남의 테넌트 이벤트는 상한에도 세지 않는다 — 세면 잘림 사유가 흐려진다.
    if (!e.tenant_id || e.tenant_id !== opts.scope.tenantId) {
      counters.foreignTenantDropped += 1;
      continue;
    }
    if (!e.event_id || !e.interaction_id) {
      counters.eventsRejected += 1;
      continue;
    }
    if (seen.has(e.event_id)) {
      counters.duplicatesDropped += 1;
      continue;
    }
    seen.add(e.event_id);
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
        tenantId: e.tenant_id,
        firstAt: e.occurred_at,
        sawStart: false,
        sawEnd: false,
        channels: [],
        intents: [],
        handoffCount: 0,
        lines: [],
      };
      byId.set(e.interaction_id, acc);
    }
    if (e.occurred_at < acc.firstAt) acc.firstAt = e.occurred_at;
    // §5.2 전환 — 채널은 관측된 전부의 합집합이다. 첫 이벤트 채널만 적으면
    // voice→visual 로 전환된 세션이 `visual` 필터에서 통째로 빠진다.
    if (!acc.channels.includes(e.channel)) acc.channels.push(e.channel);

    switch (e.type) {
      case 'session.started':
        acc.sawStart = true;
        if (acc.startedAt === undefined || e.occurred_at < acc.startedAt) acc.startedAt = e.occurred_at;
        break;
      case 'turn.completed': {
        const t = e as TurnCompletedEvent;
        if (!SPEAKERS.includes(t.speaker)) {
          counters.turnsDropped += 1;
          break;
        }
        // 인텐트는 전문이 아니라 메타데이터다 — 화자 선언으로 좁혀도 집계에서 빠지지 않는다.
        // 판정 규칙은 `reports/aggregate.ts` 와 같다(화자 무관, 값이 있을 때만).
        if (t.intent !== undefined && t.intent !== '' && !acc.intents.includes(t.intent)) {
          acc.intents.push(t.intent);
        }
        if (!wanted.has(t.speaker)) break;
        const raw = typeof t.utterance_masked === 'string' ? t.utterance_masked : '';
        if (raw.length === 0) break;      // 빈 발화는 전문에 줄을 만들지 않는다
        // 마지막 방어선. 원장에는 과거 호스트가 넣은 값도 남아 있다(§10.3).
        const remask = maskPii(raw);
        if (remask.masked) counters.turnsRemasked += 1;
        acc.lines.push(`${SPEAKER_LABEL_KO[t.speaker]} ${remask.text}`);
        break;
      }
      case 'handoff.requested': {
        const h = e as HandoffRequestedEvent;
        acc.handoffCount += 1;
        // 사유가 단수인 조회 행에서는 **마지막 관측 건**이 실제로 이관된 사유다.
        // 규칙을 여기 한 곳에만 두고, 둘 이상이었다는 사실은 카운터로 드러낸다.
        acc.handoffReason = h.reason;
        // h.summary_masked 는 전문에 담지 않는다(§2·§10.3). 상담사용 요약이 목록 화면의 키워드
        // 검색 대상이 되면, 고객에게 보여서는 안 되는 문장이 비-PII 목록 경로로 새어 나간다.
        break;
      }
      case 'session.ended': {
        const s = e as SessionEndedEvent;
        acc.sawEnd = true;
        if (acc.endedAt === undefined || e.occurred_at > acc.endedAt) acc.endedAt = e.occurred_at;
        acc.outcome = s.outcome;
        if (s.duration_ms !== undefined) {
          if (typeof s.duration_ms === 'number' && Number.isFinite(s.duration_ms) && s.duration_ms >= 0) {
            acc.durationMs = s.duration_ms;
          } else {
            // 0 으로도 그대로도 적지 않는다 — "안 쟀다"와 "쓸 수 없는 값이 왔다"는 대응이 다르다.
            counters.durationValuesRejected += 1;
          }
        }
        break;
      }
    }
  }

  const rows: InteractionSummary[] = [];
  for (const acc of byId.values()) {
    if (!acc.sawStart) counters.sessionsWithoutStart += 1;
    // 종료 이벤트가 없는 세션도 **행을 만든다**. 빼면 폴백·누수로 끝난 통화 —
    // 민원·감독기관 점검에서 가장 먼저 열리는 통화들 — 이 영영 조회되지 않는다.
    if (!acc.sawEnd) counters.sessionsWithoutEnd += 1;
    if (acc.sawEnd && acc.durationMs === undefined) counters.sessionsMissingDuration += 1;
    if (acc.handoffCount > 1) counters.sessionsWithMultipleHandoffs += 1;
    rows.push({
      id: acc.id,
      tenantId: acc.tenantId,
      // 시작 이벤트가 없으면 **관측된 첫 이벤트 시각**을 쓴다(없는 시각을 만드는 것이 아니다).
      // 비워 두면 기간 필터가 `started_at` 기준이라 그 세션이 조회에서 사라진다.
      startedAt: acc.startedAt ?? acc.firstAt,
      ...(acc.endedAt !== undefined ? { endedAt: acc.endedAt } : {}),
      channels: [...acc.channels],
      ...(acc.outcome !== undefined ? { outcome: acc.outcome } : {}),
      intents: [...acc.intents],
      ...(acc.handoffReason !== undefined ? { handoffReason: acc.handoffReason } : {}),
      transcriptMasked: acc.lines.join('\n'),
      ...(acc.durationMs !== undefined ? { durationMs: acc.durationMs } : {}),
    });
  }
  rows.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));

  const note = indexNoteKo(counters);
  return { rows, counters, ...(note !== undefined ? { noteKo: note } : {}) };
}

/** 투영에서 숨기면 안 되는 사실만 한 줄로. 판정·점수는 만들지 않는다(§13-3). */
export function indexNoteKo(c: InteractionIndexCounters): string | undefined {
  const parts: string[] = [];
  if (c.truncated) parts.push(`수집 상한에 걸려 ${c.eventsSkipped}건을 보지 않았다 — 기간을 좁혀 다시 투영하라`);
  if (c.foreignTenantDropped > 0) parts.push(`다른 테넌트 이벤트 ${c.foreignTenantDropped}건 제외(§11.1 — 전달 경로를 점검하라)`);
  if (c.eventsRejected > 0) parts.push(`식별자 없는 이벤트 ${c.eventsRejected}건 제외(§8.1)`);
  if (c.duplicatesDropped > 0) parts.push(`중복 이벤트 ${c.duplicatesDropped}건 제외`);
  if (c.turnsRemasked > 0) parts.push(`마스킹을 지나지 않은 발화 ${c.turnsRemasked}턴 발견(§10.3 — 저장 경로를 점검하라)`);
  if (c.turnsDropped > 0) parts.push(`규약 밖 화자 ${c.turnsDropped}턴 제외`);
  if (c.sessionsWithoutEnd > 0) parts.push(`종료 기록이 없는 세션 ${c.sessionsWithoutEnd}건`);
  if (c.sessionsWithoutStart > 0) parts.push(`시작 기록이 없는 세션 ${c.sessionsWithoutStart}건(기간 경계에서 잘렸다)`);
  if (c.durationValuesRejected > 0) parts.push(`쓸 수 없는 통화 길이 ${c.durationValuesRejected}건 거부`);
  if (c.sessionsMissingDuration > 0) parts.push(`통화 길이 실측이 없는 종료 세션 ${c.sessionsMissingDuration}건`);
  if (c.sessionsWithMultipleHandoffs > 0) parts.push(`이관 요청이 둘 이상인 세션 ${c.sessionsWithMultipleHandoffs}건(마지막 사유를 적었다)`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * 원장에서 바로 투영한다. 스코프는 **원장이 가진 것**을 쓴다 —
 * 호스트가 테넌트를 주장하지 못하게 하는 것은 브리지와 같은 규칙이다(§11.1).
 */
export function projectFromLog(
  log: EventLog,
  opts: Omit<InteractionIndexOptions, 'scope'> = {},
  read?: ReadOptions,
): InteractionIndexResult {
  return projectInteractions(log.read(read).map((r) => r.event), { ...opts, scope: log.scope });
}

// ── 2) 감사에 묶인 조회 경로 ──────────────────────────────────────────────────

/** 목록 화면 라우트(§7 7.2). 다른 라우트로 조회하는 경로를 따로 만들지 않는다. */
export const INTERACTION_LIST_ROUTE_ID = 'interactions.list';

export type InteractionQueryStatus =
  | 'ok'                 // 행을 돌려줬다
  | 'empty'              // 권한·질의 모두 정상이지만 해당 행이 없다(빈 상태 안내)
  | 'invalid'            // 질의 규약 위반 — 저장소까지 내려보내지 않았다
  | 'unsupported_scope'  // 워크스페이스 단위 조회(위 설명)
  | 'denied';            // 권한·격리 위반

export interface InteractionQueryRequest {
  actor: AccessActor;
  query: InteractionQuery;
  /**
   * 조회 대상 행. `projectInteractions`·`projectFromLog` 결과를 그대로 넘긴다 —
   * 이 함수는 다시 투영하지 않는다(판정과 부작용을 한 함수에 묶지 않는다).
   */
  rows: readonly InteractionSummary[];
  at: string;        // ISO8601 — 주입(순수 함수 유지, §13-3)
  recordId: string;  // 감사 레코드 식별자 — 생성기는 호스트가 가진다
  /** 라우트를 덮어쓸 때만(상세 화면에서의 조회 등). 기본은 목록 라우트. */
  routeId?: string;
}

export interface InteractionQueryOptions {
  /** `QueryLimits` — 기간·페이지 상한. 운영·법무가 정한 값만 들어온다(§13-3). */
  limits: QueryLimits;
  /** 대량 조회 판단 기준. 조직마다 다르므로 호출자가 넣는다 — 기본값 없음(§13-3). */
  bulkViewThreshold?: number;
  /**
   * 목록에 실어 보낼 전문 길이. 주지 않으면 **전문을 그대로** 돌려주고 그 사실을
   * `transcriptFull` 로 적는다 — 조용히 줄이지도, 조용히 다 보내지도 않는다.
   */
  snippetChars?: number;
}

export interface InteractionQueryResult {
  status: InteractionQueryStatus;
  /** 화면에 그대로 띄울 한 줄. 빈 상태·거부 상태에서 다음 행동을 알려 준다(품질기준 §1). */
  messageKo: string;
  rows: InteractionSummary[];
  nextCursor?: string;
  resultCount: number;
  /** 넘긴 행에 남의 테넌트가 섞여 있던 수. 0 이 아니면 저장소 어댑터 버그다(§11.1). */
  scopeViolationsDropped: number;
  /** 항목 단위 검증 결과 — 포털이 인라인으로 표시한다(던지지 않는 이유). */
  issues: QueryIssue[];
  /** 임계값이 주어졌고 그 이상을 조회한 경우에만 true. 임계값이 없으면 판정하지 않는다. */
  bulk: boolean;
  /** 전문을 잘라 실었는가(`snippetChars` 선언 시). */
  snippetApplied: boolean;
  /** 전문을 그대로 실었는가. 선언이 없으면 true — 그 사실을 감추지 않는다(§10.3). */
  transcriptFull: boolean;
  /** 조회 이력 화면용 항목. 감사의 **원천은 체인**이며 이것은 사본이다. */
  audit?: QueryAuditEntry;
  chain: AuditChain;
  recorded: boolean;
  record?: AuditRecord;
}

const ELLIPSIS = '…';

/** 키워드가 보이는 창으로 자른다. 키워드가 없으면 앞에서부터. 자른 쪽에는 표시를 남긴다. */
export function transcriptSnippet(text: string, maxChars: number, keyword?: string): string {
  if (text.length <= maxChars) return text;
  const k = keyword?.trim().toLowerCase() ?? '';
  const hit = k.length > 0 ? text.toLowerCase().indexOf(k) : -1;
  if (hit < 0) return `${text.slice(0, maxChars)}${ELLIPSIS}`;
  const half = Math.max(0, Math.floor((maxChars - k.length) / 2));
  const start = Math.max(0, hit - half);
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? ELLIPSIS : ''}${text.slice(start, end)}${end < text.length ? ELLIPSIS : ''}`;
}

/** 행 복사 — 호출자가 돌려받은 객체를 고쳐도 감사에 적힌 조회 결과와 어긋나지 않게. */
function copyRow(r: InteractionSummary, transcript: string): InteractionSummary {
  return {
    ...r,
    channels: [...r.channels],
    intents: [...r.intents],
    transcriptMasked: transcript,
  };
}

function detailKo(parts: readonly (string | undefined)[]): string | undefined {
  const kept = parts.filter((v): v is string => typeof v === 'string' && v.length > 0);
  return kept.length > 0 ? kept.join(' · ') : undefined;
}

/**
 * 대량 조회 여부. 임계값이 없으면 **판정하지 않는다**(§13-3).
 * 감사 detail 의 대량 반출 문구는 `recordAccess` 가 쓴다 — 여기서 같은 문구를 또 만들면 §2 다.
 */
function isBulk(count: number, threshold: number | undefined): boolean {
  return threshold !== undefined && count >= threshold;
}

/**
 * 상호작용을 조회한다.
 *
 * 순서가 곧 안전장치다: **격리 → 질의 검증 → 권한·기록 → 행 선별 → 전문 적재**.
 * 전문을 마지막에 싣기 때문에 앞의 어느 단계에서 걸려도 발화가 호출자에게 남지 않는다.
 *
 * 기록 규칙:
 *  - **거부는 항상 남는다**(`recordAccess` 가 보장한다).
 *  - **성공도 항상 남긴다.** `interactions.list` 는 `pii:false` 라 `shouldAudit` 가 거짓이지만,
 *    마스킹 전문을 조건으로 훑는 행위는 성격이 다르다 — 그래서 `recordAllReads` 를 켠다(§10.2).
 *  - **형태 오류는 남기지 않는다**(열람이 일어나지 않았다). 단 **개인정보 패턴 검색어는 남긴다** —
 *    저장소에 그 값이 없어야 정상이므로, 그런 검색어가 들어왔다는 것 자체가 사고 신호다.
 *    검색어 원문은 적지 않고 차단 사실만 적는다(§10.3).
 */
export function queryInteractions(
  chain: AuditChain,
  req: InteractionQueryRequest,
  hash: Hasher,
  opts: InteractionQueryOptions,
): InteractionQueryResult {
  const routeId = req.routeId ?? INTERACTION_LIST_ROUTE_ID;
  if (opts.snippetChars !== undefined && (!Number.isInteger(opts.snippetChars) || opts.snippetChars <= 0)) {
    throw new Error(`전문 길이(snippetChars)는 1 이상의 정수여야 한다: ${String(opts.snippetChars)} (설계서 §13-3)`);
  }

  const empty = (
    status: InteractionQueryStatus,
    messageKo: string,
    out: { chain: AuditChain; recorded: boolean; record?: AuditRecord },
    extra: { issues?: QueryIssue[]; scopeViolationsDropped?: number } = {},
  ): InteractionQueryResult => ({
    status,
    messageKo,
    rows: [],
    resultCount: 0,
    scopeViolationsDropped: extra.scopeViolationsDropped ?? 0,
    issues: extra.issues ?? [],
    bulk: false,
    snippetApplied: false,
    transcriptFull: false,
    chain: out.chain,
    recorded: out.recorded,
    ...(out.record !== undefined ? { record: out.record } : {}),
  });

  // 1) 질의 검증. 권한 판정에 쓸 스코프 자체가 틀린 질의를 판정까지 끌고 가지 않는다.
  const issues = validateQuery(req.query, opts.limits);
  const scopeOk = !issues.some((i) => i.code === 'scope');
  if (!scopeOk) {
    // 테넌트를 모르면 어느 체인에도 남길 수 없다(§11.1). 남길 자리가 없다는 사실을 그대로 돌려준다.
    return empty('invalid', '조회 범위(테넌트)가 없다. 항목별 사유를 함께 돌려준다.', { chain, recorded: false }, { issues });
  }

  // 2) 워크스페이스 스코프. 0건으로 보여 주면 "그 기간에 통화 없음"과 구분되지 않는다.
  if (req.query.scope.workspaceId !== undefined) {
    return empty('unsupported_scope', WORKSPACE_SCOPE_UNSUPPORTED_KO, { chain, recorded: false });
  }

  const access: AccessRequest = {
    scope: req.query.scope,
    actor: req.actor,
    routeId,
    at: req.at,
    recordId: req.recordId,
    action: 'view',
  };

  // 3) 권한·격리를 먼저 **판정만** 한다(`decideAccess` 는 기록하지 않는다).
  //    기록을 두 번 하면 같은 조회가 감사에 두 줄로 남아 열람 건수가 실제보다 많아진다(§13-3).
  const decision = decideAccess(access);

  // 4) 개인정보 값으로 사람을 찾으려는 시도는 흘려보내지 않는다 —
  //    저장소에 그 값이 없어야 정상이므로, 그런 검색어가 들어왔다는 것 자체가 사고 신호다.
  //    권한이 없더라도 **시도 사실은 남는다**(거부 기록은 조사에서 가장 먼저 보는 자료다).
  if (issues.some((i) => i.code === 'keyword_pii')) {
    const outcome = recordAccess(chain, {
      ...access,
      affectedCount: 0,
      // 검색어 원문·마스킹본 모두 적지 않는다 — 차단된 값을 감사로그가 보관하면 안 된다.
      detail: '개인정보 패턴 검색어 차단(§10.3) — 열람 0건',
    }, hash, { recordAllReads: true });
    const out = { chain: outcome.chain, recorded: outcome.recorded, ...(outcome.record !== undefined ? { record: outcome.record } : {}) };
    // 권한이 없는 행위자에게 "검색어 때문에 막혔다"를 알려 주지 않는다 — 권한 유무 외의 정보를 흘리지 않는다.
    if (!decision.allowed) {
      return empty('denied', decision.messageKo ?? '이 화면에 접근할 권한이 없다.', out);
    }
    return empty(
      'invalid',
      '개인정보(주민등록번호·카드·계좌·연락처) 패턴은 검색어로 쓸 수 없다. 다른 조건으로 조회하라.',
      out,
      { issues },
    );
  }

  // 5) 그 밖의 형태 오류는 기록하지 않는다 — 열람이 일어나지 않았고, 남기면 조사에서 잡음이 된다.
  if (issues.length > 0) {
    return empty('invalid', '조회 조건을 확인하라. 항목별 사유를 함께 돌려준다.', { chain, recorded: false }, { issues });
  }

  // 6) 거부. 기록은 `recordAccess` 가 화면 성격과 무관하게 남긴다.
  if (!decision.allowed) {
    const outcome = recordAccess(chain, { ...access, affectedCount: 0, detail: '조회 거부 — 열람 0건' }, hash);
    return empty(
      'denied',
      decision.messageKo ?? '이 화면에 접근할 권한이 없다.',
      { chain: outcome.chain, recorded: outcome.recorded, ...(outcome.record !== undefined ? { record: outcome.record } : {}) },
    );
  }

  // 7) 행 선별. 판정은 `runQuery` 하나다 — 여기서 다시 거르지 않는다(§2).
  const page = runQuery([...req.rows], req.query);
  const audit = buildQueryAudit(req.query, {
    actorId: req.actor.userId,
    atIso: req.at,
    resultCount: page.rows.length,
  });
  const bulk = isBulk(page.rows.length, opts.bulkViewThreshold);

  // 8) 성공 기록. 필터 요약 문구는 `buildQueryAudit` 에서 가져온다 —
  //    같은 요약 규칙이 두 곳에 생기면 감사로그와 조회 이력 화면의 문구가 갈린다(§2).
  //    검색어는 `keyword=Y` 로만 남긴다(원문·마스킹본 모두 감사로그에 보관하지 않는다).
  const outcome = recordAccess(chain, {
    ...access,
    affectedCount: page.rows.length,
    detail: detailKo([
      `기간 ${audit.periodFrom}~${audit.periodTo}`,
      audit.filtersSummary.length > 0 ? audit.filtersSummary : '필터 없음',
      `조회 ${page.rows.length}건`,
      page.scopeViolationsDropped > 0
        ? `격리 위반 행 ${page.scopeViolationsDropped}건 제외(§11.1 — 저장소 어댑터를 점검하라)`
        : undefined,
    ]),
  }, hash, {
    recordAllReads: true,
    // 대량 반출 문구는 `recordAccess` 한 곳에서만 만든다(§2). 임계값이 없으면 판정하지 않는다.
    ...(opts.bulkViewThreshold !== undefined ? { bulkExportThreshold: opts.bulkViewThreshold } : {}),
  });

  const out = {
    chain: outcome.chain,
    recorded: outcome.recorded,
    ...(outcome.record !== undefined ? { record: outcome.record } : {}),
  };

  if (page.rows.length === 0) {
    return {
      ...empty('empty', '조건에 맞는 상호작용이 없다. 기간·채널·결과 조건을 넓혀 조회하라.', out),
      audit,
      scopeViolationsDropped: page.scopeViolationsDropped,
    };
  }

  const snippet = opts.snippetChars;
  const rows = page.rows.map((r) =>
    copyRow(r, snippet === undefined ? r.transcriptMasked : transcriptSnippet(r.transcriptMasked, snippet, req.query.keyword)),
  );

  return {
    status: 'ok',
    messageKo: `상호작용 ${rows.length}건을 조회했다.${bulk ? ' 대량 조회로 기록됐다.' : ''}`,
    rows,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    resultCount: rows.length,
    scopeViolationsDropped: page.scopeViolationsDropped,
    issues: [],
    bulk,
    snippetApplied: snippet !== undefined,
    transcriptFull: snippet === undefined,
    audit,
    ...out,
  };
}
