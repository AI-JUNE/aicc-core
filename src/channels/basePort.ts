// 채널 포트 베이스 구현 — 설계서 §1.2(Core 단일화)·§5.2(채널 전환)·§5.3(하나의 Flow)·
// §9.3(장애 폴백)·§10.3(마스킹)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// contract.ts 는 계약을, conformance.ts 는 검사기를 준다. 그런데 검사를 통과하는 포트를
// 채널 저장소 3곳이 각자 처음부터 쓰면, 세 번 모두 같은 지점에서 틀린다 —
// steps 배열을 그대로 가공해 §8.1 이력을 오염시키거나, end 중복 호출에서 죽거나,
// 전송 실패를 그냥 삼켜서 고객이 무응답을 보게 만든다. 이 세 가지는 검사 항목이기 전에
// 운영 사고 유형이다. 그래서 "매체에 실제로 내보내는 부분"만 남기고 나머지는 여기서 한 번만 구현한다.
//
// 채널 저장소가 할 일은 ChannelTransport 하나를 구현하는 것뿐이다. 나머지(입력 복사·종료 멱등·
// 예산 초과 처리·개인정보 마스킹·실패 보고)는 베이스가 책임진다.
//
// 무엇을 하지 않는가 (build now, activate on approval):
//  - 기본은 dry_run 이다. 이 상태에서는 transport 를 **호출하지 않고** 기록만 남긴다.
//  - live 전환은 승인 근거(approvalRef)와 transport 주입이 모두 있어야만 가능하다 — [승인 필요].
//  - 회선·메신저 프로토콜 코드는 여기 없다. 각 저장소의 transport 구현에 있다.
import type { ChannelKind } from '../domain/types.ts';
import type { RenderedStep } from '../flow/types.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { ChannelAdapterId, ChannelCapabilities, ChannelPort } from './contract.ts';
import { ADAPTER_CHANNEL } from './contract.ts';
import { profileFor } from './profiles.ts';

/** http.ts 의 Activation 과 같은 뜻이다. 채널도 같은 규칙으로 잠근다. */
export type ChannelActivation = 'dry_run' | 'live';

export type ChannelPortErrorCode =
  | 'E_APPROVAL_REQUIRED'  // 승인 근거 없이 live 를 켜려 함
  | 'E_CONFIG'             // 능력 선언과 구현이 어긋남
  | 'E_TRANSPORT'          // 매체 전송 거부
  | 'E_TIMEOUT';           // 예산 안에 정착하지 않음

export class ChannelPortError extends Error {
  readonly code: ChannelPortErrorCode;
  constructor(code: ChannelPortErrorCode, messageKo: string) {
    super(messageKo);
    this.name = 'ChannelPortError';
    this.code = code;
  }
}

/** 베이스가 transport 에 넘기는 지시. 발화 원문은 steps 안에만 있고, 기록·오류에는 남지 않는다(§10.3). */
export interface DeliveryEnvelope {
  interactionId: string;
  adapter: ChannelAdapterId;
  channel: ChannelKind;
  kind: 'present' | 'transfer' | 'routeToLegacyIvr' | 'invite' | 'end';
  /** present 전용. 베이스가 동결한 복사본이므로 transport 가 수정할 수 없다. */
  steps?: readonly RenderedStep[];
  queue?: string;
  /** 이미 마스킹된 이관 요약(§2·§10.3). 베이스는 이 값을 다시 마스킹하지 않는다. */
  summaryMasked?: string;
  reasonKo?: string;
  target?: ChannelKind;
}

/**
 * 채널 저장소가 구현하는 유일한 부분 — 실제 매체로 내보내기.
 * 실패는 예외로 던진다. 베이스가 잡아서 마스킹·기록·보고로 바꾼다.
 */
export interface ChannelTransport {
  readonly name: string;
  deliver(env: DeliveryEnvelope): Promise<void>;
}

/** 전송 시도 기록. 발화 원문·개인정보를 담지 않는다(§10.3) — 개수와 마스킹된 사유만 남는다. */
export interface DeliveryRecord {
  kind: DeliveryEnvelope['kind'];
  interactionId: string;
  ok: boolean;
  /** dry_run 이라 매체로 나가지 않은 경우 true. */
  simulated: boolean;
  stepCount?: number;
  detail?: string;
  errorCode?: ChannelPortErrorCode;
  /** 실측 소요(ms). clock 주입이 없으면 기록하지 않는다 — 기본값을 만들어 넣지 않는다(§13-3). */
  durationMs?: number;
  /** 중복 종료처럼 매체 호출 없이 흡수한 경우. */
  suppressed?: boolean;
}

export interface ChannelPortOptions {
  id: ChannelAdapterId;
  capabilities?: ChannelCapabilities;
  /** 기본 dry_run. live 는 사람이 명시적으로 켠다. */
  activation?: ChannelActivation;
  /** live 활성화 근거(승인자·티켓). 없으면 live 로 만들 수 없다. */
  approvalRef?: string;
  /** 실전송 구현. dry_run 에서는 호출되지 않는다. */
  transport?: ChannelTransport;
  /** 호출 하나가 정착해야 하는 예산(ms). 계약값을 넣는다 — 코드 기본값을 두지 않는다(§13-3). */
  timeoutMs?: number;
  /**
   * 실패 통지. 채널 계약상 포트 메서드는 "접수했다"까지만 뜻하므로 예외를 위로 던지지 않는다.
   * 대신 실패는 반드시 이 훅과 failures 로 드러난다 — 삼키지 않는다(품질기준 §3).
   */
  onFailure?: (record: DeliveryRecord) => void;
  /** 지연 실측용 시계(ms). 주입하지 않으면 durationMs 를 기록하지 않는다. */
  clock?: () => number;
  /** 보관할 기록 수 상한. 장시간 운영에서 메모리가 무한히 늘지 않게 한다. */
  maxRecords?: number;
}

export interface BaseChannelPort extends ChannelPort {
  readonly activation: ChannelActivation;
  readonly records: readonly DeliveryRecord[];
  readonly failures: readonly DeliveryRecord[];
  reset(): void;
}

const DEFAULT_MAX_RECORDS = 500;

/** 오류를 사람이 읽을 수 있게 만들되, 개인정보 원문이 섞여 있으면 마스킹한다(§10.3). */
function safeErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return maskPii(raw).text;
}

async function withTimeout(p: Promise<void>, ms: number | undefined): Promise<void> {
  if (ms === undefined) return p;
  // 예산을 넘긴 뒤 뒤늦게 거부되는 promise 가 unhandled rejection 으로 프로세스를 죽이지 않게 한다.
  let settledByRace = false;
  p.catch(() => { if (settledByRace) { /* 이미 실패로 기록됨 */ } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<'__timeout__'>((resolve) => {
    timer = setTimeout(() => resolve('__timeout__'), ms);
  });
  try {
    const r = await Promise.race([p.then(() => '__ok__' as const), guard]);
    if (r === '__timeout__') {
      settledByRace = true;
      throw new ChannelPortError('E_TIMEOUT', `매체 전송이 ${ms}ms 예산 안에 정착하지 않았습니다.`);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * 계약을 지키는 채널 포트를 만든다. 저장소는 transport 만 구현하면 적합성 스위트를 통과한다.
 *
 * 설계 결정 두 가지:
 *  1) 메서드는 예외를 던지지 않는다. 채널 계약이 "접수했다"까지만 약속하기 때문이다.
 *     대신 실패는 failures·onFailure 로 드러나고, 이 값이 §9.3 헬스 보고의 입력이 된다.
 *  2) steps 는 동결 복사본으로 넘긴다. 같은 배열이 §8.1 이벤트·이력에 쓰이므로,
 *     transport 가 실수로 건드려도 Core 쪽 이력이 오염되지 않아야 한다.
 */
export function createChannelPort(opts: ChannelPortOptions): BaseChannelPort {
  const capabilities = opts.capabilities ?? profileFor(opts.id);
  if (capabilities.adapter !== opts.id || capabilities.channel !== ADAPTER_CHANNEL[opts.id]) {
    throw new ChannelPortError('E_CONFIG', `능력 선언이 어댑터(${opts.id})와 어긋납니다. 등록이 거부됩니다.`);
  }
  const activation: ChannelActivation = opts.activation ?? 'dry_run';
  if (activation === 'live') {
    if (!opts.approvalRef) {
      throw new ChannelPortError('E_APPROVAL_REQUIRED', '[승인 필요] live 전송에는 승인 근거(approvalRef)가 필요합니다.');
    }
    if (!opts.transport) {
      throw new ChannelPortError('E_CONFIG', 'live 인데 transport 구현이 없습니다. 내보낼 매체가 없습니다.');
    }
  }

  const records: DeliveryRecord[] = [];
  const ended = new Set<string>();
  const maxRecords = opts.maxRecords ?? DEFAULT_MAX_RECORDS;

  function push(r: DeliveryRecord): void {
    records.push(r);
    if (records.length > maxRecords) records.splice(0, records.length - maxRecords);
    if (!r.ok && opts.onFailure) {
      // 통지 훅이 던져도 채널 턴이 죽으면 안 된다.
      try { opts.onFailure(r); } catch { /* 통지 실패는 전송 실패를 덮지 않는다 */ }
    }
  }

  async function run(env: DeliveryEnvelope, base: Omit<DeliveryRecord, 'ok' | 'simulated'>): Promise<void> {
    const started = opts.clock?.();
    const finish = (): number | undefined => {
      if (started === undefined || !opts.clock) return undefined;
      return opts.clock() - started;
    };
    if (activation !== 'live' || !opts.transport) {
      // dry_run: 매체를 건드리지 않는다. 기록만 남기고 성공으로 접수한다 — [승인 필요].
      push({ ...base, ok: true, simulated: true, durationMs: finish() });
      return;
    }
    try {
      await withTimeout(Promise.resolve(opts.transport.deliver(env)), opts.timeoutMs);
      push({ ...base, ok: true, simulated: false, durationMs: finish() });
    } catch (e) {
      const code = e instanceof ChannelPortError ? e.code : 'E_TRANSPORT';
      push({
        ...base,
        ok: false,
        simulated: false,
        errorCode: code,
        detail: `${base.detail ? `${base.detail} ` : ''}${safeErrorText(e)}`,
        durationMs: finish(),
      });
    }
  }

  const port: BaseChannelPort & {
    routeToLegacyIvr?: (id: string, reasonKo: string) => Promise<void>;
    invite?: (id: string, target: ChannelKind) => Promise<void>;
  } = {
    id: opts.id,
    capabilities,
    activation,
    records,
    get failures() { return records.filter((r) => !r.ok); },
    reset() { records.length = 0; ended.clear(); },

    async present(interactionId: string, steps: RenderedStep[]): Promise<void> {
      // 표시할 것이 없는 턴(Api 대기 등)에서도 예외 없이 지나가야 한다.
      const copy = Object.freeze(steps.map((s) => Object.freeze({ ...s })));
      await run(
        { interactionId, adapter: opts.id, channel: capabilities.channel, kind: 'present', steps: copy },
        { kind: 'present', interactionId, stepCount: copy.length },
      );
    },

    async transfer(interactionId: string, queue: string | undefined, summaryMasked: string | undefined): Promise<void> {
      // §9.3 장애 이관은 큐도 요약도 없이 온다. 그 경우에도 이관 자체는 수행해야 한다.
      await run(
        { interactionId, adapter: opts.id, channel: capabilities.channel, kind: 'transfer', queue, summaryMasked },
        { kind: 'transfer', interactionId, detail: `queue=${queue ?? '-'} summary=${summaryMasked === undefined ? '없음' : '있음'}` },
      );
    },

    async end(interactionId: string, reasonKo: string): Promise<void> {
      if (ended.has(interactionId)) {
        // 고객 끊음과 Core 종료가 겹치면 반드시 생기는 상황이다. 매체를 두 번 내리지 않는다.
        push({ kind: 'end', interactionId, ok: true, simulated: true, suppressed: true, detail: '중복 종료 흡수' });
        return;
      }
      ended.add(interactionId);
      await run(
        { interactionId, adapter: opts.id, channel: capabilities.channel, kind: 'end', reasonKo },
        { kind: 'end', interactionId, detail: maskPii(reasonKo).text },
      );
    },
  };

  if (capabilities.routeToLegacyIvr) {
    port.routeToLegacyIvr = async (interactionId, reasonKo) => {
      await run(
        { interactionId, adapter: opts.id, channel: capabilities.channel, kind: 'routeToLegacyIvr', reasonKo },
        { kind: 'routeToLegacyIvr', interactionId, detail: maskPii(reasonKo).text },
      );
    };
  }
  if (capabilities.crossChannelInvite) {
    port.invite = async (interactionId, target) => {
      await run(
        { interactionId, adapter: opts.id, channel: capabilities.channel, kind: 'invite', target },
        { kind: 'invite', interactionId, detail: target },
      );
    };
  }
  return port;
}

/**
 * 저장소 3곳이 그대로 쓰는 드라이런 포트 묶음.
 * Callbot·챗봇·D-ARS 각각이 이 결과에 자기 transport 를 끼우면 실연동이 된다 — 활성화는 [승인 필요].
 */
export function createChannelPortSet(
  overrides: Partial<Record<ChannelAdapterId, Omit<ChannelPortOptions, 'id'>>> = {},
): Record<ChannelAdapterId, BaseChannelPort> {
  const ids: ChannelAdapterId[] = ['callbot', 'chatbot', 'dars'];
  const out = {} as Record<ChannelAdapterId, BaseChannelPort>;
  for (const id of ids) out[id] = createChannelPort({ id, ...(overrides[id] ?? {}) });
  return out;
}

/** 활성화 상태를 환경변수에서 읽는다. 값이 없거나 해석 불가면 dry_run 이다. */
export function activationFromEnv(env: Record<string, string | undefined>, key: string): ChannelActivation {
  return env[key] === 'live' ? 'live' : 'dry_run';
}
