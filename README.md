# 260729_finance

NPay증권([stock.naver.com](https://stock.naver.com/)) 데이터를 구글 스프레드시트로 가져오는 Apps Script 프로젝트.
종목을 검색해 추가하고, 현재 시세를 갱신하고, 삭제할 수 있다. 국내·해외 모두 지원한다.

## 구성

| 파일 | 설명 |
| --- | --- |
| `src/Code.gs` | 검색·추가·시세갱신·삭제 서버 로직 |
| `src/Index.html` | 웹앱 화면 |
| `src/appsscript.json` | 매니페스트 (타임존, 권한, 웹앱 설정) |
| `.clasp.json` | clasp 프로젝트 설정 (`rootDir: src`) |

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

배포 후 웹앱 URL에 접속하면 검색창과 보유 종목 표가 나온다.
최초 실행 시 권한 승인이 필요하다 (스프레드시트 접근 + 외부 요청).

## 동작 방식

이 스크립트는 스프레드시트에 바인딩되지 않은 **독립 스크립트**다.
따라서 `getActiveSpreadsheet()` 대신 `openById()` 로 타겟 시트를 연다.
상단 메뉴(`onOpen`)는 바인딩된 스크립트에서만 동작하므로, 조작은 배포된 웹앱 화면에서 한다.

타겟 시트는 `DEFAULT_SPREADSHEET_ID` 에 박혀 있지만,
스크립트 속성 `TARGET_SPREADSHEET_ID` 가 있으면 그 값이 우선한다.
바꾸려면 편집기에서 실행:

```js
setTargetSpreadsheet('새로운_스프레드시트_ID');
```

## 검색 노출 차단

세 겹으로 막아뒀다.

1. **접근 권한** — `appsscript.json` 의 `webapp.access` 가 `MYSELF` 라
   배포 계정 외에는 로그인 리다이렉트(302)를 받는다. 크롤러는 본문에 도달하지 못한다.
   공개로 바꾸려면 이 값을 `ANYONE` 으로 고치는데, 그러면 아래 메타 태그만 남는다.
2. **`doGet` 메타 태그** — `noindex, nofollow, noarchive, nosnippet`
3. **`Index.html` 메타 태그** — 웹앱은 iframe 안에서 렌더링되므로 안쪽 문서에도 걸어둔다.

`robots.txt` 는 쓸 수 없다. 웹앱 URL 이 `script.google.com/macros/s/...` 로 고정이라
도메인 루트에 파일을 둘 수 없고, `X-Robots-Tag` 응답 헤더도 설정할 수 없다.

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
