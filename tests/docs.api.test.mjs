// API.md 가 실제 소스와 어긋나지 않게 잡는다.
//
// 공개 API 문서는 가만히 두면 반드시 썩는다. 채널 저장소 3곳이 이 문서를 보고 붙기 때문에,
// 문서에만 있는 export·문서가 가리키는 없는 파일은 그 자체로 결함이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(ROOT, 'API.md');

const hasDoc = existsSync(DOC);
const b = { skip: hasDoc ? false : 'API.md 없음' };
const md = hasDoc ? readFileSync(DOC, 'utf8') : '';

/** `| \`mod/file.ts\` | 설명 | \`a\`, \`b\` |` 형태의 표 행만 걷는다. */
function moduleRows() {
  const rows = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*`([a-z0-9/]+\.ts)`\s*\|(.*)\|(.*)\|\s*$/i.exec(line);
    if (!m) continue;
    const symbols = [...m[3].matchAll(/`([A-Za-z0-9_]+)`/g)].map((s) => s[1]);
    rows.push({ file: m[1], symbols });
  }
  return rows;
}

const rows = moduleRows();

test('API.md 가 모듈 표를 가지고 있다', b, () => {
  assert.ok(rows.length >= 30, `모듈 행이 ${rows.length}개뿐이다 — 표 형식이 깨졌을 수 있다`);
});

test('문서가 가리키는 모듈 파일이 모두 실재한다', b, () => {
  const missing = rows.map((r) => r.file).filter((f) => !existsSync(join(ROOT, 'src', f)));
  assert.deepEqual(missing, [], `문서에만 있는 파일: ${missing.join(', ')}`);
});

test('문서가 소개한 export 가 소스에 실제로 있다', b, () => {
  const missing = [];
  for (const { file, symbols } of rows) {
    const src = readFileSync(join(ROOT, 'src', file), 'utf8');
    for (const s of symbols) {
      const re = new RegExp(`export\\s+(?:async\\s+)?(?:function|const|class|interface|type|enum)\\s+${s}\\b`);
      if (!re.test(src)) missing.push(`${file}:${s}`);
    }
  }
  assert.deepEqual(missing, [], `소스에 없는 export 를 문서가 소개하고 있다: ${missing.join(', ')}`);
});

test('문서가 모든 소스 모듈을 빠짐없이 다룬다', b, () => {
  const listed = new Set(rows.map((r) => r.file));
  // 새 모듈을 만들고 문서에 안 적으면 여기서 걸린다.
  const undocumented = collectSources().filter((f) => !listed.has(f));
  assert.deepEqual(undocumented, [], `문서에 없는 모듈: ${undocumented.join(', ')}`);
});

function collectSources() {
  const out = [];
  const walk = (rel) => {
    for (const name of readdirSync(join(ROOT, 'src', rel))) {
      const relPath = rel ? `${rel}/${name}` : name;
      if (statSync(join(ROOT, 'src', relPath)).isDirectory()) walk(relPath);
      else if (name.endsWith('.ts')) out.push(relPath);
    }
  };
  walk('');
  return out.sort();
}

test('활성화 규약(승인 필요)이 문서에 명시돼 있다', b, () => {
  assert.match(md, /\[승인 필요\]/);
  assert.match(md, /dry_run/);
  assert.match(md, /§13-3/);
});
