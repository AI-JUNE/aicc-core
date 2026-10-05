// Policy Guard — 설계서 §10.3. 저장 전 개인정보 자동 마스킹.
// 개인정보위 지적 사례(통화 내용 국외이전·처리방침 누락)를 구조적으로 예방한다.

// 규칙 순서 = 우선순위. 앞 규칙이 잡은 구간은 뒤 규칙이 다시 보지 않는다.
// 좁은 패턴(주민·카드·휴대폰)을 먼저 두고, 가장 넓은 계좌 패턴을 마지막에 둔다.
// 계좌를 앞에 두면 휴대폰 번호가 계좌로 분류되어 마스킹은 되지만 pii_kinds 통계가 틀어진다(§8.1 이벤트 신뢰도).
const RULES: { name: string; re: RegExp; mask: (m: string) => string }[] = [
  { name: 'rrn',     re: /\b(\d{6})[-\s]?([1-4]\d{6})\b/g,        mask: (m) => m.slice(0, 6) + '-*******' },
  { name: 'card',    re: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,          mask: (m) => m.slice(0, 4) + '-****-****-' + m.slice(-4) },
  { name: 'phone',   re: /\b01[0-9][-\s]?\d{3,4}[-\s]?\d{4}\b/g,  mask: (m) => m.slice(0, 3) + '-****-' + m.slice(-4) },
  { name: 'account', re: /\b\d{2,3}-?\d{2,6}-?\d{2,6}\b/g,        mask: (m) => '***-****-' + m.slice(-4) },
];

/**
 * 이미 마스킹된 값의 모양 — 위 RULES 의 mask() 출력과 **짝**이다.
 * 한쪽만 고치면 `tests/core.policyGuard.test.mjs` 의 멱등 검사가 깨진다(§2 이중 관리 방지).
 *
 * 왜 필요한가: maskPii 가 자기 출력에 멱등이 아니면 **두 번 가린 값이 더 가려지는 것이 아니라
 * 다른 값으로 바뀐다**. `900101-*******` 은 계좌 규칙에 다시 걸려 `***-****-0101-*******` 이 된다.
 * 결과는 조용한 오답이다 — 원장(§8.1)의 전문과 화면·감사에 적힌 전문이 달라지고, 이미 마스킹된
 * 값을 한 번 더 통과시키는 방어 경로(저장 전 재확인)가 `masked: true` 를 돌려주므로
 * "원문이 들어왔다"는 사고 신호와 구분되지 않는다. 실제로 감사 detail·정산 사유는 호출부와
 * `audit/log.ts` 에서 두 번 지나간다.
 */
const MASKED_SHAPES = /\d{6}-\*{7}|\d{4}-\*{4}-\*{4}-\d{4}|\d{3}-\*{4}-\d{4}|\*{3}-\*{4}-\d{4}/;

/**
 * ISO8601 날짜·기간 — 계좌 규칙(`\d{2,3}-?\d{2,6}-?\d{2,6}`)이 날짜를 삼키는 것을 막는다.
 * `2026-01-01T00:00:00.000Z` 는 지금까지 `***-****-6-01-01T...` 로 바뀌었고, 그래서
 * 감사 detail·정산 사유에 적힌 **대상 기간이 깨진 채** 쌓였다 — 개인정보가 새는 쪽이 아니라
 * 조사에서 가장 먼저 보는 값(어느 기간을 조회·반출했는가)이 사라지는 쪽의 사고다.
 *
 * 경계는 `(?<![\d-])`·`(?![\d-])` 가 잡는다. 이 두 조건이 없으면 카드·계좌의 앞 네 자리가
 * 날짜로 보여 **마스킹을 피해 나간다** — 과도 보호는 곧 유출이므로 아래 네 규칙이 날짜와
 * 맞붙어 있을 때도 여전히 가려지는지 검사로 고정한다.
 */
const ISO_TEMPORAL = /(?<![\d-])\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?)?(?![\d-])|(?<![\d-])\d{4}-(?:0[1-9]|1[0-2])(?![\d-])/;

/** 규칙에 넘기기 전에 치워 둘 구간. hits 에는 올리지 않는다 — 이번 호출이 가린 것이 아니다. */
const PRESERVE = new RegExp(`${ISO_TEMPORAL.source}|${MASKED_SHAPES.source}`, 'g');

export interface MaskResult { text: string; masked: boolean; hits: string[] }

/** 이미 마스킹된 구간을 뒤 규칙이 다시 잡지 않도록 자리표시자로 보호한다(숫자 미포함). */
const PH = (i: number) => `\u0001${String(i).replace(/\d/g, (d) => String.fromCharCode(103 + Number(d)))}\u0001`;

export function maskPii(input: string): MaskResult {
  let out = input;
  const hits: string[] = [];
  const vault: string[] = [];

  // 이미 마스킹된 값과 날짜를 먼저 치워 둔다.
  // 구분자로 공백을 허용하지 않는 것이 중요하다: 허용하면 `900101-******* 010-1234-5678` 이
  // 한 덩어리로 보호되어 **뒤의 진짜 번호가 마스킹되지 않는다**.
  out = out.replace(new RegExp(PRESERVE.source, 'g'), (m) => {
    vault.push(m);
    return PH(vault.length - 1);
  });

  for (const r of RULES) {
    const re = new RegExp(r.re.source, 'g');
    let hit = false;
    out = out.replace(re, (m) => {
      hit = true;
      vault.push(r.mask(m));
      return PH(vault.length - 1);
    });
    if (hit) hits.push(r.name);
  }
  out = out.replace(/\u0001([g-p]+)\u0001/g, (_m, k: string) => {
    const idx = Number(String(k).replace(/[g-p]/g, (c) => String(c.charCodeAt(0) - 103)));
    return vault[idx] ?? '';
  });
  return { text: out, masked: hits.length > 0, hits };
}
