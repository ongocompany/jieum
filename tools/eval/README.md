# 후보 품질 평가 도구

`tools/eval`은 사전 조회 결과를 표본 데이터와 비교해 후보 누락과 선택 비용을 측정합니다.

## 명령

```bash
pnpm --filter @jieum/eval eval:suggestions --limit 20000 --save
pnpm --filter @jieum/eval diagnose
pnpm --filter @jieum/eval build-golden
pnpm --filter @jieum/eval extract-supplement
```

평가 말뭉치와 사전 원본은 공개 저장소에 포함되지 않습니다. 위 명령을 실행하려면
`data/eval/`과 사전 빌드 결과를 별도로 준비해야 합니다.

## 지표 해석

- **후보 누락**: 원하는 한자가 후보 목록에 없고, 표제어를 나누어 입력해도 만들 수 없는 경우
- **즉시 확정**: 첫 후보를 선택할 수 있는 경우
- **숫자키 선택**: 첫 화면의 다른 후보를 선택하는 경우
- **쪽 이동**: 다음 후보 묶음으로 이동해야 하는 경우
- **분할 입력**: 표제어를 둘 이상으로 나누어 입력하는 경우

첫 후보 적중률만으로 전체 품질을 판단하지 않습니다. 입력 중에는 뒤 문맥을 알 수 없고,
후보가 목록 안에 있으면 사용자가 선택할 수 있기 때문입니다. 누락과 선택 비용을 분리해
살펴보는 것이 이 도구의 목적입니다.

결과는 `data/eval/suggestion-<timestamp>.json`에 저장되며 `--save`를 사용하면
`data/eval/suggestion-latest.json`도 갱신합니다.
