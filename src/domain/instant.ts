/**
 * ISO 시각 비교 — 문자열이 아니라 **순간(ms)** 으로 본다 (§9.3·§13-3 과 같은 뿌리).
 *
 * 이벤트·감사 기록의 시각은 Core 가 만든 값이 아니라 호스트가 선언한 값이다.
 * Core 기본 시계는 `…Z` 인데 국내 호스트는 `+09:00` 으로 적으므로, 사전식 비교에서는
 * `2026-11-02T09:00:00+09:00`(= 00:00Z)이 `2026-11-02T00:10:00Z` 보다 "크다".
 * 그러면 기간 필터가 기록을 빠뜨리고 첫·마지막 시각이 거꾸로 적힌다.
 *
 * 해석할 수 없는 값이 섞이면 **종전 동작(사전식)으로 물러난다** — 비교 불가를
 * 예외로 올리면 조회 화면 전체가 멈추고, 임의로 한쪽을 이긴 것으로 치면 기록이 사라진다.
 */

/** ISO 시각 → epoch ms. 해석되지 않으면 NaN. */
export function instantMs(iso: string): number {
  return typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
}

/** a - b 의 부호를 돌려준다(음수: a 가 더 이르다). 둘 다 해석될 때만 순간으로, 아니면 사전식. */
export function compareInstants(a: string, b: string): number {
  const x = instantMs(a);
  const y = instantMs(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x - y;
  return a < b ? -1 : a > b ? 1 : 0;
}
