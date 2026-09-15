//! Windows virtual-key codes to the ASCII keys expected by libhangul.

const VK_A: u16 = 0x41;
const VK_Z: u16 = 0x5A;

/// Modifier key presses pass through without ending the current Hangul composition.
pub(crate) fn is_modifier_key(vk: u16) -> bool {
    matches!(
        vk,
        0x10 | 0x11 | 0x12 // Shift / Ctrl / Alt
            | 0xA0 | 0xA1 // left / right Shift
            | 0xA2 | 0xA3 // left / right Ctrl
            | 0xA4 | 0xA5 // left / right Alt
    )
}

/// Convert an alphabetic Windows virtual key into a libhangul keyboard key.
pub(crate) fn hangul_ascii(vk: u16, shifted: bool) -> Option<u8> {
    if !(VK_A..=VK_Z).contains(&vk) {
        return None;
    }

    let base = if shifted { b'A' } else { b'a' };
    Some(base + (vk - VK_A) as u8)
}
