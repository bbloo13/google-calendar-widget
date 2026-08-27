# Google Calendar Widget

Windows 바탕화면에 띄우는 프레임리스 Google Calendar 위젯 (Electron 기반).

## 기능

### 캘린더 위젯
- 프레임리스, 투명 배경, 드래그로 위치 이동, 항상 위 표시 없음
- 오늘/내일(일), 이번 주(주), 월 달력(그리드) 세 가지 보기
- 월 보기: 여러 날에 걸친 일정은 막대로 표시, 겹치면 레인을 나눠 배치
- 대한민국 공휴일 캘린더 자동 병합 (초록색으로 구분)
- 일정 클릭 시 설명/장소 펼쳐보기
- **일정 제목 우클릭 → 수정/삭제**, **펼친 설명란은 클릭하면 바로 수정** (내 캘린더 일정만 가능, 공휴일 항목은 읽기 전용)
- 20분마다 자동 새로고침, 수동 새로고침 버튼
- 시스템 트레이 상주 (닫아도 완전 종료되지 않음, 트레이에서 표시/완전 종료)
- "+" 버튼으로 Google 캘린더 웹 열기
- Windows 로그인 시 자동 실행 (선택)

### 메모장 (별도 창, 트레이/위젯의 📝 버튼으로 열기)
- Google Drive에 전용 폴더를 자동으로 만들어 그 안에서만 동작 (자세한 내용은 [메모장](#메모장) 항목 참고)
- 카테고리 안에 하위 카테고리를 만들 수 있는 트리 구조, ▸/▾ 로 펼치기/접기
- 카테고리·메모 모두 드래그로 순서 변경, 메모는 다른 카테고리로 드래그해서 이동도 가능
- 우클릭 메뉴로 이름 변경 / 삭제 (삭제는 확인 절차 있음, Drive 휴지통으로 이동해 복구 가능)
- 제목 + 본문을 함께 검색 (카테고리 안이 아니라 전체 메모 대상)
- 메모에서 바로 "일정에 추가" — 제목/본문이 그대로 캘린더 일정으로, 날짜 범위(시작~종료) 지정 가능

공용 UI 요소 (삭제 확인창 등)는 앱 전체에서 같은 다크 테마 디자인을 씁니다.

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

### 2. Google Calendar API / Google Drive API 활성화

1. 좌측 메뉴 "API 및 서비스" → "라이브러리"
2. "Google Calendar API" 검색 → 선택 → "사용 설정" 클릭
3. 같은 방법으로 "Google Drive API"도 검색해서 "사용 설정" 클릭 (메모장 기능에 필요)
   - ⚠️ 둘 중 하나라도 활성화를 빼먹으면 해당 기능에서 `403 accessNotConfigured` 오류가 납니다. 활성화 직후에는 전파에 몇 분 걸릴 수 있습니다.

### 3. OAuth 동의 화면 구성

1. "API 및 서비스" → "OAuth 동의 화면"
2. User Type: **외부(External)** 선택 (일반 Gmail 계정 사용 시)
3. 앱 이름, 지원 이메일, 개발자 연락처 이메일 등 필수 항목만 입력하고 저장
4. 범위(Scopes) 단계에서 딱히 추가하지 않아도 됨 (코드에서 `calendar.readonly`, `calendar.events`, `drive.file` 스코프를 요청함 — 각각 일정 읽기, 메모에서 만든 일정 추가, 앱이 만든 메모 파일 접근용)
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

## 메모장

트레이 메뉴 "메모장 열기" 또는 위젯의 📝 버튼으로 별도 창을 엽니다.

### 전용 Drive 폴더 (가장 중요한 동작 원리)

메모장을 처음 열면 Google Drive에 **"Calendar Widget 메모"** 폴더가 자동으로 만들어지고, 이 폴더가 메모장의 "메인 루트"가 됩니다.

- 사이드바의 모든 카테고리(및 하위 카테고리)는 이 폴더 밑의 하위 폴더이고, 메모는 그 안의 `.md` 파일입니다. drive.google.com에서 이 폴더를 직접 열어도 똑같은 구조로 보이고 편집도 가능합니다.
- 앱은 `drive.file` 스코프만 사용합니다 — **이 앱이 직접 만든 파일/폴더에만 접근**하고, Drive 전체를 읽지 않습니다. 즉 이 전용 폴더 바깥의 파일은 애초에 앱이 볼 수 없고, 반대로 이 폴더 안의 것은 다른 기기/세션에서 다시 로그인해도 그대로 이어서 보입니다.
- 이 폴더는 앱이 알아서 찾고 없으면 만드는 방식이라 별도 설정이 필요 없습니다 — 처음 실행할 때 자동으로 준비됩니다.
- 사이드바 하단의 "Google Drive에서 열기" 링크로 이 폴더를 브라우저에서 바로 열 수 있습니다.

### 그 외 기능

- 카테고리 우클릭 → 하위 카테고리 추가 / 이름 변경 / 삭제. 메모도 우클릭으로 이름 변경 / 삭제 가능 (에디터의 🗑 버튼과 동일 동작)
- 카테고리·메모 모두 드래그로 순서 변경, 메모를 다른 카테고리 위로 드래그하면 그쪽으로 이동
- 상단 검색창은 제목과 본문을 모두 대상으로 전체 카테고리에서 검색
- 메모 에디터의 📅 버튼으로 해당 메모를 Google 캘린더 일정으로 바로 추가 (제목 + 본문이 설명란까지 그대로 전달되고, 날짜는 시작~종료로 범위 지정 가능)
- 삭제는 항상 Drive 휴지통으로 이동하는 방식이라 복구 가능합니다

이 기능이 처음 추가된 버전을 실행하면, 새로 추가된 스코프(`calendar.events`, `drive.file`) 동의를 위해 브라우저 로그인 창이 한 번 더 뜹니다 — 정상입니다.

## 다른 나라 공휴일 캘린더로 바꾸기

기본값은 대한민국 공휴일(`ko.south_korea#holiday@group.v.calendar.google.com`)입니다. `src/calendarService.js`의 `HOLIDAY_CALENDAR_ID` 상수를 원하는 공개 캘린더 ID로 바꾸면 됩니다.
