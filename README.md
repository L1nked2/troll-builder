# Troll Auction

롤 내전 팀을 포인트 경매로 구성하는 정적 웹 페이지입니다. 유저 입력, 전적 조회, 경매 진행은 모두 브라우저에서 처리하며 별도 백엔드, API 키, JSON 입력 파일이 필요하지 않습니다. 한국(KR) 서버를 조회합니다.

## 사용 방법

1. 첫 화면에서 팀장과 참가자의 `닉네임#태그` 및 주 포지션을 입력합니다. 빈 행은 무시되며, 팀장과 참가자 간 같은 Riot ID를 중복 입력할 수 없습니다.
2. 기본 예산과 팀장별 예산을 설정하고 **경매 준비하기**를 누릅니다. 팀장별 예산을 비우면 기본 예산을 사용합니다. 0pt도 허용합니다.
3. **모든 유저 업데이트**로 팀장과 참가자를 조회하거나, 각 유저의 **새로고침** 버튼으로 개별 조회합니다. 참가자 관리 목록에서는 낙찰된 선수도 조회할 수 있고, 상세 화면에서도 갱신할 수 있습니다.
4. 선수 지목, 낙찰, 유찰, 방출, 결과 복사 등 기존 경매 기능을 사용합니다. 전적 갱신은 팀 배정과 예산을 유지합니다.
5. **참가자 편집**으로 입력 내용을 변경할 수 있습니다. **경매 준비하기**를 다시 누르면 경매 배정과 예산이 초기화됩니다. 동일 Riot ID의 전적은 유지됩니다. **경매로 돌아가기**는 편집 내용을 적용하지 않습니다.

유저와 전적 데이터는 JavaScript 메모리에만 보관합니다. `localStorage`, `sessionStorage`, 쿠키, 파일 저장을 사용하지 않으며 새로고침·탭 종료 후에는 입력부터 다시 시작합니다. 다른 브라우저나 탭과 동기화하지 않습니다.

## 전적 데이터

- 브라우저에서 DEEPLOL의 CORS 허용 조회 API와 Riot Data Dragon을 직접 호출합니다. 조회 버튼을 누르면 입력한 Riot ID가 DEEPLOL에 전송됩니다.
- 솔로/자유 랭크, 최근 10경기, 현재 시즌 챔피언 통계와 이전 시즌 기록을 조회합니다. 현재 시즌 번호는 API에서 읽으며 코드에 고정하지 않습니다.
- **업데이트**는 DEEPLOL에서 제공하는 전적을 다시 조회한다는 뜻입니다. 별도 인증이 필요한 DEEPLOL의 원본 갱신 API는 호출하지 않으므로 제공처의 캐시 지연이 있을 수 있습니다.
- LP 차트는 현재 페이지에서 성공적으로 조회한 랭크의 추이입니다. 기존 FOW의 과거 LP 그래프 크롤링은 외부 사이트의 CORS 제약 때문에 사용하지 않습니다. 시즌 라벨은 DEEPLOL의 시즌 식별자입니다.
- 전체 조회는 최대 두 유저씩 처리합니다. 진행 수와 유저별 오류를 표시하며 실패한 유저를 재시도할 수 있습니다. 필수 랭크/전적 조회에 실패하면 기존 데이터를 유지하고, 챔피언 통계만 실패한 경우 해당 통계는 유지하면서 부분 실패를 표시합니다.
- 외부 API의 CORS 정책, 응답 형식, 호출 제한이 바뀌면 조회가 실패할 수 있습니다. API가 차단되더라도 입력한 선수로 경매는 진행할 수 있습니다.

## GitHub Pages 배포

[GitHub Pages 공식 안내](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)에 따라 저장소의 **Settings → Pages → Build and deployment → Source**를 **GitHub Actions**로 설정합니다.

`main`에 변경 사항을 push하거나 **Actions → Deploy GitHub Pages → Run workflow**를 실행하면 `.github/workflows/pages.yml`이 검증 후 정적 페이지를 배포합니다. 기본 주소는 `https://<계정>.github.io/<저장소>/`이며 하위 경로에서도 동작합니다.

배포 산출물에는 `index.html`, `styles.css`, `app.js`, `session.js`, `record-client.js`만 포함합니다. 기존 로컬 유저 JSON, Python 코드, 가상환경은 업로드하지 않습니다.

## 로컬 실행 및 검증

```powershell
python -m http.server 8000 --bind 127.0.0.1
# http://localhost:8000 에서 확인

node --check app.js
node --check session.js
node --check record-client.js
node --test tests/*.test.cjs
```

`run.bat` 또는 `run.sh`로도 정적 파일 서버를 실행할 수 있습니다. Python은 로컬 미리보기용이며 GitHub Pages에서는 필요하지 않습니다. 기존 `crawler.py`, `update_data.*`, JSON 예시는 과거 오프라인 작업용으로 남아 있고 웹 페이지에서 사용하지 않습니다.

`index.html`을 브라우저에서 직접 열어 사용할 수도 있습니다. `tests/browser-smoke.cjs`는 설치된 Playwright와 Edge를 이용해 실제 UI를 검증하며, 외부 전적 요청은 모두 테스트 응답으로 대체합니다. Playwright가 기본 모듈 경로에 없다면 `NODE_PATH`를 해당 패키지 디렉터리로 지정한 후 `node tests/browser-smoke.cjs`로 실행합니다.
