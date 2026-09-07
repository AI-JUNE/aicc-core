// 채널 브리지 실행기 — 비-Node 채널 호스트(Callbot 파이썬 에이전트 등)가 Core 를 소비하는 진입점.
//
// 이 스크립트는 얇다. 프로토콜 로직은 전부 src/channels/bridge.ts 에 있고 테스트로 덮여 있다.
// 여기서 하는 일은 셋뿐이다: argv 를 읽고, Core 모듈을 동적 import 하고, 표준입출력을 줄 단위로 잇는다.
//
// 사용: node scripts/channel-bridge.mjs --core <모듈경로> --adapter callbot
//                                       [--export 이름] [--max-line-bytes 65536]
//                                       [--include-handoff-summary] [--include-slots]
// 모듈은 `{ core, scope }` 를 export 하거나, 그것을 돌려주는 함수(default/createCore)를 export 한다.
//
// 프로토콜(한 줄 = 한 요청):
//   → {"id":"1","op":"hello"}
//   → {"id":"2","op":"start","req":{"flowId":"f_x","entryPoint":"inbound_call"}}
//   ← {"id":"2","ok":true,"result":{...}}
//
// 종료코드: 0=정상 종료, 1=설정·로드 실패. 잘못된 요청 줄은 오류 **응답**이지 종료가 아니다 —
// 회선 하나가 이상한 바이트를 보냈다고 통화 전체가 끊기면 안 된다.
//
// 실회선·실메신저에 붙지 않는다. 기본 dry_run 이며 live 는 [승인 필요].
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { resolve as resolvePath } from 'node:path';
import { createBridge, encodeResponse } from '../src/channels/bridge.ts';

const USAGE = `사용: node scripts/channel-bridge.mjs --core <모듈경로> --adapter <callbot|chatbot|dars>
       [--export 이름] [--max-line-bytes N] [--include-handoff-summary] [--include-slots]
모듈은 { core, scope } 를 export 하거나, 그것을 돌려주는 함수를 export 합니다.
기본 dry_run 이며 실회선 연결은 [승인 필요] 입니다.`;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
};

if (argv.length === 0 || flag('--help') || flag('-h')) {
  console.error(USAGE);
  process.exit(argv.length === 0 ? 1 : 0);
}

const coreModule = value('--core');
const adapter = value('--adapter');
const issues = [];
if (!coreModule) issues.push('--core 모듈 경로가 없습니다.');
if (!adapter) issues.push('--adapter 가 없습니다(callbot|chatbot|dars).');
const maxLineRaw = value('--max-line-bytes');
let maxLineBytes;
if (maxLineRaw !== undefined) {
  maxLineBytes = Number(maxLineRaw);
  if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) issues.push('--max-line-bytes 는 양의 정수여야 합니다.');
}
if (issues.length > 0) {
  console.error(`${issues.join('\n')}\n\n${USAGE}`);
  process.exit(1);
}

// 상대 경로는 이 스크립트가 아니라 **호출한 저장소의 cwd** 기준이다.
const spec = coreModule.startsWith('.') || coreModule.startsWith('/') || /^[A-Za-z]:[\\/]/.test(coreModule)
  ? pathToFileURL(resolvePath(process.cwd(), coreModule)).href
  : coreModule;

let mod;
try {
  mod = await import(spec);
} catch (e) {
  // 로드 실패 메시지에는 배포 경로가 통째로 실린다. 사용자가 준 경로만 그대로 보여준다.
  console.error(`Core 모듈을 불러오지 못했습니다: ${coreModule}\n${e instanceof Error ? e.name : 'Error'}`);
  process.exit(1);
}

const picked = mod[value('--export') ?? ''] ?? mod.default ?? mod.createCore ?? mod.core;
const built = typeof picked === 'function' ? await picked() : picked;
if (!built || typeof built !== 'object' || !built.core || !built.scope) {
  console.error('Core 모듈은 { core, scope } 를 내놓아야 합니다.');
  process.exit(1);
}

let bridge;
try {
  bridge = createBridge({
    core: built.core,
    scope: built.scope,
    adapter,
    capabilities: built.capabilities,
    activation: built.activation,
    approvalRef: built.approvalRef,
    includeHandoffSummary: flag('--include-handoff-summary'),
    includeSlots: flag('--include-slots'),
    maxLineBytes,
  });
} catch (e) {
  console.error(`브리지 설정 오류: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of rl) {
  if (line.trim() === '') continue; // 파이프 끝 개행이 오류 응답을 만들지 않게 한다
  process.stdout.write(`${encodeResponse(await bridge.handleLine(line))}\n`);
}
