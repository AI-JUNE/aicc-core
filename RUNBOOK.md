# RUNBOOK — 백업·복구

대상: AICC Conversation Core(라이브러리) 및 이를 소비하는 호스트 저장소.
근거: 설계서 §8.2(보존·파기) · §9.3(장애 대응) · §10.3(마스킹) · §11.1(테넌트 격리) · §13-3(실측만).

이 문서의 모든 절차는 `src/ops/backup.ts` 로 **실행 가능**하다. 손으로만 지키는 절차는 지켜지지 않는다.

---

## 0. 전제와 경계

- Core 는 저장소를 소유하지 않는다. 백업 원본(`BackupSource`)과 복구 대상(`RestoreSink`)은 **호스트가 주입**한다.
- 운영 데이터에 대한 실백업·실복구 실행은 **[승인 필요]** 다. 리허설은 참조 구현(메모리)으로 언제든 돌린다.
- 백업본에 **암호화 키·접속 문자열·자격증명을 넣지 않는다.** 스냅샷 레코드의 `body` 는 문자열 맵으로 제한되어 있고,
  마스킹을 거치지 않은 값이 들어오면 스냅샷 생성 자체가 `E_PII` 로 거부된다(§10.3).
- **RPO/RTO 목표치는 계약값이다.** 실측 전에는 이 문서에 숫자를 적지 않는다(§13-3).
  아래 "리허설 기록"의 소요 시간은 참조 구현 기준 실측이며, 운영 목표치가 아니다.

## 1. 백업 대상

`DataClass`(§8.2) 단위로 뜬다. 분류가 곧 보존기간·파기 단위이므로 백업 단위도 같아야 한다.

| 분류 | 개인정보 포함 가능 | 백업 시 유의 |
|---|---|---|
| `interaction_event` | 아니오 | §8.1 이벤트. 원장이 있으면 원장 커서와 함께 뜬다 |
| `transcript_masked` | 아니오 | 마스킹 완료본만. 원문 전문은 백업 대상이 아니다 |
| `recording` | 예 | 별도 보관소. 스냅샷에는 참조만 넣고 매체를 넣지 않는다 |
| `pii_field` | 예 | 마스킹 후에만 스냅샷에 들어간다 |
| `consent_record` | 예 | 파기 방식이 archive 이므로 보존기간 경과분도 남는다 |
| `audit_log` | 아니오 | 감사 대상. 복구 시 **덮어쓰기 금지**, 병합만 |
| `vector_index` | 아니오 | 네임스페이스(테넌트) 단위로 뜬다(§11.1) |
| `aggregate_metric` | 아니오 | 재생성 가능. 우선순위 최하 |

## 2. 백업 절차

```js
import { createSnapshot, verifySnapshot, serializeSnapshot } from './src/ops/backup.ts';

const snap = await createSnapshot({ source, scope: { tenantId }, timeoutMs, clock: () => Date.now() });
const v = verifySnapshot(snap);
if (!v.ok) throw new Error(v.issues.join(' / '));   // 검증 실패본은 보관하지 않는다
await store(serializeSnapshot(snap));               // JSONL: 헤더 1행 + 레코드 1행씩
```

지켜야 할 것:

1. **스코프 없는 백업을 만들지 않는다.** `scope` 는 필수이고, 원본이 스코프 밖 레코드를 내면
   조용히 걸러내지 않고 `E_TENANCY` 로 중단한다 — 그 상태의 백업은 다른 테넌트 자료를 품고 있을 수 있다.
2. **검증에 실패한 스냅샷은 보관하지 않는다.** 보관하면 "백업은 있는데 복구가 안 되는" 상태가 된다.
3. **체크섬을 헤더와 함께 보관한다.** 순서 무관 체크섬이므로 복구가 순서를 바꿔도 거짓 실패가 나지 않는다.
4. JSONL 을 쓰는 이유는 **한 줄이 깨져도 나머지를 살릴 수 있어서**다. 압축·암호화는 이 성질을 유지하는 선에서 적용한다.

## 3. 복구 절차

```js
import { parseSnapshot, verifySnapshot, restoreSnapshot } from './src/ops/backup.ts';

const parsed = parseSnapshot(text);
if (parsed.corruptedLines.length) log.warn('손상 줄', parsed.corruptedLines);   // 살린 만큼은 계속 진행 가능
const r = await restoreSnapshot({ snapshot: parsed.snapshot, sink, scope, batchSize, timeoutMs });
if (!r.ok) log.error('복구 부분 실패', r.written, '/', r.attempted, r.failures);
```

판단 기준:

| 상황 | 판단 |
|---|---|
| `checksumMatches === false` | 유실이 있다. 다른 세대의 백업본을 먼저 찾는다 |
| `corruptedLines` 가 있으나 건수가 요구 수준 이상 | 살린 만큼 복구하고, **무엇이 빠졌는지 기록**한 뒤 재백업 |
| `restore.failures` 존재 | 부분 복구 상태. 서비스 재개 전에 실패 배치를 반드시 재시도 |
| 다른 테넌트로 복구 시도 | `E_TENANCY` 로 차단된다. 우회하지 않는다(§11.1) |

주의:

- **복구 전에 복구 대상을 비운다.** 이전 복구본이 남아 있으면 리허설 대조에서 `extraIds` 로 잡히지만,
  운영 복구에서는 조용히 중복 데이터가 된다.
- `audit_log` 는 덮어쓰지 않는다. 감사 기록을 복구 작업이 지우면 사고 조사가 불가능해진다.
- 복구 실패 사유는 `maskPii` 를 거쳐 기록된다. 사유를 그대로 티켓에 붙여도 개인정보가 새지 않는다.

## 4. 복구 리허설 (정기)

```
node scripts/recovery-drill.mjs [--records 200] [--batch 50]
```

종료코드: `0` 통과 · `1` 실패 · `2` 판정보류. CI 게이트로 그대로 쓴다.

판정 규칙(코드와 동일):

- **통과(passed)** — 되읽은 자료가 원본과 체크섬까지 같다.
- **판정보류(inconclusive)** — 원본이 비었거나 복구 대상이 되읽기를 제공하지 않아 대조를 못 했다.
  **성공으로 적지 않는다.** 실제 사고는 대개 여기서 시작한다.
- **실패(failed)** — 검증 실패·복구 실패·대조 불일치. 백업 절차를 신뢰할 수 없다.

운영 데이터로 리허설을 돌리려면 원본·복구 대상을 주입해야 하며, 실행은 **[승인 필요]** 다.
운영 리허설은 반드시 **격리된 복구 대상**(운영과 분리된 인스턴스)에 대고 수행한다.

### 리허설 기록

| 일자 | 범위 | 원본 → 복구대상 | 판정 | 기록 |
|---|---|---|---|---|
| 2026-09-03 | 참조 구현(절차 리허설) | reference-source(memory) → reference-sink(memory) | 통과 | 아래 |

```
복구 리허설 결과: 통과
- 범위: drill-tenant
- 원본 → 복구대상: reference-source(memory) → reference-sink(memory)
- 스냅샷: 200건 / 43670바이트 / 체크섬 200-142798b9-858d7c9f
- 자료 구분: audit_log 50건, consent_record 50건, interaction_event 50건, transcript_masked 50건
- 손상 줄: 없음
- 복구: 200/200건 기록, 실패 배치 0건
- 되읽기 대조: 200건, 체크섬 일치, 누락 0건, 초과 0건
- 소요: 8ms
- 지적사항: 없음
```

> 위 기록은 `scripts/recovery-drill.mjs` 실행 결과를 그대로 붙인 것이다. 사람이 적은 수치가 아니다(§13-3).
> 참조 구현 기준이므로 **운영 복구 시간의 근거가 아니다.** 운영 리허설 기록은 승인 후 이 표에 덧붙인다.

## 5. 장애 시나리오별 대응

| 시나리오 | 첫 조치 | 확인 |
|---|---|---|
| 스냅샷 파일 일부 손상 | `parseSnapshot` 으로 살릴 수 있는 만큼 파싱 | `corruptedLines`·`checksumMatches` |
| 복구 대상 쓰기 거부 | `stopOnFirstFailure` 없이 끝까지 돌려 **피해 범위 확정** 후 재시도 | `failures[].batchIndex` |
| 복구가 예산 안에 안 끝남 | `E_TIMEOUT` 으로 배치 단위 기록됨. 배치 크기를 줄여 재시도 | `failures[].errorCode` |
| 원본이 비어 있음 | 성공으로 처리하지 않는다. 원본 쿼리·스코프부터 점검 | 판정 `inconclusive` |
| 다른 테넌트 자료 혼입 의심 | 백업을 폐기하고 **원본 쿼리의 테넌트 조건**을 고친다 | `E_TENANCY` |
| 마스킹 미경유 값 발견 | 백업이 아니라 **저장 경로**를 고친다(§10.3) | `E_PII` + 필드명 |

## 6. [승인 필요] 목록

- 운영 DB·오브젝트 스토리지에 실제 `BackupSource`/`RestoreSink` 연결
- 운영 데이터 대상 리허설 실행 및 격리 복구 인스턴스 준비
- 백업본 보관 위치·암호화 방식·보관 기간 확정(계약·규정 반영)
- RPO/RTO 목표치 확정 — 확정 전까지 이 문서에 수치를 적지 않는다
