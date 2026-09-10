# 개인정보처리방침 (Privacy Policy)

**Calendar Widget**은 개인 용도로 만들어진 Windows 데스크톱 앱입니다. 별도의 서버 없이, 사용자의 컴퓨터에서 사용자 본인의 Google 계정으로 직접 Google API에 접속하는 구조입니다.

## 이 앱이 요청하는 권한(스코프)과 사용 목적

- `https://www.googleapis.com/auth/calendar.readonly`, `https://www.googleapis.com/auth/calendar.events` — 사용자 본인의 Google 캘린더 일정을 위젯에 표시하고, 위젯/메모장에서 만든 일정을 추가·수정·삭제하기 위해 사용합니다.
- `https://www.googleapis.com/auth/drive.file` — 이 앱이 직접 만든 파일/폴더에만 접근하는 제한된 권한입니다. 메모(마크다운 파일)와 첨부파일을 저장하기 위한 전용 폴더("Calendar Widget 메모") 안에서만 동작하며, 그 밖의 Google Drive 파일에는 접근하지 않습니다.

## 데이터 처리 방식

- 이 앱에는 별도의 백엔드 서버가 없습니다. 모든 요청은 사용자의 컴퓨터에서 Google API로 직접 이루어집니다.
- 캘린더 일정, 메모, 첨부파일은 전부 사용자 본인의 Google 계정(Google Calendar, Google Drive)에만 저장됩니다. 개발자를 포함한 어떤 제3자도 이 데이터를 전달받거나 열람하지 않습니다.
- OAuth 인증 토큰은 사용자 컴퓨터의 로컬 앱 데이터 폴더에만 저장되며, 외부로 전송되지 않습니다.

## 개인용 앱 안내

이 앱은 개발자 본인의 개인적인 용도로 만들어졌으며, 불특정 다수를 대상으로 배포되지 않습니다.

## 문의

문의 사항은 아래 이메일로 연락해 주세요.

bbloo@naver.com
