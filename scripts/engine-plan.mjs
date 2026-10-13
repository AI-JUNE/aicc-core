// 엔진 기동 계획 확인 실행기 — 승인 전에 "지금 무엇을 부르게 되어 있나"를 CI·사람이 읽는 경로.
// 판정은 src/adapters/enginePlan.ts 에 있고 테스트로 덮여 있다. 여기서는 argv·모듈 로드·출력·
// 종료코드만 다룬다. **엔진을 부르지 않는다** — 조립·검증까지만 하고 네트워크에 닿지 않는다.
// 종료코드 0/1/2 를 그대로 게이트로 쓴다. 모듈을 못 읽으면 판정보류(2) — 통과로 적지 않는다(§13-3).
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import {
  ENGINE_PLAN_USAGE_KO, formatEnginePlan, judgeEnginePlan, parseEnginePlanArgs, safePlanReason,
} from '../src/adapters/enginePlan.ts';
import { startEngines } from '../src/adapters/executeEngines.ts';

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.log(ENGINE_PLAN_USAGE_KO);
  process.exitCode = argv.length === 0 ? 1 : 0;
} else {
  const args = parseEnginePlanArgs(argv);
  let declaration;
  let loadErrorKo;
  if (args.issuesKo.length === 0) {
    try {
      const mod = await import(pathToFileURL(resolvePath(process.cwd(), args.declarationModule)).href);
      // export 이름을 하나로 못 박지 않는다 — 저장소마다 파일 구성이 다르다. 다만 **찾지 못하면
      // 판정보류**다(아무것도 없는 모듈을 "선언이 비었다"로 읽으면 통과로 적힌다).
      const picked = mod.default ?? mod.declaration ?? mod.engines;
      const resolved = typeof picked === 'function' ? picked() : picked;
      if (resolved === undefined || resolved === null) {
        loadErrorKo = '모듈에 default·declaration·engines export 가 없습니다';
      } else {
        declaration = resolved;
      }
    } catch (e) {
      loadErrorKo = safePlanReason(e);
    }
  }

  let runtime;
  let startErrorKo;
  if (declaration !== undefined) {
    try {
      // 헬스 배선을 넘기지 않는다 — 계획 확인은 관측이 아니고, 레지스트리는 런타임의 것이다.
      runtime = startEngines(declaration);
    } catch (e) {
      startErrorKo = safePlanReason(e);
    }
  }

  const report = judgeEnginePlan({
    args,
    ...(runtime !== undefined ? { runtime } : {}),
    ...(loadErrorKo !== undefined ? { loadErrorKo } : {}),
    ...(startErrorKo !== undefined ? { startErrorKo } : {}),
  });
  console.log(args.json ? JSON.stringify(report, null, 2) : formatEnginePlan(report));
  process.exitCode = report.exitCode;
}
