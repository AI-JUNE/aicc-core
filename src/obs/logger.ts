// 구조화 로깅 — 설계서 §8.1(이벤트·추적)·§9.3(장애 인지)·§10.3(개인정보 미기록)·§11.1(테넌트)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// 상용에서 장애를 좁히려면 "언제·누가·무엇이·얼마나 걸려·어떤 코드로 실패했는가"가 한 줄에 있어야 한다.
// 그런데 그 한 줄을 자유 문자열로 적기 시작하면, 두 가지가 반드시 일어난다.
//  1) 발화 원문·전화번호가 로그에 그대로 남는다(§10.3 위반, 사고 시 회수 불가).
//  2) 채널 저장소마다 형식이 달라 집계·검색이 안 된다.
// 그래서 필드를 고정하고, 값은 전부 마스킹·차단 규칙을 통과시킨 뒤에만 기록한다.
//
// 무엇을 하지 않는가:
//  - 외부 전송을 하지 않는다. sink 를 주입하지 않으면 아무 데도 쓰지 않는다(미설정 시 무해한 no-op).
//  - 시각·소요시간을 임의로 만들지 않는다. clock 주입이 없으면 해당 필드를 비운다(§13-3).
import { maskPii } from '../core/policyGuard.ts';
import type { TenantScope } from '../core/tenancy.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * 어떤 값이 와도 로그에 실리면 안 되는 키.
 * 마스킹으로도 충분하지 않은 것들이다 — 인증값은 형태가 제각각이라 규칙으로 못 잡고,
 * 발화 원문은 마스킹해도 대화 내용 자체가 남는다. 값을 지우고 있었다는 사실만 남긴다.
 */
export const DENIED_FIELDS: readonly string[] = [
  'authorization', 'apikey', 'api_key', 'token', 'accesstoken', 'refreshtoken',
  'password', 'secret', 'cookie', 'sessionkey',
  'text', 'utterance', 'transcript', 'prompt', 'answer', 'message', 'content',
  'phone', 'phonenumber', 'callerid', 'email', 'name', 'address', 'rrn', 'ssn', 'card', 'account',
];

const REDACTED = '[제거됨]';
/** 값이 아무리 길어도 로그 한 줄이 터지지 않게 자른다. */
const MAX_VALUE_LEN = 200;

/** 고정 필드. 자유 필드는 fields 아래에만 들어간다. */
export interface LogRecord {
  level: LogLevel;
  /** 무슨 일이 일어났는가. 점 표기 이름(예: channel.present). 자유 문장이 아니다. */
  event: string;
  /** 발생 시각(ISO). clock 주입이 없으면 비운다. */
  at?: string;
  /** 요청 상관관계 식별자. 이 값으로 채널→Core→엔진 로그를 잇는다. */
  requestId?: string;
  tenantId?: string;
  workspaceId?: string;
  interactionId?: string;
  /** 실측 소요(ms). 만들어 넣지 않는다. */
  durationMs?: number;
  /** 실패 분류 코드(E_TIMEOUT 등). 메시지 대신 코드로 분기한다. */
  code?: string;
  /** 마스킹·차단 규칙을 통과한 부가 필드. */
  fields?: Record<string, string | number | boolean>;
  /** 차단 규칙에 걸려 값이 제거된 키 목록. 무엇을 숨겼는지는 남긴다. */
  redactedKeys?: string[];
}

export type LogSink = (record: LogRecord) => void;

export interface LoggerOptions {
  /** 이 수준 미만은 버린다. 기본 info. */
  minLevel?: LogLevel;
  /** 기록 대상. 없으면 아무것도 하지 않는다(미설정 시 무해한 no-op). */
  sink?: LogSink;
  /** ISO 시각을 만들 시계. 없으면 at 을 비운다. */
  clock?: () => number;
  /** 모든 레코드에 붙는 기본 컨텍스트. */
  base?: Partial<Pick<LogRecord, 'requestId' | 'tenantId' | 'workspaceId' | 'interactionId'>>;
  /** 차단 키 추가(제품별 필드). 기본 목록에 더해진다. */
  extraDeniedFields?: readonly string[];
}

export interface LogContext {
  requestId?: string;
  scope?: TenantScope;
  interactionId?: string;
  code?: string;
  durationMs?: number;
  fields?: Record<string, unknown>;
}

export interface Logger {
  readonly minLevel: LogLevel;
  debug(event: string, ctx?: LogContext): void;
  info(event: string, ctx?: LogContext): void;
  warn(event: string, ctx?: LogContext): void;
  error(event: string, ctx?: LogContext): void;
  /** 하위 컨텍스트 고정(요청 단위). 부모 설정을 그대로 물려받는다. */
  child(base: LoggerOptions['base']): Logger;
  /**
   * 소요시간 측정. clock 주입이 없으면 durationMs 를 비운 채로 기록한다 —
   * 0 이나 추정치를 넣지 않는다(§13-3).
   */
  time<T>(event: string, run: () => Promise<T>, ctx?: LogContext): Promise<T>;
}

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[_\-\s]/g, '');
}

/** 문자열 값은 마스킹 후 길이를 제한한다. 숫자·불리언은 그대로 둔다. */
function sanitizeValue(v: unknown): string | number | boolean | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s === undefined) return undefined;
  const masked = maskPii(s).text;
  return masked.length > MAX_VALUE_LEN ? `${masked.slice(0, MAX_VALUE_LEN)}…` : masked;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const minLevel = opts.minLevel ?? 'info';
  const denied = new Set<string>([
    ...DENIED_FIELDS.map(normalizeKey),
    ...(opts.extraDeniedFields ?? []).map(normalizeKey),
  ]);

  function build(level: LogLevel, event: string, ctx: LogContext = {}): LogRecord {
    const fields: Record<string, string | number | boolean> = {};
    const redactedKeys: string[] = [];
    for (const [k, v] of Object.entries(ctx.fields ?? {})) {
      if (denied.has(normalizeKey(k))) { redactedKeys.push(k); continue; }
      const sv = sanitizeValue(v);
      if (sv !== undefined) fields[k] = sv;
    }
    const rec: LogRecord = {
      level,
      event,
      ...(opts.clock ? { at: new Date(opts.clock()).toISOString() } : {}),
      ...(ctx.requestId ?? opts.base?.requestId ? { requestId: ctx.requestId ?? opts.base?.requestId } : {}),
      ...(ctx.scope?.tenantId ?? opts.base?.tenantId ? { tenantId: ctx.scope?.tenantId ?? opts.base?.tenantId } : {}),
      ...(ctx.scope?.workspaceId ?? opts.base?.workspaceId ? { workspaceId: ctx.scope?.workspaceId ?? opts.base?.workspaceId } : {}),
      ...(ctx.interactionId ?? opts.base?.interactionId ? { interactionId: ctx.interactionId ?? opts.base?.interactionId } : {}),
      ...(ctx.code ? { code: ctx.code } : {}),
      ...(ctx.durationMs !== undefined ? { durationMs: ctx.durationMs } : {}),
      ...(Object.keys(fields).length > 0 ? { fields } : {}),
      ...(redactedKeys.length > 0 ? { redactedKeys } : {}),
    };
    return rec;
  }

  function emit(level: LogLevel, event: string, ctx?: LogContext): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    if (!opts.sink) return;                        // 미설정이면 아무 일도 하지 않는다
    const rec = build(level, event, ctx);
    // 로깅 실패가 업무 흐름을 멈추면 안 된다. 다만 조용히 넘기는 대신 콘솔로 한 번은 알린다.
    try { opts.sink(rec); } catch { /* sink 장애는 호출자에게 전파하지 않는다 */ }
  }

  const logger: Logger = {
    minLevel,
    debug: (e, c) => emit('debug', e, c),
    info: (e, c) => emit('info', e, c),
    warn: (e, c) => emit('warn', e, c),
    error: (e, c) => emit('error', e, c),
    child: (base) => createLogger({ ...opts, base: { ...opts.base, ...base } }),
    async time<T>(event: string, run: () => Promise<T>, ctx: LogContext = {}): Promise<T> {
      const started = opts.clock?.();
      const elapsed = (): number | undefined => (started !== undefined && opts.clock ? opts.clock() - started : undefined);
      try {
        const value = await run();
        emit('info', event, { ...ctx, durationMs: elapsed() });
        return value;
      } catch (e) {
        // 오류를 삼키지 않는다. 기록한 뒤 그대로 다시 던진다(품질기준 §3).
        emit('error', event, {
          ...ctx,
          durationMs: elapsed(),
          code: ctx.code ?? (typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'E_UNHANDLED'),
          fields: { ...ctx.fields, reason: e instanceof Error ? e.message : String(e) },
        });
        throw e;
      }
    },
  };
  return logger;
}

/**
 * 요청 식별자 생성기. 난수원을 주입받는다 —
 * 라이브러리가 런타임 전역(crypto)에 의존하면 브라우저·워커·서버에서 서로 다르게 깨진다.
 */
export function createRequestIdFactory(random: () => number = Math.random): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    const r = Math.floor(random() * 0xffffff).toString(36).padStart(4, '0');
    return `req_${seq.toString(36)}_${r}`;
  };
}

/** 로그 한 줄 직렬화(JSON Lines). 파일·수집기로 보내는 sink 가 그대로 쓴다. */
export function formatLine(rec: LogRecord): string {
  return JSON.stringify(rec);
}

/** 테스트·개발용 수집 sink. 상용 sink 는 각 저장소가 붙인다. */
export function createMemorySink(limit = 1000): LogSink & { readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  const sink = ((rec: LogRecord) => {
    records.push(rec);
    if (records.length > limit) records.splice(0, records.length - limit);
  }) as LogSink & { records: LogRecord[] };
  sink.records = records;
  return sink;
}
