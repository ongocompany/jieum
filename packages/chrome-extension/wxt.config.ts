import { defineConfig } from 'wxt';

export default defineConfig({
  manifestVersion: 3,
  manifest: {
    name: '지음입력기',
    description: '한글 입력 중 실시간 한자 후보를 제시하는 문맥 인식형 한자입력기',
    permissions: ['storage'],
    web_accessible_resources: [
      {
        resources: ['data/*'],
        matches: ['<all_urls>'],
      },
    ],
  },
});
