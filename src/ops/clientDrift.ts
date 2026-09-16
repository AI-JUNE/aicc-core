// 참조 클라이언트 복사본 드리프트 검사 — 설계서 §2(시나리오 이중 관리 금지)·§13-3(판정보류는 통과가 아니다).
//
// 왜 필요한가:
// 파이썬 참조 클라이언트(`clients/python/aicc_bridge.py`·`aicc_callbot.py`)는 Callbot 저장소에 **복사**되어
// 산다(`voice-agent/aicc/`). 복사는 import 가 아니라서 Core 가 고쳐도 저쪽은 그대로다 — 그리고 그 어긋남은
// 컴파일 오류가 아니라 **통화 중 다른 동작**으로 나타난다(예: Core 가 end 멱등 규칙을 바꿨는데 복사본은 옛 규칙).
// 이 모듈은 두 쪽의 파일을 대조해 같은지/다른지/빠졌는지를 판정한다. 순수 함수다 — 파일 읽기·해시는 주입받는다.
//
// 판정 규칙:
//  - 내용이 다르면 실패, 원본에 있는데 대상에 없으면 실패(복사가 불완전하다).
//  - 줄끝(CRLF/LF)만 다른 것은 실패로 보지 않고 경고로 남긴다(OneDrive·git autocrlf 가 만드는 차이라 동작이 같다).
//  - 대상에만 있는 파일(README·__init__.py 등)은 이 검사의 관심 밖이다 — 건수만 남긴다.
//  - 원본이 비었거나 대상을 못 읽었으면 **판정보류**다. 대조를 못 한 것을 통과로 적지 않는다(§13-3).

export interface ClientFile {
  /** 원본·대상 양쪽에서 같은 이름으로 대조된다(예: 'aicc_bridge.py'). */
  relPath: string;
  content: string;
}

export type DriftStatus = 'same' | 'eol_only' | 'diff' | 'missing_in_target';

export interface DriftItem {
  relPath: string;
  status: DriftStatus;
  /** 짧은 해시(앞 12자). 내용은 싣지 않는다 — 보고서에 코드가 통째로 실리면 읽지 않게 된다. */
  sourceHash?: string;
  targetHash?: string;
}

export type DriftVerdict = 'pass' | 'fail' | 'inconclusive';

export interface DriftReport {
  verdict: DriftVerdict;
  /** 0=통과, 1=실패, 2=판정보류 — CI·야간 작업이 그대로 게이트로 쓴다. */
  exitCode: 0 | 1 | 2;
  items: DriftItem[];
  counts: { same: number; eolOnly: number; diff: number; missing: number; extraInTarget: number };
  /** 판정보류·실패 사유(한국어). 통과면 없다. */
  reasonKo?: string;
}

export interface DriftOptions {
  /** 내용 → 해시 문자열. 주입받는다(node:crypto 를 여기서 만지지 않는다). */
  hash: (text: string) => string;
  /**
   * 대조할 파일 이름 목록. 원본 목록에서 이 이름들만 본다. 비어 있으면 판정보류다 —
   * "무엇을 복사했는가"는 Core 가 추측할 일이 아니라 호출자가 선언할 일이다.
   */
  files: readonly string[];
}

const normalizeEol = (s: string): string => s.replace(/\r\n?/g, '\n');
const short = (h: string): string => h.slice(0, 12);

export function compareClientCopies(
  source: readonly ClientFile[],
  target: readonly ClientFile[] | undefined,
  opts: DriftOptions,
): DriftReport {
  const counts = { same: 0, eolOnly: 0, diff: 0, missing: 0, extraInTarget: 0 };
  const inconclusive = (reasonKo: string): DriftReport => ({ verdict: 'inconclusive', exitCode: 2, items: [], counts, reasonKo });

  if (opts.files.length === 0) return inconclusive('대조할 파일 목록이 비어 있습니다 — 무엇을 복사했는지 선언해야 합니다.');
  if (target === undefined) return inconclusive('대상 디렉터리를 읽지 못했습니다(Callbot 저장소 미체크아웃 등). 대조 없이 통과로 적지 않습니다.');
  if (source.length === 0) return inconclusive('원본 파일이 하나도 없습니다 — 원본 경로가 틀렸을 가능성이 큽니다.');

  const srcByName = new Map(source.map((f) => [f.relPath, f]));
  const dstByName = new Map(target.map((f) => [f.relPath, f]));
  const wanted = new Set(opts.files);

  const missingInSource = opts.files.filter((n) => !srcByName.has(n));
  if (missingInSource.length > 0) {
    return inconclusive(`선언한 파일이 원본에 없습니다: ${missingInSource.join(', ')} — 목록 또는 원본 경로가 틀렸습니다.`);
  }

  const items: DriftItem[] = [];
  for (const name of opts.files) {
    const s = srcByName.get(name) as ClientFile;
    const d = dstByName.get(name);
    const sourceHash = short(opts.hash(s.content));
    if (d === undefined) {
      counts.missing += 1;
      items.push({ relPath: name, status: 'missing_in_target', sourceHash });
      continue;
    }
    const targetHash = short(opts.hash(d.content));
    if (s.content === d.content) {
      counts.same += 1;
      items.push({ relPath: name, status: 'same', sourceHash, targetHash });
    } else if (normalizeEol(s.content) === normalizeEol(d.content)) {
      counts.eolOnly += 1;
      items.push({ relPath: name, status: 'eol_only', sourceHash, targetHash });
    } else {
      counts.diff += 1;
      items.push({ relPath: name, status: 'diff', sourceHash, targetHash });
    }
  }
  for (const name of dstByName.keys()) if (!wanted.has(name)) counts.extraInTarget += 1;

  if (counts.diff > 0 || counts.missing > 0) {
    const parts: string[] = [];
    if (counts.diff > 0) parts.push(`내용 다름 ${counts.diff}건`);
    if (counts.missing > 0) parts.push(`대상에 없음 ${counts.missing}건`);
    return { verdict: 'fail', exitCode: 1, items, counts, reasonKo: `복사본이 원본과 어긋났습니다(${parts.join(' · ')}). 원본을 다시 복사하세요.` };
  }
  return { verdict: 'pass', exitCode: 0, items, counts };
}

// ── CLI 지원 (얇게 — 스크립트는 argv 와 파일 읽기만 담당) ─────────────────────

export interface DriftArgs {
  source?: string;
  target?: string;
  files: string[];
  json: boolean;
}

export const DRIFT_USAGE_KO = [
  '사용: node scripts/client-drift.mjs --source clients/python --target <Callbot>/voice-agent/aicc --files aicc_bridge.py,aicc_callbot.py [--json]',
  '종료코드: 0=통과, 1=실패(복사본 어긋남), 2=판정보류(대상 미존재·목록 미선언)',
].join('\n');

export function parseDriftArgs(argv: readonly string[]): DriftArgs {
  const out: DriftArgs = { files: [], json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string;
    const next = () => { const v = argv[i + 1]; i += 1; return v; };
    if (a === '--source') out.source = next();
    else if (a === '--target') out.target = next();
    else if (a === '--files') out.files = (next() ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--json') out.json = true;
  }
  return out;
}

const STATUS_KO: Record<DriftStatus, string> = {
  same: '동일', eol_only: '줄끝만 다름(경고)', diff: '내용 다름', missing_in_target: '대상에 없음',
};

export function formatDriftReport(r: DriftReport): string {
  const head = r.verdict === 'pass' ? '통과' : r.verdict === 'fail' ? '실패' : '판정보류';
  const lines = [`참조 클라이언트 복사본 대조: ${head}`];
  for (const it of r.items) {
    const hashes = it.targetHash ? `${it.sourceHash} → ${it.targetHash}` : `${it.sourceHash} → (없음)`;
    lines.push(`  - ${it.relPath}: ${STATUS_KO[it.status]} [${hashes}]`);
  }
  lines.push(`  동일 ${r.counts.same} · 줄끝만 ${r.counts.eolOnly} · 다름 ${r.counts.diff} · 없음 ${r.counts.missing} · 대상 전용 ${r.counts.extraInTarget}`);
  if (r.reasonKo) lines.push(`  사유: ${r.reasonKo}`);
  return lines.join('\n');
}
