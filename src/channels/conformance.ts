// 채널 계약 적합성 스위트 — 설계서 §1.2(Core 단일화)·§5.3(단일 시나리오)·§9.3(장애 폴백)·
// §10.3(마스킹)·§11.1(테넌트 격리)·§13-7.
//
// contract.ts 는 "이렇게 부르기로 한다"를, runtime.ts 는 Core 측 이행을 담당한다.
// 남은 구멍은 반대편이다: Callbot·챗봇·D-ARS 세 저장소가 각자 만든 ChannelPort 가
// 정말 계약대로 동작하는지 확인할 방법이 없었다. 그래서 세 저장소가 "구현했다"고 선언한 뒤
// 운영에서 처음 깨지는 일이 생긴다 — 그것도 회선을 내리거나 이관을 못 하는 형태로.
//
// 이 파일은 채널 저장소가 CI에서 자기 포트에 돌리는 검사기다. 실회선·실메신저·실발신을
// 쓰지 않는다(전부 드라이런). 통과가 곧 상용 동작 보증은 아니지만, 아래 항목에서 깨지는
// 구현은 상용에 올릴 수 없다는 최소선이다 — 실연동 활성화는 [승인 필요].
//
// 사용법(각 채널 저장소):
//   const report = await runChannelConformance({ port: myPort, reportsComponents: [...], contractVersion: 1 });
//   if (!report.passed) process.exit(1);
import type { ChannelKind } from '../domain/types.ts';
import type { Flow, RenderedStep } from '../flow/types.ts';
import { maskPii } from '../core/policyGuard.ts';
import type { SwitchTicket } from '../core/executeSwitch.ts';
import type {
  ChannelAdapterId, ChannelCapabilities, ChannelPort, ChannelRegistration,
} from './contract.ts';
import {
  ADAPTER_CHANNEL, CHANNEL_CONTRACT_VERSION, checkFlowSupported, validateRegistration,
} from './contract.ts';
import { CHANNEL_COMPONENTS, profileFor } from './profiles.ts';

export type ConformanceCheckId =
  | 'REGISTRATION'        // 정적 계약 검증(버전·채널·능력별 구현 존재)
  | 'ASYNC_CONTRACT'      // 필수 메서드가 Promise 를 돌려주는가
  | 'EMPTY_STEPS'         // 빈 입력: 렌더할 것이 없어도 예외 없이 지나가는가
  | 'INPUT_IMMUTABLE'     // Core가 넘긴 steps 를 채널이 변형하지 않는가
  | 'UNKNOWN_SESSION'     // 모르는 interactionId 를 받아도 죽지 않는가
  | 'TRANSFER_OPTIONALS'  // queue·요약이 없는 이관(§9.3 장애 이관)도 되는가
  | 'END_REPEATABLE'      // 종료가 두 번 와도(재시도·중복 이벤트) 되는가
  | 'TIMEOUT_BUDGET'      // 각 호출이 예산 안에 정착하는가
  | 'PII_SAFE_ECHO'       // 오류 메시지에 개인정보 원문을 되뱉지 않는가(§10.3)
  | 'FLOW_SUPPORT'        // 선언한 능력으로 대상 Flow 를 렌더할 수 있는가(§5.3)
  | 'TURN_HINTS'          // 재시도·타이밍 힌트가 붙은 단계를 흡수하는가(§5.1)
  | 'CONNECTOR_WAIT'      // 한 턴에 present 가 두 번 와도(대기 안내 → 결과) 되는가(§6.1)
  | 'CHANNEL_INVITE';     // 전환 초대에 티켓이 실려도 흡수하는가 — 링크는 토큰으로 만든다(§5.2·§10.3)

export interface ConformanceCheck {
  id: ConformanceCheckId;
  passed: boolean;
  severity: 'error' | 'warning';
  /** 왜 이 검사가 있는지 + 무엇이 어긋났는지. 실패 시 그대로 CI 로그에 남는다. */
  messageKo: string;
  /** 검사를 돌릴 수 없었던 경우(선택 기능 미구현 등). passed 판정에서 제외한다. */
  skipped?: boolean;
}

export interface ConformanceReport {
  adapter: ChannelAdapterId;
  channel: ChannelKind;
  contractVersion: number;
  checks: ConformanceCheck[];
  /** error 심각도 실패가 0건인가. warning 실패는 통과를 막지 않는다. */
  passed: boolean;
  errorCount: number;
  warningCount: number;
}

export interface ConformanceOptions {
  port: ChannelPort;
  reportsComponents?: ChannelRegistration['reportsComponents'];
  contractVersion?: number;
  /** 호출 하나가 정착해야 하는 예산(ms). 계약·회선 사정에 따라 다르므로 호출자가 정한다(§13-3). */
  timeoutMs?: number;
  /** 이 채널에서 실제로 돌릴 시나리오. 주면 §5.3 렌더 가능 여부까지 본다. */
  flows?: Flow[];
  /** 테스트에서 시간을 고정하기 위한 주입점. */
  sleep?: (ms: number) => Promise<void>;
}

const PII_PROBE = '010-1234-5678';

function step(channel: ChannelKind, text: string): RenderedStep {
  return { channel, nodeId: 'n_probe', kind: 'Say', text };
}

/**
 * §5.1 재시도·타이밍 힌트가 붙은 입력 대기 단계. Core 는 정책이 선언된 테넌트에서
 * 이 필드들을 실어 보낸다 — 단계 모양을 엄격히 검사하는 포트는 여기서 깨진다.
 */
function hintedStep(channel: ChannelKind): RenderedStep {
  return {
    channel, nodeId: 'n_probe_retry', kind: 'Collect', text: '다시 말씀해 주세요.',
    reprompt: { reason: 'no_input', attempt: 2, exhausted: false },
    inputTimeoutMs: 7000,
    ...(channel === 'voice' ? { bargeIn: true, acceptDtmf: true } : {}),
  };
}

/**
 * §6.1 Api 대기 안내 단계. `waitText` 가 선언된 Api 노드는 **무음이 아니므로** 채널에 그대로 나간다 —
 * `awaitConnectorId` 가 실린 `Api` 종류의 단계를 받는 것이다. 단계 종류를 열거해 처리하거나
 * `awaitConnectorId` 를 보고 자기가 커넥터를 부르려 드는 포트는 여기서 깨진다(호출은 Core 가 한다, §6.2).
 */
function waitStep(channel: ChannelKind): RenderedStep {
  return {
    channel, nodeId: 'n_probe_api', kind: 'Api', text: '조회 중입니다. 잠시만 기다려 주세요.',
    awaitConnectorId: 'c_probe',
  };
}

type BudgetOutcome<T> = { ok: true; value: T } | { ok: false; error: unknown } | { ok: false; timeout: true };

/**
 * 예산 초과를 실패로 바꾼다. 매달린 호출을 무한정 기다리면 CI 자체가 멈춘다.
 * 인자를 thunk 로 받는 이유: 동기 예외를 던지는 구현이 있어도 검사기가 함께 죽지 않아야 한다.
 */
async function withBudget<T>(call: () => Promise<T> | T, ms: number | undefined): Promise<BudgetOutcome<T>> {
  let started: Promise<T> | T;
  try {
    started = call();
  } catch (error) {
    return { ok: false, error };
  }
  if (ms === undefined) {
    try { return { ok: true, value: await started }; } catch (error) { return { ok: false, error }; }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<'__timeout__'>((resolve) => { timer = setTimeout(() => resolve('__timeout__'), ms); });
  try {
    const r = await Promise.race([Promise.resolve(started).then((v) => ({ v })), guard]);
    if (r === '__timeout__') return { ok: false, timeout: true };
    return { ok: true, value: (r as { v: T }).v };
  } catch (error) {
    return { ok: false, error };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? `${e.message}` : String(e);
}

function isThenable(v: unknown): boolean {
  return typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function';
}

/**
 * 채널 포트 적합성 검사. 부작용이 있는 실호출은 하지 않는다 —
 * 포트 구현체가 드라이런 모드(전송 대신 기록)로 동작한다는 전제이며, 이는 각 저장소의 책임이다.
 */
export async function runChannelConformance(opts: ConformanceOptions): Promise<ConformanceReport> {
  const { port } = opts;
  const checks: ConformanceCheck[] = [];
  const channel = ADAPTER_CHANNEL[port.id] ?? port.capabilities?.channel;
  const budget = opts.timeoutMs;
  const add = (c: ConformanceCheck) => { checks.push(c); };

  // 1) 정적 계약 — 여기서 걸리면 Core 등록 자체가 거부된다.
  const reg: ChannelRegistration = {
    port,
    reportsComponents: opts.reportsComponents ?? CHANNEL_COMPONENTS[port.id] ?? [],
    contractVersion: opts.contractVersion ?? CHANNEL_CONTRACT_VERSION,
  };
  const regIssues = validateRegistration(reg);
  const regErrors = regIssues.filter((i) => i.severity === 'error');
  add({
    id: 'REGISTRATION',
    passed: regErrors.length === 0,
    severity: 'error',
    messageKo: regErrors.length === 0
      ? '정적 계약 검증 통과. Core 등록 가능.'
      : `Core 등록이 거부되는 상태입니다: ${regErrors.map((i) => i.messageKo).join(' / ')}`,
  });

  // 2) 비동기 계약 — 동기 예외를 던지는 구현은 Core의 await 체인에서 세션을 통째로 날린다.
  let asyncOk = true;
  const asyncNotes: string[] = [];
  for (const name of ['present', 'transfer', 'end'] as const) {
    const fn = (port as unknown as Record<string, unknown>)[name];
    if (typeof fn !== 'function') { asyncOk = false; asyncNotes.push(`${name} 미구현`); continue; }
  }
  if (asyncOk) {
    const probes: [string, () => unknown][] = [
      ['present', () => port.present('i_probe', [step(channel, '적합성 검사')])],
      ['transfer', () => port.transfer('i_probe', 'q_default', '요약 없음')],
      ['end', () => port.end('i_probe', '적합성 검사 종료')],
    ];
    for (const [name, call] of probes) {
      let returned: unknown;
      let threwSync = false;
      // 예산 없이 await 하면, 정착하지 않는 구현 하나가 CI 자체를 매달아 버린다.
      const settled = await withBudget(() => {
        try {
          returned = call();
        } catch (e) {
          threwSync = true;
          throw e;
        }
        return returned as Promise<unknown>;
      }, budget);
      if (threwSync) {
        asyncOk = false;
        asyncNotes.push(`${name}가 동기 예외를 던짐: ${errText((settled as { error: unknown }).error)}`);
        continue;
      }
      if (!isThenable(returned)) { asyncOk = false; asyncNotes.push(`${name}가 Promise를 돌려주지 않음`); continue; }
      if (settled.ok === false) {
        asyncOk = false;
        asyncNotes.push('timeout' in settled ? `${name} 미정착(예산 ${String(budget)}ms 초과)` : `${name} 거부: ${errText((settled as { error: unknown }).error)}`);
      }
    }
  }
  add({
    id: 'ASYNC_CONTRACT',
    passed: asyncOk,
    severity: 'error',
    messageKo: asyncOk
      ? '필수 메서드 3종이 Promise 계약을 지킵니다.'
      : `비동기 계약 위반 — Core가 await 하는 지점에서 세션이 끊깁니다: ${asyncNotes.join(' / ')}`,
  });

  // 3) 빈 입력 — 무음 단계만 있는 턴에서는 steps 가 비어 온다(§ runtime visibleSteps).
  {
    const r = await withBudget(() => port.present('i_probe_empty', []), budget);
    const ok = r.ok === true;
    add({
      id: 'EMPTY_STEPS',
      passed: ok,
      severity: 'error',
      messageKo: ok
        ? '빈 steps 입력을 무해하게 처리합니다.'
        : `steps 가 빈 턴(커넥터 대기 등)에서 실패했습니다: ${'timeout' in r ? '예산 초과' : errText((r as { error: unknown }).error)}`,
    });
  }

  // 4) 입력 불변 — Core는 같은 steps 를 이벤트·이력에도 쓴다. 채널이 뒤집으면 이력이 오염된다.
  {
    const steps: RenderedStep[] = [step(channel, '첫 번째'), step(channel, '두 번째')];
    const snapshot = JSON.stringify(steps);
    const r = await withBudget(() => port.present('i_probe_imm', steps), budget);
    const unchanged = JSON.stringify(steps) === snapshot;
    add({
      id: 'INPUT_IMMUTABLE',
      passed: r.ok === true && unchanged,
      severity: 'error',
      messageKo: unchanged
        ? (r.ok ? 'present 가 입력 steps 를 변형하지 않습니다.' : 'present 호출이 실패했습니다.')
        : 'present 가 Core가 넘긴 steps 배열을 변형했습니다. 같은 배열이 §8.1 이벤트·이력에 쓰이므로 복사 후 가공하세요.',
    });
  }

  // 5) 모르는 세션 — 재시도·중복 이벤트로 이미 끝난 id 가 다시 온다. 예외를 던지면 Core 턴이 통째로 실패한다.
  {
    const r = await withBudget(() => port.present('i_does_not_exist', [step(channel, '유령 세션')]), budget);
    add({
      id: 'UNKNOWN_SESSION',
      passed: r.ok === true,
      severity: 'warning',
      messageKo: r.ok
        ? '알 수 없는 interactionId 를 무해하게 흡수합니다.'
        : '알 수 없는 interactionId 에서 예외가 납니다. 재시도·중복 전달 시 턴 전체가 실패합니다(§8.1).',
    });
  }

  // 6) 이관 부분 실패 — §9.3 장애 이관은 큐도 요약도 없이 온다(요약 생성마저 실패한 경우).
  {
    const r = await withBudget(() => port.transfer('i_probe_tr', undefined, undefined), budget);
    add({
      id: 'TRANSFER_OPTIONALS',
      passed: r.ok === true,
      severity: 'error',
      messageKo: r.ok
        ? '큐·요약이 없는 이관도 수행합니다(§9.3 장애 이관 경로 확보).'
        : '큐·요약 없이 이관을 요청하면 실패합니다. AI 장애 시 고객이 갈 곳이 없어집니다(§9.3).',
    });
  }

  // 7) 종료 재시도 — 고객 끊음과 Core 종료가 동시에 오면 end 가 두 번 온다.
  {
    const first = await withBudget(() => port.end('i_probe_end', '고객 종료'), budget);
    const second = await withBudget(() => port.end('i_probe_end', '고객 종료'), budget);
    add({
      id: 'END_REPEATABLE',
      passed: first.ok === true && second.ok === true,
      severity: 'error',
      messageKo: first.ok && second.ok
        ? '종료가 중복 호출되어도 안전합니다.'
        : '종료 중복 호출에서 실패합니다. 고객 끊음과 Core 종료가 겹치면 반드시 발생하는 상황입니다.',
    });
  }

  // 8) 예산 — timeoutMs 를 준 경우에만 판정한다. 임의 기본값을 두지 않는다(§13-3).
  if (budget === undefined) {
    add({ id: 'TIMEOUT_BUDGET', passed: true, skipped: true, severity: 'warning', messageKo: 'timeoutMs 미지정 — 응답 예산을 검사하지 않았습니다.' });
  } else {
    const r = await withBudget(() => port.present('i_probe_budget', [step(channel, '예산 검사')]), budget);
    const timedOut = r.ok === false && 'timeout' in r;
    add({
      id: 'TIMEOUT_BUDGET',
      passed: !timedOut,
      severity: 'error',
      messageKo: timedOut
        ? `present 가 ${budget}ms 예산 안에 정착하지 않았습니다. Core 턴이 매달리면 고객은 무응답을 봅니다.`
        : `호출이 ${budget}ms 예산 안에 정착합니다.`,
    });
  }

  // 9) 오류 메시지 개인정보(§10.3) — 실패를 알리되 원문을 되뱉으면 로그·오류리포트에 개인정보가 남는다.
  {
    const masked = maskPii(PII_PROBE).text;
    const r = await withBudget(() => port.present('i_probe_pii', [step(channel, `연락처는 ${masked} 입니다`)]), budget);
    const leaked = r.ok === false && !('timeout' in r) && errText((r as { error: unknown }).error).includes(PII_PROBE);
    add({
      id: 'PII_SAFE_ECHO',
      passed: !leaked,
      severity: 'error',
      messageKo: leaked
        ? '오류 메시지에 마스킹 전 개인정보가 그대로 담겼습니다(§10.3). 오류에는 식별자만 남기세요.'
        : '오류 경로에서 개인정보 원문이 노출되지 않습니다.',
    });
  }

  // 10) 재시도·타이밍 힌트(§5.1) — 정책이 선언된 테넌트에서는 단계에 필드가 더 붙는다.
  //     힌트를 모르는 포트는 무시해도 되지만, 모양이 다르다고 예외를 던지거나 입력을 고치면
  //     정책을 켜는 순간(코드 배포 없이 설정만 바꿔도) 전 통화가 깨진다.
  {
    const steps: RenderedStep[] = [hintedStep(channel)];
    const snapshot = JSON.stringify(steps);
    const r = await withBudget(() => port.present('i_probe_hint', steps), budget);
    const unchanged = JSON.stringify(steps) === snapshot;
    add({
      id: 'TURN_HINTS',
      passed: r.ok === true && unchanged,
      severity: 'error',
      messageKo: r.ok === true && unchanged
        ? '재시도·대기시간 힌트가 붙은 단계를 흡수합니다(§5.1).'
        : !unchanged
          ? '힌트가 붙은 단계를 present 가 변형했습니다. 같은 배열이 §8.1 이벤트·이력에 쓰입니다.'
          : `재시도·대기시간 힌트가 붙은 단계에서 실패했습니다: ${'timeout' in r ? '예산 초과' : errText((r as { error: unknown }).error)}. 모르는 필드는 무시하세요 — 정책을 켜는 순간 전 통화가 깨집니다.`,
    });
  }

  // 11) Api 대기 이행(§6.1) — **한 턴에 present 가 두 번 온다**. 대기 안내가 먼저 나가고,
  //     업무시스템 조회가 끝난 뒤 결과가 또 나간다. 한 턴 = present 한 번으로 가정한 포트
  //     (화면을 통째로 갈아 끼우거나 일회성 가드를 둔 구현)는 **커넥터 배선을 켜는 순간** 전 통화가
  //     깨진다 — 그것도 코드 배포가 아니라 설정 변경으로. TURN_HINTS 와 같은 이유로 미리 잡는다.
  {
    const first: RenderedStep[] = [waitStep(channel)];
    const second: RenderedStep[] = [step(channel, '조회가 끝났습니다.')];
    const snapshot = JSON.stringify(first);
    const r1 = await withBudget(() => port.present('i_probe_api', first), budget);
    const r2 = await withBudget(() => port.present('i_probe_api', second), budget);
    const unchanged = JSON.stringify(first) === snapshot;
    const failing = r1.ok !== true ? r1 : r2;
    add({
      id: 'CONNECTOR_WAIT',
      passed: r1.ok === true && r2.ok === true && unchanged,
      severity: 'error',
      messageKo: r1.ok === true && r2.ok === true && unchanged
        ? '한 턴에 두 번 오는 present(대기 안내 → 결과)를 흡수하고, Api 대기 단계를 변형하지 않습니다(§6.1).'
        : !unchanged
          ? 'Api 대기 단계를 present 가 변형했습니다. 같은 배열이 §8.1 이벤트·이력에 쓰입니다.'
          : `대기 안내 → 결과 순서의 두 번째 present 에서 실패했습니다: ${'timeout' in failing ? '예산 초과' : errText((failing as { error: unknown }).error)}. 한 턴에 present 는 여러 번 올 수 있습니다 — 커넥터 배선을 켜는 순간 전 통화가 깨집니다.`,
    });
  }

  // 12) 채널 전환 초대(§5.2) — 전환이 배선되면 `invite` 에 **세 번째 인자(티켓)** 가 실린다.
  //     인자 개수를 세거나 모르는 값에서 던지는 포트는 **배선을 켜는 날** 전 전환이 깨진다 —
  //     그것도 코드 배포가 아니라 설정 변경으로(TURN_HINTS·CONNECTOR_WAIT 와 같은 이유).
  //     더 중요한 것은 그 다음이다: **티켓이 오면 링크는 토큰으로 만들어야 한다.** interactionId 로
  //     만들면 1회용·만료·회수가 전부 무의미해진다(다른 경로로 같은 문이 열린다). 그 사실은 여기서
  //     검사할 수 없으므로 — 링크 문자열은 포트 안에서 만들어진다 — 실패 문구에 못박아 둔다.
  if (typeof port.invite !== 'function') {
    // **건너뜀으로 적지 않는다.** 교차채널 초대를 선언하지 않은 채널(챗봇·D-ARS)에서 invite 가 없는
    // 것은 정상이며, 이를 판정보류로 적으면 "검사를 못 돌렸다"와 "해당 사항이 없다"가 섞인다 —
    // 그러면 진짜 판정보류(설정 누락, §13-3)가 잡음에 묻힌다.
    add({
      id: 'CHANNEL_INVITE',
      passed: !port.capabilities.crossChannelInvite,
      severity: 'error',
      messageKo: port.capabilities.crossChannelInvite
        ? 'crossChannelInvite 를 선언했으나 invite 구현이 없습니다 — 전환을 시켜도 아무 일도 일어나지 않고, 고객은 오지 않는 화면을 기다립니다(§5.2).'
        : '해당 없음 — 교차채널 초대를 선언하지 않은 채널입니다(§5.2).',
    });
  } else if (!port.capabilities.crossChannelInvite) {
    add({
      id: 'CHANNEL_INVITE',
      passed: false,
      severity: 'warning',
      messageKo: 'invite 를 구현했지만 crossChannelInvite 를 선언하지 않았습니다 — Core 는 이 경로를 쓰지 않습니다(§5.2).',
    });
  } else {
    const ticket: SwitchTicket = {
      token: 'tk_conformance_probe',
      interactionId: 'i_probe_switch',
      toChannel: 'visual',
      expiresAt: '2026-01-01T00:00:00.000Z',
    };
    const snapshot = JSON.stringify(ticket);
    // 배선 전(티켓 없음)과 배선 후(티켓 있음)가 **둘 다** 동작해야 한다. 한쪽만 되는 구현은
    // 배선을 켜는 순간, 또는 되돌리는 순간 전환이 죽는다.
    const bare = await withBudget(() => (port.invite as NonNullable<ChannelPort['invite']>)('i_probe_switch', 'visual'), budget);
    const withTicket = await withBudget(() => (port.invite as NonNullable<ChannelPort['invite']>)('i_probe_switch', 'visual', ticket), budget);
    const unchanged = JSON.stringify(ticket) === snapshot;
    const failing = bare.ok !== true ? bare : withTicket;
    add({
      id: 'CHANNEL_INVITE',
      passed: bare.ok === true && withTicket.ok === true && unchanged,
      severity: 'error',
      messageKo: bare.ok === true && withTicket.ok === true && unchanged
        ? '전환 초대를 티켓 유무 양쪽에서 흡수하고 티켓을 변형하지 않습니다. 티켓이 실리면 링크는 token 으로 만드세요 — interactionId 로 만들면 1회용·만료가 무의미해집니다(§5.2·§10.3).'
        : !unchanged
          ? '전환 티켓을 invite 가 변형했습니다. 같은 객체가 만료 안내·감사 기록에 쓰입니다(§5.2).'
          : `전환 초대에서 실패했습니다: ${'timeout' in failing ? '예산 초과' : errText((failing as { error: unknown }).error)}. 모르는 인자는 무시하세요 — 전환 배선을 켜는 순간 전 전환이 깨집니다(§5.2).`,
    });
  }

  // 13) 시나리오 렌더 가능성(§5.3) — 능력 선언과 실제 시나리오가 어긋나면 배포 후에야 드러난다.
  if (!opts.flows || opts.flows.length === 0) {
    add({ id: 'FLOW_SUPPORT', passed: true, skipped: true, severity: 'warning', messageKo: 'flows 미지정 — 시나리오 렌더 가능 여부를 검사하지 않았습니다(§5.3).' });
  } else {
    const issues = opts.flows.flatMap((f) => checkFlowSupported(f, port.capabilities).map((i) => `${f.id}v${f.version}: ${i.messageKo}`));
    add({
      id: 'FLOW_SUPPORT',
      passed: issues.length === 0,
      severity: 'error',
      messageKo: issues.length === 0
        ? `대상 시나리오 ${opts.flows.length}건을 이 채널에서 렌더할 수 있습니다.`
        : `렌더 불가 노드가 있습니다: ${issues.join(' / ')}`,
    });
  }

  const failed = checks.filter((c) => !c.passed && c.skipped !== true);
  return {
    adapter: port.id,
    channel,
    contractVersion: reg.contractVersion,
    checks,
    passed: failed.every((c) => c.severity !== 'error'),
    errorCount: failed.filter((c) => c.severity === 'error').length,
    warningCount: failed.filter((c) => c.severity === 'warning').length,
  };
}

/** CI 로그용 한국어 요약. 실패 항목만 이유와 함께 남긴다. */
export function formatConformanceReport(r: ConformanceReport): string {
  const head = `[${r.adapter}/${r.channel}] 채널 계약 v${r.contractVersion} 적합성: ${r.passed ? '통과' : '실패'} (오류 ${r.errorCount} · 경고 ${r.warningCount})`;
  const lines = r.checks
    .filter((c) => !c.passed || c.skipped === true)
    .map((c) => `  - ${c.id} ${c.skipped ? '[건너뜀]' : c.severity === 'error' ? '[오류]' : '[경고]'} ${c.messageKo}`);
  return [head, ...lines].join('\n');
}

// ── 참조 구현 ────────────────────────────────────────────────────────────────
// 채널 저장소가 실회선을 붙이기 전에 쓰는 드라이런 포트. 매체 대신 호출 기록을 남긴다.
// 이 구현은 위 적합성 항목을 전부 만족하도록 작성되어 있으므로, 각 저장소는
// 자기 구현이 이것과 같은 결과를 내는지 비교하면 된다. 실전송은 [승인 필요].

export interface RecordedCall {
  method: 'present' | 'transfer' | 'routeToLegacyIvr' | 'invite' | 'end';
  interactionId: string;
  /** 마스킹을 통과한 값만 담는다(§10.3). 원문 발화는 기록하지 않는다. */
  detail?: string;
  stepCount?: number;
}

export interface DryRunPort extends ChannelPort {
  readonly calls: RecordedCall[];
  /** 드라이런임을 명시한다. 실전송 구현으로 교체될 때 이 값이 false 가 되어야 한다 — [승인 필요]. */
  readonly dryRun: true;
  reset(): void;
}

export interface DryRunPortOptions {
  id: ChannelAdapterId;
  capabilities?: ChannelCapabilities;
}

/**
 * 드라이런 채널 포트. 네트워크·회선·메신저 API를 건드리지 않는다.
 * 능력 선언에 맞춰 선택 메서드(routeToLegacyIvr·invite)를 붙이거나 뺀다 —
 * 붙였는데 선언하지 않으면 계약 검증이 통과해도 Core가 그 경로를 쓰지 않는다.
 */
export function createDryRunPort(opts: DryRunPortOptions): DryRunPort {
  const capabilities = opts.capabilities ?? profileFor(opts.id);
  const calls: RecordedCall[] = [];
  const base = {
    id: opts.id,
    capabilities,
    dryRun: true as const,
    calls,
    reset() { calls.length = 0; },
    async present(interactionId: string, steps: RenderedStep[]): Promise<void> {
      // 입력을 변형하지 않는다. 기록도 개수만 남긴다 — 발화 원문을 다시 저장하지 않는다(§10.3).
      calls.push({ method: 'present', interactionId, stepCount: steps.length });
    },
    async transfer(interactionId: string, queue: string | undefined, summaryMasked: string | undefined): Promise<void> {
      calls.push({
        method: 'transfer',
        interactionId,
        detail: `queue=${queue ?? '-'} summary=${summaryMasked === undefined ? '없음' : '있음'}`,
      });
    },
    async end(interactionId: string, reasonKo: string): Promise<void> {
      calls.push({ method: 'end', interactionId, detail: reasonKo });
    },
  };

  const port = base as DryRunPort & {
    routeToLegacyIvr?: (id: string, reasonKo: string) => Promise<void>;
    invite?: (id: string, target: ChannelKind, ticket?: SwitchTicket) => Promise<void>;
  };
  if (capabilities.routeToLegacyIvr) {
    port.routeToLegacyIvr = async (interactionId, reasonKo) => {
      calls.push({ method: 'routeToLegacyIvr', interactionId, detail: reasonKo });
    };
  }
  if (capabilities.crossChannelInvite) {
    port.invite = async (interactionId, target, ticket) => {
      // 토큰은 기록하지 않는다 — 초대 토큰은 세션 열쇠라, 로그에 남으면 그 로그를 읽는 누구나
      // 남의 상담에 합류할 수 있다(§10.3). 있었다는 사실과 만료만 남긴다.
      calls.push({
        method: 'invite',
        interactionId,
        detail: `${target} ticket=${ticket === undefined ? '없음' : `있음(만료 ${ticket.expiresAt})`}`,
      });
    };
  }
  return port;
}
