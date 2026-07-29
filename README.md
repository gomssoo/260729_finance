# 260729_finance

NPay증권([stock.naver.com](https://stock.naver.com/)) 데이터를 구글 스프레드시트로 가져오는 Apps Script 프로젝트.
종목을 검색해 추가하고, 현재 시세를 갱신하고, 삭제할 수 있다. 국내·해외 모두 지원한다.

화면은 **GitHub Pages**, 데이터 처리는 **Apps Script**가 맡는 2계층 구조다.

```
GitHub Pages (docs/)  ──JSONP──▶  Apps Script 웹앱  ──▶  네이버 API
   정적 화면                        JSON API              시세·검색
                                        │
                                        ▼
                                   스프레드시트
```

**왜 나눴나** — 네이버 API 는 `Origin` 헤더가 붙으면 403 을 주고 CORS 헤더도 없다.
브라우저에서 직접 못 부르므로 Apps Script 가 중계한다.
그런데 Apps Script 는 응답 헤더를 설정할 수 없어 CORS 를 열 수 없다.
그래서 `script` 태그로 불러오는 **JSONP** 로 통신한다.

## 구성

| 파일 | 설명 |
| --- | --- |
| `docs/index.html` | Pages 화면 |
| `docs/app.js` | JSONP 호출·렌더링 |
| `docs/style.css` | 스타일 (다크 모드 대응) |
| `docs/config.js` | **Apps Script 배포 URL** — 재배포하면 여기를 고친다 |
| `src/Code.gs` | JSON API + 검색·추가·시세갱신·삭제 로직 |
| `src/appsscript.json` | 매니페스트 (타임존, 권한, 웹앱 설정) |
| `.clasp.json` | clasp 설정 (`rootDir: src`) |

- 스크립트: [1ZrQV_2I…](https://script.google.com/d/1ZrQV_2IG5rWMOvSnQ4b2sIjywROXWhCKhKC0ndN6PuxG2BU0knnHPHb1/edit)
- 스프레드시트: [1YU3TvG6…](https://docs.google.com/spreadsheets/d/1YU3TvG6WNG29Hx-puRqpe4vvfWeBvo0lGlqyAxgtvXE/edit)

## 사용법

```bash
npm install        # clasp 설치
npm run push       # 코드 업로드
npm run deploy     # 업로드 + 새 버전 배포
npm run open       # 편집기 열기
npm run logs       # 실행 로그
```

`npm run deploy` 로 나온 새 URL 을 `docs/config.js` 에 반영하고 커밋해야
Pages 화면이 새 배포를 바라본다.

## API

```
GET <배포URL>?action=state          목록 + 갱신시각 + 자동갱신 여부 (화면이 쓰는 것)
             ?action=list           목록만
             ?action=search&query=삼성전자
             ?action=add&items=<JSON 배열>
             ?action=delete&codes=<JSON 배열>
             ?action=move&code=005930&offset=-1
             ?action=reorder&codes=<JSON 배열>
             ?action=refresh        네이버에서 시세를 새로 받아 시트에 쓴다
             ?action=trigger        자동갱신 상태 (on=1 설치, on=0 해제)
```

`callback` 파라미터를 붙이면 JSONP 로 응답한다.
응답은 `{"ok":true,"data":...}` 또는 `{"ok":false,"error":"..."}` 형태다.

## 갱신 구조

읽기와 쓰기를 분리했다.

- **쓰기** — Apps Script 시간 기반 트리거가 1분마다 `scheduledRefresh()` 를 돌려
  네이버에서 시세를 받아 시트에 쓴다. 브라우저를 열어두지 않아도 값이 쌓인다.
- **읽기** — 화면은 `state` 로 시트를 읽기만 한다. 1분마다 다시 읽고,
  탭이 숨겨져 있으면 건너뛴다. 숨어 있던 탭으로 돌아오면 즉시 한 번 읽는다.

트리거는 장이 열려 있을 때만 실제 갱신을 한다. 시트의 `장상태` 열을 보고
전부 장마감이면 그냥 빠져나온다. 하루 1,440번 도는 트리거가
실행 시간 할당량(무료 90분/일)을 다 먹지 않게 하려는 것이다.

## 성능

GAS 웹앱은 호출 1회당 **2.2~3.3초**가 걸린다 (실측). 내역은:

| 구간 | 시간 |
| --- | --- |
| TCP 연결 | 0.17s |
| script.google.com → googleusercontent.com 리다이렉트 + 실행 | 2.4s |
| 네이버 API 직접 호출 (참고) | 0.046s |

리다이렉트 1회와 컨테이너 콜드스타트가 원인이라 코드로는 줄일 수 없다.
그래서 화면은 마지막 목록을 `localStorage` 에 저장해두고 **먼저 그린 뒤**
서버 응답으로 덮어쓴다. 체감상 즉시 뜨고, 값은 몇 초 뒤 최신으로 바뀐다.

더 빠르게 하려면 GAS 를 벗어나야 한다 (Cloudflare Workers 등, 100ms 이하).

## 동작 방식

스프레드시트에 바인딩되지 않은 **독립 스크립트**다.
따라서 `getActiveSpreadsheet()` 대신 `openById()` 로 타겟 시트를 연다.
상단 메뉴(`onOpen`)도 바인딩된 스크립트 전용이라 쓸 수 없다.

타겟 시트는 `DEFAULT_SPREADSHEET_ID` 에 박혀 있지만,
스크립트 속성 `TARGET_SPREADSHEET_ID` 가 있으면 그 값이 우선한다.
바꾸려면 편집기에서 실행:

```js
setTargetSpreadsheet('새로운_스프레드시트_ID');
```

## 검색 노출 차단

`docs/index.html` 에 `noindex, nofollow, noarchive, nosnippet` 메타 태그를 넣었고,
`docs/robots.txt` 로 크롤러를 차단한다.

Pages 는 도메인 루트가 `gomssoo.github.io` 라 `robots.txt` 가 저장소 단위로는
완전히 적용되지 않을 수 있다. 메타 태그가 실질적인 차단 수단이다.

## 보안 주의

**API 는 인증 없이 열려 있다.** Pages(정적 사이트)에서 호출하려면
`webapp.access` 가 `ANYONE_ANONYMOUS` 여야 하고, 이 값이면 URL 을 아는 누구나
시트를 읽고·쓰고·지울 수 있다. 로그인 요구(`MYSELF`)로 바꾸면 Pages 화면이 동작하지 않는다.

URL 자체가 사실상 비밀번호다. 완화하려면:

- 배포 URL 을 공개된 곳에 올리지 않는다 (지금 `docs/config.js` 에 들어 있고, 저장소가 public 이라 노출된다)
- 민감한 데이터를 이 시트에 두지 않는다
- 필요하면 `dispatch()` 앞에 공유 토큰 검사를 추가한다
  (완전한 인증은 아니지만 URL 만 아는 접근은 막는다)

URL 이 노출되어 곤란해지면 `npm run deploy` 로 새 배포를 만들고
`docs/config.js` 의 값을 교체한 뒤, Apps Script 편집기에서 이전 배포를 삭제한다.

## 네이버 API 메모

공식 문서가 없는 내부 API다. 예고 없이 바뀔 수 있으니
값이 갑자기 안 들어오면 엔드포인트 변경을 먼저 의심할 것.

**시세 조회 호스트가 국가별로 다르다.** 바꿔 호출하면 409 나 빈 응답이 온다.

```
국내  https://m.stock.naver.com/api/stock/005930/basic
해외  https://api.stock.naver.com/stock/AAPL.O/basic
```

**검색** — 종목명·티커·종목코드 모두 인식한다. 결과의 `reutersCode` 와 `nationCode` 를
시트에 숨김 열로 저장해두고, 나중에 시세 URL 을 만들 때 쓴다.

```
https://m.stock.naver.com/front-api/search/autoComplete?query=<검색어>&target=stock
```

`target` 에는 허용된 값만 넣을 수 있다 (`stock` 등). 임의 조합은 400 을 반환한다.

**전일대비 부호** — 국내는 `-34,000` 처럼 부호가 붙어 오지만 해외는 그렇지 않은 경우가 있다.
`compareToPreviousPrice.code` (4·5 = 하락) 로 방향을 판단해 부호를 붙인다.

**요청 헤더** — `User-Agent` 와 `Referer` 를 함께 보내야 한다.
브라우저에서 직접 부르면 `Origin` 이 붙어 403 이 온다.

## 종목코드 앞자리 0

`005930` 을 시트에 그냥 쓰면 숫자 `5930` 으로 해석되어 앞의 0 이 날아간다.
그 코드로 조회하면 시세가 통째로 빈 값이 된다. 실제로 겪은 버그다.

세 겹으로 막았다.

1. 코드 계열 열에 텍스트 서식(`@`) 지정 — `setupSheet` 와 `addStocks` 양쪽에서
2. `setValues` **전에** 서식을 걸어야 한다 (순서가 중요)
3. 읽을 때 `normalizeCode()` 로 복원 — 6자리 미만 순수 숫자면 0 을 채운다

국내/해외 판별은 `nationCode` 가 있으면 그것을 쓰고,
없으면 `isDomestic()` 이 코드 모양(`/^\d[0-9A-Z]{5}$/`)으로 추정한다.
점 유무만으로 판단하면 `TM`(토요타 ADR) 같은 해외 티커를 국내로 오인한다.

## 시트 열

`reutersCode`, `nationCode` 는 내부 조회용이라 숨김 처리된다.

```
종목명 | 코드 | reutersCode | nationCode | 시장 | 국가
      | 현재가 | 전일대비 | 등락률(%) | 통화 | 장상태 | 기준시각 | 갱신시각
```

## 앞으로

- PER·PBR·ROE 등 재무 정보
- 시간 기반 트리거로 자동 갱신
- 보유 수량·평단가 입력 후 수익률 계산
