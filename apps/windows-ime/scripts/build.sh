#!/usr/bin/env bash
# TIP DLL을 빌드한다. **64비트와 32비트 둘 다.**
#
# 빌드는 x64 리눅스에서 MinGW로 크로스 컴파일한다. 윈도우 VM 안에서 빌드하지 않는
# 이유는 반복 속도다 — 리눅스 호스트가 VM보다 코어가 훨씬 많다. windows-chewing-tsf도
# MinGW 크로스 빌드를 공식 지원하므로 검증된 경로다.
#
# ## 왜 32비트도 만드는가 (2026-08-07)
#
# **아래한글은 32비트 프로그램이다** (`C:\Program Files (x86)\Hnc\Office 2024\...`).
# 32비트 프로세스는 64비트 DLL을 적재할 수 없다 — 시도해서 실패하는 것이 아니라
# 애초에 후보에서 빠진다. 그래서 64비트만 있던 동안 아래한글 안에는 지음이 **존재조차
# 하지 않았고**, 진단 로그에 한 줄도 남지 않았다. 한글이 그대로 쳐진 것은 윈도우가
# MS 한글 입력기로 넘겼기 때문이고, 그래서 "한글은 되는데 후보만 안 뜬다"로 보였다.
#
# 남의 프로세스 안에 얹히는 프로그램은 **상대의 비트수를 고를 수 없다.** 윈도우
# 입력기가 32·64비트를 둘 다 내놓는 것은 예외가 아니라 규격이다.
#
# 사용: build.sh [--release] [--host] [--arch 64|32|both]
#   --host  원격 빌드 호스트 대신 현재 머신에서 빌드 (그 호스트 위에서 돌릴 때)
#   --arch  기본값 both
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJ="$(dirname "$HERE")"
# 원격 VM으로 밀어 넣는 구성. 개발 기계에만 있고 공개 배포본에는 없다 —
# 없으면 로컬 빌드(--host)만 가능하다.
if [[ -f "$HERE/vm-env.sh" ]]; then
  source "$HERE/vm-env.sh"
else
  VM_ENV_MISSING=1
fi

if [[ "${VM_ENV_MISSING:-0}" == 1 ]]; then
  # 원격 구성이 없으면 로컬 빌드로 고정한다. 조용히 원격을 시도하다 실패하는 것보다
  # 여기서 정하는 편이 낫다.
  FORCE_LOCAL=1
fi

PROFILE=debug
CARGO_FLAGS=()
LOCAL=0
ARCH=both
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release) PROFILE=release; CARGO_FLAGS+=(--release) ;;
    --host)    LOCAL=1 ;;
    --arch)    ARCH="${2:-}"; shift ;;
    *) echo "모르는 인자: $1" >&2; exit 2 ;;
  esac
  shift
done
if [[ "${FORCE_LOCAL:-0}" == 1 ]]; then LOCAL=1; fi

case "$ARCH" in
  64|32|both) ;;
  *) echo "모르는 --arch: $ARCH (64 | 32 | both)" >&2; exit 2 ;;
esac

REMOTE_DIR='jieum-windows-ime'

# 비트수마다: rust 트리플 · libhangul 설치 위치 · 산출물을 받을 곳.
#
# 32비트 산출물이 `build/x86/`으로 따로 가는 것이 중요하다. 입력기 DLL은 옆에 있는
# `libhangul.dll`과 후보 창 실행 파일을 **자기 모듈 경로 기준으로** 찾으므로
# (`hangul.rs`의 `module_dir`), 폴더만 갈라 두면 코드는 한 줄도 안 고쳐도 된다.
# 같은 폴더에 두면 32비트 DLL이 64비트 libhangul을 집어 조합이 통째로 죽는다.
target_of()  { [[ "$1" == 64 ]] && echo x86_64-pc-windows-gnu || echo i686-pc-windows-gnu; }
hangul_of()  { [[ "$1" == 64 ]] && echo jieum-libhangul     || echo jieum-libhangul32; }
outdir_of()  { [[ "$1" == 64 ]] && echo "$PROJ/build"       || echo "$PROJ/build/x86"; }

arches=()
[[ "$ARCH" == both || "$ARCH" == 64 ]] && arches+=(64)
[[ "$ARCH" == both || "$ARCH" == 32 ]] && arches+=(32)

if [[ $LOCAL -eq 1 ]]; then
  cd "$PROJ"
  for a in "${arches[@]}"; do
    t="$(target_of "$a")"
    JIEUM_LIBHANGUL_DIR="$HOME/$(hangul_of "$a")" \
      cargo build --target "$t" "${CARGO_FLAGS[@]}"
    echo "산출물(${a}비트): $PROJ/target/$t/$PROFILE/jieum_tip.dll"
  done
  exit 0
fi

echo "→ 소스 동기화 ($BUILD_HOST)"
rsync -az --delete \
  --exclude target/ \
  "$PROJ/" "$BUILD_HOST:jieum-windows-ime/"

for a in "${arches[@]}"; do
  t="$(target_of "$a")"
  h="$(hangul_of "$a")"
  out="$(outdir_of "$a")"

  echo "→ 빌드 (${a}비트 · $t · $PROFILE)"
  ssh "$BUILD_HOST" "cd \$HOME/$REMOTE_DIR && JIEUM_LIBHANGUL_DIR=\$HOME/$h \
    \$HOME/.cargo/bin/cargo build --target $t ${CARGO_FLAGS[*]-}"

  echo "→ 산출물 회수 (${a}비트)"
  mkdir -p "$out"
  for f in jieum_tip.dll jieum-tip-harness.exe jieum-tip-host.exe; do
    scp -q "$BUILD_HOST:$REMOTE_DIR/target/$t/$PROFILE/$f" "$out/$f"
  done
  # libhangul은 우리가 빌드한 것이 아니라 조달한 것이라 target/ 밖에 있다.
  scp -q "$BUILD_HOST:$h/lib/libhangul.dll" "$out/libhangul.dll" 2>/dev/null \
    || echo "  (libhangul.dll 없음 — fetch-libhangul.sh를 먼저 돌릴 것)"
done

ls -lh "$PROJ/build/" "$PROJ/build/x86/" 2>/dev/null
