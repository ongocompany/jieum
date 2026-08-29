//! 프로토콜 v1 — Rust 쪽 계약.
//!
//! `packages/engine-server/src/protocol.ts`가 원본이고, 이 파일은 그 계약의 Rust 표현이다.
//! **파괴적 변경은 양쪽을 같은 커밋에서 고친다.** macOS 셸의 `Protocol.swift`가 같은 자리에
//! 있는 세 번째 표현이다.
//!
//! ## 숫자 필드에 관한 규약 — 실제로 당한 함정
//!
//! JSON에는 정수와 실수의 구분이 없고 TypeScript의 `number`도 마찬가지다. 그래서 이쪽에서
//! 정수처럼 보이는 값이 언제든 소수로 온다. macOS에서 `level`(급수)이 `7.5`로 나가는 것을
//! Swift가 `Int`로 받아 **조회 응답 전체가 조용히 해석 실패**했고, 증상은 "제안이 아예 안
//! 뜬다"뿐이라 소켓·엔진·사전을 차례로 의심하고 나서야 원인에 닿았다.
//!
//! 그래서 **정수로 받는 필드는 프로토콜이 정수를 보장하는 것뿐이다**: `v`, `id`, `token`,
//! `length`. 나머지 숫자는 전부 `f64`로 받는다.

use serde::Deserialize;

/// 프로토콜 버전. 불일치는 조용히 넘어가지 않고 즉시 실패한다.
pub const PROTOCOL_VERSION: u32 = 1;

/// 후보 하나.
///
/// 지금 단계에서 쓰는 것은 `hanja`·`score`뿐이지만 계약 전체를 적어 둔다 — 와이어 계약은
/// 후보 UI가 필요로 할 때 늘리는 것이 아니라 처음부터 맞춰 두는 것이다.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireCandidate {
    pub word: String,
    pub hanja: String,
    #[serde(default)]
    pub score: f64,
    #[serde(default)]
    pub freq: f64,
    /// 급수. 정수가 아니다 (여러 엔트리의 평균이라 `7.5`가 온다)
    #[serde(default)]
    pub level: f64,
    /// 훈(뜻) — 1글자 한자에만 있다
    #[serde(default)]
    pub meaning: Option<String>,
    #[serde(default)]
    pub inmyeong: Option<bool>,
    /// 2층(고어·전문어) 여부
    #[serde(default)]
    pub archaic: Option<bool>,
    /// 사용 이력 신호. 최근성 기반이라 큰 수가 올 수 있다
    #[serde(default)]
    pub used: Option<f64>,
    /// 앞 문맥에서 걸린 연어 문맥어 수
    #[serde(default)]
    pub collocation: Option<f64>,
    #[serde(default)]
    pub source: String,
}

/// 표제어 하나에 대한 후보 묶음.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireLookupGroup {
    pub word: String,
    /// 표제어 길이(문자 수). 프로토콜이 정수를 보장한다
    pub length: u32,
    pub candidates: Vec<WireCandidate>,
    /// `"normal"` | `"archaic"` | `"inmyeong"`
    #[serde(default)]
    pub r#type: Option<String>,
    /// 이 조회 시점에 이 표제어가 놓인 문맥의 이름. 확정할 때 **그대로 돌려보낸다.**
    ///
    /// **그룹마다 다르다.** 조회는 길이별로 여러 표제어를 돌려주고("발전소"·"발전"·"발")
    /// 표제어마다 걸리는 연어 규칙이 달라 문맥 칸도 따로다. 확정 시점에 문맥을 다시 읽으면
    /// 그 사이 커서가 움직였을 수 있고, 그러면 사용 이력이 엉뚱한 칸에 쌓인다.
    #[serde(default)]
    pub context_key: Option<String>,
}

/// 응답 봉투. 무엇이 왔는지 판별하는 데 필요한 최소한만 본다.
///
/// 응답에는 `op`가 없고 `id`만 있다. 그래서 어떤 요청의 답인지는 **보낸 쪽이 기억해야**
/// 한다 (`RequestKind`).
#[derive(Debug, Deserialize)]
pub struct ReplyEnvelope {
    pub id: u64,
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub error: Option<WireErrorBody>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct WireErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloReply {
    pub server_version: String,
    pub protocol_v: u32,
    /// 사전 빌드 지문. 셸이 캐시를 들고 있다면 이 값으로 무효화한다
    pub dict_fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LookupReply {
    /// 연결마다 단조 증가하는 조회 번호. 이보다 낮은 응답은 낡았으므로 버린다.
    ///
    /// 요청 `id`와 따로 두는 이유: 최신 판정의 근거를 서버가 쥐게 하려는 것. 클라이언트가
    /// id를 어떻게 발급하든(재사용·래핑) 순서 판정이 흔들리지 않는다.
    pub token: i64,
    pub groups: Vec<WireLookupGroup>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOpenReply {
    pub session_id: String,
}
