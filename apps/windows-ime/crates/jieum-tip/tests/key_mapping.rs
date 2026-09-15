#[path = "../src/key_mapping.rs"]
mod key_mapping;

use key_mapping::{hangul_ascii, is_modifier_key};

#[test]
fn shift_key_events_do_not_end_the_current_composition() {
    for vk in [0x10, 0x11, 0x12, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5] {
        assert!(is_modifier_key(vk), "modifier virtual key 0x{vk:02X}");
    }
    assert!(!is_modifier_key(0x52));
}

#[test]
fn shift_preserves_the_uppercase_keys_libhangul_uses_for_double_jamo() {
    for (vk, lower, shifted) in [
        (0x52, b'r', b'R'), // ㄱ / ㄲ
        (0x45, b'e', b'E'), // ㄷ / ㄸ
        (0x51, b'q', b'Q'), // ㅂ / ㅃ
        (0x54, b't', b'T'), // ㅅ / ㅆ
        (0x57, b'w', b'W'), // ㅈ / ㅉ
        (0x4F, b'o', b'O'), // ㅐ / ㅒ
        (0x50, b'p', b'P'), // ㅔ / ㅖ
    ] {
        assert_eq!(hangul_ascii(vk, false), Some(lower));
        assert_eq!(hangul_ascii(vk, true), Some(shifted));
    }
}

#[test]
fn non_letter_virtual_keys_are_not_hangul_input() {
    assert_eq!(hangul_ascii(0x40, false), None);
    assert_eq!(hangul_ascii(0x5B, true), None);
}
