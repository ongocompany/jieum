#!/usr/bin/env bash
#
# 일반 사용자용 macOS 설치 파일을 만든다.
#
# 결과: 공증 프로필이 있으면 ...-notarized.dmg, 없으면 ...-signed.dmg
# DMG 안의 .pkg가 Jieum.app을 /Library/Input Methods에 설치하고 현재 로그인한
# 사용자의 입력 소스로 등록·활성화한다.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"
BUNDLE="$APP_DIR/build/Jieum.app"
WORK="$APP_DIR/build/installer"
OUT_DIR="${JIEUM_RELEASE_DIR:-$REPO_ROOT/dist}"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_DIR/Resources/Info.plist")"
ARCH="${JIEUM_MAC_ARCH:-$(uname -m)}"
APPLICATION_IDENTITY="${JIEUM_CODESIGN_IDENTITY:-Developer ID Application: jinwoo lee (9AGG9898BB)}"
INSTALLER_IDENTITY="${JIEUM_INSTALLER_IDENTITY:-Developer ID Installer: jinwoo lee (9AGG9898BB)}"
NOTARY_PROFILE="${JIEUM_NOTARY_PROFILE:-}"
if [[ -n "$NOTARY_PROFILE" ]]; then
  RELEASE_SUFFIX=notarized
else
  RELEASE_SUFFIX=signed
fi

case "$ARCH" in
  arm64)
    BUN_TARGET=bun-darwin-arm64
    MAC_REQUIREMENT='Apple Silicon Mac(M1 이상)과 macOS 14 이상'
    ;;
  x86_64)
    BUN_TARGET=bun-darwin-x64-baseline
    MAC_REQUIREMENT='Intel Mac과 macOS 14 이상'
    ;;
  *) echo "지원하지 않는 Mac 아키텍처: $ARCH" >&2; exit 1 ;;
esac
LIBHANGUL_PREFIX="$APP_DIR/vendor/libhangul-$ARCH"
ENGINE_BIN="$APP_DIR/build/engine-$ARCH/jieum-engine"

case "$WORK" in
  "$APP_DIR"/build/installer) ;;
  *) echo "안전하지 않은 작업 경로: $WORK" >&2; exit 1 ;;
esac

security find-identity -v | grep -Fq "\"$APPLICATION_IDENTITY\"" || {
  echo "Developer ID Application identity를 찾지 못했다: $APPLICATION_IDENTITY" >&2
  exit 1
}
security find-identity -v | grep -Fq "\"$INSTALLER_IDENTITY\"" || {
  echo "Developer ID Installer identity를 찾지 못했다: $INSTALLER_IDENTITY" >&2
  exit 1
}

JIEUM_MAC_ARCH="$ARCH" JIEUM_LIBHANGUL_PREFIX="$LIBHANGUL_PREFIX" \
  "$APP_DIR/scripts/fetch-libhangul.sh"
mkdir -p "$(dirname "$ENGINE_BIN")"
bun build --compile --target="$BUN_TARGET" \
  "$REPO_ROOT/packages/engine-server/src/main.ts" --outfile "$ENGINE_BIN"
JIEUM_BUILD_CONFIG=release JIEUM_MAC_ARCH="$ARCH" \
  JIEUM_LIBHANGUL_PREFIX="$LIBHANGUL_PREFIX" JIEUM_ENGINE_BIN="$ENGINE_BIN" \
  JIEUM_CODESIGN_IDENTITY="$APPLICATION_IDENTITY" \
  "$APP_DIR/scripts/build-app.sh"

required=(
  "$BUNDLE/Contents/MacOS/JieumIME"
  "$BUNDLE/Contents/Frameworks/libhangul.1.dylib"
  "$BUNDLE/Contents/Resources/jieum-engine"
  "$BUNDLE/Contents/Resources/dict/jieum-dict.dat"
  "$BUNDLE/Contents/Resources/dict/jieum-collocation.json"
)
for file in "${required[@]}"; do
  [[ -f "$file" ]] || { echo "배포 번들에 필요한 파일이 없다: $file" >&2; exit 1; }
done

rm -rf "$WORK"
mkdir -p \
  "$WORK/root/Library/Input Methods" \
  "$WORK/resources/ko.lproj" \
  "$WORK/dmg" \
  "$OUT_DIR"

ditto "$BUNDLE" "$WORK/root/Library/Input Methods/Jieum.app"
xattr -cr "$WORK/root/Library/Input Methods/Jieum.app"
cp -R "$APP_DIR/installer/resources/ko.lproj/." "$WORK/resources/ko.lproj/"
cp "$REPO_ROOT/LICENSE" "$WORK/resources/ko.lproj/license.txt"
for file in "$WORK/resources/ko.lproj"/*.html; do
  sed "s|@@MAC_REQUIREMENT@@|$MAC_REQUIREMENT|g" "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
done

COPYFILE_DISABLE=1 pkgbuild \
  --root "$WORK/root" \
  --install-location / \
  --identifier com.ongocompany.inputmethod.Jieum.installer \
  --version "$VERSION" \
  --ownership recommended \
  --scripts "$APP_DIR/installer/scripts" \
  "$WORK/Jieum-component.pkg"

sed -e "s/@@VERSION@@/$VERSION/g" -e "s/@@ARCH@@/$ARCH/g" \
  "$APP_DIR/installer/Distribution.xml" > "$WORK/Distribution.xml"

productbuild \
  --distribution "$WORK/Distribution.xml" \
  --resources "$WORK/resources" \
  --package-path "$WORK" \
  --sign "$INSTALLER_IDENTITY" \
  "$WORK/Jieum-$VERSION-macOS-$ARCH.pkg"

pkgutil --expand-full "$WORK/Jieum-$VERSION-macOS-$ARCH.pkg" "$WORK/expanded"
pkgutil --payload-files "$WORK/Jieum-component.pkg" | grep -q '^\./Library/Input Methods/Jieum.app/'

cp "$WORK/Jieum-$VERSION-macOS-$ARCH.pkg" "$WORK/dmg/지음 $VERSION 설치.pkg"
sed -e "s|@@MAC_REQUIREMENT@@|$MAC_REQUIREMENT|g" \
  "$APP_DIR/installer/dmg-readme.txt" > "$WORK/dmg/먼저 읽어 주세요.txt"

DMG="$OUT_DIR/Jieum-$VERSION-macOS-$ARCH-$RELEASE_SUFFIX.dmg"
hdiutil create \
  -volname "지음 $VERSION 설치" \
  -srcfolder "$WORK/dmg" \
  -ov \
  -format UDZO \
  "$DMG"

codesign --force --sign "$APPLICATION_IDENTITY" --timestamp "$DMG"
hdiutil verify "$DMG"
codesign --verify --deep --strict --verbose=2 "$BUNDLE"
pkgutil --check-signature "$WORK/Jieum-$VERSION-macOS-$ARCH.pkg" | \
  grep -Fq "Developer ID Installer: jinwoo lee (9AGG9898BB)"

if [[ -n "$NOTARY_PROFILE" ]]; then
  echo "[지음] Apple 공증 제출: $NOTARY_PROFILE"
  xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$DMG"
  xcrun stapler validate "$DMG"
  hdiutil verify "$DMG"
else
  echo "주의: JIEUM_NOTARY_PROFILE이 없어 공증을 건너뛰었다." >&2
fi

echo
echo "완료: $DMG"
stat -f '크기: %z bytes' "$DMG"
shasum -a 256 "$DMG"
if [[ -z "$NOTARY_PROFILE" ]]; then
  echo "주의: 설치 파일은 서명됐지만 아직 공증되지 않았다."
fi
