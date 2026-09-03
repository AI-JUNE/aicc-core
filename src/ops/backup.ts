// 백업·복구 — 설계서 §9.3(장애 대응)·§10.3(저장 전 마스킹)·§11.1(테넌트 격리)·§13-3(실측만).
//
// 왜 이 파일이 필요한가:
// 백업은 "돌려봤는가"로만 증명된다. 백업 잡이 초록불인데 복구가 안 되는 사고는
// 대부분 (a) 스냅샷 일부가 조용히 잘렸거나, (b) 복구 대상에 다른 테넌트 자료가 섞였거나,
// (c) 애초에 원본이 비어 있었는데 성공으로 집계된 경우다. 절차 문서만으로는 이 셋을 못 잡는다.
// 그래서 스냅샷 생성 → 직렬화 → 부분손상 복구 → 되읽기 대조까지를 **실행 가능한 리허설**로 만든다.
// RUNBOOK.md 의 리허설 기록은 이 모듈의 실행 결과이며, 사람이 손으로 적은 수치가 아니다(§13-3).
//
// 무엇을 하지 않는가 (build now, activate on approval):
//  - 실제 DB·오브젝트 스토리지에 붙지 않는다. 원본(BackupSource)·복구대상(RestoreSink)은 호스트가 주입한다.
//  - 운영 데이터를 대상으로 한 실복구는 **[승인 필요]**. 이 모듈은 주입된 대상에만 쓴다.
//  - 암호화 키·자격증명을 다루지 않는다. 스냅샷에 비밀값을 넣을 경로 자체를 만들지 않는다.
import { maskPii } from '../core/policyGuard.ts';
import { assertTenantScope, partitionKey, type TenantScope } from '../core/tenancy.ts';
import type { DataClass } from '../core/retention.ts';

export const SNAPSHOT_FORMAT_VERSION = 1;

export type BackupErrorCode =
  | 'E_SOURCE'     // 원본 읽기 실패·규약 위반 반환값
  | 'E_TIMEOUT'    // 예산 안에 정착하지 않음
  | 'E_INTEGRITY'  // 체크섬·건수 불일치
  | 'E_TENANCY'    // 스코프 밖 레코드 혼입(§11.1)
  | 'E_PII'        // 마스킹 미경유 값 발견(§10.3)
  | 'E_SINK';      // 복구 대상 쓰기 실패

export class BackupError extends Error {
  readonly code: BackupErrorCode;
  constructor(code: BackupErrorCode, messageKo: string) {
    super(messageKo);
    this.name = 'BackupError';
    this.code = code;
  }
}

/**
 * 백업 단위 레코드.
 *
 * body 를 `Record<string, string>` 으로 못박은 것은 의도적이다. 임의 객체를 허용하면
 * 중첩 깊은 곳의 원문이 마스킹 점검을 우회한다 — 실제 사고가 나는 지점이 정확히 거기다(§10.3).
 * 구조가 필요한 값은 호출자가 직렬화해서 넣고, 넣기 전에 마스킹을 거친다.
 */
export interface BackupRecord {
  tenantId: string;
  workspaceId?: string;
  dataClass: DataClass;
  id: string;
  createdAt: string;
  body: Record<string, string>;
}

/** 원본. 커서 기반으로 페이지를 낸다 — 전량을 한 번에 메모리에 올리지 않기 위해서다. */
export interface BackupSource {
  readonly name: string;
  read(cursor: string | undefined): Promise<{ records: BackupRecord[]; nextCursor?: string }>;
}

/** 복구 대상. readAll 이 있어야 리허설이 '대조까지' 갈 수 있다. 없으면 판정은 inconclusive 다. */
export interface RestoreSink {
  readonly name: string;
  write(records: readonly BackupRecord[]): Promise<void>;
  readAll?(): Promise<BackupRecord[]>;
}

export interface SnapshotCounts {
  total: number;
  byTenant: Record<string, number>;
  byDataClass: Record<string, number>;
}

export interface Snapshot {
  formatVersion: number;
  scope: TenantScope;
  partition: string;
  sourceName: string;
  counts: SnapshotCounts;
  /** 순서 무관 체크섬. 복구가 순서를 바꿨다는 이유로 거짓 실패를 내지 않기 위해서다. */
  checksum: string;
  /** clock 주입이 있을 때만 채운다. 시각을 만들어 넣지 않는다(§13-3). */
  createdAt?: string;
  records: readonly BackupRecord[];
}

// ── 내부 유틸 ────────────────────────────────────────────────────────────────

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 키 순서에 흔들리지 않는 정규 문자열. 같은 레코드는 어디서 읽어도 같은 해시가 나와야 한다.
 * 구분자로 제어문자를 쓰는 이유: 본문에 나타날 수 없는 문자여야
 * `{a:"1|2"}` 와 `{a:"1", b:"2"}` 가 같은 문자열로 뭉개지지 않는다.
 */
const FIELD_SEP = '\u0001';
const KV_SEP = '\u0002';

function canonical(r: BackupRecord): string {
  const keys = Object.keys(r.body).sort();
  const body = keys.map((k) => `${k}${KV_SEP}${r.body[k] ?? ''}`).join(FIELD_SEP);
  return [r.tenantId, r.workspaceId ?? '', r.dataClass, r.id, r.createdAt, body].join(FIELD_SEP);
}

/** 합(sum)과 배타합(xor)을 함께 쓴다. 둘 다 교환법칙을 만족하면서, 하나만 쓸 때보다 충돌이 어렵다. */
export function checksumOf(records: readonly BackupRecord[]): string {
  let sum = 0;
  let xor = 0;
  for (const r of records) {
    const h = fnv1a(canonical(r));
    sum = (sum + h) >>> 0;
    xor = (xor ^ h) >>> 0;
  }
  return `${records.length}-${sum.toString(16)}-${xor.toString(16)}`;
}

function countOf(records: readonly BackupRecord[]): SnapshotCounts {
  const byTenant: Record<string, number> = {};
  const byDataClass: Record<string, number> = {};
  for (const r of records) {
    byTenant[r.tenantId] = (byTenant[r.tenantId] ?? 0) + 1;
    byDataClass[r.dataClass] = (byDataClass[r.dataClass] ?? 0) + 1;
  }
  return { total: records.length, byTenant, byDataClass };
}

async function withBudget<T>(p: Promise<T>, ms: number | undefined, whatKo: string): Promise<T> {
  if (ms === undefined) return p;
  // 예산을 넘긴 뒤 뒤늦게 거부되는 promise 가 프로세스를 죽이지 않게 한다.
  p.catch(() => { /* 아래 race 에서 이미 실패로 처리된다 */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_res, rej) => {
    timer = setTimeout(
      () => rej(new BackupError('E_TIMEOUT', `${whatKo}이(가) ${ms}ms 예산 안에 정착하지 않았습니다.`)),
      ms,
    );
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** 스코프 소속 판정. workspace 가 지정되면 그 하위만, 아니면 테넌트 전역. */
function inScope(r: BackupRecord, scope: TenantScope): boolean {
  if (r.tenantId !== scope.tenantId) return false;
  if (scope.workspaceId !== undefined && r.workspaceId !== scope.workspaceId) return false;
  return true;
}

/**
 * 이미 마스킹된 흔적을 검사 대상에서 뺀다.
 *
 * 왜 필요한가: `900101-*******` 처럼 **정상적으로 마스킹된 주민번호**의 앞 6자리가
 * 계좌 패턴(`\d{2,3}-?\d{2,6}-?\d{2,6}`)에 다시 걸린다. 이걸 놔두면 규정을 지켜 저장한
 * 자료의 백업이 통째로 거부된다 — 가드가 오히려 백업을 막는 최악의 형태다.
 *
 * 규칙: 숫자·`*`·`-` 로만 이어진 한 덩어리 안에 `***` 가 있으면 그 덩어리는 마스킹 산출물로 본다.
 * 덩어리는 하이픈으로만 이어지므로, 공백으로 떨어진 옆의 원문 번호는 그대로 검사된다.
 * (이 함수는 maskPii 를 빠뜨린 코드 경로를 잡는 안전망이지, 우회를 노린 입력에 대한 방어가 아니다.)
 */
function stripMaskedArtifacts(v: string): string {
  return v.replace(/[0-9*]+(?:-[0-9*]+)*/g, (token) => (token.includes('***') ? ' ' : token));
}

/**
 * 마스킹 미경유 값 탐지(§10.3).
 * maskPii 가 무언가를 잡아냈다면 그 값은 **원문 상태로 저장 경로에 들어온 것**이다.
 * 반환은 필드명뿐 — 무엇이 걸렸는지 알리되 원문을 다시 노출하지 않는다.
 */
export function findUnmaskedFields(r: BackupRecord): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(r.body)) {
    if (typeof v !== 'string') { out.push(k); continue; }
    if (maskPii(stripMaskedArtifacts(v)).masked) out.push(k);
  }
  return out.sort();
}

// ── 스냅샷 생성 ──────────────────────────────────────────────────────────────

export interface SnapshotOptions {
  source: BackupSource;
  scope: TenantScope;
  /** 페이지 한 번 읽기에 허용하는 예산(ms). 계약값을 넣는다 — 코드 기본값을 두지 않는다(§13-3). */
  timeoutMs?: number;
  /** 실측 시각용. 주입하지 않으면 createdAt 을 채우지 않는다. */
  clock?: () => number;
  /** 안전장치: 원본이 커서를 잘못 내보내 무한히 도는 것을 막는다. */
  maxPages?: number;
  maxRecords?: number;
}

const DEFAULT_MAX_PAGES = 10_000;

export async function createSnapshot(opts: SnapshotOptions): Promise<Snapshot> {
  assertTenantScope(opts.scope);
  const records: BackupRecord[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;

  for (let page = 0; page < maxPages; page++) {
    let chunk: { records: BackupRecord[]; nextCursor?: string };
    try {
      chunk = await withBudget(Promise.resolve(opts.source.read(cursor)), opts.timeoutMs, '원본 읽기');
    } catch (e) {
      if (e instanceof BackupError) throw e;
      const why = maskPii(e instanceof Error ? e.message : String(e)).text;
      throw new BackupError('E_SOURCE', `원본(${opts.source.name}) 읽기 실패: ${why}`);
    }
    if (!chunk || !Array.isArray(chunk.records)) {
      throw new BackupError('E_SOURCE', `원본(${opts.source.name})이 규약과 다른 값을 돌려줬습니다.`);
    }
    for (const r of chunk.records) {
      if (!inScope(r, opts.scope)) {
        // 여기서 그냥 걸러내면 안 된다. 원본 쿼리에 스코프가 안 걸렸다는 뜻이고,
        // 그 상태의 백업은 다른 테넌트 자료를 품고 있을 수 있다(§11.1).
        throw new BackupError(
          'E_TENANCY',
          `스코프(${partitionKey(opts.scope)}) 밖 레코드가 원본에서 나왔습니다. 원본 쿼리에 테넌트 조건이 빠졌습니다.`,
        );
      }
      const unmasked = findUnmaskedFields(r);
      if (unmasked.length > 0) {
        throw new BackupError('E_PII', `마스킹을 거치지 않은 값이 있습니다: ${r.dataClass}.${unmasked.join(',')} (§10.3)`);
      }
      records.push(r);
      if (opts.maxRecords !== undefined && records.length > opts.maxRecords) {
        throw new BackupError('E_SOURCE', `스냅샷 상한(${opts.maxRecords}건)을 넘었습니다. 범위를 좁혀 다시 뜨십시오.`);
      }
    }
    const next = chunk.nextCursor;
    if (next === undefined) break;
    if (seenCursors.has(next)) {
      throw new BackupError('E_SOURCE', `원본(${opts.source.name})이 같은 커서를 반복해 냈습니다. 순회가 끝나지 않습니다.`);
    }
    seenCursors.add(next);
    cursor = next;
  }

  const snap: Snapshot = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    scope: { ...opts.scope },
    partition: partitionKey(opts.scope),
    sourceName: opts.source.name,
    counts: countOf(records),
    checksum: checksumOf(records),
    records,
  };
  if (opts.clock) snap.createdAt = new Date(opts.clock()).toISOString();
  return snap;
}

// ── 직렬화 / 부분손상 복구 ───────────────────────────────────────────────────

/** JSONL: 1행 헤더 + 레코드 1행씩. 한 줄이 깨져도 나머지를 살릴 수 있는 형식을 고른 이유다. */
export function serializeSnapshot(snap: Snapshot): string {
  const header = {
    formatVersion: snap.formatVersion,
    scope: snap.scope,
    partition: snap.partition,
    sourceName: snap.sourceName,
    counts: snap.counts,
    checksum: snap.checksum,
    ...(snap.createdAt ? { createdAt: snap.createdAt } : {}),
  };
  const lines = [JSON.stringify(header), ...snap.records.map((r) => JSON.stringify(r))];
  return lines.join('\n') + '\n';
}

export interface ParsedSnapshot {
  snapshot: Snapshot;
  /** 살리지 못한 줄 번호(1부터). 비어 있으면 무손상이다. */
  corruptedLines: number[];
  /** 헤더가 선언한 체크섬과 실제로 살린 레코드가 일치하는가. */
  checksumMatches: boolean;
}

function isRecord(v: unknown): v is BackupRecord {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.tenantId !== 'string' || typeof r.id !== 'string') return false;
  if (typeof r.dataClass !== 'string' || typeof r.createdAt !== 'string') return false;
  if (typeof r.body !== 'object' || r.body === null || Array.isArray(r.body)) return false;
  return true;
}

export function parseSnapshot(text: string): ParsedSnapshot {
  const lines = text.split('\n');
  const corruptedLines: number[] = [];
  let header: Record<string, unknown> | undefined;
  const records: BackupRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      corruptedLines.push(i + 1);
      continue;
    }
    if (header === undefined) {
      if (typeof parsed === 'object' && parsed !== null && 'checksum' in (parsed as object)) {
        header = parsed as Record<string, unknown>;
      } else {
        corruptedLines.push(i + 1);
      }
      continue;
    }
    if (isRecord(parsed)) records.push(parsed);
    else corruptedLines.push(i + 1);
  }

  if (header === undefined) {
    throw new BackupError('E_INTEGRITY', '스냅샷 헤더를 읽지 못했습니다. 파일 앞부분이 손상되었습니다.');
  }
  const scope = (header.scope as TenantScope | undefined) ?? { tenantId: '' };
  const declared = String(header.checksum ?? '');
  const snapshot: Snapshot = {
    formatVersion: Number(header.formatVersion ?? 0),
    scope,
    partition: String(header.partition ?? ''),
    sourceName: String(header.sourceName ?? ''),
    counts: countOf(records),
    checksum: checksumOf(records),
    records,
    ...(typeof header.createdAt === 'string' ? { createdAt: header.createdAt } : {}),
  };
  return { snapshot, corruptedLines, checksumMatches: declared === snapshot.checksum };
}

export interface VerifyResult {
  ok: boolean;
  /** 사람이 읽는 한국어 사유. 개인정보·원문을 담지 않는다. */
  issues: string[];
}

export function verifySnapshot(snap: Snapshot): VerifyResult {
  const issues: string[] = [];
  if (snap.formatVersion !== SNAPSHOT_FORMAT_VERSION) {
    issues.push(`형식 버전 불일치: 파일 ${snap.formatVersion} / 코드 ${SNAPSHOT_FORMAT_VERSION}`);
  }
  try {
    assertTenantScope(snap.scope);
    if (snap.partition && snap.partition !== partitionKey(snap.scope)) {
      issues.push('파티션 키가 스코프와 어긋납니다.');
    }
  } catch (e) {
    issues.push(`스코프 위반: ${e instanceof Error ? e.message : String(e)}`);
  }
  const recomputed = checksumOf(snap.records);
  if (recomputed !== snap.checksum) issues.push(`체크섬 불일치: 선언 ${snap.checksum} / 실제 ${recomputed}`);
  if (snap.counts.total !== snap.records.length) {
    issues.push(`건수 불일치: 선언 ${snap.counts.total} / 실제 ${snap.records.length}`);
  }
  let strays = 0;
  let leaky = 0;
  for (const r of snap.records) {
    if (!inScope(r, snap.scope)) strays++;
    if (findUnmaskedFields(r).length > 0) leaky++;
  }
  if (strays > 0) issues.push(`스코프 밖 레코드 ${strays}건 혼입(§11.1)`);
  if (leaky > 0) issues.push(`마스킹 미경유 레코드 ${leaky}건(§10.3)`);
  return { ok: issues.length === 0, issues };
}

// ── 복구 ────────────────────────────────────────────────────────────────────

export interface RestoreFailure {
  batchIndex: number;
  recordCount: number;
  errorCode: BackupErrorCode;
  detail: string;
}

export interface RestoreResult {
  ok: boolean;
  attempted: number;
  written: number;
  failures: RestoreFailure[];
  durationMs?: number;
}

export interface RestoreOptions {
  snapshot: Snapshot;
  sink: RestoreSink;
  /** 복구 범위. 스냅샷보다 좁힐 수 있고, 다른 테넌트로 넓힐 수는 없다(§11.1). */
  scope?: TenantScope;
  batchSize?: number;
  timeoutMs?: number;
  /**
   * 한 배치가 실패해도 계속할지. 기본은 계속이다 —
   * 첫 실패에서 멈추면 "얼마나 망가졌는지"를 모른 채 판단하게 되기 때문이다.
   */
  stopOnFirstFailure?: boolean;
  clock?: () => number;
}

const DEFAULT_BATCH = 200;

export async function restoreSnapshot(opts: RestoreOptions): Promise<RestoreResult> {
  const scope = opts.scope ?? opts.snapshot.scope;
  assertTenantScope(scope);
  if (scope.tenantId !== opts.snapshot.scope.tenantId) {
    throw new BackupError(
      'E_TENANCY',
      `스냅샷(${opts.snapshot.scope.tenantId})과 다른 테넌트(${scope.tenantId})로 복구할 수 없습니다(§11.1).`,
    );
  }
  const target = opts.snapshot.records.filter((r) => inScope(r, scope));
  const size = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
  const started = opts.clock?.();
  const failures: RestoreFailure[] = [];
  let written = 0;

  for (let i = 0; i * size < target.length; i++) {
    const batch = target.slice(i * size, (i + 1) * size);
    try {
      await withBudget(Promise.resolve(opts.sink.write(batch)), opts.timeoutMs, '복구 쓰기');
      written += batch.length;
    } catch (e) {
      const code: BackupErrorCode = e instanceof BackupError ? e.code : 'E_SINK';
      failures.push({
        batchIndex: i,
        recordCount: batch.length,
        errorCode: code,
        detail: maskPii(e instanceof Error ? e.message : String(e)).text,
      });
      if (opts.stopOnFirstFailure) break;
    }
  }

  const result: RestoreResult = {
    ok: failures.length === 0,
    attempted: target.length,
    written,
    failures,
  };
  if (started !== undefined && opts.clock) result.durationMs = opts.clock() - started;
  return result;
}

// ── 복구 리허설(drill) ───────────────────────────────────────────────────────

export type DrillVerdict = 'passed' | 'inconclusive' | 'failed';

export interface DrillComparison {
  recovered: number;
  checksumMatches: boolean;
  missingIds: string[];
  extraIds: string[];
}

export interface DrillReport {
  verdict: DrillVerdict;
  scope: TenantScope;
  sourceName: string;
  sinkName: string;
  counts: SnapshotCounts;
  checksum: string;
  serializedBytes: number;
  corruptedLines: number[];
  restore: RestoreResult;
  comparison?: DrillComparison;
  /** clock 주입이 있을 때만. 없으면 소요를 만들어 넣지 않는다(§13-3). */
  startedAt?: string;
  durationMs?: number;
  issues: string[];
}

export interface DrillOptions {
  source: BackupSource;
  sink: RestoreSink;
  scope: TenantScope;
  timeoutMs?: number;
  batchSize?: number;
  clock?: () => number;
  /** 대조에서 보여줄 누락·초과 ID 최대 개수. 보고서가 무한히 길어지지 않게 한다. */
  maxIdsShown?: number;
}

const MAX_IDS_SHOWN = 20;

/**
 * 스냅샷 → 직렬화 → 파싱 → 복구 → 되읽기 대조까지 한 번에 돈다.
 *
 * 판정 규칙:
 *  - failed        : 검증 실패·복구 실패·대조 불일치. 백업 절차를 신뢰할 수 없다.
 *  - inconclusive  : 원본이 비었거나 sink.readAll 이 없어 대조를 못 했다.
 *                    "성공"으로 적으면 안 되는 상태다 — 실제 사고는 대개 여기서 시작한다.
 *  - passed        : 되읽은 자료가 원본과 체크섬까지 같다.
 */
export async function runRecoveryDrill(opts: DrillOptions): Promise<DrillReport> {
  const started = opts.clock?.();
  const issues: string[] = [];
  const snapshot = await createSnapshot({
    source: opts.source,
    scope: opts.scope,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
  });

  const verify = verifySnapshot(snapshot);
  if (!verify.ok) issues.push(...verify.issues);

  const text = serializeSnapshot(snapshot);
  const serializedBytes = Buffer.byteLength(text, 'utf8');
  const parsed = parseSnapshot(text);
  if (parsed.corruptedLines.length > 0) issues.push(`직렬화 왕복에서 ${parsed.corruptedLines.length}줄을 잃었습니다.`);
  if (!parsed.checksumMatches) issues.push('직렬화 왕복 후 체크섬이 달라졌습니다.');

  const restore = await restoreSnapshot({
    snapshot: parsed.snapshot,
    sink: opts.sink,
    scope: opts.scope,
    ...(opts.batchSize !== undefined ? { batchSize: opts.batchSize } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  if (!restore.ok) {
    issues.push(`복구 실패 배치 ${restore.failures.length}건(${restore.written}/${restore.attempted}건만 기록됨).`);
  }

  let comparison: DrillComparison | undefined;
  if (opts.sink.readAll) {
    let recovered: BackupRecord[];
    try {
      recovered = await withBudget(Promise.resolve(opts.sink.readAll()), opts.timeoutMs, '복구본 되읽기');
    } catch (e) {
      recovered = [];
      issues.push(`되읽기 실패: ${maskPii(e instanceof Error ? e.message : String(e)).text}`);
    }
    const cap = opts.maxIdsShown ?? MAX_IDS_SHOWN;
    const srcIds = new Set(snapshot.records.map((r) => r.id));
    const dstIds = new Set(recovered.map((r) => r.id));
    const missingIds = [...srcIds].filter((id) => !dstIds.has(id)).slice(0, cap);
    const extraIds = [...dstIds].filter((id) => !srcIds.has(id)).slice(0, cap);
    const checksumMatches = checksumOf(recovered) === snapshot.checksum;
    comparison = { recovered: recovered.length, checksumMatches, missingIds, extraIds };
    if (!checksumMatches) issues.push('되읽은 자료가 원본과 다릅니다(체크섬 불일치).');
    if (missingIds.length > 0) issues.push(`복구본에 없는 레코드 ${missingIds.length}건 이상.`);
    if (extraIds.length > 0) {
      issues.push(`복구본에만 있는 레코드 ${extraIds.length}건 이상 — 이전 복구본이 지워지지 않았습니다.`);
    }
  } else {
    issues.push('복구 대상이 되읽기(readAll)를 제공하지 않아 대조하지 못했습니다.');
  }

  const comparisonOk = comparison !== undefined && comparison.checksumMatches
    && comparison.missingIds.length === 0 && comparison.extraIds.length === 0;
  let verdict: DrillVerdict;
  if (!verify.ok || !restore.ok || !parsed.checksumMatches || (comparison !== undefined && !comparisonOk)) {
    verdict = 'failed';
  } else if (snapshot.records.length === 0) {
    issues.push('원본이 비어 있어 복구를 증명하지 못했습니다. 성공으로 기록하지 않습니다.');
    verdict = 'inconclusive';
  } else if (comparison === undefined) {
    verdict = 'inconclusive';
  } else {
    verdict = 'passed';
  }

  const report: DrillReport = {
    verdict,
    scope: { ...opts.scope },
    sourceName: opts.source.name,
    sinkName: opts.sink.name,
    counts: snapshot.counts,
    checksum: snapshot.checksum,
    serializedBytes,
    corruptedLines: parsed.corruptedLines,
    restore,
    ...(comparison ? { comparison } : {}),
    issues,
  };
  if (started !== undefined && opts.clock) {
    report.startedAt = new Date(started).toISOString();
    report.durationMs = opts.clock() - started;
  }
  return report;
}

const VERDICT_KO: Record<DrillVerdict, string> = {
  passed: '통과',
  inconclusive: '판정보류',
  failed: '실패',
};

/** RUNBOOK 에 그대로 붙일 수 있는 한국어 기록. 실측하지 않은 값은 '미측정'으로 쓴다(§13-3). */
export function formatDrillReport(r: DrillReport): string {
  const lines: string[] = [];
  lines.push(`복구 리허설 결과: ${VERDICT_KO[r.verdict]}`);
  lines.push(`- 범위: ${r.scope.tenantId}${r.scope.workspaceId ? `/${r.scope.workspaceId}` : ''}`);
  lines.push(`- 원본 → 복구대상: ${r.sourceName} → ${r.sinkName}`);
  lines.push(`- 스냅샷: ${r.counts.total}건 / ${r.serializedBytes}바이트 / 체크섬 ${r.checksum}`);
  const byClass = Object.entries(r.counts.byDataClass).sort(([a], [b]) => a.localeCompare(b));
  lines.push(`- 자료 구분: ${byClass.length === 0 ? '없음' : byClass.map(([k, v]) => `${k} ${v}건`).join(', ')}`);
  lines.push(`- 손상 줄: ${r.corruptedLines.length === 0 ? '없음' : r.corruptedLines.join(', ')}`);
  lines.push(`- 복구: ${r.restore.written}/${r.restore.attempted}건 기록, 실패 배치 ${r.restore.failures.length}건`);
  lines.push(r.comparison
    ? `- 되읽기 대조: ${r.comparison.recovered}건, 체크섬 ${r.comparison.checksumMatches ? '일치' : '불일치'}, `
      + `누락 ${r.comparison.missingIds.length}건, 초과 ${r.comparison.extraIds.length}건`
    : '- 되읽기 대조: 수행 못 함');
  lines.push(`- 소요: ${r.durationMs === undefined ? '미측정(시계 미주입)' : `${r.durationMs}ms`}`);
  lines.push(`- 지적사항: ${r.issues.length === 0 ? '없음' : ''}`);
  for (const i of r.issues) lines.push(`  · ${i}`);
  return lines.join('\n');
}

// ── 참조 구현 ────────────────────────────────────────────────────────────────

/** 리허설·테스트용 원본. 운영 원본은 호스트가 주입한다 — 실 DB 연결은 [승인 필요]. */
export function createMemoryBackupSource(
  records: readonly BackupRecord[],
  opts: { name?: string; pageSize?: number } = {},
): BackupSource {
  const pageSize = Math.max(1, opts.pageSize ?? 100);
  const all = records.slice();
  return {
    name: opts.name ?? 'memory',
    async read(cursor) {
      const from = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isInteger(from) || from < 0) {
        throw new BackupError('E_SOURCE', '커서 형식이 올바르지 않습니다.');
      }
      const page = all.slice(from, from + pageSize);
      const next = from + pageSize;
      return next < all.length ? { records: page, nextCursor: String(next) } : { records: page };
    },
  };
}

export interface MemoryRestoreSink extends RestoreSink {
  readonly written: readonly BackupRecord[];
  clear(): void;
}

/** 리허설용 복구 대상. 운영 복구 대상은 호스트가 주입한다 — 실 DB 연결은 [승인 필요]. */
export function createMemoryRestoreSink(opts: { name?: string; failOnBatch?: number } = {}): MemoryRestoreSink {
  const store: BackupRecord[] = [];
  let batch = 0;
  return {
    name: opts.name ?? 'memory-restore',
    get written() { return store; },
    clear() { store.length = 0; batch = 0; },
    async write(records) {
      const idx = batch++;
      if (opts.failOnBatch === idx) throw new Error(`배치 ${idx} 쓰기 거부(리허설 주입 실패)`);
      store.push(...records);
    },
    async readAll() { return store.slice(); },
  };
}
