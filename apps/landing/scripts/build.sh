#!/usr/bin/env bash
# 랜딩페이지에 SDK 번들과 사전을 채워 넣는다.
#
# 사전은 저장소에 커밋하지 않는다 — `data/build`가 원본이고, 여기 있는 것은 사본이다.
# 사본을 커밋하면 사전을 다시 빌드할 때마다 두 곳이 어긋난다.
#
#   ./scripts/build.sh            로컬·배포 공용 (원본 .dat)
#
# ⚠️ 사전이 Pages 상한에 붙어 있다: `jieum-dict.dat`은 24.96 MiB인데 Pages는
# **파일 하나가 25 MiB**를 넘으면 거부한다. 여유가 42 KB뿐이라 사전이 조금만
# 자라도 배포가 통째로 막힌다. 아래 상한 검사가 그것을 먼저 잡는다.
#
# gzip 사본을 `.dat` 이름으로 올리고 `_headers`로 풀게 하는 우회를 2026-08-28에
# 시도했다가 **되돌렸다.** Cloudflare가 그 헤더를 전송 계층에서 소비하고 본문은
# 압축된 채로 넘겨 사전이 통째로 깨졌다(받은 첫 바이트가 1f 8b). 실제 여유가
# 떨어지면 우회가 아니라 R2로 옮긴다 — 설계에서 설치 파일을 두기로 한 그 자리다.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
root="$(cd "$here/../.." && pwd)"
out="$here/public"
build="$root/data/build"
sdk="$root/packages/sdk/dist/jieum.iife.js"

[ -f "$sdk" ] || { echo "SDK 번들이 없다 — 먼저 'pnpm --filter @jieum/sdk build'" >&2; exit 1; }
[ -d "$build" ] || { echo "사전 빌드가 없다 — 먼저 'pnpm build:dict'" >&2; exit 1; }

mkdir -p "$out/data"
cp "$sdk" "$out/jieum.iife.js"
for f in jieum-collocation.json jieum-compound.json jieum-blocklist.json jieum-meta.json; do
  cp "$build/$f" "$out/data/$f"
done

cp "$build/jieum-dict.dat" "$out/data/jieum-dict.dat"

# Pages 상한을 넘는 파일이 있으면 배포가 통째로 거부되므로 여기서 먼저 잡는다.
limit=$((25 * 1024 * 1024))
over=0
while IFS= read -r f; do
  size=$(stat -f%z "$f" 2>/dev/null || stat -c%s "$f")
  if [ "$size" -gt "$limit" ]; then
    printf '⛔ %s — %s bytes (Pages 상한 %s 초과)\n' "${f#$out/}" "$size" "$limit" >&2
    over=1
  fi
done < <(find "$out" -type f)
[ "$over" -eq 0 ] || { echo "위 파일 때문에 Pages 배포가 거부된다." >&2; exit 1; }

du -sh "$out" | sed 's/^/합계 /'
