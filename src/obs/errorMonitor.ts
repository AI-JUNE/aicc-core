// 에러 모니터링 — 설계서 §9.3(장애 인지·폴백)·§10.3(개인정보 미기록)·§11.1(테넌트)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// 로깅(obs/logger.ts)은 "무슨 일이 있었는지"를 남긴다. 그러나 상용에서 진짜로 필요한 것은
// "지금 터진 것을 누가 언제 아는가"다. 오류가 로그 파일 어딘가에만 남으면 아무도 모른 채 사용자가 떠난다
// (품질기준 §3: 오류를 삼키고 아무 일 없는 척 금지).
// 그래서 (1) 던져진 모든 값을 같은 모양으로 정규화하고 (2) 같은 원인끼리 묶고(fingerprint)
// (3) 알림 훅으로 한 번 내보낸다.
//
// 무엇을 하지 않는가 (build now, activate on approval):
//  - **네트워크 호출을 하지 않는다.** Core 는 전송기를 갖지 않는다. transport 를 주입하지 않으면 완전한 no-op 다.
//  - DSN 값을 저장·기록하지 않는다. 보관하는 것은 "설정되었는가"라는 사실과 환경변수 **이름**뿐이다.
//    실제 수집기 연결은 **[승인 필요]**.
//  - 시각을 임의로 만들지 않는다. clock 주입이 없으면 at 을 비운다(§13-3).
//    (중복 억제·폭주 방지도 시계가 있어야 동작한다 — 시간 없이 "몇 초 안"을 판단할 수 없다.)
//
// 개인정보(§10.3):
//  - 메시지·스택은 maskPii 를 통과하고, 자격증명 형태(Bearer/키=값/URL 내 비밀번호)는 값 자체를 지운다.
//  - 부가 필드는 로거와 **같은 차단 키 목록**(DENIED_FIELDS)을 쓴다. 기준이 두 곳에 있으면 반드시 어긋난다.
import { maskPii } from '../core/policyGuard.ts';
import type { TenantScope } from '../core/tenancy.ts';
import type { ApiErrorCode } from '../api/errors.ts';
import { DENIED_FIELDS } from './logger.ts';

export const REDACTED = '[제거됨]';

/** 심각도. 알림 대상 판단에 쓴다 — 사용자 입력 오류로 새벽에 사람을 깨우지 않기 위한 구분이다. */
export type Severity = 'warning' | 'error' | 'fatal';

/** 어디서 잡혔는가. 전역 훅에서 온 것은 프로세스가 이미 위험하다는 뜻이므로 fatal 로 본다. */
export type ErrorOrigin = 'captured' | 'uncaught' | 'unhandled_rejection';

/**
 * API 오류코드 → 심각도.
 * 4xx 계열(입력·권한·충돌)은 시스템 고장이 아니다. 이것을 error 로 올리면 알림이 잡음으로 덮여
 * 정작 진짜 장애를 놓친다.
 */
export const SEVERITY_BY_CODE: Record<ApiErrorCode, Severity> = {
  E_INVALID_INPUT: 'warning',
  E_UNAUTHENTICATED: 'warning',
  E_FORBIDDEN: 'warning',
  E_NOT_FOUND: 'warning',
  E_CONFLICT: 'warning',
  E_RATE_LIMITED: 'warning',
  E_APPROVAL_REQUIRED: 'warning',
  E_UPSTREAM: 'error',
  E_TIMEOUT: 'error',
  E_INTERNAL: 'error',
};

const MAX_MESSAGE_LEN = 300;
const MAX_FRAME_LEN = 200;
const DEFAULT_MAX_FRAMES = 5;
/** 중복 억제용으로 기억하는 원인 종류 상한. 메모리 누수를 막는다. */
const MAX_TRACKED_FINGERPRINTS = 500;

// ── 정규화 ────────────────────────────────────────────────────────────────────

export interface NormalizedError {
  name: string;
  /** 분류 코드. 없으면 E_UNHANDLED. 상위 계층은 메시지가 아니라 이 값으로 분기한다. */
  code: string;
  /** 마스킹·자격증명 제거를 마친 메시지. 원문을 남기지 않는다. */
  messageMasked: string;
  /** 정리된 스택 프레임(경로 축약·마스킹). 스택이 없으면 빈 배열. */
  frames: string[];
}

/** URL 안의 자격증명, Bearer 토큰, key=value 형태의 비밀값을 값째로 지운다. */
export function stripSecrets(input: string): string {
  return input
    .replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/g, `$1${REDACTED}@`)
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(
      /\b(api[_-]?key|apikey|token|secret|password|passwd|pwd|authorization|dsn)\b(\s*[=:]\s*)("?)[^\s"'&,)]+\3/gi,
      `$1$2${REDACTED}`,
    );
}

/** 절대경로는 마지막 두 조각만 남긴다 — 배포 환경의 디렉터리 구조가 오류 리포트로 새 나가지 않게. */
function shortenPaths(line: string): string {
  return line.replace(/(?:file:\/\/)?(?:[A-Za-z]:)?[\\/](?:[^\s()\\/:]+[\\/]){2,}([^\s()\\/:]+)/g, '…/$1');
}

function clean(text: string, max: number): string {
  const out = maskPii(stripSecrets(text)).text.trim();
  return out.length > max ? `${out.slice(0, max)}…` : out;
}

function frameLines(stack: string, maxFrames: number): string[] {
  return stack
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('at '))
    .slice(0, maxFrames)
    .map(l => clean(shortenPaths(l), MAX_FRAME_LEN));
}

function readCode(v: unknown): string | undefined {
  const c = (v as { code?: unknown } | null)?.code;
  return typeof c === 'string' && c.length > 0 ? c : undefined;
}

/**
 * 던져진 값은 Error 라는 보장이 없다. 문자열·객체·undefined 도 온다.
 * 여기서 모양을 하나로 맞추지 않으면 상위 코드가 전부 방어 코드로 뒤덮인다.
 */
export function normalizeError(e: unknown, maxFrames: number = DEFAULT_MAX_FRAMES): NormalizedError {
  if (e === null || e === undefined) {
    return { name: 'Unknown', code: 'E_UNHANDLED', messageMasked: '(빈 오류)', frames: [] };
  }
  if (e instanceof Error) {
    const message = clean(e.message || '(메시지 없음)', MAX_MESSAGE_LEN);
    return {
      name: e.name || 'Error',
      code: readCode(e) ?? 'E_UNHANDLED',
      messageMasked: message.length > 0 ? message : '(메시지 없음)',
      frames: typeof e.stack === 'string' ? frameLines(e.stack, maxFrames) : [],
    };
  }
  if (typeof e === 'string' || typeof e === 'number' || typeof e === 'boolean') {
    const message = clean(String(e), MAX_MESSAGE_LEN);
    return {
      name: 'Thrown',
      code: 'E_UNHANDLED',
      messageMasked: message.length > 0 ? message : '(메시지 없음)',
      frames: [],
    };
  }
  const obj = e as { message?: unknown; name?: unknown; stack?: unknown };
  const raw = typeof obj.message === 'string' ? obj.message : safeJson(e);
  const message = clean(raw, MAX_MESSAGE_LEN);
  return {
    name: typeof obj.name === 'string' && obj.name.length > 0 ? obj.name : 'Thrown',
    code: readCode(e) ?? 'E_UNHANDLED',
    messageMasked: message.length > 0 ? message : '(메시지 없음)',
    frames: typeof obj.stack === 'string' ? frameLines(obj.stack, maxFrames) : [],
  };
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return typeof s === 'string' ? s : String(v);
  } catch {
    return '(직렬화 불가 오류)';
  }
}

// ── 묶기(fingerprint) ─────────────────────────────────────────────────────────

/**
 * 같은 원인을 한 건으로 묶기 위한 키.
 * 암호학적 해시가 아니다 — 위·변조 탐지 용도가 아니라 그룹핑 용도이므로 내장 해시로 충분하다.
 * (변조 탐지가 필요한 감사로그는 audit/log.ts 처럼 해시를 주입받는다.)
 */
export function fingerprintOf(n: NormalizedError): string {
  const shape = n.messageMasked
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, '#')
    .replace(/\d+/g, '#')
    .slice(0, 120);
  // 최상단 프레임의 줄·칸 번호는 지운다 — 코드 한 줄만 옮겨도 같은 장애가 다른 건으로 갈라진다.
  const top = (n.frames[0] ?? '').replace(/\d+/g, '#');
  return `grp_${fnv1a(`${n.code}|${n.name}|${shape}|${top}`)}`;
}

function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ── 보고서 ────────────────────────────────────────────────────────────────────

export interface ReleaseInfo {
  version?: string;
  /** 짧은 커밋 해시. 긴 값은 12자로 자른다. */
  commit?: string;
}

export interface ErrorReport {
  fingerprint: string;
  severity: Severity;
  origin: ErrorOrigin;
  code: string;
  name: string;
  messageMasked: string;
  frames: string[];
  at?: string;
  requestId?: string;
  tenantId?: string;
  workspaceId?: string;
  interactionId?: string;
  environment?: string;
  release?: ReleaseInfo;
  fields?: Record<string, string | number | boolean>;
  /** 차단 규칙에 걸려 값이 제거된 키. 무엇을 숨겼는지는 남긴다. */
  redactedKeys?: string[];
  /** 이 보고가 대표하는 발생 횟수(중복 억제분 포함). 항상 1 이상. */
  occurrences: number;
}

export type ErrorTransport = (report: ErrorReport) => void | Promise<void>;

export interface CaptureContext {
  origin?: ErrorOrigin;
  /** 상위에서 이미 분류한 코드가 있으면 그것을 우선한다. */
  code?: string;
  severity?: Severity;
  scope?: TenantScope;
  requestId?: string;
  interactionId?: string;
  fields?: Record<string, unknown>;
}

export interface ErrorMonitorOptions {
  /**
   * 수집기 DSN. **값은 보관하지 않는다** — 설정 여부만 본다.
   * 비어 있으면(또는 미설정이면) 전송을 하지 않는다.
   */
  dsn?: string;
  /** DSN 을 읽어온 환경변수 이름(참조용 표기). 값이 아니다. */
  dsnEnvVar?: string;
  /** 실제 전송기. 주입하지 않으면 완전한 no-op. 외부 전송 연결은 [승인 필요]. */
  transport?: ErrorTransport;
  /** ISO 시각·중복 억제 창에 쓰는 시계. 없으면 at 을 비우고 억제도 하지 않는다(§13-3). */
  clock?: () => number;
  /** 같은 fingerprint 를 이 시간 안에는 한 번만 내보낸다. 억제분은 다음 보고의 occurrences 에 합산된다. */
  dedupeWindowMs?: number;
  /** 한 창(dedupeWindowMs) 안에서 내보낼 최대 건수. 알림 폭주로 수집기가 마비되는 것을 막는다. */
  maxPerWindow?: number;
  environment?: string;
  release?: ReleaseInfo;
  /** 스택 프레임 최대 개수. */
  maxFrames?: number;
  /** warning 심각도도 전송할 것인가. 기본은 전송하지 않는다(알림 잡음 방지). */
  reportWarnings?: boolean;
  /** 로거와 같은 기준 + 제품별 추가 차단 키. */
  extraDeniedFields?: readonly string[];
  /** 전송 실패 통지. 실패를 삼키지 않기 위한 마지막 출구다. */
  onTransportError?: (error: unknown, report: ErrorReport) => void;
}

export interface ErrorMonitorStats {
  /** capture 호출 수(억제·전송 여부와 무관). */
  captured: number;
  /** 전송기로 넘긴 수. */
  sent: number;
  /** 중복 억제로 보류된 수. */
  suppressed: number;
  /** 창 상한 초과로 버린 수. */
  dropped: number;
  /** 전송기가 던지거나 거부한 수. */
  failed: number;
}

export interface ErrorMonitor {
  /** 전송기가 주입되고 DSN 이 빈 값이 아닐 때만 true. false 면 아무것도 전송하지 않는다. */
  readonly enabled: boolean;
  /** DSN 이 설정되어 있는가(값은 노출하지 않는다). */
  readonly configured: boolean;
  readonly dsnEnvVar?: string;
  /**
   * 오류 한 건 처리. **절대 던지지 않는다** — 오류 보고 경로가 다시 오류를 내면 원래 실패를 덮어버린다.
   * 반환값은 만들어진 보고서(억제·비활성 시에도 호출자가 사용자에게 오류 ID 를 보여줄 수 있게 준다).
   */
  capture(error: unknown, ctx?: CaptureContext): ErrorReport | undefined;
  /** 아직 내보내지 못한 억제분을 합계 보고로 내보낸다(종료 직전 호출). */
  flush(): number;
  stats(): ErrorMonitorStats;
}

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[_\-\s]/g, '');
}

function sanitizeFieldValue(v: unknown): string | number | boolean | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  const s = typeof v === 'string' ? v : safeJson(v);
  return clean(s, MAX_FRAME_LEN);
}

function shortCommit(commit: string | undefined): string | undefined {
  if (!commit) return undefined;
  const trimmed = commit.trim();
  if (!/^[0-9a-fA-F]{7,40}$/.test(trimmed)) return undefined; // 형태를 알 수 없으면 남기지 않는다
  return trimmed.slice(0, 12).toLowerCase();
}

export function createErrorMonitor(opts: ErrorMonitorOptions = {}): ErrorMonitor {
  const configured = opts.dsn !== undefined && opts.dsn.trim().length > 0;
  const enabled = opts.transport !== undefined && (opts.dsn === undefined || configured);
  const denied = new Set<string>([
    ...DENIED_FIELDS.map(normalizeKey),
    ...(opts.extraDeniedFields ?? []).map(normalizeKey),
  ]);
  const maxFrames = opts.maxFrames ?? DEFAULT_MAX_FRAMES;
  const release = opts.release
    ? {
        ...(opts.release.version ? { version: opts.release.version } : {}),
        ...(shortCommit(opts.release.commit) ? { commit: shortCommit(opts.release.commit) } : {}),
      }
    : undefined;

  const stats: ErrorMonitorStats = { captured: 0, sent: 0, suppressed: 0, dropped: 0, failed: 0 };
  /** fingerprint → { 마지막 전송 시각, 그 뒤 억제된 횟수, 마지막 보고서 골격 } */
  const seen = new Map<string, { lastSentAt: number; pending: number; sample: ErrorReport }>();
  let windowStart: number | undefined;
  let sentInWindow = 0;
  /** 상한을 넘겨 버린 건수. 다음 성공 보고에 실어 "조용히 사라진 것이 있다"를 드러낸다. */
  let droppedPending = 0;

  function build(e: unknown, ctx: CaptureContext, occurrences: number): ErrorReport {
    const n = normalizeError(e, maxFrames);
    const origin = ctx.origin ?? 'captured';
    const code = ctx.code ?? n.code;
    const severity =
      ctx.severity ??
      (origin === 'captured'
        ? ((SEVERITY_BY_CODE as Record<string, Severity | undefined>)[code] ?? 'error')
        : 'fatal');

    const fields: Record<string, string | number | boolean> = {};
    const redactedKeys: string[] = [];
    for (const [k, v] of Object.entries(ctx.fields ?? {})) {
      if (denied.has(normalizeKey(k))) { redactedKeys.push(k); continue; }
      const sv = sanitizeFieldValue(v);
      if (sv !== undefined) fields[k] = sv;
    }

    return {
      fingerprint: fingerprintOf(n),
      severity,
      origin,
      code,
      name: n.name,
      messageMasked: n.messageMasked,
      frames: n.frames,
      ...(opts.clock ? { at: new Date(opts.clock()).toISOString() } : {}),
      ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
      ...(ctx.scope?.tenantId ? { tenantId: ctx.scope.tenantId } : {}),
      ...(ctx.scope?.workspaceId ? { workspaceId: ctx.scope.workspaceId } : {}),
      ...(ctx.interactionId ? { interactionId: ctx.interactionId } : {}),
      ...(opts.environment ? { environment: opts.environment } : {}),
      ...(release && (release.version || release.commit) ? { release } : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
      ...(redactedKeys.length > 0 ? { redactedKeys } : {}),
      occurrences,
    };
  }

  /** 전송. 실패해도 호출자에게 전파하지 않되, 통계와 훅으로 반드시 드러낸다. */
  function deliver(report: ErrorReport): void {
    const transport = opts.transport;
    if (!transport) return;
    try {
      const r = transport(report);
      stats.sent += 1;
      if (r && typeof (r as Promise<void>).catch === 'function') {
        (r as Promise<void>).catch((err: unknown) => {
          // 비동기 전송이 나중에 거부되면 앞서 센 성공을 되돌린다 — 통계가 거짓이면 없느니만 못하다.
          stats.sent -= 1;
          stats.failed += 1;
          try { opts.onTransportError?.(err, report); } catch { /* 통지 실패까지 추적하지는 않는다 */ }
        });
      }
    } catch (err) {
      stats.failed += 1;
      try { opts.onTransportError?.(err, report); } catch { /* 통지 실패까지 추적하지는 않는다 */ }
    }
  }

  /** 창 상한 검사. 시계가 없으면 창을 셀 수 없으므로 제한하지 않는다. */
  function allowedByWindow(now: number | undefined): boolean {
    if (opts.maxPerWindow === undefined || now === undefined || !opts.dedupeWindowMs) return true;
    if (windowStart === undefined || now - windowStart >= opts.dedupeWindowMs) {
      windowStart = now;
      sentInWindow = 0;                    // 버린 건수는 여기서 지우지 않는다 — 다음 보고에 실어 알린다
    }
    if (sentInWindow >= opts.maxPerWindow) {
      droppedPending += 1;
      return false;
    }
    sentInWindow += 1;
    return true;
  }

  /** 추적 중인 fingerprint 가 무한히 쌓이지 않게 오래된 것부터 정리한다. */
  function pruneSeen(now: number): void {
    const window = opts.dedupeWindowMs ?? 0;
    for (const [fp, entry] of seen) {
      if (entry.pending === 0 && now - entry.lastSentAt >= window * 2) seen.delete(fp);
    }
    if (seen.size <= MAX_TRACKED_FINGERPRINTS) return;
    const overflow = seen.size - MAX_TRACKED_FINGERPRINTS;
    let removed = 0;
    for (const [fp, entry] of seen) {
      if (removed >= overflow) break;
      if (entry.pending > 0) continue;    // 아직 알리지 못한 억제분은 버리지 않는다
      seen.delete(fp);
      removed += 1;
    }
  }

  return {
    enabled,
    configured,
    ...(opts.dsnEnvVar ? { dsnEnvVar: opts.dsnEnvVar } : {}),

    capture(error: unknown, ctx: CaptureContext = {}): ErrorReport | undefined {
      try {
        stats.captured += 1;
        const now = opts.clock?.();
        let report = build(error, ctx, 1);

        if (report.severity === 'warning' && !opts.reportWarnings) return report;
        if (!enabled) return report;

        // 중복 억제 — 시계가 있어야만 동작한다.
        if (opts.dedupeWindowMs && now !== undefined) {
          const prev = seen.get(report.fingerprint);
          if (prev && now - prev.lastSentAt < opts.dedupeWindowMs) {
            prev.pending += 1;
            prev.sample = report;
            stats.suppressed += 1;
            return report;
          }
          const pending = prev?.pending ?? 0;
          if (pending > 0) report = { ...report, occurrences: pending + 1 };
          seen.set(report.fingerprint, { lastSentAt: now, pending: 0, sample: report });
          pruneSeen(now);
        }

        if (!allowedByWindow(now)) {
          stats.dropped += 1;
          return report;
        }
        if (droppedPending > 0) {
          report = { ...report, fields: { ...report.fields, droppedSinceLastReport: droppedPending } };
          droppedPending = 0;
        }
        deliver(report);
        return report;
      } catch {
        // 보고 경로의 실패가 원래 오류를 덮으면 안 된다. 통계로만 남긴다.
        stats.failed += 1;
        return undefined;
      }
    },

    flush(): number {
      let flushed = 0;
      for (const [fp, entry] of seen) {
        if (entry.pending <= 0) continue;
        deliver({ ...entry.sample, occurrences: entry.pending });
        flushed += entry.pending;
        seen.set(fp, { ...entry, pending: 0 });
      }
      return flushed;
    },

    stats(): ErrorMonitorStats {
      return { ...stats };
    },
  };
}

// ── 전역 캡처 ─────────────────────────────────────────────────────────────────

/**
 * 전역 오류 훅의 최소 계약. node 의 process, 브라우저의 window 가 구조적으로 이 모양이다.
 * Core 가 process 를 직접 참조하면 런타임 종속이 생기므로(§6.2 취지) 호스트가 넣어준다.
 */
export interface GlobalErrorSource {
  on(event: string, handler: (payload: unknown) => void): unknown;
  off?(event: string, handler: (payload: unknown) => void): unknown;
  removeListener?(event: string, handler: (payload: unknown) => void): unknown;
}

export interface GlobalCaptureOptions {
  uncaughtEvent?: string;
  rejectionEvent?: string;
  fields?: Record<string, unknown>;
}

/**
 * 잡히지 않은 예외·거부를 monitor 로 보낸다. 반환값은 해제 함수다.
 * 프로세스를 종료시키지 않는다 — 종료 정책은 호스트가 정한다(라이브러리가 남의 프로세스를 죽이면 안 된다).
 */
export function installGlobalCapture(
  monitor: ErrorMonitor,
  source: GlobalErrorSource,
  opts: GlobalCaptureOptions = {},
): () => void {
  const uncaughtEvent = opts.uncaughtEvent ?? 'uncaughtException';
  const rejectionEvent = opts.rejectionEvent ?? 'unhandledRejection';

  const onUncaught = (payload: unknown): void => {
    monitor.capture(payload, { origin: 'uncaught', ...(opts.fields ? { fields: opts.fields } : {}) });
  };
  const onRejection = (payload: unknown): void => {
    // 브라우저 이벤트는 { reason } 으로 감싸 온다. node 는 이유를 그대로 준다.
    const reason =
      payload && typeof payload === 'object' && 'reason' in (payload as Record<string, unknown>)
        ? (payload as { reason: unknown }).reason
        : payload;
    monitor.capture(reason, { origin: 'unhandled_rejection', ...(opts.fields ? { fields: opts.fields } : {}) });
  };

  source.on(uncaughtEvent, onUncaught);
  source.on(rejectionEvent, onRejection);

  return () => {
    const off = source.off ?? source.removeListener;
    if (!off) return;                              // 해제 수단이 없으면 조용히 둔다(강제 해제 금지)
    off.call(source, uncaughtEvent, onUncaught);
    off.call(source, rejectionEvent, onRejection);
  };
}

/**
 * 환경변수에서 DSN 설정 여부만 읽는다. **값을 반환하지 않는다.**
 * 실제 전송기 연결은 [승인 필요] — 이 함수는 "켤 준비가 되었는가"만 알려준다.
 */
export function resolveDsnConfig(
  env: Record<string, string | undefined>,
  varName = 'AICC_ERROR_DSN',
): { configured: boolean; envVar: string } {
  const raw = env[varName];
  return { configured: typeof raw === 'string' && raw.trim().length > 0, envVar: varName };
}
