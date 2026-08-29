#!/usr/bin/env bash
#
# libhangul 내려받아 동적 라이브러리로 빌드
#
# ## 왜 서브모듈이 아니라 스크립트인가
# libhangul은 LGPL 2.1이다. **동적 링크**로 붙여야 우리 코드에 라이선스가 전파되지
# 않는다 (사용자가 libhangul만 교체할 수 있어야 한다는 것이 LGPL의 요구다).
# 구름입력기가 서브모듈로 격리한 것과 같은 이유이고, 지음은 산출물(.dylib)만
# 번들에 넣는 방식으로 같은 결과를 얻는다.
#
# 산출물은 vendor/ 아래에 생기며 git에 들어가지 않는다.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR="$APP_DIR/vendor"
SRC="$VENDOR/libhangul-src"
PREFIX="$VENDOR/libhangul"
# 재현 가능하게 고정한다. 올릴 때는 손으로 올리고 두벌식 조합을 다시 확인한다.
REF="${JIEUM_LIBHANGUL_REF:-main}"

command -v cmake >/dev/null || { echo "[지음] cmake가 필요하다: brew install cmake" >&2; exit 1; }

mkdir -p "$VENDOR"

if [[ ! -d "$SRC/.git" ]]; then
  echo "[지음] libhangul 내려받는 중 ($REF)"
  git clone --depth 1 --branch "$REF" https://github.com/libhangul/libhangul.git "$SRC"
else
  echo "[지음] 이미 받아 둔 소스를 쓴다: $SRC"
fi

echo "[지음] 빌드 (동적 라이브러리)"
cmake -S "$SRC" -B "$SRC/build" \
  -DBUILD_SHARED_LIBS=ON \
  -DBUILD_TESTING=OFF \
  -DENABLE_UNIT_TEST=OFF \
  -DENABLE_TOOLS=OFF \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=14.0 >/dev/null
cmake --build "$SRC/build" -j"$(sysctl -n hw.ncpu)" >/dev/null

DYLIB="$(find "$SRC/build" -name 'libhangul.*.dylib' -type f | head -1)"
[[ -n "$DYLIB" ]] || { echo "[지음] dylib을 찾지 못했다" >&2; exit 1; }

echo "[지음] 설치: $PREFIX"
mkdir -p "$PREFIX/lib" "$PREFIX/include" "$APP_DIR/Sources/CHangul/include"
cp "$DYLIB" "$PREFIX/lib/libhangul.1.dylib"
ln -sf libhangul.1.dylib "$PREFIX/lib/libhangul.dylib"
cp "$SRC/hangul/hangul.h" "$PREFIX/include/"
# SwiftPM의 C 타깃이 헤더를 여기서 찾는다. Package.swift는 이 파일의 존재로
# libhangul 사용 여부를 판단하므로, 이 복사가 곧 기능 켜기 스위치다.
cp "$SRC/hangul/hangul.h" "$APP_DIR/Sources/CHangul/include/"

# 앱 번들 안(Contents/Frameworks)에서 찾을 수 있게 설치 이름을 @rpath로 바꾼다.
# 이걸 안 하면 빌드 기계의 절대 경로가 박혀 다른 기계에서 못 뜬다.
install_name_tool -id "@rpath/libhangul.1.dylib" "$PREFIX/lib/libhangul.1.dylib"
codesign --force --sign - "$PREFIX/lib/libhangul.1.dylib" >/dev/null 2>&1 || true

echo "[지음] 완료"
echo "  헤더 : $PREFIX/include/hangul.h"
echo "  라이브러리: $PREFIX/lib/libhangul.1.dylib"
echo "  라이선스: LGPL 2.1 — $SRC/COPYING (배포 시 함께 넣어야 한다)"
