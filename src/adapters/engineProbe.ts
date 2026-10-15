// 엔진 복구 프로브 구현체 — 설계서 §9.3(장애 폴백)·§6.2(엔진 비종속)·§10.3(마스킹)·§11.2(과금 근거)·§13-3(실측만).
//
// 왜 이 파일이 필요한가 — **찌를 것이 없는 프로브 러너.**
// (38)이 복구 프로브 *러너*를 배선하고 (40)이 엔진을 *기동*했지만, 그 둘 사이에 들어갈
// `HealthProbe` **구현이 저장소 전체에 0건**이었다. `ops/fallback.ts` 의 선언에는
// "구현은 어댑터 쪽에 둔다"고 적혀 있는데 어댑터 쪽에 그 구현이 없었던 셈이고,
// `RecoveryBinding.schedules[].probe` 를 채울 수 있는 것은 호스트가 손으로 쓴 함수뿐이었다.
//
// 그 상태가 조용한 방식은 (38)이 고친 래치와 같은 계열이다. 엔진이 `down` 으로 판정되면
// 통화가 IVR·상담사로 내려가 **엔진을 부르는 일 자체가 멈추고**, 새 샘플은 프로브에서만 나온다.
// 프로브 구현이 없으면 보고서의 `unprobed` 에 그 컴포넌트가 계속 올라오고 — 보수적 테넌트는
// 사람이 손대기 전까지 영구 상담사 직결, 그렇지 않은 테넌트는 **증거 없이** AI 를 재개한다.
//
// 그리고 호스트가 그 함수를 각자 쓰면 **각자 다르게 틀린다**. 빠지는 것은 취향이 아니라 정해져 있다.
//
//  (가) **복원력이 붙은 세트로 프로브를 만든다.** `startEngines` 가 돌려주는 `engines` 는
//       재시도·대체가 붙은 묶음이다. 그걸로 프로브를 만들면 **대체 엔진이 응답한 결과가 주 엔진의
//       `up` 으로 기록되고**, 폴백이 풀린 뒤 전 통화가 대체 경로로 간다(그건 `degraded` 로 적을
//       사안이다, §9.3). 더 나쁜 것은 주 엔진이 죽은 사실이 **영구히 관측되지 않는다**는 점이다.
//       그래서 이 모듈은 후보 **하나**만 받고, 호스트가 고를 일이 없도록 `startEngines` 가
//       조립만 된(복원력 없는) 주 세트로 프로브를 만들어 준다.
//
//  (나) **승인 전(dry_run) 성공을 엔진 상태로 적는다.** dry_run 어댑터는 실호출을 하지 않으므로
//       **언제나 성공한다**. 그 성공을 `up` 으로 적으면 프로브는 영원히 "살아 있다"를 보고하고,
//       폴백은 즉시 풀리며, 켜지지도 않은 엔진 위에서 AI 응대가 재개된다 — (40)의 헬스 기록이
//       `live` 에서만 켜지는 것과 **같은 이유, 같은 조건**이다. 그래서 `live` 가 아니면 프로브를
//       만들지 않고 그 사실을 적는다 **[승인 필요]**.
//
//  (다) **합성 입력을 지어낸다.** STT 는 오디오가 있어야 찌를 수 있다. Core 가 오디오를 만들면
//       포맷·샘플레이트가 엔진마다 달라 **설정 오류가 영구 `down` 으로 보고되고**(우리 잘못을
//       엔진 탓으로 적는 것이다), 고객 발화를 재사용하면 녹취가 60초마다 엔진으로 나간다(§10.3).
//       그래서 샘플은 선언 사항이고, 선언이 없으면 그 컴포넌트 프로브를 만들지 않는다(§13-3).
//       선언된 문장·텍스트에 개인정보 흔적이 있으면 **거절한다** — 합성 입력이어야 하고,
//       설정에 박힌 실번호는 프로브 주기마다 반복해서 나간다(되돌릴 수 없다).
//
//  (라) **실패를 스스로 샘플로 바꾼다.** 러너(`ops/recoveryProbe.ts`)는 `check()` 가 던진 오류를
//       `classifyEngineFailure` 로 분류해 **엔진 탓으로 볼 수 없는 실패(승인 전·설정 오류·정체불명)는
//       샘플을 남기지 않는다.** 프로브가 실패를 `{ state: 'down' }` 으로 바꿔 돌려주면 그 판정이
//       통째로 무력해지고, 설정 오류 하나가 영구 래치가 된다. 그래서 이 프로브는 **성공만 샘플로
//       돌려주고 실패는 그대로 던진다**(§2 — 분류는 한 곳이다).
//
//  (마) **스트림을 끝까지 읽는다.** stt·tts·llm 은 `AsyncIterable` 이다. 전부 읽으면 확인 한 번이
//       합성 오디오 전량 수신이 되고 그 비용은 §11.2 사용량으로 나타난다. **첫 조각이 오면 살아
//       있는 것**이며(`resilience.ts` 의 첫 청크 판정과 같은 규칙), 읽고 나면 **반드시 닫는다** —
//       닫지 않으면 어댑터는 계속 받고 커넥션이 샌다.
//
//  (바) **빈 응답을 `up` 으로 적는다.** 조각이 0개면 엔진은 응답했지만 아무것도 내놓지 못한 것이고,
//       TTS 라면 채널은 그 0바이트를 **무음으로 재생**한다. 규격 위반(`E_PROTOCOL`)으로 드러낸다.
//
//  (사) **프로브 사용량이 과금 근거에 섞인다.** 어댑터의 `lastUsage()` 는 **마지막 호출**의 실측을
//       들고 있다. 프로브는 턴과 같은 어댑터 인스턴스를 쓰므로, 엔진을 부르지 않은 턴(DTMF·타임아웃)이
//       `lastUsage()` 를 읽으면 **직전 프로브의 사용량이 그 통화의 과금 근거로 실린다**. 금액이
//       그럴듯해 아무도 눈치채지 못하고, 그 차이는 몇 주 뒤 대사에서 '미설명'으로 돌아온다(§11.2).
//       그래서 프로브는 호출 **앞뒤로** 알리고(`onProbeCall`), 수집 쪽이 그 구간에 생긴 값을
//       과금 근거로 내보내지 않는다 — 0 으로 적지 않고 **모른다(undefined)** 로 둔다.
//
// 이 모듈이 **하지 않는 것**:
//  - 간격·제한 시간을 정하지 않는다(§13-3). 러너의 `ProbeSchedule` 이 선언 사항이다.
//  - `latencyMs`·`errorRate` 를 만들지 않는다. 소요는 러너가 단조 시계로 재고, 한 번의 호출로
//    실패율을 계산할 수 없다(§13-3).
//  - 시계를 만들지 않는다. `observedAt` 은 주입된 `now()` 하나다(러너가 자기 시계로 다시 통일한다).
//  - 컴포넌트 매핑을 복사하지 않는다 — `HEALTH_COMPONENT_OF`(resilience.ts) 하나를 쓴다(§2).
//  - 정상인 엔진을 찌르지 않는다. 대상 선택은 러너가 폴백 정책과 같은 규칙으로 한다.
import type { AudioChunk, EngineSet, LlmMessage, SttResult } from './index.ts';
import type { Activation } from './http.ts';
import { EngineError } from './http.ts';
import type { EngineCallComponent } from './resilience.ts';
import { HEALTH_COMPONENT_OF } from './resilience.ts';
import type { ComponentId, HealthProbe, HealthSample } from '../ops/fallback.ts';
import { maskPii } from '../core/policyGuard.ts';
import { checkVector } from '../knowledge/embedding.ts';

export const ENGINE_PROBE_CONTRACT_VERSION = 1;

/**
 * 프로브가 엔진에 보낼 **합성 입력**. Core 가 만들지 않는다((다)).
 * 선언하지 않은 슬롯은 프로브를 만들지 않는다 — 건너뛴 사실은 `skipped` 에 남는다.
 */
export interface EngineProbeSamples {
  /** STT 확인용 오디오. 고객 녹취가 아니라 합성·고정 샘플이어야 한다(§10.3 — 바이트는 검사할 수 없다). */
  stt?: AudioChunk;
  /** TTS 확인용 문장. 개인정보 흔적이 있으면 거절한다. */
  tts?: { text: string; voice?: string };
  /** LLM 확인용 메시지. 지시문·응답 내용은 쓰지 않는다 — 첫 조각이 오는지만 본다. */
  llm?: LlmMessage[];
  /** 임베딩 확인용 텍스트. 빈 배열은 호출하지 않는다. */
  embedding?: string[];
}

/** 프로브 호출 구간 알림((사)). 호출 **앞뒤로** 각각 한 번씩 불린다. */
export type ProbeCallPhase = 'before' | 'after';

export interface EngineProbeDeclaration {
  /**
   * 찌를 후보 **하나**. **복원력이 붙은 세트를 넣지 않는다**((가)) — 대체가 응답하면 주 엔진이
   * 죽은 채 `up` 으로 적힌다. `startEngines` 는 조립만 된 주 세트를 넘긴다.
   */
  engines: Partial<Pick<EngineSet, 'stt' | 'tts' | 'llm' | 'embedding'>>;
  /** 이 후보의 활성화. `live` 가 아니면 프로브를 만들지 않는다((나)) **[승인 필요]**. */
  activation: Activation;
  /**
   * 관측 시각(ISO8601). Core 가 시계를 만들지 않는다(§13-3).
   *
   * **없으면 프로브를 만들지 않는다**(`no_clock`). 시각 없는 샘플은 러너의 `validSample` 을
   * 지나지 못해 **한 건도 기록되지 않는데** 배선도에는 "프로브 있음"으로 남는다. 선언을
   * 검토하는 경로(`enginePlan`)는 헬스 배선 없이 기동하므로 이 상태가 정상적으로 생긴다 —
   * 거절하지 않고 **만들지 않았다는 사실**을 적는다(헬스 기록 미배선과 같은 규칙).
   */
  now?: () => string;
  samples?: EngineProbeSamples;
  /** 후보 이름. `detail` 에 "어느 후보를 찔렀나"로 남는다 — 지어내지 않는다. */
  candidate?: string;
  /** 프로브 호출 구간 알림((사)). 수집 쪽이 과금 근거에서 이 구간을 빼는 데 쓴다. */
  onProbeCall?: (phase: ProbeCallPhase, component: ComponentId) => void;
}

export type ProbeSkipReason =
  /** 승인 전 — dry_run 은 언제나 성공하므로 up 을 적으면 폴백이 즉시 풀린다((나)) */
  | 'not_activated'
  /** 이 후보에 그 슬롯이 없다 */
  | 'no_adapter'
  /** 합성 입력 미선언((다)·§13-3) */
  | 'no_sample'
  /** 관측 시계 미배선 — 시각 없는 샘플은 러너를 지나지 못한다 */
  | 'no_clock';

export interface ProbeSkip {
  component: ComponentId;
  slot: EngineCallComponent;
  reason: ProbeSkipReason;
  reasonKo: string;
}

export interface EngineProbeSet {
  readonly contractVersion: number;
  /** 만들어진 프로브. 승인 전이거나 샘플이 없으면 비어 있다(빈 배열은 "확인하지 않는다"는 사실이다). */
  probes: HealthProbe[];
  /** 만들지 못한 컴포넌트와 사유. 조용히 비워 두지 않는다. */
  skipped: ProbeSkip[];
  /** 사람이 먼저 읽을 한 줄. 지어낸 수치 없이 사실만 적는다(§13-3). */
  describeKo: string;
  /** 확인하지 못하는 범위. 숨기지 않는다(§13-3). */
  limitsKo: string[];
}

const SLOTS: readonly EngineCallComponent[] = Object.freeze(['stt', 'tts', 'llm', 'embedding']);

const SLOT_LABEL_KO: Readonly<Record<EngineCallComponent, string>> = Object.freeze({
  stt: '음성인식', tts: '음성합성', llm: 'LLM', embedding: '임베딩',
});

function fail(component: EngineError['component'], message: string): never {
  // 샘플 문장·조각 이름은 설정에서 온 문자열이고 로그·저장 경로로 흐른다. 한 번 거른다(§10.3).
  throw new EngineError('E_CONFIG', component, maskPii(message).text);
}

/**
 * 프로브 입력에 개인정보 흔적이 있으면 거절한다((다)).
 * **마스킹해서 보내지 않는 이유**: 마스킹한 문장을 보내면 설정은 그대로 남고, 다음 사람은 그 설정이
 * 통과했다는 사실만 본다. 프로브는 합성 입력으로만 도는 것이 약속이므로 설정을 고치게 해야 한다.
 */
function assertSynthetic(component: EngineError['component'], label: string, text: string): void {
  const m = maskPii(text);
  if (m.masked) {
    fail(
      component,
      `${label}에 개인정보 흔적이 있다(${m.hits.join(', ')}) — 프로브 입력은 합성 샘플이어야 하고,`
      + ' 설정에 박힌 값은 확인 주기마다 반복해서 엔진으로 나간다(§10.3)',
    );
  }
}

/**
 * 스트림의 **첫 조각만** 읽고 닫는다((마)). 조각이 없으면 규격 위반이다((바)).
 * 닫기는 `finally` 에 둔다 — 검사에서 던지더라도 반복자를 열어 둔 채 떠나지 않는다.
 */
async function firstChunkOnly<T>(
  component: EngineCallComponent,
  open: () => AsyncIterable<T>,
): Promise<T> {
  const it = open()[Symbol.asyncIterator]();
  try {
    const first = await it.next();
    if (first.done) {
      throw new EngineError('E_PROTOCOL', component, '엔진이 응답했지만 조각을 하나도 내놓지 않았다');
    }
    return first.value;
  } finally {
    // 어댑터가 return 을 구현하지 않아도(또는 그 안에서 던져도) 프로브는 그 때문에 실패하지 않는다.
    try { await it.return?.(undefined as never); } catch { /* 닫기 실패는 엔진 상태가 아니다 */ }
  }
}

/** 성공 샘플. `latencyMs`·`errorRate` 는 만들지 않는다(§13-3 — 러너가 소요를 잰다). */
function upSample(component: ComponentId, nowIso: string, candidate: string | undefined, noteKo: string): HealthSample {
  return {
    component,
    state: 'up',
    observedAt: nowIso,
    detail: maskPii(`복구 프로브 성공 · ${noteKo}${candidate ? ` · 후보 ${candidate}` : ''}`).text,
  };
}

/**
 * 선언 → `HealthProbe` 목록. **설정이 틀렸으면 여기서 던진다** — 기동 시점이고 통화 중이 아니다.
 * 엔진을 부르지 않는다(부르는 것은 러너가 `check()` 를 부를 때다).
 */
export function createEngineProbes(decl: EngineProbeDeclaration): EngineProbeSet {
  if (!decl || typeof decl !== 'object') fail('config', '프로브 선언이 없다');
  if (!decl.engines || typeof decl.engines !== 'object') {
    fail('config', '프로브 선언에 engines 가 없다 — 무엇을 찌를지 선언해야 한다');
  }
  if (decl.activation !== 'dry_run' && decl.activation !== 'live') {
    fail('config', `프로브 선언의 활성화 값이 올바르지 않다: ${JSON.stringify(decl.activation)}`);
  }
  if (decl.now !== undefined && typeof decl.now !== 'function') {
    fail('config', '관측 시각(now)이 함수가 아니다 — Core 가 시계를 만들지 않는다(§13-3)');
  }
  const clock = decl.now;

  const samples = decl.samples ?? {};
  // 샘플 형태는 **프로브를 만들기 전에** 검사한다. 통화 중이 아니라 기동 시점에 거절해야
  // "확인하고 있다"는 상태가 거짓이 되지 않는다.
  if (samples.stt !== undefined) {
    const a = samples.stt;
    if (!a || !(a.data instanceof Uint8Array) || a.data.length === 0) {
      fail('stt', 'STT 프로브 오디오가 비어 있다 — 빈 오디오는 엔진마다 다르게 행동한다');
    }
    if (typeof a.mime !== 'string' || a.mime.trim() === '') {
      fail('stt', 'STT 프로브 오디오에 mime 이 없다 — 엔진은 컨테이너를 mime 으로 판별한다');
    }
  }
  if (samples.tts !== undefined) {
    const t = samples.tts;
    if (!t || typeof t.text !== 'string' || t.text.trim() === '') {
      fail('tts', 'TTS 프로브 문장이 비어 있다 — 빈 문장은 호출 전에 거절된다');
    }
    assertSynthetic('tts', 'TTS 프로브 문장', t.text);
    if (t.voice !== undefined && (typeof t.voice !== 'string' || t.voice.trim() === '')) {
      fail('tts', 'TTS 프로브 voice 가 빈 문자열이다');
    }
  }
  if (samples.llm !== undefined) {
    const msgs = samples.llm;
    if (!Array.isArray(msgs) || msgs.length === 0) {
      fail('llm', 'LLM 프로브 메시지가 비어 있다');
    }
    for (const msg of msgs) {
      if (!msg || (msg.role !== 'system' && msg.role !== 'user' && msg.role !== 'assistant')) {
        fail('llm', `LLM 프로브 메시지의 role 이 올바르지 않다: ${JSON.stringify(msg?.role)}`);
      }
      if (typeof msg.content !== 'string' || msg.content.trim() === '') {
        fail('llm', 'LLM 프로브 메시지 내용이 비어 있다');
      }
      assertSynthetic('llm', 'LLM 프로브 메시지', msg.content);
    }
  }
  if (samples.embedding !== undefined) {
    const texts = samples.embedding;
    if (!Array.isArray(texts) || texts.length === 0) {
      fail('embedding', '임베딩 프로브 텍스트가 비어 있다');
    }
    for (const t of texts) {
      if (typeof t !== 'string' || t.trim() === '') fail('embedding', '임베딩 프로브 텍스트에 빈 값이 있다');
      assertSynthetic('embedding', '임베딩 프로브 텍스트', t);
    }
  }

  const notify = (phase: ProbeCallPhase, component: ComponentId): void => {
    if (decl.onProbeCall === undefined) return;
    // 호스트·수집 쪽 콜백이 던져도 프로브가 실패하지 않아야 한다 — 그러면 알림 결함이
    // 엔진 장애로 집계된다((라)와 같은 이유).
    try { decl.onProbeCall(phase, component); } catch { /* 알림 실패는 엔진 상태가 아니다 */ }
  };

  const probes: HealthProbe[] = [];
  const skipped: ProbeSkip[] = [];
  const limitsKo: string[] = [];

  for (const slot of SLOTS) {
    const component = HEALTH_COMPONENT_OF[slot];
    const adapter = decl.engines[slot];
    const label = SLOT_LABEL_KO[slot];

    if (adapter === undefined) {
      skipped.push({
        component, slot, reason: 'no_adapter',
        reasonKo: `${label} 어댑터가 이 후보에 없다 — 찌를 대상이 없다`,
      });
      continue;
    }
    if (decl.activation !== 'live') {
      skipped.push({
        component, slot, reason: 'not_activated',
        reasonKo: `${label}: 승인 전(dry_run)이라 프로브를 만들지 않는다 — dry_run 은 언제나 성공하므로 up 을 적으면 폴백이 즉시 풀린다 [승인 필요]`,
      });
      continue;
    }
    if (samples[slot] === undefined) {
      skipped.push({
        component, slot, reason: 'no_sample',
        reasonKo: `${label}: 확인용 합성 입력이 선언되지 않아 프로브를 만들지 않는다(§13-3)`,
      });
      continue;
    }
    if (clock === undefined) {
      skipped.push({
        component, slot, reason: 'no_clock',
        reasonKo: `${label}: 관측 시계가 배선되지 않아 프로브를 만들지 않는다 — 시각 없는 샘플은 러너를 지나지 못하고 한 건도 기록되지 않는다(§9.3·§13-3)`,
      });
      continue;
    }

    // 여기까지 와야 프로브를 만든다 — 어느 검사에서 걸려도 "돌아가는 프로브"가 생기지 않는다.
    probes.push(makeProbe(slot, component, decl, clock, notify));
  }

  if (samples.stt !== undefined) {
    limitsKo.push(
      '오디오 바이트는 마스킹할 수 없어 STT 프로브 샘플이 합성인지 고객 녹취인지 Core 가 확인할 방법이 없다 — 선언이 유일한 근거다(§10.3)',
    );
  }
  if (probes.length > 0) {
    limitsKo.push(
      '어댑터 인터페이스에 중단 신호 자리가 없어 제한 시간이 지나도 호출 자체는 떠 있을 수 있다 — 러너는 기다리지 않고 판정한다(§9.3)',
    );
    limitsKo.push(
      '프로브는 턴과 같은 어댑터 인스턴스를 쓰므로 lastUsage() 가 프로브 값으로 덮인다 — 수집 쪽이 그 구간을 과금 근거에서 뺀다(§11.2)',
    );
  }
  if (decl.activation !== 'live') {
    limitsKo.push('승인 전이라 프로브가 하나도 없다 — 엔진 컴포넌트가 나빠지면 복구를 확인할 길이 없다 [승인 필요]');
  } else if (clock === undefined) {
    limitsKo.push('관측 시계가 배선되지 않아 프로브를 만들지 않았다 — 선언은 있지만 확인은 돌지 않는다(§9.3)');
  }

  const made = probes.map((p) => p.component).join(', ');
  const describeKo = maskPii(
    `복구 프로브 ${probes.length}건${made ? `(${made})` : ''} · 미생성 ${skipped.length}건`
    + ` · 활성화 ${decl.activation === 'live' ? 'live' : 'dry_run [승인 필요]'}`
    + (decl.candidate ? ` · 후보 ${decl.candidate}` : ''),
  ).text;

  return { contractVersion: ENGINE_PROBE_CONTRACT_VERSION, probes, skipped, describeKo, limitsKo };
}

/**
 * 슬롯 하나의 프로브. **성공만 샘플로 돌려주고 실패는 그대로 던진다**((라)) —
 * 던진 오류의 분류·집계 여부는 러너가 `classifyEngineFailure` 하나로 판정한다(§2).
 */
function makeProbe(
  slot: EngineCallComponent,
  component: ComponentId,
  decl: EngineProbeDeclaration,
  clock: () => string,
  notify: (phase: ProbeCallPhase, component: ComponentId) => void,
): HealthProbe {
  const label = SLOT_LABEL_KO[slot];
  return {
    component,
    async check(): Promise<HealthSample> {
      // 알림은 호출 **앞뒤로** 나간다. 앞을 빼면 던진 경우에 구간이 닫히지 않고, 뒤를 빼면
      // 실패한 호출이 남긴 사용량이 과금 근거에 그대로 남는다((사)).
      notify('before', component);
      try {
        const noteKo = await callOnce(slot, decl);
        return upSample(component, clock(), decl.candidate, `${label} ${noteKo}`);
      } finally {
        notify('after', component);
      }
    },
  };
}

/** 슬롯별 한 번의 확인. 응답 **내용은 쓰지 않는다** — 살아 있는지만 본다. */
async function callOnce(slot: EngineCallComponent, decl: EngineProbeDeclaration): Promise<string> {
  const samples = decl.samples ?? {};
  switch (slot) {
    case 'stt': {
      const adapter = decl.engines.stt as NonNullable<EngineSet['stt']>;
      const audio = samples.stt as AudioChunk;
      const first = await firstChunkOnly<SttResult>('stt', () =>
        adapter.stream((async function* one() { yield audio; })()));
      if (!first || typeof first.text !== 'string') {
        // 전사 **내용**은 보지 않는다(빈 전사는 무음일 수 있다). 형태만 본다.
        throw new EngineError('E_PROTOCOL', 'stt', '전사 결과에 text 문자열이 없다');
      }
      return '전사 1건 수신';
    }
    case 'tts': {
      const adapter = decl.engines.tts as NonNullable<EngineSet['tts']>;
      const s = samples.tts as { text: string; voice?: string };
      const first = await firstChunkOnly<AudioChunk>('tts', () => adapter.synthesize(s.text, s.voice));
      if (!first || !(first.data instanceof Uint8Array) || first.data.length === 0) {
        // 0바이트는 채널에서 **무음으로 재생**된다 — 성공으로 적으면 고객만 알게 된다((바)).
        throw new EngineError('E_PROTOCOL', 'tts', '합성 오디오 조각이 비어 있다 — 채널은 이것을 무음으로 재생한다');
      }
      return `오디오 ${first.data.length}바이트 수신`;
    }
    case 'llm': {
      const adapter = decl.engines.llm as NonNullable<EngineSet['llm']>;
      const msgs = samples.llm as LlmMessage[];
      const first = await firstChunkOnly<string>('llm', () => adapter.complete(msgs.map((m) => ({ ...m }))));
      if (typeof first !== 'string') {
        throw new EngineError('E_PROTOCOL', 'llm', '응답 조각이 문자열이 아니다');
      }
      // 빈 문자열 조각은 살아 있다는 증거로 받는다(토큰 경계·킵얼라이브에서 정상이다).
      // 조각이 **하나도** 없는 경우는 firstChunkOnly 가 이미 E_PROTOCOL 로 끊었다.
      return '응답 조각 수신';
    }
    case 'embedding': {
      const adapter = decl.engines.embedding as NonNullable<EngineSet['embedding']>;
      const texts = samples.embedding as string[];
      const got = await adapter.embed([...texts]);
      if (!Array.isArray(got) || got.length !== texts.length) {
        throw new EngineError(
          'E_PROTOCOL', 'embedding',
          `임베딩 개수 불일치: 요청 ${texts.length}건, 응답 ${Array.isArray(got) ? got.length : '배열 아님'}`,
        );
      }
      // 성분 판정은 복사하지 않는다 — 인제스트와 같은 함수를 쓴다(§2).
      const problem = checkVector(got[0], 0);
      if (problem !== undefined) throw new EngineError('E_PROTOCOL', 'embedding', problem);
      return `${got.length}건 · ${(got[0] as number[]).length}차원`;
    }
  }
}
