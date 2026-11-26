/**
 * 상호작용 ID 기본 생성기 — 같은 밀리초에 두 번 불려도 **서로 다른 값**을 낸다 (§11.1·§13-3).
 *
 * 종전 기본값은 `Date.now().toString(36)` 뿐이었다. 같은 밀리초에 시작한 두 통화(같은 어댑터)가
 * 같은 ID 를 받으면 세션 저장소가 키로 덮어써 **먼저 시작한 통화의 상태가 사라지고**,
 * 이후 두 호출자가 한 세션을 함께 쓴다. 예외도 로그도 없고 평시(저부하)에는 재현되지 않는다.
 * 같은 프로세스 안에서 단조 증가하는 일련번호를 덧붙여 충돌을 없앤다 — 난수에 기대지 않으므로
 * 테스트에서 시계를 고정해도 결정적이다. 프로세스가 둘 이상이면 호스트가 `newInteractionId` 로
 * 인스턴스 식별자를 넣어야 한다(여기서 지어내지 않는다).
 */
let seq = 0;

export function uniqueSuffix(nowMs: number = Date.now()): string {
  seq = (seq + 1) % Number.MAX_SAFE_INTEGER;
  return `${nowMs.toString(36)}_${seq.toString(36)}`;
}
