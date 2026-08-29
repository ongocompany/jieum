import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { MruStore } from '@jieum/core';

/**
 * 사용 이력의 보존
 *
 * 사전 엔트리의 97.6%가 빈도 0이라 사용 이력은 사실상 유일한 랭킹 신호다.
 * 기계를 껐다 켰다고 그것이 사라지면 입력기는 매번 처음부터 시작한다.
 *
 * 편집기의 localStorage와는 **별도 저장소**다. 통합은 범위 밖으로 이미 결정됐다
 * (docs/07 M2). 시스템 입력기는 어느 앱에서 쳤든 같은 이력을 쓰고, 편집기는
 * 브라우저 안에 갇혀 있다.
 */
export class MruFile {
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    private readonly path: string,
    readonly store: MruStore,
    /** 변경을 묶어서 쓰는 간격 */
    private readonly debounceMs: number,
  ) {}

  /**
   * 파일에서 읽어 연다. 파일이 없거나 깨져 있으면 빈 이력으로 시작한다.
   *
   * 깨진 이력 때문에 입력기가 안 뜨면 안 된다 — 이력은 편의지 필수가 아니다.
   */
  static async open(path: string, debounceMs = 2000): Promise<MruFile> {
    let store = new MruStore();
    try {
      const raw = await readFile(path, 'utf-8');
      store = MruStore.fromJSON(JSON.parse(raw));
    } catch {
      // 없거나 못 읽으면 빈 이력
    }
    return new MruFile(path, store, debounceMs);
  }

  /**
   * 바뀌었음을 알린다. 실제 쓰기는 묶어서 한다.
   *
   * 확정마다 31MB짜리 사전을 든 프로세스가 파일을 쓰면 타이핑 중에 디스크가
   * 튄다. 확정은 몰려서 일어나므로 묶는 것이 자연스럽다.
   */
  touch(): void {
    this.dirty = true;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.debounceMs);
    // 이 타이머 때문에 프로세스가 안 죽으면 안 된다
    this.timer.unref?.();
  }

  /** 즉시 쓴다 (종료 시) */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.dirty) return;
    this.dirty = false;

    // 앞선 쓰기가 끝난 뒤에 쓴다 — 두 쓰기가 겹치면 임시 파일이 서로를 덮는다
    this.writing = this.writing.then(() => this.writeAtomically());
    await this.writing;
  }

  /**
   * 임시 파일에 쓰고 이름을 바꾼다.
   *
   * 그냥 덮어쓰면 쓰는 중에 프로세스가 죽었을 때 반쯤 쓰인 JSON이 남고,
   * 다음 기동에서 이력을 통째로 잃는다. rename은 같은 파일 시스템 안에서
   * 원자적이다.
   */
  private async writeAtomically(): Promise<void> {
    const temporary = `${this.path}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, JSON.stringify(this.store.toJSON()), 'utf-8');
      await rename(temporary, this.path);
    } catch {
      // 이력 저장 실패로 입력기가 죽으면 안 된다. 다음 기회에 다시 쓴다.
      this.dirty = true;
    }
  }
}
