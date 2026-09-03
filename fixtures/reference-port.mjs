// 채널 저장소가 복사해 가는 최소 예시 — 적합성 실행기가 무엇을 기대하는지 보여준다.
//
// 저장소가 할 일은 ChannelTransport(deliver 하나)를 구현해 여기 끼우는 것뿐이다.
// 나머지(입력 동결·종료 멱등·예산·마스킹·실패 보고)는 basePort 가 책임진다.
// 이 파일은 transport 를 주입하지 않으므로 `dry_run` 이며 매체로 아무것도 내보내지 않는다.
// live 전환은 approvalRef + transport 가 모두 있어야 하고 **[승인 필요]** 다.
import { createChannelPort } from '../src/channels/basePort.ts';

export const port = createChannelPort({ id: 'chatbot' });
