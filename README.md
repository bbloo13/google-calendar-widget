# Google Calendar Widget

Windows 바탕화면에 띄우는 프레임리스 Google Calendar 위젯 (Electron 기반).

## 기능

- 프레임리스, 투명 배경, 드래그로 위치 이동, 항상 위 표시 없음
- 오늘/내일(일), 이번 주(주), 월 달력(그리드) 세 가지 보기
- 월 보기: 여러 날에 걸친 일정은 막대로 표시, 겹치면 레인을 나눠 배치
- 대한민국 공휴일 캘린더 자동 병합 (초록색으로 구분)
- 일정 클릭 시 설명/장소 펼쳐보기
- 20분마다 자동 새로고침, 수동 새로고침 버튼
- 시스템 트레이 상주 (닫아도 완전 종료되지 않음, 트레이에서 표시/완전 종료)
- "+" 버튼으로 Google 캘린더 웹 열기
- Windows 로그인 시 자동 실행 (선택)

## 요구사항

- Windows
- [Node.js](https://nodejs.org/) (LTS 버전 권장) — `winget install --id OpenJS.NodeJS.LTS -e` 로 설치 가능
- Google 계정 + 아래 "Google Cloud OAuth 설정" 과정을 마친 `credentials.json`

## 설치

```bash
npm install
```

> `npm warn allow-scripts ...` 경고가 뜰 수 있는데, Electron 바이너리 다운로드(postinstall)에는 지장이 없습니다. 혹시 `node_modules/electron/dist/electron.exe`가 없다면 `npm rebuild electron`을 실행해보세요.

## Google Cloud OAuth 설정 (필수, 최초 1회)

이 앱은 사용자 본인의 Google Calendar 데이터를 읽기 위해 OAuth 2.0 "Desktop app(설치된 앱)" 클라이언트가 필요합니다. **각 사용자가 자기 자신의 클라이언트를 직접 만들어야 합니다** (저장소에 포함된 코드에는 시크릿이 없습니다).

### 1. Google Cloud 프로젝트 생성

1. https://console.cloud.google.com 접속
2. 상단 프로젝트 선택기 → "새 프로젝트" → 아무 이름이나 지정 (예: `calendar-widget`) → 만들기

### 2. Google Calendar API 활성화

1. 좌측 메뉴 "API 및 서비스" → "라이브러리"
2. "Google Calendar API" 검색 → 선택 → "사용 설정" 클릭

### 3. OAuth 동의 화면 구성

1. "API 및 서비스" → "OAuth 동의 화면"
2. User Type: **외부(External)** 선택 (일반 Gmail 계정 사용 시)
3. 앱 이름, 지원 이메일, 개발자 연락처 이메일 등 필수 항목만 입력하고 저장
4. 범위(Scopes) 단계에서 딱히 추가하지 않아도 됨 (코드에서 `calendar.readonly` 스코프를 요청함)
5. **테스트 사용자(Test users)** 단계에서 본인의 Gmail 주소를 추가
   - ⚠️ 이 단계를 건너뛰면 로그인 시 `403: access_denied` 오류가 발생합니다.
   - 앱을 "프로덕션(게시)" 상태로 전환하는 것은 권장하지 않습니다 — `calendar.readonly`는 민감한 스코프라 Google의 별도 검증 절차가 필요합니다. 개인용으로는 테스트 사용자 추가만으로 충분합니다.

### 4. OAuth 클라이언트 ID 생성

1. "API 및 서비스" → "사용자 인증 정보" → "+ 사용자 인증 정보 만들기" → "OAuth 클라이언트 ID"
2. **애플리케이션 유형: "데스크톱 앱(Desktop app)"** 선택 (다른 유형 선택 시 loopback 리다이렉트가 동작하지 않음)
3. 이름 아무거나 지정 → 만들기
4. 생성된 클라이언트의 "JSON 다운로드" 클릭

### 5. credentials.json 배치

다운로드한 JSON 파일을 프로젝트 루트에 `credentials.json` 이름으로 저장합니다.

```
calendar-widget/
├── credentials.json   ← 여기
├── package.json
├── src/
└── auth/
```

파일 내용은 대략 이런 형태입니다 (`installed` 키 하위에 `client_id`, `client_secret`, `redirect_uris: ["http://localhost"]` 포함):

```json
{
  "installed": {
    "client_id": "....apps.googleusercontent.com",
    "client_secret": "...",
    "redirect_uris": ["http://localhost"]
  }
}
```

### 6. 로그인 테스트

```bash
npm run test-auth
```

브라우저가 열리며 Google 로그인 화면이 뜹니다. 로그인/동의를 완료하면 콘솔에 오늘/내일 일정이 출력되면 성공입니다. 로그인 토큰은 `%APPDATA%/calendar-widget/token.json`(실제 앱 실행 시) 또는 `auth/.test-userdata/token.json`(테스트 스크립트 실행 시)에 저장되어 이후 재로그인이 필요 없습니다.

## 실행

```bash
npm start
```

## Windows 시작 시 자동 실행 설정 (선택)

콘솔 창 없이 조용히 실행되도록, 시작프로그램 폴더에 `node_modules/electron/dist/electron.exe`를 직접 가리키는 바로가기를 만듭니다.

1. `Win+R` → `shell:startup` 입력 → Enter (시작프로그램 폴더 열림)
2. 그 폴더 안에 새 바로가기 생성
   - 대상: `<프로젝트 경로>\node_modules\electron\dist\electron.exe`
   - 인수(Arguments): `.`
   - 시작 위치(작업 디렉터리): `<프로젝트 경로>` (예: `C:\Users\bbloo\Documents\calendar-widget`)
3. 다음 로그인부터 자동 실행됩니다. 끄려면 바로가기를 삭제하면 됩니다.

## 설정/데이터 파일 위치

| 항목 | 위치 |
|---|---|
| OAuth 클라이언트 (본인이 준비) | `<프로젝트>/credentials.json` |
| 로그인 토큰 | `%APPDATA%/calendar-widget/token.json` |
| 창 위치 기억 | `%APPDATA%/calendar-widget/window-position.json` |
| 시작프로그램 바로가기 | `%APPDATA%/Microsoft/Windows/Start Menu/Programs/Startup/CalendarWidget.lnk` |

## 다른 나라 공휴일 캘린더로 바꾸기

기본값은 대한민국 공휴일(`ko.south_korea#holiday@group.v.calendar.google.com`)입니다. `src/calendarService.js`의 `HOLIDAY_CALENDAR_ID` 상수를 원하는 공개 캘린더 ID로 바꾸면 됩니다.
