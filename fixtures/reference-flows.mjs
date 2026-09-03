// 적합성 실행기에 넘기는 시나리오 예시(§5.3). 저장소는 자기 운영 시나리오를 여기에 넣는다.
// 실고객 자료가 아니며 개인정보를 담지 않는다(§10.3).
export const flows = [{
  id: 'f_reference',
  version: 1,
  startNodeId: 'n_greet',
  nodes: {
    n_greet: { id: 'n_greet', kind: 'Say', text: '안녕하세요. 무엇을 도와드릴까요?', next: 'n_ask' },
    n_ask: { id: 'n_ask', kind: 'Collect', slot: 'purpose', prompt: '용건을 말씀해 주세요.', next: 'n_tr' },
    n_tr: { id: 'n_tr', kind: 'Transfer', queue: 'q_default', reason: '상담사 연결' },
  },
}];
