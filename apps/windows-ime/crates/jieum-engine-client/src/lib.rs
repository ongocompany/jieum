//! 지음 엔진 클라이언트 — named pipe 위의 NDJSON.
//!
//! macOS 셸의 `EngineClient.swift`와 같은 자리다. **변환 로직은 여기 없다.** 이 크레이트가
//! 하는 일은 바이트를 주고받는 것뿐이고, 무엇이 후보인지·어떤 순서인지는 전적으로 엔진이
//! 정한다 (계획서 §0).
//!
//! ## 왜 스레드 두 개인가 — D6를 구조로 보장한다
//!
//! 계획서 D6가 "조회는 비동기"라고 정한 이유는 이 코드가 **남의 프로세스 안에서** 돌기
//! 때문이다. 키 처리 중에 파이프를 기다리면 그 순간 아래한글이나 워드가 통째로 멈추고,
//! 엔진이 죽어 있으면 영원히 멈춘다. "엔진이 죽어도 타이핑은 계속되고 제안만 사라진다"가
//! 지켜져야 한다.
//!
//! 그래서 입력 경로는 **채널에 밀어 넣기만** 한다 — 이건 어떤 경우에도 막히지 않는다.
//! 실제 파이프 읽기·쓰기는 배경 스레드가 맡는다:
//!
//! - **writer** — 채널에서 요청을 꺼내 `WriteFile`. 파이프 버퍼가 차서 막히더라도
//!   막히는 것은 이 스레드지 입력이 아니다.
//! - **reader** — `ReadFile`로 응답을 받아 파싱하고 이벤트 큐에 쌓은 뒤 `notify`를 부른다.
//!
//! 쓰기도 배경으로 넘기는 것이 요점이다. `WriteFile`이 "요청은 작으니 대개 안 막힌다"에
//! 기대면 그 '대개'가 아닌 날 남의 프로그램이 멈춘다.
//!
//! 두 스레드가 같은 핸들을 쓰므로 파이프는 **반드시 중첩(overlapped) 모드**여야 한다.
//! 그러지 않으면 두 방향이 서로를 막아 두 번째 요청부터 교착한다 — 자세한 것은
//! [`pipe`] 모듈 주석에 있다.
//!
//! ## 응답을 어떻게 돌려받는가
//!
//! 이 크레이트는 COM도 창도 모른다. 응답이 도착하면 `notify` 콜백을 부를 뿐이고, 그것을
//! `PostMessage`로 옮기는 것은 입력기 쪽 일이다. 입력기 객체는 apartment(스레드 친화)
//! 모델이라 만든 스레드에서만 만질 수 있으므로, 배경 스레드가 직접 건드리면 안 된다.

#![cfg(windows)]

mod pipe;
pub mod protocol;

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};

use serde_json::json;

use pipe::{Io, Pipe};

pub use protocol::{
    HelloReply, LookupReply, SessionOpenReply, WireCandidate, WireErrorBody, WireLookupGroup,
    PROTOCOL_VERSION,
};

/// 엔진이 파이프를 여는 기본 이름.
///
/// ⚠️ **전역 이름이라 그대로 배포하면 안 된다.** 두 사용자가 동시에 로그인하면 뒤에 온
/// 사람의 엔진이 이름을 못 잡고, 그의 입력기는 앞사람의 엔진에 붙는다 — 앞사람의 사용
/// 이력에 뒷사람이 친 것이 쌓인다. 사용자별 이름(토큰 SID 해시)은 파이프 host를 세울 때
/// 함께 간다. `docs/notes/2026-08-03-windows-tsf-survey.md` §3.
pub const DEFAULT_PIPE_NAME: &str = r"\\.\pipe\jieum-engine";

// ------------------------------------------------------------------ 공개 타입

/// 보낸 요청의 종류.
///
/// 응답 봉투에는 `op`가 없고 `id`만 있다. 그래서 무엇의 답인지는 **보낸 쪽이 기억해야**
/// 한다. 응답 필드 모양으로 추측하는 방법도 있지만, 그건 프로토콜에 필드가 하나 늘 때
/// 조용히 어긋난다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestKind {
    Hello,
    Ping,
    Lookup,
    SessionOpen,
    SessionClose,
    Commit,
    ForgetUserWord,
}

/// 엔진에서 올라온 사건. `drain`으로 가져간다.
#[derive(Debug, Clone)]
pub enum EngineEvent {
    /// 악수 성공. 프로토콜 버전이 맞는지는 **호출자가 확인한다** — 이 크레이트는 판단하지
    /// 않고 사실만 올린다.
    Hello(HelloReply),
    /// 후보 도착. 낡은 응답(이미 본 토큰 이하)은 여기까지 오지 않는다.
    Lookup(LookupReply),
    SessionOpen(String),
    /// 엔진이 오류를 돌려줬다.
    Failed {
        kind: RequestKind,
        code: String,
        message: String,
    },
    /// 파이프가 끊겼다. 타이핑은 계속되고 제안만 멈춘다.
    Disconnected,
}

#[derive(Debug)]
pub enum EngineError {
    NotConnected,
    Io(std::io::Error),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::NotConnected => write!(f, "엔진에 연결되지 않았다"),
            EngineError::Io(e) => write!(f, "파이프 오류: {e}"),
        }
    }
}

// ------------------------------------------------------------------ 내부 상태

struct Shared {
    /// 이벤트 큐. 배경 스레드가 쌓고 입력기 스레드가 비운다.
    events: Mutex<VecDeque<EngineEvent>>,
    /// 보냈지만 아직 답이 안 온 요청. 끊기면 통째로 비운다.
    pending: Mutex<HashMap<u64, RequestKind>>,
    next_id: AtomicU64,
    /// 지금까지 본 최대 조회 토큰 (latest-wins).
    ///
    /// 타이핑 중에는 조회가 응답보다 빨리 나가 순서가 뒤집힌다. 거르지 않으면 팝업이
    /// 한 글자 전 후보로 되돌아간다.
    highest_token: AtomicI64,
    connected: AtomicBool,
    /// 이벤트가 쌓였음을 알린다. 배경 스레드에서 불리므로 **여기서 COM을 만지면 안 된다.**
    notify: Box<dyn Fn() + Send + Sync>,
}

impl Shared {
    fn push(&self, event: EngineEvent) {
        if let Ok(mut q) = self.events.lock() {
            // 입력기가 이벤트를 안 가져가는 상황(창 메시지가 안 돌아가는 앱)에서도
            // 큐가 무한정 자라지 않게 한다. 후보는 최신만 의미가 있으므로 오래된
            // 것부터 버리는 쪽이 맞다.
            const MAX: usize = 64;
            while q.len() >= MAX {
                q.pop_front();
            }
            q.push_back(event);
        }
        (self.notify)();
    }
}

/// 엔진과의 연결 하나.
///
/// `Drop`이 파이프를 끊고 배경 스레드를 정리한다.
pub struct EngineClient {
    shared: Arc<Shared>,
    tx: Sender<Vec<u8>>,
    /// 파이프. **이 필드를 없애면 안 된다** — 클라이언트가 살아 있는 동안 핸들이 유효함을
    /// 보장하는 것이 이 참조다. 배경 스레드가 먼저 끝나 핸들이 닫히면 윈도우는 그 번호를
    /// 다른 파일에 재사용하고, `Drop`의 취소 요청이 엉뚱한 대상에 걸린다.
    pipe: Arc<Pipe>,
}

impl EngineClient {
    /// 파이프에 붙고 배경 스레드를 띄운다.
    ///
    /// `notify`는 **배경 스레드에서** 불린다. 입력기는 여기서 `PostMessage` 하나만 하고
    /// 돌아와야 한다 — COM 객체를 만지면 apartment 규칙 위반이다.
    pub fn connect<F>(pipe_name: &str, notify: F) -> Result<Self, EngineError>
    where
        F: Fn() + Send + Sync + 'static,
    {
        let pipe = Arc::new(Pipe::open(pipe_name).map_err(EngineError::Io)?);

        let shared = Arc::new(Shared {
            events: Mutex::new(VecDeque::new()),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            highest_token: AtomicI64::new(0),
            connected: AtomicBool::new(true),
            notify: Box::new(notify),
        });

        let (tx, rx) = channel::<Vec<u8>>();

        // writer — 채널이 닫히면 스스로 끝난다.
        //
        // 자기 몫의 중첩 입출력 문맥을 갖는다. reader와 이벤트를 공유하면 한쪽의 완료
        // 신호를 다른 쪽이 가로챈다.
        {
            let pipe = Arc::clone(&pipe);
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("jieum-engine-writer".into())
                .spawn(move || {
                    let Ok(io) = Io::new() else {
                        shared.connected.store(false, Ordering::SeqCst);
                        return;
                    };
                    for msg in rx {
                        if io.write_all(&pipe, &msg).is_err() {
                            shared.connected.store(false, Ordering::SeqCst);
                            break;
                        }
                    }
                })
                .map_err(EngineError::Io)?;
        }

        // reader — 파이프가 끊기거나 취소가 걸리면 끝난다.
        {
            let pipe = Arc::clone(&pipe);
            let shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("jieum-engine-reader".into())
                .spawn(move || read_loop(pipe, shared))
                .map_err(EngineError::Io)?;
        }

        Ok(Self { shared, tx, pipe })
    }

    pub fn is_connected(&self) -> bool {
        self.shared.connected.load(Ordering::SeqCst)
    }

    /// 쌓인 사건을 전부 가져간다. 입력기 스레드에서만 부른다.
    pub fn drain(&self) -> Vec<EngineEvent> {
        match self.shared.events.lock() {
            Ok(mut q) => q.drain(..).collect(),
            Err(_) => Vec::new(),
        }
    }

    /// 최초 악수. 버전·사전 지문을 확인한다.
    pub fn hello(&self, client_version: &str) -> Result<(), EngineError> {
        self.send(
            RequestKind::Hello,
            "hello",
            json!({ "clientVersion": client_version }),
        )
    }

    pub fn ping(&self) -> Result<(), EngineError> {
        self.send(RequestKind::Ping, "ping", json!({}))
    }

    /// 조합 중인 버퍼에 대한 후보 조회.
    ///
    /// 응답은 `EngineEvent::Lookup`으로 올라오고, 낡은 것은 걸러진 뒤다.
    pub fn lookup(
        &self,
        buffer: &str,
        preceding_text: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<(), EngineError> {
        let mut payload = json!({ "buffer": buffer });
        if let Some(text) = preceding_text {
            payload["precedingText"] = json!(text);
        }
        if let Some(id) = session_id {
            payload["sessionId"] = json!(id);
        }
        self.send(RequestKind::Lookup, "lookup", payload)
    }

    /// 사용자가 손으로 조합을 잊는다.
    ///
    /// 잘못 배운 것이 계속 첫 줄에 오면 기능이 없느니만 못하다. 자동 학습만으로는 나쁜
    /// 항목을 영영 막을 수 없으므로 사람의 거부권이 있어야 한다.
    pub fn forget_user_word(&self, reading: &str, hanja: &str) -> Result<(), EngineError> {
        self.send(
            RequestKind::ForgetUserWord,
            "forgetUserWord",
            json!({ "reading": reading, "hanja": hanja }),
        )
    }

    pub fn session_open(&self) -> Result<(), EngineError> {
        self.send(RequestKind::SessionOpen, "sessionOpen", json!({}))
    }

    pub fn session_close(&self, session_id: &str) -> Result<(), EngineError> {
        self.send(
            RequestKind::SessionClose,
            "sessionClose",
            json!({ "sessionId": session_id }),
        )
    }

    /// 사용자가 후보를 확정했다. MRU에 기록된다.
    ///
    /// `context_key`는 **조회 응답의 그 그룹에서 받은 값을 그대로** 돌려보낸다. 확정
    /// 시점에 앞 문맥을 다시 읽으면 조합 때와 다른 칸에 기록되고, 방금 고른 것이 다음
    /// 조회에서 사라진다.
    pub fn commit(
        &self,
        headword: &str,
        hanja: &str,
        context_key: Option<&str>,
        session_id: Option<&str>,
    ) -> Result<(), EngineError> {
        let mut payload = json!({ "headword": headword, "hanja": hanja });
        if let Some(key) = context_key {
            payload["contextKey"] = json!(key);
        }
        if let Some(id) = session_id {
            payload["sessionId"] = json!(id);
        }
        self.send(RequestKind::Commit, "commit", payload)
    }

    fn send(
        &self,
        kind: RequestKind,
        op: &str,
        mut payload: serde_json::Value,
    ) -> Result<(), EngineError> {
        if !self.is_connected() {
            return Err(EngineError::NotConnected);
        }

        let id = self.shared.next_id.fetch_add(1, Ordering::SeqCst);
        payload["v"] = json!(PROTOCOL_VERSION);
        payload["id"] = json!(id);
        payload["op"] = json!(op);

        let Ok(mut line) = serde_json::to_vec(&payload) else {
            return Err(EngineError::NotConnected);
        };
        line.push(b'\n');

        if let Ok(mut pending) = self.shared.pending.lock() {
            pending.insert(id, kind);
        }

        // 채널 전송은 막히지 않는다 — 이것이 입력 경로가 절대 멈추지 않는 근거다.
        self.tx.send(line).map_err(|_| {
            if let Ok(mut pending) = self.shared.pending.lock() {
                pending.remove(&id);
            }
            EngineError::NotConnected
        })
    }
}

impl Drop for EngineClient {
    fn drop(&mut self) {
        self.shared.connected.store(false, Ordering::SeqCst);

        // reader가 `ReadFile`에서 자고 있다. 핸들을 닫는 것만으로는 깨지 않으므로
        // 진행 중인 입출력을 명시적으로 취소한다.
        self.pipe.cancel_all();

        // 핸들 자체는 여기서 닫지 않는다. 배경 스레드가 `Arc<Pipe>`를 쥐고 있고,
        // 마지막 참조가 사라질 때 닫힌다. 여기서 손으로 닫으면 아직 `ReadFile` 안에
        // 있는 스레드가 이미 닫힌 핸들을 보게 된다.
    }
}

// ------------------------------------------------------------------ 배경 스레드

fn read_loop(pipe: Arc<Pipe>, shared: Arc<Shared>) {
    let Ok(io) = Io::new() else {
        shared.connected.store(false, Ordering::SeqCst);
        shared.push(EngineEvent::Disconnected);
        return;
    };
    let mut buf = [0u8; 64 * 1024];
    // ⚠️ **바이트로 모으고 줄 단위로만 UTF-8 해석한다.** 파이프의 chunk 경계는 바이트
    // 단위라 한글 3바이트 중간을 자를 수 있고, 그 조각을 단독으로 디코딩하면 U+FFFD로
    // 바뀌어 영영 복구되지 않는다. 주고받는 것이 대부분 한글이라 가정이 아니라 확실히
    // 일어나는 일이다.
    let mut inbox: Vec<u8> = Vec::new();

    loop {
        let n = match io.read(&pipe, &mut buf) {
            Ok(0) => break,  // 엔진이 닫았거나 취소로 깨어났다
            Ok(n) => n,
            Err(_) => break,
        };
        inbox.extend_from_slice(&buf[..n]);

        while let Some(pos) = inbox.iter().position(|&b| b == b'\n') {
            let mut line: Vec<u8> = inbox.drain(..=pos).collect();
            line.pop(); // 개행
            if line.last() == Some(&b'\r') {
                line.pop(); // \r\n으로 오는 구현도 받아준다
            }
            if line.is_empty() {
                continue;
            }
            handle_line(&line, &shared);
        }

        // 개행 없는 쓰레기 스트림이 메모리를 무한정 먹는 것을 막는다.
        const MAX_LINE: usize = 4 * 1024 * 1024;
        if inbox.len() > MAX_LINE {
            inbox.clear();
        }
    }

    shared.connected.store(false, Ordering::SeqCst);
    if let Ok(mut pending) = shared.pending.lock() {
        pending.clear();
    }
    shared.highest_token.store(0, Ordering::SeqCst);
    shared.push(EngineEvent::Disconnected);
}

fn handle_line(line: &[u8], shared: &Arc<Shared>) {
    let Ok(envelope) = serde_json::from_slice::<protocol::ReplyEnvelope>(line) else {
        // 응답에 id조차 없으면 누구에게 돌려줄지 알 수 없다.
        return;
    };

    let kind = shared
        .pending
        .lock()
        .ok()
        .and_then(|mut p| p.remove(&envelope.id));
    let Some(kind) = kind else { return };

    if !envelope.ok {
        let (code, message) = envelope
            .error
            .map(|e| (e.code, e.message))
            .unwrap_or_else(|| ("unknown".into(), String::new()));
        shared.push(EngineEvent::Failed {
            kind,
            code,
            message,
        });
        return;
    }

    match kind {
        RequestKind::Hello => {
            if let Ok(reply) = serde_json::from_slice::<HelloReply>(line) {
                shared.push(EngineEvent::Hello(reply));
            }
        }
        RequestKind::Lookup => {
            let Ok(reply) = serde_json::from_slice::<LookupReply>(line) else {
                // 해석 실패를 조용히 삼키지 않는다. macOS에서 `level`이 소수로 오는 것을
                // `Int`로 받아 응답 전체가 사라진 적이 있고, 증상은 "제안이 안 뜬다"뿐이라
                // 원인에 닿는 데 오래 걸렸다.
                shared.push(EngineEvent::Failed {
                    kind,
                    code: "decode".into(),
                    message: "조회 응답 해석 실패".into(),
                });
                return;
            };
            // latest-wins. 이미 본 것보다 낡았으면 여기서 버린다.
            let highest = shared.highest_token.load(Ordering::SeqCst);
            if reply.token <= highest {
                return;
            }
            shared.highest_token.store(reply.token, Ordering::SeqCst);
            shared.push(EngineEvent::Lookup(reply));
        }
        RequestKind::SessionOpen => {
            if let Ok(reply) = serde_json::from_slice::<SessionOpenReply>(line) {
                shared.push(EngineEvent::SessionOpen(reply.session_id));
            }
        }
        // 확정·세션 종료·생존 확인은 성공 여부만 의미가 있다. 화면에 반영할 것이 없다.
        // 응답에서 얻을 것이 없는 것들. 잊기는 성공 여부가 화면(후보가 사라짐)으로
        // 이미 보이므로 따로 사건을 올리지 않는다.
        RequestKind::Ping
        | RequestKind::SessionClose
        | RequestKind::Commit
        | RequestKind::ForgetUserWord => {}
    }
}

