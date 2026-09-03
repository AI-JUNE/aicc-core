# 관리 포털 IA ↔ 화면 매핑

`src/portal/ia.ts` 의 라우트 표와 실제 화면 구현을 대조한 결과다.
**이 문서는 `src/portal/screenMap.ts` 에서 생성된다 — 직접 고치지 말 것.**

- 라우트 25건 — 구현 0 · 작업중 0 · 미착수 25 · 보류 0
- 감사 대상(개인정보 열람·상태 변경) 15건 중 접근 기록 배선 완료 0건 (§10.2)

진행률(%)은 적지 않는다. 실측 건수만 둔다(§13-3).

## 대시보드 (`dashboard`)

| 라우트 | 경로 | 권한 | PII | 변경 | 상태 | 화면 위치 | 감사 배선 |
|---|---|---|---|---|---|---|---|
| `dashboard.overview` | `/dashboard` | tenant_owner, admin, supervisor, analyst | - | - | 미착수 | - | - |
| `dashboard.outcomes` | `/dashboard/outcomes` | tenant_owner, admin, supervisor, analyst | - | - | 미착수 | - | - |

## 상호작용 (`interactions`)

| 라우트 | 경로 | 권한 | PII | 변경 | 상태 | 화면 위치 | 감사 배선 |
|---|---|---|---|---|---|---|---|
| `interactions.list` | `/interactions` | tenant_owner, admin, supervisor, agent, auditor | - | - | 미착수 | - | - |
| `interactions.detail` | `/interactions/:interactionId` | tenant_owner, admin, supervisor, agent, auditor | O | - | 미착수 | - | 필요 |
| `interactions.handoff` | `/interactions/:interactionId/handoff` | tenant_owner, admin, supervisor, agent | O | - | 미착수 | - | 필요 |

## 시나리오 스튜디오 (`studio`)

| 라우트 | 경로 | 권한 | PII | 변경 | 상태 | 화면 위치 | 감사 배선 |
|---|---|---|---|---|---|---|---|
| `studio.flows` | `/studio/flows` | tenant_owner, admin | - | - | 미착수 | - | - |
| `studio.editor` | `/studio/flows/:flowId` | tenant_owner, admin | - | O | 미착수 | - | 필요 |
| `studio.validate` | `/studio/flows/:flowId/validate` | tenant_owner, admin | - | - | 미착수 | - | - |
| `studio.simulate` | `/studio/flows/:flowId/simulate` | tenant_owner, admin | - | - | 미착수 | - | - |
| `studio.publish` | `/studio/flows/:flowId/publish` | tenant_owner, admin | - | O | 미착수 | - | 필요 |
| `studio.knowledge` | `/studio/knowledge` | tenant_owner, admin | - | O | 미착수 | - | 필요 |

## 운영 (`operations`)

| 라우트 | 경로 | 권한 | PII | 변경 | 상태 | 화면 위치 | 감사 배선 |
|---|---|---|---|---|---|---|---|
| `operations.queues` | `/operations/queues` | tenant_owner, admin, supervisor | - | O | 미착수 | - | 필요 |
| `operations.campaigns` | `/operations/campaigns` | tenant_owner, admin | O | O | 미착수 | - | 필요 |
| `operations.disclosure` | `/operations/ai-disclosure` | tenant_owner, admin | - | O | 미착수 | - | 필요 |
| `operations.health` | `/operations/health` | tenant_owner, admin, supervisor | - | - | 미착수 | - | - |

## QA·품질 (`qa`)

| 라우트 | 경로 | 권한 | PII | 변경 | 상태 | 화면 위치 | 감사 배선 |
|---|---|---|---|---|---|---|---|
| `qa.review` | `/qa/review` | tenant_owner, admin, supervisor | O | O | 미착수 | - | 필요 |
| `qa.testsets` | `/qa/testsets` | tenant_owner, admin | - | O | 미착수 | - | 필요 |

## 리포트 (`reports`)

| 라우트 | 경로 | 권한 | PII | 변경 | 상태 | 화면 위치 | 감사 배선 |
|---|---|---|---|---|---|---|---|
| `reports.builder` | `/reports` | tenant_owner, admin, analyst, auditor | - | - | 미착수 | - | - |
| `reports.export` | `/reports/export` | tenant_owner, admin, analyst | - | O | 미착수 | - | 필요 |
| `reports.audit` | `/reports/audit-log` | tenant_owner, auditor | - | - | 미착수 | - | - |
| `reports.settlement` | `/reports/settlement` | tenant_owner, admin, analyst | - | - | 미착수 | - | - |

## 설정 (`settings`)

| 라우트 | 경로 | 권한 | PII | 변경 | 상태 | 화면 위치 | 감사 배선 |
|---|---|---|---|---|---|---|---|
| `settings.tenant` | `/settings/tenant` | tenant_owner, admin | - | O | 미착수 | - | 필요 |
| `settings.members` | `/settings/members` | tenant_owner, admin | O | O | 미착수 | - | 필요 |
| `settings.engines` | `/settings/engines` | tenant_owner, admin | - | O | 미착수 | - | 필요 |
| `settings.retention` | `/settings/retention` | tenant_owner, admin | - | O | 미착수 | - | 필요 |

## 비고

- 포털 저장소 미착수(2026-09-03 기준). Core 측 계약은 준비됨. — 25건 (dashboard.overview, dashboard.outcomes, interactions.list, interactions.detail, interactions.handoff, studio.flows, studio.editor, studio.validate, studio.simulate, studio.publish, studio.knowledge, operations.queues, operations.campaigns, operations.disclosure, operations.health, qa.review, qa.testsets, reports.builder, reports.export, reports.audit, reports.settlement, settings.tenant, settings.members, settings.engines, settings.retention)
