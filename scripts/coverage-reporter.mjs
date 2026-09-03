// 커버리지 수집 리포터 — node --test 의 test:coverage 이벤트에서 원시 요약만 뽑아 낸다.
// 판정·서식은 하지 않는다(그건 src/ops/coverage.ts 의 몫이다). 여기는 통로일 뿐이다.
//
// 요약을 표준출력에 그대로 흘리면 테스트 로그와 섞이므로, 한 줄 마커로 감싸서 내보낸다.
export const COVERAGE_MARKER = '__AICC_COVERAGE__';

export default async function* coverageReporter(source) {
  for await (const event of source) {
    if (event.type === 'test:coverage') {
      const files = (event.data?.summary?.files ?? []).map((f) => ({
        path: f.path,
        totalLineCount: f.totalLineCount,
        coveredLineCount: f.coveredLineCount,
        totalBranchCount: f.totalBranchCount,
        coveredBranchCount: f.coveredBranchCount,
        totalFunctionCount: f.totalFunctionCount,
        coveredFunctionCount: f.coveredFunctionCount,
      }));
      yield `${COVERAGE_MARKER}${JSON.stringify({ files })}\n`;
    } else if (event.type === 'test:fail') {
      // 테스트가 깨진 채로 커버리지만 초록으로 뜨는 일이 없게, 실패는 반드시 드러낸다.
      yield `TEST_FAIL ${event.data?.name ?? '(이름 없음)'}\n`;
    }
  }
}
