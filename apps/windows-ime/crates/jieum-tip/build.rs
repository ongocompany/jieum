//! libhangul 링크 설정.
//!
//! libhangul은 repo에 넣지 않는다(LGPL 2.1 — 동적 링크로 격리한다).
//! `scripts/fetch-libhangul.sh`가 빌드 머신에 만들어 두고, 그 위치를
//! `JIEUM_LIBHANGUL_DIR`로 알려 준다.

fn main() {
    let dir = std::env::var("JIEUM_LIBHANGUL_DIR").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_default();
        format!("{home}/jieum-libhangul")
    });
    println!("cargo:rustc-link-search=native={dir}/lib");
    println!("cargo:rerun-if-env-changed=JIEUM_LIBHANGUL_DIR");
}
