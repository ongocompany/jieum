import { createSnapshot, JieumEngine } from '@jieum/core';
import { attachEditableSurface, observeEditableSurfaces } from '@jieum/browser';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_end',
  async main() {
    console.log('[지음] 한자입력기 초기화 중...');

    try {
      const engine = await loadEngine();
      console.log(`[지음] 사전 로드 완료 (${engine.dictSize.toLocaleString()}개 단어)`);

      // 현재 페이지의 편집 가능 요소에 부착
      attachToExistingTargets(engine);

      // 동적으로 추가되는 요소 감시
      observeEditableSurfaces(document, { engine });

      console.log('[지음] 한자입력기 활성화');
    } catch (err) {
      console.error('[지음] 초기화 실패:', err);
    }
  },
});

async function loadEngine(): Promise<JieumEngine> {
  const getUrl = (path: string) => browser.runtime.getURL(path as any);

  const [dictData, compoundData, blocklistData] = await Promise.all([
    fetchJson<Record<string, any[]>>(getUrl('data/jieum-dict.json')),
    fetchJson<Record<string, string>>(getUrl('data/jieum-compound.json')),
    fetchJson<string[]>(getUrl('data/jieum-blocklist.json')),
  ]);

  const snapshot = createSnapshot(dictData, compoundData, blocklistData);
  return new JieumEngine(snapshot);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
  return res.json() as Promise<T>;
}

function attachToExistingTargets(engine: JieumEngine): void {
  const targets = document.querySelectorAll<HTMLElement>(
    'input[type="text"], input[type="search"], input:not([type]), textarea, [contenteditable="true"]',
  );

  for (const target of targets) {
    attachEditableSurface(target, { engine });
  }
}
