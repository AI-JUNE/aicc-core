const runner = await import('./src/flow/runner.ts');
const flow = {
  id: 'f_card_status', version: 1, startNodeId: 'ask',
  nodes: {
    ask:     { id: 'ask',     kind: 'Collect', slot: 'phone', prompt: '연락처를 말씀해 주세요.', next: 'lookup' },
    lookup:  { id: 'lookup',  kind: 'Api',     connectorId: 'crm_lookup', waitText: '조회 중입니다.', next: 'reply', onError: 'sorry' },
    reply:   { id: 'reply',   kind: 'Say',     text: '조회되었습니다.' },
    sorry:   { id: 'sorry',   kind: 'Say',     text: '지금은 조회가 어렵습니다.' },
  },
};
const ctx = { tenantId: 't_bank', interactionId: 'i_1', channel: 'voice', visualAvailable: true, now: () => '2026-09-01T00:00:00.000Z' };
const silentFlow = { ...flow, nodes: { ...flow.nodes, lookup: { id: 'lookup', kind: 'Api', connectorId: 'crm_lookup', next: 'reply' } } };
const r1 = runner.start(silentFlow, ctx);
const r2 = runner.send(silentFlow, r1.state, { kind: 'utterance', text: '010-1234-5678' }, ctx);
console.log(JSON.stringify(r2.events, null, 1));
