//! 지음 TIP이 쓰는 고유 식별자.
//!
//! 이 값들은 **바꾸면 안 된다.** 레지스트리 등록·입력 소스 목록·사용자 설정이 전부
//! 이 식별자로 묶여 있어서, 바꾸면 기존 설치가 유령으로 남는다. macOS 번들 식별자를
//! 첫 공증 전까지만 조정 가능하다고 못박아 둔 것과 같은 이유다.
//!
//! 발급: 2026-08-03, `uuidgen`.

use windows_core::GUID;

/// COM 클래스 식별자. `HKCR\CLSID\{...}\InprocServer32`에 등록된다.
pub const CLSID_JIEUM_TIP: GUID = GUID::from_u128(0x7bae2d1e_e156_4329_b243_f9f7224deda2);

/// 언어 프로파일 식별자. 한 TIP이 여러 프로파일(자판)을 가질 수 있어 CLSID와 별개다.
pub const GUID_JIEUM_PROFILE: GUID = GUID::from_u128(0x9312b5d2_7323_4f3e_987b_23ed785a2952);

/// 조합 중인 글자의 표시 속성(밑줄 등). TSF가 앱에 "이건 아직 확정 전"임을 알리는 통로다.
pub const GUID_JIEUM_DISPLAY_ATTR_INPUT: GUID =
    GUID::from_u128(0xcc48b6b2_67d1_4941_8892_a26ebea6fa55);

/// 예약키(preserved key) 등록용. 아직 쓰지 않는다 — 한/영 전환은 시스템 입력 소스
/// 전환에 맡긴다는 결정(2026-08-02)이 윈도우에도 그대로 간다.
#[allow(dead_code)]
pub const GUID_JIEUM_PRESERVED_KEY: GUID =
    GUID::from_u128(0x85204d7c_faf6_471d_9c9f_9e785f6340d9);

/// 한국어 (ko-KR). 프로파일을 등록할 언어.
pub const LANGID_KO_KR: u16 = 0x0412;

/// 입력 소스 목록에 보이는 이름. 표시 문자열이므로 한글을 쓴다
/// (코드 식별자·번들 이름에는 쓰지 않는다는 규칙의 반대편).
pub const PROFILE_DESCRIPTION: &str = "지음";
