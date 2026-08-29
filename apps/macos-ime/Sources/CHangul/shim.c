/*
 * libhangul을 Swift에서 쓰기 위한 껍데기 타깃.
 *
 * 실제 구현은 vendor의 libhangul.dylib에 있고 여기서는 헤더만 노출한다.
 * SwiftPM의 C 타깃은 소스 파일이 최소 한 개 있어야 하므로 이 빈 번역 단위를 둔다.
 *
 * 헤더(include/hangul.h)는 scripts/fetch-libhangul.sh가 복사해 넣으며 git에
 * 들어가지 않는다 — LGPL 2.1 코드를 우리 repo에 담지 않고 동적 링크로만 쓰기
 * 위해서다. 헤더가 없으면 Package.swift가 이 타깃 자체를 빼고, 입력기는
 * 조합 없이 빌드된다 (docs/07 D6의 폴백 구조).
 */

// 빈 번역 단위가 경고를 내지 않게 하는 최소한의 심볼
extern const char jieum_changul_shim;
const char jieum_changul_shim = 0;
