import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { UserWordStore } from '@jieum/core';

/**
 * 사용자가 조합한 어휘의 보존
 *
 * `MruFile`과 같은 구조인데 **묶어 쓰지 않는다.** 그것 하나가 다르고, 그 하나가 중요하다.
 *
 * ## 왜 즉시 쓰는가
 *
 * 참조 구현들이 여기서 크게 갈리고, 그 차이가 곧 데이터 손실이다 — sunpinyin은 어휘가
 * 늘 때마다 쓰고, libime는 30분마다(그것도 1분 이상 놀 때만), libpinyin은 5분 놀면 쓰되
 * **종료할 때는 아예 안 쓴다.**
 *
 * 이름 하나를 공들여 조합해 놓고 크래시로 잃는 것은 이 기능이 줄 수 있는 **최악의
 * 첫인상**이다. 사용 이력은 하나쯤 잃어도 다음에 다시 쌓이지만, 조합은 사용자가 한
 * 글자씩 확인하며 만든 수고다. 저장소도 작아서(수천 건) 즉시 쓰기가 공짜에 가깝다.
 *
 * 설계 근거: `docs/08-user-word-learning-plan.md` §5.4
 */
export class UserWordFile {
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    readonly store: UserWordStore,
  ) {}

  /**
   * 파일에서 읽어 연다. 없거나 깨져 있으면 빈 저장소로 시작한다.
   *
   * 깨진 파일 때문에 입력기가 안 뜨면 안 된다 — 배운 것을 잃는 편이 낫다.
   */
  static async open(path: string): Promise<UserWordFile> {
    let store = new UserWordStore();
    try {
      const raw = await readFile(path, 'utf-8');
      store = UserWordStore.fromJSON(JSON.parse(raw));
    } catch {
      // 없거나 못 읽으면 빈 저장소
    }
    return new UserWordFile(path, store);
  }

  /** 바뀌었다 — **바로** 쓴다 */
  touch(): void {
    void this.flush();
  }

  /** 앞선 쓰기가 끝난 뒤에 쓴다 — 두 쓰기가 겹치면 임시 파일이 서로를 덮는다 */
  async flush(): Promise<void> {
    this.writing = this.writing.then(() => this.writeAtomically());
    await this.writing;
  }

  /**
   * 임시 파일에 쓰고 이름을 바꾼다.
   *
   * 그냥 덮어쓰면 쓰는 중에 죽었을 때 반쯤 쓰인 JSON이 남고, 다음 기동에서 배운 것을
   * 통째로 잃는다. rename은 같은 파일 시스템 안에서 원자적이다.
   */
  private async writeAtomically(): Promise<void> {
    const temporary = `${this.path}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, JSON.stringify(this.store.toJSON()), 'utf-8');
      await rename(temporary, this.path);
    } catch {
      // 저장 실패로 입력기가 죽으면 안 된다. 다음 조합에서 다시 쓴다.
    }
  }
}
