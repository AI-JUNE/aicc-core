// HTTP 커넥터 포트 실구현 — 설계서 §6.1(연동)·§6.2(종속 코드 격리)·§9.3(폴백)·§10.3(개인정보)·§13-3.
//
// `ConnectorPort` 는 선언만 있고 **구현이 하나도 없었다**(저장소 전체 검색 결과 0건).
// 그 상태의 §6.1 은 "계약은 있는데 아무도 지나가 본 적 없는 길"이고, 실제로 붙을 때가 되면
// 채널 3곳이 각자 fetch 를 쓴다. 거기서 나는 사고는 예외가 아니라 **조용한 유출과 조용한 오답**이다.
//   1) **개인정보가 URL 쿼리스트링에 실린다.** GET 으로 주민번호를 조회하면 그 값은 업무시스템 접근 로그,
//      프록시 로그, APM 트레이스에 **마스킹 없이 영구 보존**된다 — 우리 쪽 §10.3 을 다 지켜도 새어 나간다.
//      그래서 **pii 파라미터가 선언된 커넥터는 쿼리스트링으로 보내지 않는다**(본문으로만).
//   2) **오류 본문을 그대로 detail 에 싣는다.** 업무시스템 오류 응답에는 조회한 고객 정보가 되돌아온다.
//      여기서는 **상태 코드만** 싣는다 — 본문은 어떤 경로로도 나가지 않는다.
//   3) **200 으로 싸인 오류를 성공으로 읽는다.** 본문이 객체가 아니면 `schema_mismatch` 다.
//   4) **멱등 키를 헤더에 안 싣는다.** 실으려면 여기서 실어야 한다 — 안 실으면 재시도가 곧 중복 처리다.
//   5) **타임아웃이 없다.** 무한 대기는 콜을 붙잡아 둔다(§9.3).
//
// 엔드포인트 원문·자격증명은 **Core 에 두지 않는다**(§6.1 규약 1). `endpointRef` 를 실제 주소로 푸는 일은
// 호스트가 주입한 `resolveEndpoint` 가 하고, 이 파일은 그 결과를 받아 쓰기만 한다.
// 기본 `dry_run` — 실호출은 승인 근거(approvalRef)와 전송 구현이 **둘 다** 있어야 켜진다 **[승인 필요]**.
import type { FetchLike } from '../adapters/http.ts';
import { maskPii } from '../core/policyGuard.ts';
import type {
  ConnectorErrorCode, ConnectorPort, ConnectorRequest, ConnectorResponse, ParamValue,
} from './connector.ts';

export const HTTP_CONNECTOR_CONTRACT_VERSION = 1;

export type ConnectorActivation = 'dry_run' | 'live';

/** 파라미터를 어디에 싣는가. pii 가 섞이면 `query` 는 선택지에서 빠진다(위 1번). */
export type ParamPlacement = 'query' | 'body';

/**
 * `endpointRef` → 실제 호출 정보. 호스트(시크릿 저장소)가 푼다.
 * 인증 값을 여기에 넣지 않는다 — 환경변수 **이름**만 넘기고 값은 `resolveSecret` 이 가져온다.
 */
export interface ResolvedEndpoint {
  url: string;
  /** 생략하면 query 커넥터는 GET, command 커넥터는 POST. */
  httpMethod?: 'GET' | 'POST' | 'PUT' | 'PATCH';
  /** 인증키가 담긴 환경변수 **이름**. */
  apiKeyEnv?: string;
  /** 인증 헤더 이름. 생략하면 `authorization: Bearer <값>`. */
  authHeader?: string;
  /** 자격증명이 아닌 고정 헤더만. 여기에 토큰을 적으면 그대로 평문 설정이 된다. */
  headers?: Record<string, string>;
}

export interface HttpConnectorConfig {
  /** 포트 이름(로그 식별용). 업무시스템 실제 주소를 적지 않는다. */
  name: string;
  activation: ConnectorActivation;
  /** live 활성화 근거(승인자·티켓). 없으면 live 로 만들 수 없다. */
  approvalRef?: string;
  resolveEndpoint: (endpointRef: string) => ResolvedEndpoint | undefined;
  /** 환경변수 **이름**으로 실제 비밀값을 가져온다. 주입하지 않으면 인증이 필요한 엔드포인트는 live 가 안 된다. */
  resolveSecret?: (envName: string) => string | undefined;
  fetchImpl?: FetchLike;
  /** 지연 실측용 시계(ms). 주입하지 않으면 지연을 **만들어 넣지 않는다**(§13-3). */
  clock?: () => number;
  /** 멱등 키를 실을 헤더 이름. 생략하면 `idempotency-key`. */
  idempotencyHeader?: string;
  /** 응답 본문 크기 상한(byte). 주지 않으면 검사하지 않는다(§13-3). */
  maxResponseBytes?: number;
}

/** 검토용 요청 계획. 파라미터 값은 실리지 않는다 — **이름만** 남는다(§10.3). */
export interface ConnectorRequestPlan {
  httpMethod: string;
  url: string;
  /** 자격증명 자리는 참조 이름으로 대체된다. */
  headers: Record<string, string>;
  placement: ParamPlacement;
  paramNames: string[];
  activation: ConnectorActivation;
}

export interface HttpConnectorPort extends ConnectorPort {
  readonly activation: ConnectorActivation;
  /** 실호출 없이 "무엇을 보낼 것인가"를 보여준다. dry_run 검토·감사 근거. */
  plan(request: ConnectorRequest, piiParamNames?: readonly string[]): ConnectorRequestPlan | { error: string };
}

const AUTH_PLACEHOLDER = (envName: string | undefined): string =>
  envName ? `[승인 필요: env:${envName}]` : '[미설정]';

function statusToCode(status: number): ConnectorErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 408) return 'timeout';
  if (status === 429 || status === 503) return 'unavailable';
  if (status >= 500) return 'server_error';
  if (status >= 400) return 'invalid_request';
  return 'server_error';
}

function defaultMethod(m: ConnectorRequest['method']): 'GET' | 'POST' {
  return m === 'query' ? 'GET' : 'POST';
}

function encodeQuery(params: Record<string, ParamValue>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

/**
 * HTTP 커넥터 포트를 만든다. **던지지 않는다** — `ConnectorPort.call` 계약대로 모든 실패를
 * `{ ok: false, code }` 로 돌려준다. 업무시스템 장애로 통화가 끊기면 안 된다(§9.3).
 * 설정 오류(live 인데 승인 근거·전송 구현 없음)만 생성 시점에 던진다 — 그건 런타임 장애가 아니다.
 */
export function createHttpConnectorPort(cfg: HttpConnectorConfig): HttpConnectorPort {
  const fetchImpl = cfg.fetchImpl ?? (globalThis as { fetch?: FetchLike }).fetch;
  if (cfg.activation === 'live') {
    if (!cfg.approvalRef) {
      throw new Error('[승인 필요] 커넥터 실호출(live)에는 승인 근거(approvalRef)가 필요합니다.');
    }
    if (!fetchImpl) throw new Error('전송 구현(fetchImpl)이 없어 live 로 만들 수 없습니다.');
  }
  const idemHeader = cfg.idempotencyHeader ?? 'idempotency-key';

  /** 배치 결정 — 여기서만 정한다. pii 가 있으면 쿼리스트링은 선택지가 아니다. */
  function placementOf(httpMethod: string, hasPii: boolean): ParamPlacement | { error: string } {
    if (httpMethod === 'GET') {
      if (hasPii) {
        return {
          error: '개인정보 파라미터를 쿼리스트링으로 보낼 수 없습니다 — URL 은 상대 접근 로그·프록시에 마스킹 없이 남습니다(§10.3). 엔드포인트를 POST 로 선언하세요.',
        };
      }
      return 'query';
    }
    return 'body';
  }

  function prepare(
    request: ConnectorRequest, piiParamNames: readonly string[],
  ): { ep: ResolvedEndpoint; httpMethod: string; placement: ParamPlacement } | { error: string } {
    const ep = cfg.resolveEndpoint(request.endpointRef);
    if (!ep) return { error: `엔드포인트 참조를 풀 수 없습니다: ${request.endpointRef}` };
    if (!/^https?:\/\/./.test(ep.url)) return { error: `엔드포인트 URL 형식 위반: ${JSON.stringify(ep.url)}` };
    const httpMethod = ep.httpMethod ?? defaultMethod(request.method);
    const hasPii = piiParamNames.some((n) => Object.prototype.hasOwnProperty.call(request.params, n));
    const placement = placementOf(httpMethod, hasPii);
    if (typeof placement === 'object') return placement;
    return { ep, httpMethod, placement };
  }

  function plan(request: ConnectorRequest, piiParamNames: readonly string[] = []): ConnectorRequestPlan | { error: string } {
    const p = prepare(request, piiParamNames);
    if ('error' in p) return p;
    const headers: Record<string, string> = {
      ...(p.ep.headers ?? {}),
      [idemHeader]: request.idempotencyKey,
      [p.ep.authHeader ?? 'authorization']: AUTH_PLACEHOLDER(p.ep.apiKeyEnv),
    };
    if (p.placement === 'body') headers['content-type'] = 'application/json';
    return {
      httpMethod: p.httpMethod,
      url: p.ep.url,                      // 파라미터는 붙이지 않는다 — 계획에 값이 실리면 계획이 곧 유출 경로다
      headers,
      placement: p.placement,
      paramNames: Object.keys(request.params),
      activation: cfg.activation,
    };
  }

  async function call(request: ConnectorRequest, piiParamNames: readonly string[] = []): Promise<ConnectorResponse> {
    const p = prepare(request, piiParamNames);
    if ('error' in p) return { ok: false, code: 'invalid_request', detail: p.error };

    if (cfg.activation !== 'live') {
      return {
        ok: false, code: 'unavailable',
        detail: `[승인 필요] ${cfg.name} 커넥터 실호출은 승인 전까지 비활성입니다(plan() 으로 요청을 확인하세요).`,
      };
    }
    if (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0) {
      return { ok: false, code: 'invalid_request', detail: 'timeoutMs 는 1 이상의 정수여야 합니다.' };
    }

    const headers: Record<string, string> = { ...(p.ep.headers ?? {}), [idemHeader]: request.idempotencyKey };
    if (p.ep.apiKeyEnv) {
      const secret = cfg.resolveSecret?.(p.ep.apiKeyEnv);
      if (!secret) {
        // 값은 남기지 않는다 — 이름만 적는다.
        return { ok: false, code: 'unauthorized', detail: `인증키 미설정: env:${p.ep.apiKeyEnv}` };
      }
      headers[p.ep.authHeader ?? 'authorization'] = p.ep.authHeader ? secret : `Bearer ${secret}`;
    }

    let url = p.ep.url;
    let body = '';
    if (p.placement === 'query') {
      const qs = encodeQuery(request.params);
      if (qs) url = `${url}${url.includes('?') ? '&' : '?'}${qs}`;
    } else {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(request.params);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    const started = cfg.clock?.();
    try {
      const res = await (fetchImpl as FetchLike)(url, {
        method: p.httpMethod, headers, body, signal: controller.signal,
      });
      const latencyMs = started !== undefined && cfg.clock ? cfg.clock() - started : undefined;
      const lat = latencyMs !== undefined ? { latencyMs } : {};
      if (!res.ok) {
        // 본문을 읽지도 싣지도 않는다 — 업무시스템 오류 응답에 조회 대상 정보가 되돌아온다(§10.3).
        return { ok: false, code: statusToCode(res.status), detail: `업무시스템 응답 오류(status ${res.status})`, ...lat };
      }
      const raw = await res.text();
      if (cfg.maxResponseBytes !== undefined && raw.length > cfg.maxResponseBytes) {
        return { ok: false, code: 'schema_mismatch', detail: `응답 본문이 상한(${cfg.maxResponseBytes}byte)을 넘었습니다.`, ...lat };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { ok: false, code: 'schema_mismatch', detail: '응답을 JSON 으로 해석할 수 없습니다.', ...lat };
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        // 200 으로 싸인 오류·배열 응답을 성공으로 읽지 않는다. applyResponse 는 1단계 키만 본다(§6.1).
        return { ok: false, code: 'schema_mismatch', detail: '응답 최상위가 객체가 아닙니다.', ...lat };
      }
      return { ok: true, data: parsed as Record<string, unknown>, ...lat };
    } catch (err) {
      const latencyMs = started !== undefined && cfg.clock ? cfg.clock() - started : undefined;
      const lat = latencyMs !== undefined ? { latencyMs } : {};
      const aborted = controller.signal.aborted;
      return {
        ok: false,
        code: aborted ? 'timeout' : 'unavailable',
        detail: aborted
          ? `업무시스템 응답 시간 초과(${request.timeoutMs}ms)`
          : maskPii(err instanceof Error ? err.message : String(err)).text,
        ...lat,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { activation: cfg.activation, plan, call };
}
