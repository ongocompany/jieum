#!/usr/bin/env bash
#
# 디버그 설치 — ~/Library/Input Methods 에 넣고 입력 소스로 등록한다
#
# 구름입력기의 tools/install_debug.sh와 같은 자리의 스크립트다.
# 시스템 전역(/Library/Input Methods)이 아니라 사용자 홈에 넣으므로 sudo가 필요 없다.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUNDLE="$APP_DIR/build/Jieum.app"
TARGET_DIR="$HOME/Library/Input Methods"
TARGET="$TARGET_DIR/Jieum.app"

"$APP_DIR/scripts/build-app.sh"

# 쓰던 입력기는 반드시 killall **전에** 읽는다.
#
# 선택된 입력기의 프로세스가 죽는 순간 시스템이 즉시 다른 입력기로 물러난다
# (2026-08-02 실측: kill 직후 --current가 구름으로 바뀌었다). killall 뒤에 읽으면
# "사용자가 쓰던 입력기"가 아니라 방금 우리가 만든 낙하 지점을 기억하게 되고,
# 설치 끝의 복원이 그 낙하 지점을 "복원"한다 — 지음을 쓰는 중에 설치할수록
# 반드시 구름으로 튕기던 2026-08-01 회귀의 원인이 정확히 이것이었다.
PREV_BIN="$TARGET/Contents/MacOS/JieumIME"
[[ -x "$PREV_BIN" ]] || PREV_BIN="$BUNDLE/Contents/MacOS/JieumIME"
PREV_SOURCE="$("$PREV_BIN" --current 2>/dev/null || true)"

echo "[지음] 돌고 있는 인스턴스 종료"
killall JieumIME 2>/dev/null || true
sleep 0.5

echo "[지음] 설치: $TARGET"
mkdir -p "$TARGET_DIR"
rm -rf "$TARGET"
cp -R "$BUNDLE" "$TARGET"

# 복사가 끝난 **뒤에 한 번 더 죽인다.**
#
# 위 killall 직후 시스템은 지음이 활성 입력기였으면 곧바로 프로세스를 다시 띄운다.
# 그 재기동이 `rm -rf` ~ `cp -R` 구간에 끼면 **옛 번들 이미지로 뜬 프로세스**가
# 살아남는다. macOS는 실행 중인 바이너리를 지워도 그 프로세스를 계속 돌리므로,
# 파일만 새것으로 갈리고 동작은 옛 버전인 상태가 된다.
#
# 이 상태에서는 디스크의 바이너리와 실제로 실행 중인 코드가 달라져 진단을 믿을 수 없다.
#
# 끝의 `open -a`로는 구제되지 않는다. 같은 번들 식별자의 앱이 이미 떠 있으면
# `open`은 새로 띄우지 않고 기존 프로세스를 앞으로 가져올 뿐이다.
killall JieumIME 2>/dev/null || true
sleep 0.5

# 빌드 사본을 LaunchServices에서 지우고 **번들 자체도 삭제한다.**
#
# 같은 번들 식별자의 앱이 두 곳(빌드 폴더와 설치 위치)에 등록돼 있으면 시스템이
# 입력기를 띄울 때 어느 쪽을 볼지 모호해진다. 빌드 사본이 뽑히면 프로세스는 뜨는데
# 입력 소스와 이어지지 않는다 — 증상은 "메뉴에서 지음이 사라지고 한글이 안 쳐진다"다.
#
# ⚠️ **등록 해제만으로는 부족하다.** 번들이 디스크에 남아 있는 한 LaunchServices가
# 나중에 다시 스캔해 등록한다. 2026-08-02 아침에 걷어낸 이중 등록이 같은 날 10시에
# 다시 등록될 수 있다. 그래서 등록 해제 뒤 빌드 번들도 지운다. 다음 설치에서는
# build-app.sh가 새 번들을 만든다.
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$LSREGISTER" -u "$BUNDLE" 2>/dev/null || true
rm -rf "$BUNDLE"

# 사전을 App Support에 연결한다.
#
# 엔진은 사전을 찾을 때 마지막 수단으로 cwd에서 위로 올라가며 repo의 data/build를
# 뒤진다. 그런데 시스템이 띄운 입력기의 cwd는 "/"라 그 경로가 성립하지 않는다 —
# 연결하지 않으면 시스템이 띄운 입력기가 사전을 찾지 못한다.
#
# 개발 중에는 symlink가 낫다 (사전을 다시 빌드하면 바로 반영된다).
# 배포판(M4)의 .pkg는 여기에 실제 파일을 복사한다.
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
DICT_SRC="$REPO_ROOT/data/build"
DICT_LINK="$HOME/Library/Application Support/Jieum/dict"
if [[ -f "$DICT_SRC/jieum-dict.json" ]]; then
  mkdir -p "$(dirname "$DICT_LINK")"
  rm -rf "$DICT_LINK"
  ln -s "$DICT_SRC" "$DICT_LINK"
  echo "[지음] 사전 연결: $DICT_LINK → $DICT_SRC"
else
  echo "[지음] 사전이 없다 ($DICT_SRC) — pnpm build:dict를 먼저 돌려라"
  echo "        (조합은 되지만 한자 제안은 동작하지 않는다)"
fi

# 등록(register)과 활성화(enable)는 다른 일이다. 등록만 하면 시스템이 알기만 할 뿐
# 입력 소스 목록에는 오르지 않는다 — 시스템 설정에서 ＋로 추가하는 그 동작이
# TISEnableInputSource이고, 여기서 대신 해 준다. 재로그인은 필요 없다.
echo "[지음] 입력 소스 등록"
"$TARGET/Contents/MacOS/JieumIME" --register || true
echo "[지음] 입력 소스 활성화"
"$TARGET/Contents/MacOS/JieumIME" --enable || true

# 메뉴 막대는 자기 캐시를 들고 있어 갱신을 놓친다. 에이전트를 다시 띄우면 반영된다.
killall TextInputMenuAgent 2>/dev/null || true
sleep 1

# 설치 전에 기억해 둔 입력기를 되살린다. enable이 활성 입력기를 지음으로 바꿔
# 버리므로, 다른 입력기를 쓰던 사람은 원래 것으로 되돌려 준다.
case "$PREV_SOURCE" in
  com.ongocompany.inputmethod.Jieum*)
    # 지음을 쓰던 중이었다. killall이 활성 입력기를 이미 다른 곳으로 밀어냈으므로
    # "그대로 둔다"로는 부족하다 — 셸을 먼저 띄우고 지음을 다시 고른다.
    # 순서가 중요하다: 셸이 없는 채 고르면 시스템이 곧 다른 입력기로 되돌린다
    # (2026-08-02 실측).
    open -a "$TARGET"
    sleep 1
    "$TARGET/Contents/MacOS/JieumIME" --select-id "$PREV_SOURCE" >/dev/null 2>&1 || true
    echo "[지음] 지음을 다시 활성으로 올렸다: $PREV_SOURCE"
    ;;
  "")
    # 알아내지 못했으면 손대지 않는다
    ;;
  *)
    NOW="$("$TARGET/Contents/MacOS/JieumIME" --current 2>/dev/null || true)"
    if [[ "$NOW" != "$PREV_SOURCE" ]]; then
      "$TARGET/Contents/MacOS/JieumIME" --select-id "$PREV_SOURCE" >/dev/null 2>&1 || true
      echo "[지음] 쓰던 입력기로 되돌렸다: $PREV_SOURCE"
    fi
    ;;
esac

# 어떤 상태로 끝났는지 보여 준다 — 셸이 떠 있는가가 곧 한글을 칠 수 있는가다.
# (2026-08-01 함정: 셸이 떴는지 확인하지 않고 넘겨서 두 번 진단이 흐려졌다)
sleep 0.5
echo "[지음] 활성 입력기: $("$TARGET/Contents/MacOS/JieumIME" --current 2>/dev/null || echo '확인 실패')"
# 시작 시각을 함께 보여 준다. 설치보다 이른 프로세스가 살아 있으면 그것은
# **옛 번들 이미지**이고, 새 코드는 한 줄도 돌지 않는다 (위 경쟁 구간 주석 참조).
SHELL_PID="$(pgrep -f 'MacOS/JieumIME' | head -1 || true)"
if [[ -n "$SHELL_PID" ]]; then
  echo "[지음] 셸 프로세스: pid $SHELL_PID, 시작 $(ps -p "$SHELL_PID" -o lstart= 2>/dev/null | sed 's/^ *//')"
else
  echo "[지음] 셸 프로세스: 없음 — 지음을 선택하는 순간 시스템이 띄운다"
fi

# 등록이 한 곳뿐인지 확인한다.
#
# 위에서 빌드 사본을 지웠어도, 다른 경로(옛 worktree, 복사본, .app을 남긴 실험)에
# 같은 번들이 있으면 이중 등록이 그대로 재현된다. 그 상태는 **당장은 멀쩡해 보이고
# 몇 분 뒤에 터지므로**(2026-08-02: 설치 4분 뒤 입력기 소실) 설치 시점에 잡아야 한다.
REGISTERED="$("$LSREGISTER" -dump 2>/dev/null | grep -c '^path:.*/Jieum\.app' || true)"
if [[ "${REGISTERED:-0}" -eq 1 ]]; then
  echo "[지음] LaunchServices 등록: 1곳 (정상)"
else
  echo "[지음] ⚠️  LaunchServices에 Jieum.app이 ${REGISTERED}곳 등록돼 있다."
  echo "        이 상태로 두면 입력 소스 목록에서 지음이 사라지고 한글이 안 쳐진다."
  "$LSREGISTER" -dump 2>/dev/null | grep '^path:.*/Jieum\.app' || true
  echo "        설치본 밖의 번들을 지우고 다시 설치하라."
fi

cat <<'EOF'

[지음] 설치 완료. 시스템 설정에서 추가하실 필요 없습니다 (이미 켜 뒀습니다).

  1. 메뉴 막대 입력 소스 메뉴에서 "지음" 선택
     (또는 터미널에서: "$HOME/Library/Input Methods/Jieum.app/Contents/MacOS/JieumIME" --select)
  2. TextEdit을 열고 한글 타이핑 — 조합 중인 글자에 밑줄이 뜨면 통과입니다

빠져나오려면:

  # 조합만 끄기 (입력 소스는 유지)
  killall JieumIME; JIEUM_DISABLE_COMPOSITION=1 open -a "$HOME/Library/Input Methods/Jieum.app"
  # 입력 소스 목록에서 내리기
  "$HOME/Library/Input Methods/Jieum.app/Contents/MacOS/JieumIME" --disable

키 이벤트 도달을 눈으로 확인하려면 (C0.1):

  killall JieumIME
  JIEUM_DEBUG_KEYS=1 "$HOME/Library/Input Methods/Jieum.app/Contents/MacOS/JieumIME"

  ↑ 이렇게 직접 띄우면 stderr로 로그가 나옵니다. 또는 Console.app에서
    subsystem이 com.ongocompany.inputmethod.Jieum 인 항목을 보세요.

상태 확인: JieumIME --list-sources

EOF
