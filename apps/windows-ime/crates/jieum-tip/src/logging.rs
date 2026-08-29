//! 파일 진단 로그.
//!
//! 입력기는 남의 프로세스 안에서 돌아 콘솔이 없다. macOS에서 `os.Logger`가
//! `log show`에 안 잡혀 파일 진단으로 우회한 것과 같은 이유로, 처음부터 파일에 쓴다.
//!
//! ⚠️ **키 입력 내용을 절대 남기지 않는다.** 이 프로세스는 사용자가 치는 모든 것을
//! 본다. 표제어·후보·조합 중인 글자는 로그에 쓰지 않는다 (계획서 §0 로그 위생 규칙).
//! 남기는 것은 사건의 종류와 숫자뿐이다.

use std::fs::{create_dir_all, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

fn log_path() -> Option<&'static PathBuf> {
    static PATH: OnceLock<Option<PathBuf>> = OnceLock::new();
    PATH.get_or_init(|| {
        let base = std::env::var_os("LOCALAPPDATA")?;
        let dir = PathBuf::from(base).join("Jieum");
        create_dir_all(&dir).ok()?;
        Some(dir.join("tip.log"))
    })
    .as_ref()
}

/// 한 줄 기록. 실패는 조용히 무시한다 — 로그를 못 써서 입력이 막히면 안 된다.
pub fn line(msg: &str) {
    let Some(path) = log_path() else { return };
    let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let pid = std::process::id();
    let _ = writeln!(f, "[{pid}] {msg}");
}

#[macro_export]
macro_rules! log_line {
    ($($arg:tt)*) => {
        $crate::logging::line(&format!($($arg)*))
    };
}

/// 키 단위 진단. **기본값은 꺼짐.**
///
/// 조합 동작을 디버깅하려면 키마다 기록이 필요한데, 그 기록이 곧 사용자가 친 내용이다.
/// 그래서 `JIEUM_TIP_VERBOSE=1`일 때만 남긴다. 실제 사용자 환경에서는 이 변수가 없다.
pub fn verbose_enabled() -> bool {
    static ON: OnceLock<bool> = OnceLock::new();
    *ON.get_or_init(|| std::env::var_os("JIEUM_TIP_VERBOSE").is_some())
}

#[macro_export]
macro_rules! log_verbose {
    ($($arg:tt)*) => {
        if $crate::logging::verbose_enabled() {
            $crate::logging::line(&format!($($arg)*))
        }
    };
}
