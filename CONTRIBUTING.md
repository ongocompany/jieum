# 지음에 기여하기

버그 신고, 단어 제보, 문서 수정, 코드 변경을 환영합니다. 작은 제보라도 재현에 필요한
정보가 있으면 프로젝트를 개선하는 데 도움이 됩니다.

## 버그 신고

[버그 신고 양식](../../issues/new?template=bug_report.md)에 다음 내용을 적어 주세요.

- 운영체제와 버전
- 문제가 발생한 앱과 버전
- 입력한 내용과 실제 결과
- 기대한 결과
- 같은 문제를 재현하는 순서

입력 내용이 포함된 로그나 화면 캡처는 개인정보를 지운 뒤 첨부해 주세요. 보안 문제나 공개하기
어려운 내용은 이슈 대신 [보안 정책](SECURITY.md)에 적힌 이메일로 보내 주세요.

## 단어와 후보 순서 제보

[단어 제보 양식](../../issues/new?template=word_report.md)에 한글 표기, 기대한 한자,
현재 후보 순서를 적어 주세요. 출전이나 실제 사용 예가 있으면 함께 알려 주세요.

지음은 현대어, 고어, 전문어를 함께 다룹니다. 드물다는 이유만으로 제외하지 않지만,
잘못된 후보가 먼저 나오지 않도록 출처와 용례를 확인합니다.

## 개발 환경

Node.js 20 이상과 pnpm 10 이상이 필요합니다.

```bash
pnpm install
pnpm build
pnpm --filter @jieum/core test
pnpm --filter @jieum/browser test
pnpm --filter @jieum/engine-server test
```

공개 저장소에는 사전 원본과 빌드 결과가 포함되지 않으므로 `pnpm build:dict`와 전체 입력기
실행에는 별도로 준비한 사전 빌드 결과가 필요합니다.

플랫폼별 빌드 방법은 다음 문서를 참고해 주세요.

- [macOS 입력기](apps/macos-ime/README.md)
- [Windows 입력기](apps/windows-ime/README.md)

## Pull request

- 한 pull request에는 한 가지 변경 목적만 담아 주세요.
- 동작을 바꾸는 경우 관련 테스트를 추가하거나 수정해 주세요.
- 사용자에게 보이는 동작이 달라지면 README나 플랫폼 안내도 함께 고쳐 주세요.
- `packages/core`에는 브라우저나 Node.js에만 있는 API를 추가하지 마세요. 코어는 웹과
  시스템 입력기가 함께 사용합니다.
- 커밋 메시지에는 무엇을 바꿨는지와 변경 이유를 간단히 적어 주세요.

## 라이선스

코드 기여는 Apache License 2.0, `data/` 아래의 데이터 기여는 CC BY-SA 조건으로
배포됩니다.
