// Policy Guard — 설계서 §10.3. 저장 전 개인정보 자동 마스킹.
// 개인정보위 지적 사례(통화 내용 국외이전·처리방침 누락)를 구조적으로 예방한다.

const RULES: { name: string; re: RegExp; mask: (m: string) => string }[] = [
  { name: 'rrn',     re: /\b(\d{6})[-\s]?([1-4]\d{6})\b/g,        mask: (m) => m.slice(0, 6) + '-*******' },
  { name: 'card',    re: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,          mask: (m) => m.slice(0, 4) + '-****-****-' + m.slice(-4) },
  { name: 'account', re: /\b\d{2,3}-?\d{2,6}-?\d{2,6}\b/g,        mask: (m) => '***-****-' + m.slice(-4) },
  { name: 'phone',   re: /\b01[0-9][-\s]?\d{3,4}[-\s]?\d{4}\b/g,  mask: (m) => m.slice(0, 3) + '-****-' + m.slice(-4) },
];

export interface MaskResult { text: string; masked: boolean; hits: string[] }

export function maskPii(input: string): MaskResult {
  let out = input; const hits: string[] = [];
  for (const r of RULES) {
    if (r.re.test(out)) { hits.push(r.name); out = out.replace(new RegExp(r.re.source, 'g'), (m) => r.mask(m)); }
    r.re.lastIndex = 0;
  }
  return { text: out, masked: hits.length > 0, hits };
}
