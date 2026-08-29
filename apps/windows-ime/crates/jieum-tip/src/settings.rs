//! 사용자 설정 — 지금은 **앱별 후보 창 자리** 하나뿐.
//!
//! `%LOCALAPPDATA%\Jieum\settings.json`. macOS 셸의 `Settings.swift`와 같은 항목을 같은
//! 이름(`placements`)으로 담는다. 파일 자체를 두 플랫폼이 나눠 쓰지는 않지만, 이름이
//! 같으면 한쪽을 고칠 때 다른 쪽을 찾을 수 있다.
//!
//! ## 후보 창 위치를 앱별로 저장하는 이유
//!
//! 검색창은 위(앱의 자동완성이 아래에 뜨므로), 채팅·편집기는 아래(윗줄이 방금 쓴 글이므로)가
//! 맞다. 하지만 호스트가 제공하는 정보만으로 둘을 안정적으로 구분할 수 없다. 사용자가
//! `Shift+↑/↓`로 정한 위치를 앱별로 기억한다.
//!
//! ## 프로세스마다 따로 돈다
//!
//! 입력기 DLL은 사용자가 글을 쓰는 앱마다 적재되므로 이 모듈도 앱마다 하나씩 산다.
//! 그런데 **각 프로세스는 자기 앱의 항목만 쓴다** — 메모장 안의 지음이 워드의 자리를
//! 바꿀 일이 없다. 그래서 쓸 때 파일을 다시 읽어 병합하면 서로 덮어쓰지 않는다.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use crate::log_verbose;

const FILE_NAME: &str = "settings.json";
const KEY_PLACEMENTS: &str = "placements";
/// macOS 셸(`Settings.swift`)과 **같은 이름**을 쓴다. 두 기계에서 같은 뜻이어야 한다.
const KEY_SUGGESTIONS: &str = "suggestionsEnabled";

fn settings_path() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let dir = PathBuf::from(base).join("Jieum");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(FILE_NAME))
}

/// 파일에서 읽은 앱별 자리. 첫 조회 때 한 번 읽는다.
fn cache() -> &'static Mutex<HashMap<String, bool>> {
    static CACHE: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(load()))
}

fn load() -> HashMap<String, bool> {
    let Some(path) = settings_path() else {
        return HashMap::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        // 아직 없는 것이 정상이다 — 사용자가 한 번도 자리를 바꾸지 않았다.
        return HashMap::new();
    };
    parse_placements(&text)
}

/// `placements` 부분만 꺼낸다. 다른 항목(나중에 늘 것)은 건드리지 않는다.
fn parse_placements(text: &str) -> HashMap<String, bool> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return HashMap::new();
    };
    let Some(map) = value.get(KEY_PLACEMENTS).and_then(|v| v.as_object()) else {
        return HashMap::new();
    };
    map.iter()
        .filter_map(|(k, v)| v.as_bool().map(|b| (k.clone(), b)))
        .collect()
}

/// 한자 후보를 보여 주는가. 첫 조회 때 한 번 읽고 그 뒤로는 메모리에서 본다.
fn suggestions_cell() -> &'static Mutex<bool> {
    static CELL: OnceLock<Mutex<bool>> = OnceLock::new();
    CELL.get_or_init(|| Mutex::new(load_suggestions()))
}

fn load_suggestions() -> bool {
    let Some(path) = settings_path() else { return true };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return true;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return true;
    };
    value
        .get(KEY_SUGGESTIONS)
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

/// 한자 후보를 보여 주는가.
///
/// 끄면 후보 창이 안 뜰 뿐 아니라 **엔진 조회 자체를 건너뛴다.** 한글만 치는 동안
/// 키마다 나가던 소켓 왕복이 사라진다.
///
/// 숫자가 단어에 붙는 입력(`사당3동`)에서 앞 한글이 한자로 확정돼 버리는 것이 실사용에서
/// 숫자가 단어에 붙는 입력에서는 앞 한글이 후보로 잡힐 수 있어, 한자를 안 쓰는 동안 꺼 두는
/// 것이 근본 해법이다. macOS는 왼쪽 ⌘+Shift, 윈도우는 **한자 키**로 오간다.
pub fn suggestions_enabled() -> bool {
    suggestions_cell().lock().map(|v| *v).unwrap_or(true)
}

/// 한자 후보를 켜고 끈다. 바뀐 값을 돌려준다.
pub fn toggle_suggestions() -> bool {
    let next = {
        let Ok(mut cell) = suggestions_cell().lock() else {
            return true;
        };
        *cell = !*cell;
        *cell
    };
    save_suggestions(next);
    next
}

/// 이 앱에서 후보 창을 커서 위에 두는가. 기본값은 **아래**다 — 글 쓰는 앱이 다수이고,
/// 위로 올리면 방금 쓴 윗줄이 가려진다.
pub fn prefers_above(app: &str) -> bool {
    cache()
        .lock()
        .map(|c| c.get(app).copied().unwrap_or(false))
        .unwrap_or(false)
}

/// 이 앱의 자리를 정하고 파일에 남긴다.
///
/// 값이 그대로면 아무것도 하지 않는다 — 같은 키를 누를 때마다 디스크를 건드릴 이유가 없다.
pub fn set_prefers_above(app: &str, above: bool) {
    {
        let Ok(mut cached) = cache().lock() else { return };
        if cached.get(app).copied().unwrap_or(false) == above {
            return;
        }
        cached.insert(app.to_string(), above);
    }
    save(app, above);
}

/// 후보 켬/끔을 파일에 남긴다. `save`와 같은 이유로 다시 읽어 병합한다.
fn save_suggestions(enabled: bool) {
    let Some(path) = settings_path() else { return };

    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));

    let Some(object) = root.as_object_mut() else {
        return;
    };
    object.insert(
        KEY_SUGGESTIONS.to_string(),
        serde_json::Value::Bool(enabled),
    );

    let Ok(text) = serde_json::to_string_pretty(&root) else {
        return;
    };
    write_atomically(&path, &text);
}

/// 다른 항목을 지우지 않도록 **파일을 다시 읽어 병합한다.**
///
/// 다른 앱 안의 지음이 그 사이에 자기 자리를 적었을 수 있고, 우리가 가진 사본은 그것을
/// 모른다. 통째로 덮어쓰면 남의 설정이 사라진다.
fn save(app: &str, above: bool) {
    let Some(path) = settings_path() else { return };

    let mut root = std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .filter(|v| v.is_object())
        .unwrap_or_else(|| serde_json::json!({}));

    let placements = root
        .as_object_mut()
        .and_then(|o| {
            o.entry(KEY_PLACEMENTS)
                .or_insert_with(|| serde_json::json!({}))
                .as_object_mut()
        })
        .map(|p| {
            p.insert(app.to_string(), serde_json::Value::Bool(above));
        });
    if placements.is_none() {
        return;
    }

    let Ok(text) = serde_json::to_string_pretty(&root) else {
        return;
    };

    write_atomically(&path, &text);
}

/// 임시 파일에 쓰고 갈아 끼운다.
///
/// 그냥 덮어쓰면 쓰는 도중에 프로세스가 죽었을 때 반쪽 JSON이 남고, 다음 기동에서
/// 설정이 통째로 초기화된다.
fn write_atomically(path: &std::path::Path, text: &str) {
    let temp = path.with_extension("json.tmp");
    if std::fs::write(&temp, text).is_err() {
        return;
    }
    if let Err(e) = std::fs::rename(&temp, path) {
        log_verbose!("설정 저장 실패: {e}");
        let _ = std::fs::remove_file(&temp);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 없는_항목은_아래로_둔다() {
        assert!(parse_placements("{}").is_empty());
        assert!(parse_placements("쓰레기").is_empty());
    }

    #[test]
    fn 앱별_자리를_읽는다() {
        let map = parse_placements(r#"{"placements":{"notepad.exe":true,"WINWORD.EXE":false}}"#);
        assert_eq!(map.get("notepad.exe"), Some(&true));
        assert_eq!(map.get("WINWORD.EXE"), Some(&false));
    }

    #[test]
    fn 다른_항목이_섞여_있어도_읽는다() {
        let map = parse_placements(r#"{"suggestionsEnabled":true,"placements":{"Hwp.exe":true}}"#);
        assert_eq!(map.get("Hwp.exe"), Some(&true));
    }
}
