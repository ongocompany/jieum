//! 입력기 → 후보 창으로 명령을 넘기는 통로의 **형식**.
//!
//! 공유 메모리 한 덩어리를 슬롯 여러 개로 나눠 쓴다. 여는 것·알리는 것은 윈도우 API라
//! 각 crate에 있고, 여기에는 **바이트를 어디에 어떻게 놓는가**만 있다. 그래야 이 부분이
//! 리눅스·맥에서 시험된다 (`Vec`을 통로 삼아 왕복시켜 보면 된다).
//!
//! ## 왜 공유 메모리인가 — 남의 앱의 타이핑을 우리 창에 묶지 않는다
//!
//! 전에는 `WM_COPYDATA`를 `SendMessageTimeout`으로 보냈다. 그 방식은 **받는 쪽이 다
//! 읽을 때까지 보내는 쪽이 기다린다** — 프로세스 경계를 넘어 버퍼를 넘기려면 보낸 쪽
//! 메모리가 그때까지 살아 있어야 하기 때문이다.
//!
//! 그런데 입력기는 DLL이라 그 「보내는 쪽」이 곧 **호스트 앱의 입력 스레드**다. 후보 창이
//! 멎으면 사용자의 타이핑이 그만큼 멈춘다는 뜻이었다.
//!
//! 공유 메모리는 **커널이 수명을 쥔다.** 그래서 기다릴 이유가 사라지고, 알림은
//! `PostMessage`로 던지고 즉시 돌아온다.
//!
//! ⚠️ 이 전환은 아래한글의 조합 끊김을 고치려고 한 것인데 **그것은 안 고쳐졌다** —
//! 원인이 여기가 아니었다. 경위는 `jieum-tip`의 `candidate_ui.rs` 머리말에 있다.
//! 대기를 없앤 것 자체는 옳으므로 되돌리지 않는다.
//!
//! ## 왜 잠금이 없는가
//!
//! 뮤텍스로 슬롯을 지키면 고치려던 것이 그대로 돌아온다 — 후보 창이 멎은 채 잠금을 쥐면
//! 입력 경로가 다시 남의 프로세스에 묶인다. 그래서 **기다리는 지점을 하나도 두지 않았다.**
//!
//! - 순번은 원자적 증가로 받는다 (여러 앱의 입력기가 같은 통로를 쓴다)
//! - 슬롯은 순번으로 고른다. 뒷사람이 덮어쓰면 앞 명령이 사라지는데, **그래도 된다** —
//!   후보 창은 마지막 모습만 그리면 되고, 사라진 것은 다음 키에서 다시 온다
//! - 읽는 쪽은 읽기 전후로 슬롯의 순번을 대조해 **덮어써진 것을 알아본다**
//!
//! ## 배치
//!
//! ```text
//! [0..4]   표식 "JCH1"      — 통로가 준비됐는지, 판이 같은지
//! [4..8]   다음 순번         — 원자적으로 증가
//! [8..16]  예약
//! [16..]   슬롯 SLOT_COUNT개, 각 SLOT_SIZE 바이트
//!            [0..4] 이 슬롯에 담긴 명령의 순번 (0 = 비었음)
//!            [4..8] 길이
//!            [8..]  내용(JSON)
//! ```

use core::sync::atomic::{fence, AtomicU32, Ordering};

/// 공유 메모리의 이름. **`Local\`은 로그온 세션 안에서만 통한다** — 다른 사용자가 같은
/// 기계에 로그인해 있어도 서로의 통로에 닿지 못한다. 창 메시지와 같은 격리 수준이라,
/// 전송 방식을 바꾸면서 사용자 격리를 잃지 않는다.
pub const MAPPING_NAME: &str = "Local\\JieumCandidateChannel";

/// 「슬롯에 새 명령을 넣었다」는 알림. `wParam`에 순번이 실린다.
///
/// `WM_APP + 1`이다. `WM_APP`(0x8000)부터는 응용 프로그램이 자기 창에 마음대로 쓸 수 있는
/// 구간이고, 이 창은 우리가 만든 것이다. 여기 상수로 둔 이유는 보내는 쪽과 받는 쪽이
/// **한 곳을 보게 하기 위해서**다 — 양쪽에 따로 적으면 언젠가 어긋난다.
pub const WM_JIEUM_UI: u32 = 0x8000 + 1;

/// 통로가 준비됐다는 표식. 후보 창이 적고, 입력기는 확인만 한다.
const MAGIC: u32 = u32::from_le_bytes(*b"JCH1");

const OFF_MAGIC: usize = 0;
const OFF_NEXT_SEQ: usize = 4;
const HEADER_SIZE: usize = 16;

/// 슬롯 개수. 한 바퀴 도는 동안(= 새 명령 8개) 후보 창이 한 번도 못 읽으면 앞의 것이
/// 사라진다. 키 하나에 명령 하나이고 받는 쪽은 그리기만 하므로 실제로는 닿지 않는다.
pub const SLOT_COUNT: u32 = 8;

/// 슬롯 하나의 크기. 후보 9줄짜리 명령이 1 KB 안쪽이라 네 배 여유다.
pub const SLOT_SIZE: usize = 4096;

const SLOT_OFF_SEQ: usize = 0;
const SLOT_OFF_LEN: usize = 4;
const SLOT_OFF_BODY: usize = 8;

/// 명령 하나가 넘을 수 없는 크기.
pub const MAX_PAYLOAD: usize = SLOT_SIZE - SLOT_OFF_BODY;

/// 공유 메모리 전체 크기.
pub const TOTAL_SIZE: usize = HEADER_SIZE + SLOT_COUNT as usize * SLOT_SIZE;

/// 공유 메모리 한 덩어리를 슬롯으로 나눠 쓰는 통로.
///
/// 포인터를 들고 있으므로 스레드 사이로 옮길 수 없다(`!Send`). 쓰는 쪽도 읽는 쪽도 자기
/// 스레드에서 열어 자기가 쓴다.
pub struct Channel {
    base: *mut u8,
}

impl Channel {
    /// # Safety
    ///
    /// `base`는 `TOTAL_SIZE` 바이트 동안 유효하고 4바이트 정렬이어야 하며, 이 `Channel`이
    /// 사는 동안 매핑이 풀리면 안 된다. (파일 매핑의 시작 주소는 항상 페이지 정렬이다)
    pub unsafe fn new(base: *mut u8) -> Self {
        Self { base }
    }

    fn word(&self, offset: usize) -> &AtomicU32 {
        // 헤더·슬롯의 u32 자리는 전부 4의 배수 위치라 정렬이 맞는다.
        unsafe { &*(self.base.add(offset) as *const AtomicU32) }
    }

    /// 통로를 쓸 수 있게 만든다. **후보 창 프로세스만 부른다.**
    ///
    /// 새로 만든 공유 메모리는 윈도우가 0으로 채워 주므로, 표식을 적는 것이 곧 "준비됐다"는
    /// 신호가 된다. 순번은 표식보다 **먼저** 0으로 되돌린다 — 표식이 보이는 순간부터
    /// 입력기가 순번을 받아 가기 때문이다.
    pub fn initialize(&self) {
        self.word(OFF_NEXT_SEQ).store(0, Ordering::Relaxed);
        for index in 0..SLOT_COUNT {
            self.word(slot_offset(index) + SLOT_OFF_SEQ)
                .store(0, Ordering::Relaxed);
        }
        fence(Ordering::Release);
        self.word(OFF_MAGIC).store(MAGIC, Ordering::Release);
    }

    /// 이 통로가 우리가 아는 판인가. 아니면 보내지 않는다 — 옛 후보 창이 떠 있는 동안
    /// 엉뚱한 자리에 쓰는 것보다 후보가 안 뜨는 편이 낫다.
    pub fn is_ready(&self) -> bool {
        self.word(OFF_MAGIC).load(Ordering::Acquire) == MAGIC
    }

    /// 명령을 슬롯에 놓고 순번을 돌려준다. 이 순번을 알림에 실어 보낸다.
    ///
    /// 실패는 둘뿐이다 — 통로가 준비되지 않았거나, 명령이 슬롯보다 크거나.
    pub fn publish(&self, payload: &[u8]) -> Option<u32> {
        if !self.is_ready() || payload.is_empty() || payload.len() > MAX_PAYLOAD {
            return None;
        }
        // 0은 「비었음」이므로 순번은 1부터 센다.
        let seq = self.word(OFF_NEXT_SEQ).fetch_add(1, Ordering::Relaxed) + 1;
        let slot = slot_offset((seq - 1) % SLOT_COUNT);

        // 쓰는 동안 이 슬롯은 무효다. 읽는 쪽이 반쯤 쓰인 것을 집어 가면 안 된다.
        self.word(slot + SLOT_OFF_SEQ).store(0, Ordering::Release);
        self.word(slot + SLOT_OFF_LEN)
            .store(payload.len() as u32, Ordering::Relaxed);
        unsafe {
            core::ptr::copy_nonoverlapping(
                payload.as_ptr(),
                self.base.add(slot + SLOT_OFF_BODY),
                payload.len(),
            );
        }
        fence(Ordering::Release);
        self.word(slot + SLOT_OFF_SEQ).store(seq, Ordering::Release);
        Some(seq)
    }

    /// 알림에 실려 온 순번의 명령을 꺼낸다.
    ///
    /// 읽기 전후로 순번을 대조한다. 그 사이 뒷사람이 이 슬롯을 가져갔으면 `None`이다 —
    /// 그때는 더 새로운 알림이 이미 큐에 있으므로 이번 것을 버려도 화면은 최신이 된다.
    pub fn read(&self, seq: u32) -> Option<Vec<u8>> {
        if seq == 0 || !self.is_ready() {
            return None;
        }
        let slot = slot_offset((seq - 1) % SLOT_COUNT);
        if self.word(slot + SLOT_OFF_SEQ).load(Ordering::Acquire) != seq {
            return None;
        }
        let len = self.word(slot + SLOT_OFF_LEN).load(Ordering::Relaxed) as usize;
        if len == 0 || len > MAX_PAYLOAD {
            return None;
        }
        let mut out = vec![0u8; len];
        unsafe {
            core::ptr::copy_nonoverlapping(
                self.base.add(slot + SLOT_OFF_BODY),
                out.as_mut_ptr(),
                len,
            );
        }
        fence(Ordering::Acquire);
        if self.word(slot + SLOT_OFF_SEQ).load(Ordering::Acquire) != seq {
            return None;
        }
        Some(out)
    }
}

fn slot_offset(index: u32) -> usize {
    HEADER_SIZE + index as usize * SLOT_SIZE
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 시험용 통로. 공유 메모리 대신 보통 메모리를 쓴다 — 이 모듈이 보는 것은
    /// 「연속된 바이트 덩어리」뿐이라 어느 쪽이든 똑같이 동작한다.
    struct Buffer(Vec<u8>);

    impl Buffer {
        fn new() -> Self {
            Self(vec![0u8; TOTAL_SIZE])
        }
        fn channel(&mut self) -> Channel {
            unsafe { Channel::new(self.0.as_mut_ptr()) }
        }
    }

    #[test]
    fn 준비되지_않은_통로에는_쓰지_않는다() {
        let mut buf = Buffer::new();
        let ch = buf.channel();
        assert!(!ch.is_ready());
        assert_eq!(ch.publish(b"{}"), None);
    }

    #[test]
    fn 명령이_왕복한다() {
        let mut buf = Buffer::new();
        let ch = buf.channel();
        ch.initialize();

        let seq = ch.publish(b"first").expect("첫 명령");
        assert_eq!(seq, 1);
        assert_eq!(ch.read(seq).as_deref(), Some(&b"first"[..]));
    }

    #[test]
    fn 여러_명령이_각자의_슬롯에_남는다() {
        let mut buf = Buffer::new();
        let ch = buf.channel();
        ch.initialize();

        let seqs: Vec<u32> = (0..SLOT_COUNT)
            .map(|i| ch.publish(format!("cmd{i}").as_bytes()).unwrap())
            .collect();

        // 한 바퀴 안이면 먼저 것도 그대로 있다 — 받는 쪽이 늦어도 잃지 않는다.
        for (i, seq) in seqs.iter().enumerate() {
            assert_eq!(ch.read(*seq).as_deref(), Some(format!("cmd{i}").as_bytes()));
        }
    }

    #[test]
    fn 한_바퀴_돌면_옛것은_사라지고_알아본다() {
        let mut buf = Buffer::new();
        let ch = buf.channel();
        ch.initialize();

        let first = ch.publish(b"oldest").unwrap();
        for _ in 0..SLOT_COUNT {
            ch.publish(b"newer").unwrap();
        }
        // 덮어써진 것을 옛 내용인 양 돌려주면 후보 창이 지난 화면을 그린다.
        assert_eq!(ch.read(first), None);
    }

    #[test]
    fn 슬롯보다_큰_명령은_거절한다() {
        let mut buf = Buffer::new();
        let ch = buf.channel();
        ch.initialize();

        assert_eq!(ch.publish(&vec![b'x'; MAX_PAYLOAD + 1]), None);
        assert!(ch.publish(&vec![b'x'; MAX_PAYLOAD]).is_some());
    }

    #[test]
    fn 없는_순번은_거절한다() {
        let mut buf = Buffer::new();
        let ch = buf.channel();
        ch.initialize();

        assert_eq!(ch.read(0), None);
        assert_eq!(ch.read(1), None); // 아직 아무것도 안 실었다
        let seq = ch.publish(b"x").unwrap();
        assert_eq!(ch.read(seq + 1), None);
    }

    #[test]
    fn 후보_명령이_슬롯에_들어간다() {
        use crate::ui_command::{CaretRect, Command, Row};

        // 한 쪽에 보이는 최대치(9줄)를 넉넉한 내용으로 채워 본다. 여기서 넘치면
        // 실사용에서 후보가 통째로 안 뜬다.
        let rows: Vec<Row> = (0..9)
            .map(|i| Row {
                hanja: "漢字語彙".into(),
                meaning: Some(format!("뜻풀이 {i}")),
                header: Some("한자어".into()),
                word: "한자어휘".into(),
                number: i + 1,
            })
            .collect();
        let cmd = Command::Show {
            caret: CaretRect {
                left: 100,
                top: 200,
                right: 102,
                bottom: 220,
            },
            rows,
            selected: 0,
            page: 1,
            total_pages: 3,
            expanded: false,
            prefer_above: false,
        };
        let bytes = cmd.encode();
        assert!(
            bytes.len() <= MAX_PAYLOAD,
            "후보 명령이 슬롯보다 크다: {}",
            bytes.len()
        );

        let mut buf = Buffer::new();
        let ch = buf.channel();
        ch.initialize();
        let seq = ch.publish(&bytes).unwrap();
        assert_eq!(Command::decode(&ch.read(seq).unwrap()), Some(cmd));
    }
}
