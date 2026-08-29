# 지음 웹사이트

`jieum.ongo.kr`에 배포하는 정적 페이지입니다. 별도 프레임워크 없이
`public/index.html` 한 파일로 구성되어 있습니다.

## 로컬 실행

SDK 번들과 사전 파일이 준비되어 있어야 브라우저 데모가 동작합니다.

```bash
pnpm --filter @jieum/sdk build
apps/landing/scripts/build.sh
python3 -m http.server 4321 --directory apps/landing/public
```

브라우저에서 `http://localhost:4321`을 엽니다. `file://`로 열면 사전 파일을
가져올 수 없으므로 데모가 동작하지 않습니다.

## 빌드 결과

`apps/landing/scripts/build.sh`는 다음 파일을 `public/`에 복사합니다.

- `packages/sdk/dist/jieum.iife.js`
- `data/build/jieum-dict.dat`
- `data/build/jieum-collocation.json`
- `data/build/jieum-meta.json`

이 파일들은 빌드 결과이므로 저장소에 커밋하지 않습니다. 브라우저는 사용자가 데모 입력란을
처음 선택할 때 사전을 내려받고, 이후에는 IndexedDB 캐시를 사용합니다.

배포 설정은 저장소에 포함하지 않습니다.
