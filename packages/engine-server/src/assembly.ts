/**
 * 낱자 확정이 **이어서** 쳐진 것인지 가려낸다.
 *
 * 사용자가 `김`→金, `홍`→洪, `경`→京을 차례로 확정하면 `김홍경`→`金洪京`을 배운다.
 * 그런데 「차례로」를 어떻게 아는가가 문제다.
 *
 * ## 엔진은 커서를 모른다
 *
 * `commit`이 실어 오는 것은 `headword`·`hanja`·`contextKey`뿐이다. 대신 `lookup`이
 * **앞 문맥**(`precedingText`)을 실어 오고, 조회는 언제나 확정보다 먼저 온다.
 * 그래서 「방금 넣은 한자로 끝나는가」를 문자열로 물어 이어짐을 판정한다.
 *
 * ```
 * commit("김", 金)                       → 들고 있는 것 = { 김, 金 }
 * lookup("홍", 앞 문맥 "…金")            → 金으로 끝난다 ⇒ 이어짐
 * commit("홍", 洪)                       → { 김홍, 金洪 }  ← 배울 것이 생겼다
 * commit("경", 京)                       → { 김홍경, 金洪京 }
 * lookup(…, 京으로 안 끝남)              → 끊김
 * ```
 *
 * ## 왜 `commit`에 필드를 더하지 않는가
 *
 * 셸이 둘(macOS IMK·윈도우 TSF)이라 양쪽을 다 고쳐야 하고, **윈도우 쪽은 앞 문맥을
 * 아직 보내지도 않는다.** 세션 상태로 푸는 것은 공짜이고 와이어 계약이 그대로 남는다.
 *
 * ## 이 판정의 알려진 약점
 *
 * 사용자가 金을 넣고 커서를 딴 데로 옮겼는데 **그 자리의 앞 문맥이 하필 金으로 끝나면**
 * 이어진 것으로 잘못 본다. 드물고, 잘못 배워도 아래 §5.1의 좁히기가 피해를 막는다.
 *
 * ## Mozc의 신호를 못 베끼는 이유
 *
 * Mozc는 한 확정에 든 조각들에 **같은 초 단위 시각**을 찍어 「함께 입력됐다」를 안다
 * (`user_history_predictor.cc:867-882`). 일본어는 한 번의 확정이 여러 문절을 덮기
 * 때문이다. 지음은 김·홍·경을 **따로** 확정하므로 시각이 설계상 다르고 그 신호가 아예
 * 오지 않는다. 위의 앞 문맥 검사가 그 대용이다.
 *
 * 설계 전문: `docs/08-user-word-learning-plan.md` §4·§5.1
 */

/** 배울 준비가 된 조합 */
/**
 * 조합이 **안 된 이유**. 내용은 담지 않는다 — 이 프로세스는 사용자가 치는 모든 것을 본다.
 *
 * 조용히 아무 일도 안 일어나는 것이 이 기능의 가장 위험한 실패 방식이라(2026-08-28에
 * 실제로 그랬다) 사유를 남길 수 있게 해 둔다.
 */
export type AssemblySkip =
  | 'no-session'
  | 'not-single'
  | 'first'
  | 'broken'
  | 'timeout';

export interface AssemblyPiece {
  reading: string;
  hanja: string;
  /**
   * 이 조합이 **대신하는** 더 짧은 조합. 있으면 그것은 잊어야 한다.
   *
   * 조합은 한 글자씩 자라므로 `김홍경`을 만드는 동안 `김홍`도 배워진다. 그대로 두면
   * 사용자가 `金洪京`을 잊어도 `金洪`이 남아 다음에 또 뜬다 — 설계 §6이 경계한
   * 「지웠는데 또 나온다」의 약한 형태다. 사용자는 `김홍경` 하나를 만든 것이지
   * `김홍`을 만든 것이 아니다.
   *
   * 짧은 것이 정말로 홀로 쓰이는 조합이라면 다음에 그것만 쳤을 때 다시 배워진다.
   */
  supersedes?: { reading: string; hanja: string };
}

/**
 * 이만큼 쉬면 조합이 끊긴다.
 *
 * 커서를 옮기지 않고 한참 있다가 이어 치는 것은 「이어서 친 것」이 아니다.
 * 앞 문맥 검사가 이미 대부분을 거르므로 넉넉히 잡아도 된다.
 */
export const ASSEMBLY_TIMEOUT_MS = 30_000;

interface Pending {
  reading: string;
  hanja: string;
  lastAt: number;
  /** 마지막 조회에서 앞 문맥이 이어졌는가 */
  contiguous: boolean;
}

/**
 * 낱자 확정인가.
 *
 * ⭐ **가장 강한 방어는 나중에 거르는 것이 아니라 애초에 대상을 좁히는 것이다**
 * (설계 §5.1). 조합 안의 모든 확정이 1음절 표제어였을 때만 조합으로 친다.
 *
 * 이러면 노리는 것(`김`→金)에 정확히 맞으면서 잡음(`漢字` 뒤에 한 글자)은 **조합으로
 * 치지도 않으므로** `漢字X` 같은 것이 애초에 생기지 않는다. 「단어처럼 보이는가」를
 * 추측할 필요가 없다.
 *
 * libime의 길이 규칙("전부 낱자면 상한 없음")과 Rime의 `UpdateElements`가 같은 부류를
 * 특수 취급하는 것이 이 선택이 발명이 아님을 말해 준다.
 */
function isSingleSyllable(reading: string, hanja: string): boolean {
  return [...reading].length === 1 && [...hanja].length === 1;
}

export class AssemblyTracker {
  private pending = new Map<string, Pending>();

  /**
   * 조회가 왔다. 앞 문맥이 지금까지의 조합으로 끝나지 않으면 조합을 끊는다.
   *
   * 앞 문맥이 아예 없으면(셸이 안 보내면) **이어졌다고 보지 않는다** — 모르는 것을
   * 이어졌다고 치면 엉뚱한 조합이 쌓인다. 윈도우 셸이 지금 그 상태다.
   */
  noteLookup(sessionId: string | undefined, precedingText: string | undefined, now: number): void {
    if (sessionId === undefined) return;
    const key = sessionId;
    const pending = this.pending.get(key);
    if (!pending) return;

    if (now - pending.lastAt > ASSEMBLY_TIMEOUT_MS) {
      this.pending.delete(key);
      return;
    }

    pending.contiguous = precedingText !== undefined && precedingText.endsWith(pending.hanja);
    if (!pending.contiguous) this.pending.delete(key);
  }

  /**
   * 확정이 왔다. 조합이 자라 배울 것이 생기면 그것을 돌려준다.
   *
   * 낱자가 아닌 확정은 조합을 **끊고** `undefined`를 낸다.
   * 낱자 하나만으로는 아직 조합이 아니므로 두 글자가 모여야 값이 나온다.
   */
  /** 마지막 `noteCommit`이 조합을 못 만든 이유 (진단용) */
  lastSkip: AssemblySkip | undefined;

  noteCommit(
    sessionId: string | undefined,
    reading: string,
    hanja: string,
    now: number,
  ): AssemblyPiece | undefined {
    this.lastSkip = undefined;
    // ⚠️ **세션을 모르면 배우지 않는다.** 세션이 곧 텍스트 칸이고, 그것을 모르면 서로
    // 다른 칸에 친 글자들이 한 조합으로 이어 붙는다. 모르는 채로 배우는 것보다 안 배우는
    // 것이 낫다 — 이 기능의 실패 방식은 「엉뚱한 것을 배운다」이지 「덜 배운다」가 아니다.
    if (sessionId === undefined) {
      this.lastSkip = 'no-session';
      return undefined;
    }
    const key = sessionId;
    const pending = this.pending.get(key);

    if (!isSingleSyllable(reading, hanja)) {
      // 표제어를 확정했다 — 여기서 조합이 끝난다. 이어 붙이지 않는다.
      this.pending.delete(key);
      this.lastSkip = 'not-single';
      return undefined;
    }

    if (!pending || !pending.contiguous || now - pending.lastAt > ASSEMBLY_TIMEOUT_MS) {
      // 새로 시작한다
      this.lastSkip = !pending
        ? 'first'
        : now - pending.lastAt > ASSEMBLY_TIMEOUT_MS
          ? 'timeout'
          : 'broken';
      this.pending.set(key, { reading, hanja, lastAt: now, contiguous: false });
      return undefined;
    }

    const grown: Pending = {
      reading: pending.reading + reading,
      hanja: pending.hanja + hanja,
      lastAt: now,
      contiguous: false,
    };
    this.pending.set(key, grown);

    // 직전 것이 이미 배워졌다면(두 글자 이상) 이번 것이 그것을 대신한다
    const supersedes =
      [...pending.reading].length >= 2
        ? { reading: pending.reading, hanja: pending.hanja }
        : undefined;
    return { reading: grown.reading, hanja: grown.hanja, supersedes };
  }

  /** 세션이 닫혔다 — 들고 있던 조합을 버린다 */
  closeSession(sessionId: string): void {
    this.pending.delete(sessionId);
  }
}
