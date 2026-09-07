// 브리지 기록 검증 실행기 — 비-Node 채널 저장소가 자기 클라이언트를 CI 에서 판정하는 진입점.
//
// 이 스크립트는 얇다. 판정 로직은 전부 src/channels/bridgeTranscript.ts 에 있고 테스트로 덮여 있다.
// 여기서 하는 일은 셋뿐이다: argv 를 읽고, 기록 파일을 읽고, 판정을 출력한다.
//
// 사용: node scripts/bridge-transcript.mjs --transcript <기록.json> --adapter callbot --max-line-bytes 65536
//       node scripts/bridge-transcript.mjs --requests <보낸.jsonl> --responses <받은.jsonl> ...
// 기록 JSON 형식: { "requests": ["...", ...], "responses": ["...", ...] }  (파이썬 참조 클라이언트가 그대로 내놓는다)
//
// 종료코드: 0=통과, 1=실패, 2=판정보류. **판정보류를 통과로 넘기지 않는다** —
// --adapter·--max-line-bytes 를 빼면 그 검사를 건너뛴 것이므로 통과가 아니다(§13-3).
//
// 실회선·실메신저에 붙지 않는다. 파일만 읽는다.
import { readFileSync } from 'node:fs';
import { verifyBridgeTranscript, formatTranscriptReport } from '../src/channels/bridgeTranscript.ts';

const USAGE = `사용: node scripts/bridge-transcript.mjs (--transcript <기록.json> | --requests <a.jsonl> --responses <b.jsonl>)
       [--adapter <callbot|chatbot|dars>] [--max-line-bytes N]
       [--include-handoff-summary] [--include-slots] [--expect-health] [--json]
종료코드: 0=통과, 1=실패, 2=판정보류(판정보류를 통과로 넘기지 마세요).`;

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const value = (n) => {
  const i = argv.indexOf(n);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
};

if (argv.length === 0 || flag('--help') || flag('-h')) {
  console.error(USAGE);
  process.exit(argv.length === 0 ? 1 : 0);
}

function readLinesFile(path) {
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

let requests;
let responses;
try {
  const transcriptPath = value('--transcript');
  if (transcriptPath) {
    const parsed = JSON.parse(readFileSync(transcriptPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.requests) || !Array.isArray(parsed.responses)) {
      console.error('기록 파일은 { requests: [...], responses: [...] } 형식이어야 합니다.');
      process.exit(1);
    }
    requests = parsed.requests;
    responses = parsed.responses;
  } else {
    const reqPath = value('--requests');
    const resPath = value('--responses');
    if (!reqPath || !resPath) {
      console.error(`--transcript 또는 --requests/--responses 가 필요합니다.\n\n${USAGE}`);
      process.exit(1);
    }
    requests = readLinesFile(reqPath);
    responses = readLinesFile(resPath);
  }
} catch (e) {
  // 파일 경로에는 배포 경로가 실린다. 이름(코드)만 보여준다.
  console.error(`기록 파일을 읽지 못했습니다: ${e instanceof Error ? e.name : 'Error'}`);
  process.exit(1);
}

const maxRaw = value('--max-line-bytes');
let maxLineBytes;
if (maxRaw !== undefined) {
  maxLineBytes = Number(maxRaw);
  if (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0) {
    console.error('--max-line-bytes 는 양의 정수여야 합니다.');
    process.exit(1);
  }
}

const report = verifyBridgeTranscript({ requests, responses }, {
  adapter: value('--adapter'),
  maxLineBytes,
  includeHandoffSummary: flag('--include-handoff-summary'),
  includeSlots: flag('--include-slots'),
  expectHealthReport: flag('--expect-health') ? true : undefined,
});

console.log(flag('--json') ? JSON.stringify(report, null, 2) : formatTranscriptReport(report));
process.exit(report.exitCode);
