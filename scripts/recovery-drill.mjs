// 복구 리허설 실행기 — RUNBOOK.md 의 "복구 리허설 기록"을 만드는 스크립트.
//
// 기본은 **절차 리허설**이다. 참조 원본(메모리)·참조 복구대상(메모리)에 대해
// 스냅샷 → 직렬화 → 부분손상 복구 → 되읽기 대조 전 구간을 돌려, 절차 자체가 동작함을 증명한다.
// 운영 데이터 리허설은 원본·복구대상을 주입해야 하며 **[승인 필요]** 다 — 이 스크립트는 실 DB에 붙지 않는다.
//
// 사용: node scripts/recovery-drill.mjs [--records 200] [--batch 50]
// 종료코드: passed=0, inconclusive=2, failed=1 (CI에서 그대로 게이트로 쓴다)
import {
  createMemoryBackupSource,
  createMemoryRestoreSink,
  runRecoveryDrill,
  formatDrillReport,
} from '../src/ops/backup.ts';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const count = arg('records', 200);
const batch = arg('batch', 50);

// 리허설 표본. 실고객 자료가 아니며, 저장 경로와 같은 조건(마스킹 완료)을 재현한다(§10.3).
const CLASSES = ['interaction_event', 'transcript_masked', 'audit_log', 'consent_record'];
const sample = Array.from({ length: count }, (_, i) => ({
  tenantId: 'drill-tenant',
  workspaceId: i % 3 === 0 ? 'cs' : 'sales',
  dataClass: CLASSES[i % CLASSES.length],
  id: `drill-${String(i).padStart(5, '0')}`,
  createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(),
  body: {
    summary: `리허설 표본 ${i}`,
    contact: '010-****-0000',
    note: i % 7 === 0 ? '이관 요약 있음' : '',
  },
}));

const report = await runRecoveryDrill({
  source: createMemoryBackupSource(sample, { name: 'reference-source(memory)', pageSize: 64 }),
  sink: createMemoryRestoreSink({ name: 'reference-sink(memory)' }),
  scope: { tenantId: 'drill-tenant' },
  batchSize: batch,
  clock: () => Date.now(),
});

console.log(formatDrillReport(report));
process.exitCode = report.verdict === 'passed' ? 0 : report.verdict === 'inconclusive' ? 2 : 1;
