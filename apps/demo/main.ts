/**
 * 지음입력기 데모 — SDK 사용 예시
 *
 * SDK의 init() 하나로 사전 로드 + 엔진 생성 + 요소 부착을 모두 처리
 */
import { init } from '@jieum/sdk';

const status = document.getElementById('status')!;
const log = document.getElementById('commit-log')!;

async function boot() {
  status.textContent = '사전 데이터 로딩 중...';

  const jieum = await init({
    dictUrl: '/data/',
    target: '#demo-input, #demo-textarea, #demo-editable',
    observe: true,
  });

  status.textContent = `사전 로드 완료 — ${jieum.engine.dictSize.toLocaleString()}개 단어`;

  // 변환 이벤트 로깅
  jieum.on('convert', ({ word, hanja }) => {
    log.textContent = JSON.stringify({ word, hanja }, null, 2);
  });
}

boot().catch((err) => {
  status.textContent = '로딩 실패';
  log.textContent = String(err);
});
