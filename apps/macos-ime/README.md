# 지음 macOS 입력기

InputMethodKit으로 만든 macOS 시스템 입력기입니다. Swift로 작성된 입력기 셸이 로컬 엔진과
통신하며, 한글 조합에는 libhangul을 사용합니다.

## 요구 사항

- Apple 실리콘 Mac(M1 이상)
- macOS 14 이상
- Xcode Command Line Tools
- Node.js 20 이상과 pnpm 10 이상
- Bun
- 사전 빌드 결과

공개 저장소에는 사전 원본과 빌드 결과가 포함되지 않습니다. 사전 파일이 없으면 한글 조합은
동작하지만 한자 후보는 표시되지 않습니다.

## 설치

[지음 웹사이트에서 macOS 베타 설치 파일을 내려받습니다.](https://jieum.ongo.kr/download/macos)

1. DMG를 열고 `지음 설치.pkg`를 두 번 클릭합니다.
2. 설치 프로그램의 안내에 따라 관리자 암호를 입력하고 설치합니다.
3. 화면 오른쪽 위 메뉴 막대의 입력 소스 메뉴에서 지음을 선택합니다.

설치 프로그램이 입력 소스 등록까지 처리하므로 앱을 직접 입력기 폴더로 옮길 필요는 없습니다.
배포 파일은 Developer ID로 서명하고 Apple 공증을 거칩니다.

## 개발용 빌드

```bash
pnpm install
pnpm --filter @jieum/core build
pnpm --filter @jieum/engine-server compile
apps/macos-ime/scripts/fetch-libhangul.sh
pnpm --filter @jieum/macos-ime install-debug
```

`install-debug`는 `~/Library/Input Methods/Jieum.app`에 입력기를 설치하고 입력 소스
목록에 등록합니다. 설치가 끝나면 메뉴 막대의 입력 소스 메뉴에서 지음을 선택하세요.

## 키 조작

| 키 | 동작 |
|---|---|
| `1`~`9` | 해당 번호의 후보 확정 |
| `←` `→` | 이전·다음 후보로 이동 |
| `↓` `↑` | 후보 목록 펼치기·접기 |
| `Shift+↑` `Shift+↓` | 현재 앱에서 후보 창을 위·아래에 표시 |
| `Enter` | 선택한 후보 확정 |
| `Escape` | 후보 창 닫기 |
| 왼쪽 `⌘+Shift` | 한자 후보 모드와 한글 전용 모드 전환 |

영문은 macOS 입력 소스를 전환해 입력합니다.

입력 소스 메뉴에서는 다음을 바꾸거나 실행할 수 있습니다.

- 한자 후보 표시 여부
- 사용자 조합 삭제(`이 후보 잊기`)
- 한자만 입력하거나 한글·한자를 함께 적는 확정 형식
- 병기에 사용하는 괄호

## 진단

```bash
# 엔진 왕복 지연 측정
JIEUM_SOCKET=/tmp/jieum.sock ./.build/debug/JieumIME --bench --iterations 3000

# 키 이벤트 진단
killall JieumIME
JIEUM_DEBUG_KEYS=1 "$HOME/Library/Input Methods/Jieum.app/Contents/MacOS/JieumIME"
```

지원하는 환경 변수는 다음과 같습니다.

| 이름 | 용도 |
|---|---|
| `JIEUM_SOCKET` | 엔진 소켓 경로 |
| `JIEUM_ENGINE_BIN` | 번들 대신 사용할 엔진 바이너리 경로 |
| `JIEUM_DEBUG_KEYS` | `1`일 때 키코드 진단 활성화 |

진단 로그에는 입력 내용, 조회 문자열, 확정한 단어를 기록하지 않습니다.
