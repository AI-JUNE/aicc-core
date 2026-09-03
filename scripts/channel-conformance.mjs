// 채널 계약 적합성 실행기 — 채널 저장소(Callbot·챗봇·D-ARS)가 CI에서 자기 ChannelPort 에 대고 돌린다.
//
// 이 스크립트는 얇다. 판정 로직은 전부 src/channels/harness.ts 에 있고 테스트로 덮여 있다.
// 여기서 하는 일은 셋뿐이다: argv 를 넘기고, 동적 import 로 모듈을 불러오고, 종료코드를 세운다.
//
// 사용: node scripts/channel-conformance.mjs --port <모듈경로> [--export 이름] [--adapter callbot]
//                                            [--timeout-ms 1500] [--strict-warnings] [--json]
// 종료코드: 0=통과, 1=실패, 2=판정보류 (CI에서 그대로 게이트로 쓴다)
//
// 실회선·실메신저에 붙지 않는다. 드라이런 선언이 없는 포트는 통과로 적지 않는다 — 실연동은 [승인 필요].
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import {
  parseHarnessArgs, runHarness, formatHarnessResult, harnessResultToJson, HARNESS_USAGE_KO,
} from '../src/channels/harness.ts';

const argv = process.argv.slice(2);
if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  console.log(HARNESS_USAGE_KO);
  process.exitCode = argv.length === 0 ? 1 : 0;
} else {
  const config = parseHarnessArgs(argv);

  // 상대 경로는 이 스크립트가 아니라 **호출한 저장소의 cwd** 기준이어야 한다.
  // 채널 저장소는 자기 루트에서 부르기 때문이다. 패키지 지정자(bare specifier)는 그대로 둔다.
  const load = (spec) => {
    const isPath = spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec);
    return import(isPath ? pathToFileURL(resolvePath(process.cwd(), spec)).href : spec);
  };

  const result = await runHarness({ config, load });
  console.log(config.json ? harnessResultToJson(result, config) : formatHarnessResult(result, config));
  process.exitCode = result.exitCode;
}
