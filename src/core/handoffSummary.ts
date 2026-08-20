// Handoff 요약 생성기 — 설계서 §2(핸드오프 단절 해소)·§10.3(저장·표시 전 마스킹)·§11.1(테넌트 스코프).
//
// 문제: AI가 5분간 물어본 내용이 상담사에게 전달되지 않아, 고객이 "아까 다 말했는데요"를 반복한다.
// 이관 순간에 필요한 것은 "대화 전문"이 아니라 (1) 왜 넘어왔는지 (2) 무엇을 이미 받았는지
// (3) 무엇이 비었는지 (4) 직전 몇 마디 — 이 네 가지다. 그래서 요약은 이 구조로 고정한다.
//
// 이 모듈은 순수 함수다. LLM을 호출하지 않는다(추상 요약은 [승인 필요] 스텁으로만 둔다).
// 규칙 기반이라 결정적이고, 이관 지연이 모델 응답에 좌우되지 않는다.
import type { ChannelKind, Handoff, Interaction, Turn } from '../domain/types.ts';
import type { Flow } from '../flow/types.ts';
import { maskPii } from './policyGuard.ts';
import { assertTenantScope } from './tenancy.ts';

export type SummaryGenerator = 'rule' | 'llm';

export interface SummarySlot {
  key: string;
  label: string;
  value: string;
  /** 이 슬롯 값에 마스킹이 적용되었는지 (§10.3) */
  masked: boolean;
}

export interface SummaryLine {
  at: string;
  speaker: Turn['speaker'];
  text: string;
  nodeId?: string;
  intent?: string;
}

export interface HandoffSummary {
  interactionId: string;
  tenantId: string;
  workspaceId?: string;
  generatedAt: string;
  generator: SummaryGenerator;
  reason: Handoff['reason'];
  reasonLabelKo: string;
  toQueue?: string;
  channels: ChannelKind[];
  /** §5.2 — 통화 중 화면으로 전환된 세션인지. 상담사가 맥락을 오해하지 않도록 명시한다. */
  channelSwitched: boolean;
  turnCount: number;
  /** 실제 타임스탬프 차이로만 계산한다. 목표치·기준치는 넣지 않는다(§13-3). */
  durationMs?: number;
  lastIntent?: string;
  collectedSlots: SummarySlot[];
  pendingSlots: string[];
  recentTurns: SummaryLine[];
  piiMasked: boolean;
  piiKinds: string[];
  /** 상담사 화면·CTI 팝업에 그대로 붙일 수 있는 평문. 이미 마스킹을 통과했다. */
  text: string;
}

export interface SummaryOptions {
  /** 상담사에게 보여줄 최근 턴 수. 화면 표시 설정값이며 성능·KPI 수치가 아니다. */
  recentTurns?: number;
  /** 슬롯 키 → 상담사에게 보일 한글 라벨 */
  slotLabels?: Record<string, string>;
  /** 마스킹 규칙으로 잡히지 않지만 요약에 값을 노출하면 안 되는 슬롯 키 */
  hideSlotValues?: string[];
  /** 시나리오가 요구하는 슬롯 목록. 주면 미수집 슬롯을 계산한다. requiredSlotsOf(flow)로 뽑을 수 있다. */
  requiredSlots?: string[];
  /** 시각 주입 — 테스트 결정성 유지 */
  now?: () => string;
}

const DEFAULT_RECENT_TURNS = 6;
const HIDDEN_VALUE = '***';

const REASON_KO: Record<Handoff['reason'], string> = {
  low_confidence: '인식 신뢰도 부족',
  customer_request: '고객이 상담사 연결을 요청',
  policy: '정책상 상담사 처리 대상',
  error: '시스템 오류',
  max_retry: '재시도 한도 초과',
};

const SPEAKER_KO: Record<Turn['speaker'], string> = {
  customer: '고객',
  bot: 'AI',
  agent: '상담사',
};

const CONFIRM_KO: Record<string, string> = { yes: '예', no: '아니오' };

/** `__goal_completed__` 같은 실행 내부 슬롯은 상담사에게 의미가 없다. */
function isInternalSlot(key: string): boolean {
  return key.startsWith('__');
}

function labelOf(key: string, opts: SummaryOptions): string {
  const given = opts.slotLabels?.[key];
  if (given) return given;
  if (key.endsWith('__confirmed')) {
    const base = key.slice(0, -'__confirmed'.length);
    return `${opts.slotLabels?.[base] ?? base} 확인`;
  }
  return key;
}

function parseTime(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** 실측 경과시간만 사람이 읽는 형식으로 바꾼다. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const parts: string[] = [];
  if (h) parts.push(`${h}시간`);
  if (m) parts.push(`${m}분`);
  if (s || parts.length === 0) parts.push(`${s}초`);
  return parts.join(' ');
}

/** Flow에서 수집이 필요한 슬롯 키를 뽑는다(§5.3 Collect 노드). 미수집 항목 계산용. */
export function requiredSlotsOf(flow: Flow): string[] {
  const out: string[] = [];
  for (const node of Object.values(flow.nodes)) {
    if (node.kind === 'Collect' && !out.includes(node.slot)) out.push(node.slot);
  }
  return out;
}

/** §2 — 상담사 이관 요약. 저장·표시 경로이므로 모든 본문이 maskPii를 통과한다(§10.3). */
export function buildHandoffSummary(i: Interaction, opts: SummaryOptions = {}): HandoffSummary {
  const scope = i.workspaceId !== undefined
    ? { tenantId: i.tenantId, workspaceId: i.workspaceId }
    : { tenantId: i.tenantId };
  assertTenantScope(scope);

  const handoff = i.handoff;
  if (!handoff) {
    throw new Error('핸드오프가 없는 Interaction에는 이관 요약을 생성하지 않는다 (설계서 §2)');
  }

  const kinds = new Set<string>();
  const hide = new Set(opts.hideSlotValues ?? []);

  // 슬롯 — 내부 슬롯 제외, 값은 마스킹 후 노출
  const collectedSlots: SummarySlot[] = [];
  for (const [key, raw] of Object.entries(i.entities)) {
    if (isInternalSlot(key)) continue;
    if (hide.has(key)) {
      collectedSlots.push({ key, label: labelOf(key, opts), value: HIDDEN_VALUE, masked: true });
      continue;
    }
    const normalized = key.endsWith('__confirmed') ? (CONFIRM_KO[raw] ?? raw) : raw;
    const m = maskPii(normalized);
    for (const k of m.hits) kinds.add(k);
    collectedSlots.push({ key, label: labelOf(key, opts), value: m.text, masked: m.masked });
  }

  const collectedKeys = new Set(collectedSlots.map(s => s.key));
  const pendingSlots = (opts.requiredSlots ?? []).filter(k => !collectedKeys.has(k));

  // 직전 대화 — 뒤에서 N턴
  const take = Math.max(0, opts.recentTurns ?? DEFAULT_RECENT_TURNS);
  const window = take === 0 ? [] : i.turns.slice(Math.max(0, i.turns.length - take));
  const recentTurns: SummaryLine[] = window.map(t => {
    const m = maskPii(t.utterance);
    for (const k of m.hits) kinds.add(k);
    const line: SummaryLine = { at: t.at, speaker: t.speaker, text: m.text };
    if (t.intent !== undefined) line.intent = t.intent;
    return line;
  });

  const lastIntent = [...i.turns].reverse().find(t => t.intent !== undefined)?.intent;

  const startedMs = parseTime(i.startedAt);
  const endedMs = parseTime(i.endedAt) ?? parseTime(handoff.at) ?? parseTime(i.turns[i.turns.length - 1]?.at);
  const durationMs = startedMs !== undefined && endedMs !== undefined && endedMs >= startedMs
    ? endedMs - startedMs
    : undefined;

  const summary: HandoffSummary = {
    interactionId: i.id,
    tenantId: i.tenantId,
    generatedAt: (opts.now ?? (() => new Date().toISOString()))(),
    generator: 'rule',
    reason: handoff.reason,
    reasonLabelKo: REASON_KO[handoff.reason],
    channels: [...i.channels],
    channelSwitched: i.channels.length > 1,
    turnCount: i.turns.length,
    collectedSlots,
    pendingSlots,
    recentTurns,
    piiMasked: kinds.size > 0,
    piiKinds: [...kinds].sort(),
    text: '',
  };
  if (i.workspaceId !== undefined) summary.workspaceId = i.workspaceId;
  if (handoff.toQueue !== undefined) summary.toQueue = handoff.toQueue;
  if (durationMs !== undefined) summary.durationMs = durationMs;
  if (lastIntent !== undefined) summary.lastIntent = lastIntent;

  summary.text = renderSummaryText(summary);
  return summary;
}

/** 상담사 화면용 평문 렌더링. 입력이 이미 마스킹된 HandoffSummary이므로 재마스킹하지 않는다. */
export function renderSummaryText(s: HandoffSummary): string {
  const L: string[] = [];
  L.push(`[상담사 이관 요약] ${s.interactionId} · 테넌트 ${s.tenantId}`);
  L.push(`이관 사유: ${s.reasonLabelKo} (${s.reason})`);
  if (s.toQueue) L.push(`연결 큐: ${s.toQueue}`);
  L.push(`채널: ${s.channels.join(' → ')}${s.channelSwitched ? ' (전환 있음)' : ''}`);
  const progress = [`${s.turnCount}턴`];
  if (s.durationMs !== undefined) progress.push(formatDuration(s.durationMs));
  L.push(`진행: ${progress.join(' · ')}`);
  if (s.lastIntent) L.push(`직전 의도: ${s.lastIntent}`);

  L.push('수집 정보');
  if (s.collectedSlots.length === 0) L.push('  - 없음');
  else for (const c of s.collectedSlots) L.push(`  - ${c.label}: ${c.value}`);

  if (s.pendingSlots.length > 0) {
    L.push('미수집 정보');
    for (const p of s.pendingSlots) L.push(`  - ${p}`);
  }

  L.push('직전 대화');
  if (s.recentTurns.length === 0) L.push('  - 없음');
  else for (const t of s.recentTurns) L.push(`  [${SPEAKER_KO[t.speaker]}] ${t.text}`);

  L.push(`개인정보 마스킹: ${s.piiMasked ? s.piiKinds.join(', ') : '해당 없음'} (설계서 §10.3)`);
  return L.join('\n');
}

/** 요약을 Interaction에 부착한다. text는 이미 마스킹을 통과한 값이다(§10.3). */
export function attachHandoffSummary(i: Interaction, summary: HandoffSummary): Interaction {
  if (!i.handoff) {
    throw new Error('핸드오프가 없는 Interaction에는 이관 요약을 부착하지 않는다 (설계서 §2)');
  }
  i.handoff.summary = summary.text;
  return i;
}

/**
 * [승인 필요] LLM 추상 요약.
 * 규칙 기반 요약과 달리 실모델 호출이 필요하므로 승인 전까지 비활성이다
 * ("build now, activate on approval"). 인터페이스만 고정해 두고, 승인 시 §6.2 LlmAdapter를 주입한다.
 */
export interface AbstractiveSummarizer {
  readonly name: string;
  summarize(input: HandoffSummary): Promise<string>;
}

export function buildAbstractiveSummary(_summary: HandoffSummary, _llm: AbstractiveSummarizer): Promise<string> {
  return Promise.reject(new Error(
    '[승인 필요] LLM 추상 요약은 승인 전까지 비활성이다. 규칙 기반 buildHandoffSummary를 사용하라.',
  ));
}
