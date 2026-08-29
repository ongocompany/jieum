#!/usr/bin/env bash
#
# Jieum.app 번들 조립
#
# SwiftPM은 실행 파일만 만든다. IMK 입력기는 .app 번들이어야 시스템이 알아보므로
# 번들 구조를 여기서 조립한다. Xcode 프로젝트를 두지 않는 대가가 이 스크립트다.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
CONFIG="${JIEUM_BUILD_CONFIG:-debug}"
BUNDLE="$APP_DIR/build/Jieum.app"

echo "[지음] Swift 빌드 ($CONFIG)"
cd "$APP_DIR"
swift build -c "$CONFIG"

BIN_PATH="$(swift build -c "$CONFIG" --show-bin-path)/JieumIME"
if [[ ! -x "$BIN_PATH" ]]; then
  echo "[지음] 빌드 산출물을 찾지 못했다: $BIN_PATH" >&2
  exit 1
fi

echo "[지음] 번들 조립: $BUNDLE"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"

cp "$BIN_PATH" "$BUNDLE/Contents/MacOS/JieumIME"
cp "$APP_DIR/Resources/Info.plist" "$BUNDLE/Contents/Info.plist"
printf 'APPL????' > "$BUNDLE/Contents/PkgInfo"

# 입력 소스 목록에 보일 이름. 없으면 입력 모드가 날것 식별자
# (com.ongocompany.inputmethod.Jieum.hangul)로 표시된다.
for LPROJ in "$APP_DIR"/Resources/*.lproj; do
  [[ -d "$LPROJ" ]] || continue
  cp -R "$LPROJ" "$BUNDLE/Contents/Resources/"
done

# libhangul(LGPL 2.1)은 **동적 링크**로 붙는다. 정적으로 넣으면 우리 바이너리
# 전체에 재링크 허용 의무가 붙는다. dylib을 따로 넣어 두면 사용자가 그것만
# 교체할 수 있어 의무가 충족된다 (구름입력기의 서브모듈 격리와 같은 취지).
HANGUL_DYLIB="$APP_DIR/vendor/libhangul/lib/libhangul.1.dylib"
if [[ -f "$HANGUL_DYLIB" ]]; then
  mkdir -p "$BUNDLE/Contents/Frameworks"
  cp "$HANGUL_DYLIB" "$BUNDLE/Contents/Frameworks/"
  # 라이선스 전문을 함께 넣는다 — LGPL 배포 요건이다.
  # ⚠️ Frameworks/가 아니라 Resources/에 넣는다: codesign은 Frameworks 안의
  # 모든 항목을 서명 대상 코드로 보므로, 텍스트 파일이 있으면 서명이 통째로 실패한다
  # ("code object is not signed at all").
  if [[ -f "$APP_DIR/vendor/libhangul-src/COPYING" ]]; then
    cp "$APP_DIR/vendor/libhangul-src/COPYING" \
       "$BUNDLE/Contents/Resources/libhangul-LICENSE.txt"
  fi
  echo "[지음] libhangul을 번들에 넣었다 (동적 링크, LGPL 2.1)"
else
  echo "[지음] libhangul 없음 — 조합 없이 빌드됐다"
  echo "        (붙이려면: ./scripts/fetch-libhangul.sh 후 다시 빌드)"
fi

# 엔진 바이너리가 빌드돼 있으면 번들에 넣는다. 없으면 JIEUM_ENGINE_BIN으로
# 가리키면 되므로 실패로 보지 않는다 (개발 중에는 엔진만 따로 다시 컴파일한다).
ENGINE_BIN="$REPO_ROOT/packages/engine-server/bin/jieum-engine"
if [[ -x "$ENGINE_BIN" ]]; then
  cp "$ENGINE_BIN" "$BUNDLE/Contents/Resources/jieum-engine"
  echo "[지음] 엔진 바이너리를 번들에 넣었다 ($(du -h "$ENGINE_BIN" | cut -f1))"
else
  echo "[지음] 엔진 바이너리 없음 — JIEUM_ENGINE_BIN으로 가리켜야 제안이 동작한다"
  echo "        (만들려면: pnpm --filter @jieum/engine-server compile)"
fi

# 사전을 번들에 넣는다 — 배포판은 이것 없이는 아무것도 제안하지 못한다.
#
# 다섯 파일을 다 넣는다. 엔진의 `hasDict()`는 `jieum-dict.dat` 하나만 있어도
# 「사전 있음」으로 통과시키지만, 정작 읽을 때는 연어 규칙도 함께 읽는다.
# .dat만 넣으면 **오류 없이 연어가 빠진 채로** 돈다 (2026-08-28 확인).
DICT_SRC="$REPO_ROOT/data/build"
DICT_DST="$BUNDLE/Contents/Resources/dict"
DICT_FILES=(jieum-dict.dat jieum-meta.json jieum-compound.json jieum-blocklist.json jieum-collocation.json)
if [[ "${JIEUM_BUNDLE_DICT:-}" == "0" ]]; then
  echo "[지음] 사전을 넣지 않았다 (JIEUM_BUNDLE_DICT=0) — 개발용 번들이다"
else
  missing=()
  for f in "${DICT_FILES[@]}"; do [[ -f "$DICT_SRC/$f" ]] || missing+=("$f"); done
  if (( ${#missing[@]} )); then
    echo "[지음] ⛔ 사전이 모자란다: ${missing[*]}" >&2
    echo "        pnpm build:dict 를 먼저 돌린다. 개발용으로 사전 없이 만들려면" >&2
    echo "        JIEUM_BUNDLE_DICT=0 을 준다." >&2
    exit 1
  fi
  mkdir -p "$DICT_DST"
  for f in "${DICT_FILES[@]}"; do cp "$DICT_SRC/$f" "$DICT_DST/"; done
  echo "[지음] 사전을 번들에 넣었다 (${#DICT_FILES[@]}개)"
fi

# 임시(ad-hoc) 서명. 배포용 Developer ID 서명과 공증은 M4에서.
# 중첩된 코드(dylib)를 먼저 서명하고 바깥을 나중에 서명한다 — 순서가 반대면
# 바깥 서명이 안쪽의 서명 없음을 발견하고 실패한다.
echo "[지음] ad-hoc 서명"
if [[ -f "$BUNDLE/Contents/Frameworks/libhangul.1.dylib" ]]; then
  codesign --force --sign - --timestamp=none \
    "$BUNDLE/Contents/Frameworks/libhangul.1.dylib"
fi
codesign --force --sign - --timestamp=none "$BUNDLE"
codesign --verify --verbose=1 "$BUNDLE" 2>&1 | sed 's/^/[지음] /'

echo "[지음] 완료: $BUNDLE"
