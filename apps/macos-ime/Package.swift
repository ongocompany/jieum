// swift-tools-version:6.0
import Foundation
import PackageDescription

/**
 지음 macOS 입력기 (셸)

 Xcode 프로젝트가 아니라 SwiftPM으로 간다. `.xcodeproj`는 손으로 읽고 고칠 수 없는
 XML이라 반복 개발에서 비용이 크고, IMK 입력기에 필요한 것(.app 번들 구조,
 Info.plist, 서명)은 전부 `scripts/build-app.sh`에서 스크립트로 조립할 수 있다.
 M4의 공증도 조립된 번들에 codesign/notarytool을 거는 것이라 달라지지 않는다.

 이 셸에는 변환 로직이 없다. 사전·랭킹·연어·사용 이력은 전부 엔진 서버 뒤에 있다
 (docs/07 §0). 여기 있는 것은 IMK 배선, 조합 접착, UI뿐이다.

 ## libhangul은 선택 의존이다
 헤더가 없으면 `CHangul` 타깃을 아예 빼고 빌드한다 — 한글 조합이 빠진 채로
 입력기가 뜬다. libhangul은 LGPL 2.1이라 repo에 담지 않고 `scripts/fetch-libhangul.sh`가
 vendor/에 내려받아 **동적 링크**로만 붙인다. 이 구조가 docs/07 D6이 미리 승인해 둔
 폴백(마찰이 생기면 TS 오토마타로 전환)의 자리이기도 하다.
 */

let packageDir = Context.packageDirectory
let hangulHeader = "\(packageDir)/Sources/CHangul/include/hangul.h"
let hasLibhangul = FileManager.default.fileExists(atPath: hangulHeader)

var targets: [Target] = []
var imeDependencies: [Target.Dependency] = []
var imeSwiftSettings: [SwiftSetting] = [.swiftLanguageMode(.v5)]
var imeLinkerSettings: [LinkerSetting] = []

if hasLibhangul {
    targets.append(
        .target(
            name: "CHangul",
            path: "Sources/CHangul",
            publicHeadersPath: "include"
        )
    )
    imeDependencies.append("CHangul")
    imeSwiftSettings.append(.define("HAS_LIBHANGUL"))
    imeLinkerSettings.append(
        .unsafeFlags([
            "-L\(packageDir)/vendor/libhangul/lib",
            "-lhangul",
            // 앱 번들 안의 Frameworks를 먼저 보고, 없으면 개발용 vendor 경로를 본다.
            // 전자는 배포된 .app이, 후자는 .build에서 바로 돌릴 때가 쓴다.
            "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
            "-Xlinker", "-rpath", "-Xlinker", "\(packageDir)/vendor/libhangul/lib",
        ])
    )
}

targets.append(
    .executableTarget(
        name: "JieumIME",
        dependencies: imeDependencies,
        path: "Sources/JieumIME",
        swiftSettings: imeSwiftSettings,
        linkerSettings: imeLinkerSettings
    )
)

let package = Package(
    name: "JieumIME",
    platforms: [.macOS(.v14)],
    targets: targets
)
