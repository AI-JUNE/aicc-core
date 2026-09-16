// 참조 클라이언트 복사본 드리프트 검사 — §2·§13-3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

let m = null;
try { m = await import('../src/ops/clientDrift.ts'); } catch { /* 구형 런타임 */ }
const b = { skip: m ? false : '타입 스트리핑 미지원 런타임' };

const hash = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const FILES = ['aicc_bridge.py', 'aicc_callbot.py'];
const src = () => [
  { relPath: 'aicc_bridge.py', content: 'def hello():\n    return 1\n' },
  { relPath: 'aicc_callbot.py', content: 'class Hooks:\n    pass\n' },
  { relPath: 'selfcheck.py', content: 'print()\n' },   // 복사 대상 아님 — 목록에 없으니 무시된다
];

test('동일한 복사본은 통과(종료코드 0)', b, () => {
  const r = m.compareClientCopies(src(), src().slice(0, 2), { hash, files: FILES });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.exitCode, 0);
  assert.deepEqual(r.counts, { same: 2, eolOnly: 0, diff: 0, missing: 0, extraInTarget: 0 });
  assert.equal(r.reasonKo, undefined);
});

test('내용이 다르면 실패하고 어느 파일인지 해시로 드러낸다(내용은 싣지 않는다)', b, () => {
  const t = src().slice(0, 2);
  t[1] = { relPath: 'aicc_callbot.py', content: 'class Hooks:\n    old = True\n' };
  const r = m.compareClientCopies(src(), t, { hash, files: FILES });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.exitCode, 1);
  const item = r.items.find((i) => i.relPath === 'aicc_callbot.py');
  assert.equal(item.status, 'diff');
  assert.notEqual(item.sourceHash, item.targetHash);
  assert.equal(item.sourceHash.length, 12);
  assert.equal(JSON.stringify(r).includes('old = True'), false);
  assert.match(r.reasonKo, /내용 다름 1건/);
});

test('원본에 있는데 대상에 없으면 실패(복사가 불완전하다)', b, () => {
  const r = m.compareClientCopies(src(), src().slice(0, 1), { hash, files: FILES });
  assert.equal(r.verdict, 'fail');
  assert.equal(r.counts.missing, 1);
  assert.equal(r.items[1].status, 'missing_in_target');
  assert.equal(r.items[1].targetHash, undefined);
});

test('줄끝(CRLF)만 다른 것은 경고이지 실패가 아니다', b, () => {
  const t = src().slice(0, 2).map((f) => ({ ...f, content: f.content.replace(/\n/g, '\r\n') }));
  const r = m.compareClientCopies(src(), t, { hash, files: FILES });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.counts.eolOnly, 2);
  assert.ok(r.items.every((i) => i.status === 'eol_only'));
});

test('대상에만 있는 파일(README·__init__)은 건수만 남기고 판정에 넣지 않는다', b, () => {
  const t = [...src().slice(0, 2), { relPath: 'README.md', content: '# 연동' }, { relPath: '__init__.py', content: '' }];
  const r = m.compareClientCopies(src(), t, { hash, files: FILES });
  assert.equal(r.verdict, 'pass');
  assert.equal(r.counts.extraInTarget, 2);
});

test('판정보류(종료코드 2): 대상 미존재·원본 비어 있음·목록 미선언·목록이 원본에 없음', b, () => {
  const noTarget = m.compareClientCopies(src(), undefined, { hash, files: FILES });
  assert.equal(noTarget.verdict, 'inconclusive');
  assert.equal(noTarget.exitCode, 2);
  assert.match(noTarget.reasonKo, /대상 디렉터리/);
  assert.equal(m.compareClientCopies([], src(), { hash, files: FILES }).exitCode, 2);
  assert.equal(m.compareClientCopies(src(), src(), { hash, files: [] }).exitCode, 2);
  const wrong = m.compareClientCopies(src(), src(), { hash, files: ['nope.py'] });
  assert.equal(wrong.exitCode, 2);
  assert.match(wrong.reasonKo, /nope\.py/);
});

test('argv 해석과 보고서 형식', b, () => {
  const a = m.parseDriftArgs(['--source', 'clients/python', '--target', '../cb/aicc', '--files', 'a.py, b.py,', '--json']);
  assert.deepEqual(a, { source: 'clients/python', target: '../cb/aicc', files: ['a.py', 'b.py'], json: true });
  const r = m.compareClientCopies(src(), src().slice(0, 1), { hash, files: FILES });
  const text = m.formatDriftReport(r);
  assert.match(text, /^참조 클라이언트 복사본 대조: 실패/);
  assert.match(text, /aicc_callbot\.py: 대상에 없음/);
  assert.match(text, /사유:/);
});

test('실행기: 대상 디렉터리가 없으면 종료코드 2, 원본 자기 대조는 0', b, () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const run = (args) => spawnSync(process.execPath, [join(ROOT, 'scripts/client-drift.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' });
  const missing = run(['--source', 'clients/python', '--target', 'clients/__no_such_dir__', '--files', 'aicc_bridge.py']);
  assert.equal(missing.status, 2, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /판정보류/);
  const self = run(['--source', 'clients/python', '--target', 'clients/python', '--files', 'aicc_bridge.py,aicc_callbot.py', '--json']);
  assert.equal(self.status, 0, self.stdout + self.stderr);
  assert.equal(JSON.parse(self.stdout).verdict, 'pass');
  assert.equal(run([]).status, 1);   // 인자 없음 = 사용법 + 실패
});
