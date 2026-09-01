// Flow 검증기 — 설계서 §5.3(단일 시나리오)·§7(시나리오 스튜디오).
// 시나리오 빌더가 배포(publish) 전에 호출한다. 순수 함수: Flow만 읽고 부작용이 없다.
// 목적은 "런타임에서야 드러나는 시나리오 결함"을 편집 시점으로 앞당기는 것이다.
import type { Flow, FlowNode } from './types.ts';

export type Severity = 'error' | 'warning';

export type IssueCode =
  // 구조 오류 — 배포 차단
  | 'E_FLOW_ID_EMPTY'
  | 'E_FLOW_VERSION_INVALID'
  | 'E_NO_NODES'
  | 'E_START_UNDEFINED'
  | 'E_NODE_ID_MISMATCH'
  | 'E_NEXT_UNDEFINED'
  | 'E_REQUIRED_FIELD_EMPTY'
  | 'E_CHOICE_NO_OPTIONS'
  | 'E_CHOICE_DUPLICATE_VALUE'
  | 'E_MAX_RETRY_INVALID'
  | 'E_INFINITE_LOOP'
  | 'E_CONNECTOR_UNDEFINED'
  // 경고 — 배포는 가능하나 운영 리스크
  | 'W_UNREACHABLE_NODE'
  | 'W_CYCLE'
  | 'W_NO_EXIT';

export interface ValidationIssue {
  code: IssueCode;
  severity: Severity;
  message: string;
  nodeId?: string;
  field?: string;
  /** 순환 경고에서 순환 경로를 그대로 돌려준다(스튜디오 하이라이트용) */
  path?: string[];
}

export interface ValidationResult {
  ok: boolean;                 // error 0건이면 true
  issues: ValidationIssue[];
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** startNodeId 에서 도달 가능한 노드 id (선언 순서 기준 정렬) */
  reachable: string[];
  unreachable: string[];
}

/** 노드에서 나가는 간선. field 는 스튜디오가 어느 입력칸을 가리켜야 하는지 알려준다. */
export interface FlowEdge { from: string; to: string; field: string }

export function edgesOf(node: FlowNode): FlowEdge[] {
  const out: FlowEdge[] = [];
  const push = (to: string | undefined, field: string) => {
    if (typeof to === 'string' && to !== '') out.push({ from: node.id, to, field });
  };
  switch (node.kind) {
    case 'Choice':
      node.options.forEach((o, i) => push(o.next, `options[${i}].next`));
      push(node.next, 'next');
      break;
    case 'Confirm':
      push(node.onYes, 'onYes');
      push(node.onNo, 'onNo');
      push(node.next, 'next');
      break;
    case 'Api':
      push(node.onError, 'onError');
      push(node.next, 'next');
      break;
    case 'Transfer':
      break;  // Transfer 는 종단 노드다 — next 를 따라가지 않는다
    default:
      push(node.next, 'next');
  }
  return out;
}

function blank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim() === '';
}

/** 필수 필드 누락 — 노드 종류별 */
function checkRequired(node: FlowNode, add: (i: ValidationIssue) => void): void {
  const req = (field: string, value: unknown) => {
    if (blank(value)) {
      add({
        code: 'E_REQUIRED_FIELD_EMPTY', severity: 'error', nodeId: node.id, field,
        message: `${node.kind} 노드 '${node.id}' 의 필수 필드 '${field}' 가 비어 있습니다.`,
      });
    }
  };
  switch (node.kind) {
    case 'Say':
      req('text', node.text);
      break;
    case 'Collect':
      req('slot', node.slot);
      req('prompt', node.prompt);
      if (node.maxRetry !== undefined && (!Number.isInteger(node.maxRetry) || node.maxRetry < 0)) {
        add({
          code: 'E_MAX_RETRY_INVALID', severity: 'error', nodeId: node.id, field: 'maxRetry',
          message: `노드 '${node.id}' 의 maxRetry 는 0 이상의 정수여야 합니다.`,
        });
      }
      break;
    case 'Choice': {
      req('prompt', node.prompt);
      if (!Array.isArray(node.options) || node.options.length === 0) {
        add({
          code: 'E_CHOICE_NO_OPTIONS', severity: 'error', nodeId: node.id, field: 'options',
          message: `Choice 노드 '${node.id}' 에 선택지가 없습니다.`,
        });
        break;
      }
      const seen = new Set<string>();
      node.options.forEach((o, i) => {
        if (blank(o.label)) req(`options[${i}].label`, o.label);
        if (blank(o.value)) req(`options[${i}].value`, o.value);
        else if (seen.has(o.value)) {
          add({
            code: 'E_CHOICE_DUPLICATE_VALUE', severity: 'error', nodeId: node.id, field: `options[${i}].value`,
            message: `Choice 노드 '${node.id}' 에 중복된 선택지 값 '${o.value}' 가 있습니다.`,
          });
        } else seen.add(o.value);
      });
      break;
    }
    case 'Confirm':
      req('prompt', node.prompt);
      break;
    case 'Transfer':
      req('queue', node.queue);
      break;
    case 'Api':
      req('connectorId', node.connectorId);
      // onError 미지정은 오류가 아니다 — 지정하지 않으면 §9.3 상담사 이관으로 내려간다.
      break;
  }
}

/** 도달 가능 노드 집합 (BFS) */
function reachableFrom(flow: Flow, start: string): Set<string> {
  const seen = new Set<string>();
  if (!flow.nodes[start]) return seen;
  const queue = [start];
  seen.add(start);
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const node = flow.nodes[id];
    if (!node) continue;
    for (const e of edgesOf(node)) {
      if (flow.nodes[e.to] && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
    }
  }
  return seen;
}

/**
 * 순환 검출 (DFS back-edge).
 * 순환 자체는 정상 시나리오다 — 메뉴 되돌아가기·재확인 루프가 이에 해당한다.
 * 다만 Say 노드만으로 이루어진 순환은 고객 입력 없이 무한 반복되므로 오류로 본다.
 */
function findCycles(flow: Flow, scope: Set<string>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>();   // 0 미방문 / 1 진행중 / 2 완료
  const stack: string[] = [];
  const seenKeys = new Set<string>();

  const visit = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    const node = flow.nodes[id];
    if (node) {
      for (const e of edgesOf(node)) {
        if (!scope.has(e.to) || !flow.nodes[e.to]) continue;
        const st = state.get(e.to) ?? 0;
        if (st === 0) visit(e.to);
        else if (st === 1) {
          const at = stack.indexOf(e.to);
          const cycle = stack.slice(at);
          const key = [...cycle].sort().join('>');
          if (!seenKeys.has(key)) { seenKeys.add(key); cycles.push(cycle); }
        }
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const id of scope) if ((state.get(id) ?? 0) === 0) visit(id);
  return cycles;
}

/** 시나리오 배포 전 검증. error 가 0건일 때만 publish 를 허용한다(§7 스튜디오). */
export function validateFlow(flow: Flow): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (i: ValidationIssue) => { issues.push(i); };

  if (blank(flow.id)) {
    add({ code: 'E_FLOW_ID_EMPTY', severity: 'error', field: 'id', message: 'Flow id 가 비어 있습니다.' });
  }
  if (!Number.isInteger(flow.version) || flow.version < 1) {
    add({ code: 'E_FLOW_VERSION_INVALID', severity: 'error', field: 'version', message: 'Flow version 은 1 이상의 정수여야 합니다.' });
  }

  const ids = Object.keys(flow.nodes ?? {});
  if (ids.length === 0) {
    add({ code: 'E_NO_NODES', severity: 'error', field: 'nodes', message: 'Flow 에 노드가 없습니다.' });
  }

  // 키와 node.id 불일치 — 런타임 순회가 조용히 깨지는 원인
  for (const key of ids) {
    const node = flow.nodes[key] as FlowNode;
    if (node.id !== key) {
      add({
        code: 'E_NODE_ID_MISMATCH', severity: 'error', nodeId: key, field: 'id',
        message: `nodes 키 '${key}' 와 node.id '${node.id}' 가 다릅니다.`,
      });
    }
    checkRequired(node, add);
  }

  // 미정의 next
  for (const key of ids) {
    for (const e of edgesOf(flow.nodes[key] as FlowNode)) {
      if (!flow.nodes[e.to]) {
        add({
          code: 'E_NEXT_UNDEFINED', severity: 'error', nodeId: key, field: e.field,
          message: `노드 '${key}' 의 ${e.field} 가 존재하지 않는 노드 '${e.to}' 를 가리킵니다.`,
        });
      }
    }
  }

  // 시작 노드
  const hasStart = !blank(flow.startNodeId) && Boolean(flow.nodes?.[flow.startNodeId]);
  if (!hasStart) {
    add({
      code: 'E_START_UNDEFINED', severity: 'error', field: 'startNodeId',
      message: `startNodeId '${flow.startNodeId}' 에 해당하는 노드가 없습니다.`,
    });
  }

  const reach = hasStart ? reachableFrom(flow, flow.startNodeId) : new Set<string>();
  const reachable = ids.filter(id => reach.has(id));
  const unreachable = ids.filter(id => !reach.has(id));

  if (hasStart) {
    for (const id of unreachable) {
      add({
        code: 'W_UNREACHABLE_NODE', severity: 'warning', nodeId: id,
        message: `노드 '${id}' 는 시작 노드에서 도달할 수 없습니다.`,
      });
    }

    for (const cycle of findCycles(flow, reach)) {
      const kinds = cycle.map(id => (flow.nodes[id] as FlowNode).kind);
      const waitsForInput = kinds.some(k => k === 'Collect' || k === 'Choice' || k === 'Confirm');
      // Api 순환은 고객 입력 없이 돌지만 외부 응답에 따라 벗어날 수 있다(재조회·폴링).
      // 무한 루프로 단정해 배포를 막지 않고, 종료 조건 확인을 요구하는 경고로 남긴다.
      const callsExternal = kinds.some(k => k === 'Api');
      if (waitsForInput) {
        add({
          code: 'W_CYCLE', severity: 'warning', nodeId: cycle[0], path: cycle,
          message: `순환 경로가 있습니다: ${cycle.join(' → ')} → ${cycle[0]}. 고객 입력으로 벗어날 수 있는지 확인하세요.`,
        });
      } else if (callsExternal) {
        add({
          code: 'W_CYCLE', severity: 'warning', nodeId: cycle[0], path: cycle,
          message: `외부 연동 호출이 포함된 순환입니다: ${cycle.join(' → ')} → ${cycle[0]}. 조회 실패가 반복될 때 벗어날 조건이 있는지 확인하세요.`,
        });
      } else {
        add({
          code: 'E_INFINITE_LOOP', severity: 'error', nodeId: cycle[0], path: cycle,
          message: `입력 대기 없는 무한 순환입니다: ${cycle.join(' → ')} → ${cycle[0]}.`,
        });
      }
    }

    // 종료도 이관도 없는 시나리오 — 고객이 나갈 길이 없다
    const hasExit = reachable.some(id => {
      const node = flow.nodes[id] as FlowNode;
      return node.kind === 'Transfer' || edgesOf(node).length === 0;
    });
    if (reachable.length > 0 && !hasExit) {
      add({ code: 'W_NO_EXIT', severity: 'warning', message: '도달 가능한 범위에 종료 노드도 상담사 이관 노드도 없습니다.' });
    }
  }

  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  return { ok: errors.length === 0, issues, errors, warnings, reachable, unreachable };
}

/**
 * Api 노드가 가리키는 커넥터가 실제로 등록돼 있는지 대조한다(§6.1).
 * Flow만으로는 알 수 없어 validateFlow 와 분리했다 — 배포 게이트가 테넌트 커넥터 목록을 넣어 호출한다.
 * 커넥터 목록은 반드시 해당 테넌트 스코프로 조회한 것이어야 한다(§11.1).
 */
export function validateFlowConnectors(flow: Flow, registeredConnectorIds: readonly string[]): ValidationIssue[] {
  const known = new Set(registeredConnectorIds);
  const issues: ValidationIssue[] = [];
  for (const node of Object.values(flow.nodes ?? {})) {
    if (node.kind !== 'Api') continue;
    if (blank(node.connectorId)) continue;   // 필수 필드 누락은 validateFlow 가 이미 잡는다
    if (!known.has(node.connectorId)) {
      issues.push({
        code: 'E_CONNECTOR_UNDEFINED', severity: 'error', nodeId: node.id, field: 'connectorId',
        message: `Api 노드 '${node.id}' 가 등록되지 않은 커넥터 '${node.connectorId}' 를 가리킵니다.`,
      });
    }
  }
  return issues;
}

/** 배포 게이트 — 스튜디오 publish 버튼이 호출한다. */
export function canPublish(flow: Flow): boolean {
  return validateFlow(flow).ok;
}
