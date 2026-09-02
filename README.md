# 지음 (Jieum)

한글을 입력하는 동안 단어 단위로 한자 후보를 보여 주는 macOS·Windows 입력기입니다.
한자 변환 키를 눌러 글자마다 찾지 않아도 되고, 선택한 후보와 직접 만든 조합을
기억해 다음 입력에 반영합니다.

[브라우저에서 체험하기](https://jieum.ongo.kr)

```text
사당          → 祠堂 · 社堂 · 寺黨 · 四唐 · 私黨 …
조선왕조실록  → 朝鮮王朝實錄
```

## 다운로드

- [macOS 0.1.1 베타 — Apple Silicon](https://jieum.ongo.kr/download/macos/arm64) — M1 이상, macOS 14 이상
- [macOS 0.1.1 베타 — Intel](https://jieum.ongo.kr/download/macos/intel) — Intel Mac, macOS 14 이상
- [Windows 0.1.1 베타 — x64](https://jieum.ongo.kr/download/windows) — Windows 10·11

설치 방법과 기본 조작은 [지음 웹사이트](https://jieum.ongo.kr)에서 확인할 수 있습니다.
macOS 설치 파일은 Developer ID로 서명하고 Apple 공증을 거쳤습니다.
Windows 설치 파일은 아직 코드 서명 전이어서 설치할 때 `알 수 없는 게시자` 경고가
나타날 수 있습니다.

[GitHub Release](https://github.com/ongocompany/jieum/releases/tag/v0.1.1)에서도 같은 설치
파일과 SHA-256 값을 확인할 수 있습니다.

```text
71bf5c4f02e63734eac1a215dd67ff6e8dbdecefec4d9cc0a5e1b3de9605475d  Jieum-0.1.1-macOS-arm64-notarized.dmg
d2ff62cb0d62634fbfb68200dffca803109d02bc2066a9565d114e486e680326  Jieum-0.1.1-macOS-x86_64-notarized.dmg
9fa9cf1edd7bdff2de8d9154f5dc898c81abbaaaa920239d30a8bb95bf58372f  Jieum-0.1.1-Windows-x64-setup.exe
```

## 주요 기능

- 가장 긴 표제어부터 단어 단위 후보를 제안합니다.
- 커서 앞 문맥과 최근 선택 이력을 후보 순서에 반영합니다.
- 사전에 없는 이름·지명·책 이름 등을 낱자로 조합하면 다음부터 통째로 제안합니다.
- 한자만 입력하거나 `한자(漢字)`, `漢字(한자)`처럼 병기할 수 있습니다.
- 표준국어대사전·우리말샘을 바탕으로 현대어뿐 아니라 고어와 전문어도 함께 제공합니다.
- 사전 조회와 사용 이력 저장은 모두 사용자의 컴퓨터에서 처리합니다.

## 알려진 제한

아래한글은 현재 지원하지 않습니다. 아래한글에서 지음을 선택하면 조합이 깨질 수 있습니다.
`Alt+F2`를 눌러 「현재 글자판」과 「제1 글자판」을 한국어로 설정하면 한컴 입력기로
돌아갈 수 있습니다. 다른 앱에서 문제가 생기면 [버그 신고](../../issues/new/choose)에 운영체제와
앱 이름, 재현 방법을 남겨 주세요.

## 저장소 구성

```text
packages/core              사전 조회·경계 판별·후보 순위
packages/browser           웹 입력 감지·후보 창·문자열 치환
packages/sdk               브라우저용 SDK
packages/engine-server     시스템 입력기와 코어를 잇는 로컬 엔진
apps/macos-ime             macOS InputMethodKit 입력기
apps/windows-ime           Windows TSF 입력기
apps/editor                Tauri 기반 데스크톱 편집기
apps/landing               jieum.ongo.kr 정적 페이지
tools/dict-builder         사전 빌드 도구
tools/eval                 후보 품질 평가 도구
```

TypeScript 패키지는 다음 명령으로 빌드하고 테스트합니다.

```bash
pnpm install
pnpm build
pnpm --filter @jieum/core test
pnpm --filter @jieum/browser test
pnpm --filter @jieum/engine-server test
```

공개 저장소에는 사전 원본과 빌드 결과가 포함되지 않습니다. 따라서 시스템 입력기를
직접 실행하려면 별도로 준비한 사전 파일이 필요합니다. 플랫폼별 개발 방법은
[macOS 입력기](apps/macos-ime/README.md)와 [Windows 입력기](apps/windows-ime/README.md)
문서를 참고해 주세요.

## 기여와 문의

버그, 누락된 단어, 후보 순서에 관한 제보를 환영합니다. 공개하기 어려운 보안 문제는
[보안 정책](SECURITY.md)에 적힌 방법으로 알려 주세요. 코드 기여 방법은
[CONTRIBUTING.md](CONTRIBUTING.md)를 참고해 주세요.

- 이슈: [GitHub Issues](../../issues)
- 이메일: [jieum@ongo.kr](mailto:jieum@ongo.kr)
- 관리: [온고컴퍼니](https://ongo.kr)

## 라이선스

- 코드는 [Apache License 2.0](LICENSE)으로 배포합니다.
- 사전 데이터와 배포물에 포함된 사전 빌드 결과는 [CC BY-SA](data/LICENSE)를 따릅니다.
- 한글 조합에는 [libhangul](https://github.com/libhangul/libhangul)을 동적 링크합니다.
  libhangul은 LGPL 2.1을 따릅니다.

자료 출처와 제3자 라이선스는 [NOTICE](NOTICE)에 정리되어 있습니다.
