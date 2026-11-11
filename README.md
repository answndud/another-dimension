# Another Dimension

Another Dimension은 계정이나 운영자 서버 없이 코드로 연결하는 1:1 브라우저 채팅 프로젝트입니다. 대화는 브라우저 메모리에 유지하고, 연결된 상대와 재접속 복원을 위해 암호화된 대화 데이터를 공개 relay로 전송합니다. TXT 저장은 사용자가 직접 선택합니다.

**현재 코드 기반 연결과 암호화 메시지 전송이 구현 중입니다. 독립 보안 검토와 실제 기기 간 확인을 마치지 않았으므로 민감한 대화에 사용하지 마세요.**

화면은 HTML·CSS·JavaScript를 사용하며, macOS Chrome과 Android Chrome을 우선 지원 대상으로 합니다. GitHub Pages에 정적 배포하는 것을 목표로 합니다. 공개 relay로 연결 정보를 교환하고, WebRTC 직접 연결이 불가능할 때는 암호화된 메시지를 relay로 전달합니다. 현재 세 relay 중 하나 이상에 암호화된 대화 이벤트도 게시해, 한쪽이 방에 남아 있으면 재접속한 상대와 대화를 동기화합니다. relay 보관 기간은 앱이 통제하지 않습니다.

새로고침 후 재연결을 위해 입장 코드를 현재 탭의 세션 저장소에 임시 보관하고, `방 나가기`를 누르면 지웁니다. 브라우저의 탭 복원 기능에 따라 코드가 다시 나타날 수 있습니다.

새 메시지 알림은 사용자가 허용한 경우에만 표시됩니다. 모바일 알림에는 서비스 워커를 사용하지만 푸시 알림이나 백그라운드 메시지 수신은 제공하지 않습니다. 세 번째 접속 안내는 가능한 경우 표시되며 동시 입장에서 두 명 제한을 보장하지는 않습니다.

## 기술 구성

Another Dimension은 별도의 프런트엔드 프레임워크나 자체 채팅 서버 없이, 브라우저 기능과 필요한 통신·암호화 라이브러리를 조합합니다.

| 영역 | 기술 | 프로젝트에서의 역할 |
| --- | --- | --- |
| 화면 | HTML5, CSS3, JavaScript ES modules | 정적 화면, 반응형 레이아웃, 대화 및 모달 인터페이스를 구현합니다. |
| 직접 연결 | WebRTC DataChannel, ICE, STUN | 브라우저 간 직접 데이터 연결을 시도합니다. 연결 후보를 찾기 위해 Cloudflare STUN을 사용합니다. |
| 연결 및 대체 경로 | Nostr 프로토콜, WebSocket, 공개 relay | 상대방을 찾고 연결 정보를 교환합니다. 직접 연결이 불가능할 때는 암호화된 메시지를 relay로 전달합니다. |
| 암호화 | Noise Protocol `NNpsk0`, Web Crypto API, HKDF-SHA-256 | 입장 코드에서 용도별 값을 파생하고, 공유 비밀을 이용한 세션과 암호화 프레임을 구성합니다. 순번을 사용해 중복·재전송을 제한합니다. |
| 브라우저 기능 | `sessionStorage`, Clipboard API, Blob·Object URL | 탭에서 재연결용 코드를 임시 보관하고, 코드를 복사하거나 코드와 대화를 TXT로 저장합니다. |
| 알림 | Notifications API, Service Worker | 사용자가 허용한 경우 새 메시지 알림을 표시합니다. 푸시나 백그라운드 수신을 제공하지 않습니다. |
| 빌드 | Node.js, npm, esbuild | 브라우저용 JavaScript와 의존성을 번들링하고 정적 배포 파일을 생성합니다. |
| 검증 | Node.js 내장 테스트 러너, Bash, GitHub Actions | 자동 테스트와 기본 정적 검증, CI 빌드를 수행합니다. |
| 배포 목표 | GitHub Pages | 빌드된 정적 파일을 제공하는 호스팅 환경입니다. |

직접 의존성은 `noise-handshake` **4.2.0**, `nostr-tools` **2.26.0**, `sodium-javascript` **0.8.0**이며, 빌드에는 `esbuild` **0.25.12**를 사용합니다. 버전은 잠금 파일로 관리합니다.

공개 relay, STUN, 정적 호스팅은 외부 서비스입니다. relay는 접속 및 전송 메타데이터와 게시된 암호문을 볼 수 있고, 직접 연결 상대방에게 IP 주소가 노출될 수 있습니다. 프로토콜 구성은 독립적인 보안 검토를 받지 않았습니다. 자세한 내용은 [보안 안내](SECURITY.md)를 참고하세요.

## 로컬 확인

Node.js 24 LTS가 필요합니다. Node.js 20은 지원이 종료됐습니다. [현재 지원 버전](https://nodejs.org/en/about/previous-releases)을 확인하세요.

```sh
cd apps/web
npm ci
npm run build
python3 -m http.server 8000 --directory dist
```

브라우저에서 `http://127.0.0.1:8000/`을 엽니다. 다른 기기에서 접속하려면 HTTPS 제공 환경이 필요합니다.

## 기본 검증

Node.js와 Bash가 필요합니다.

```sh
bash scripts/verify_light.sh
```

이전 daemon·relay·React 제품과 관련 `reference/`, `docs2/`, `capture/` 자료는 새로운 제품의 동작을 나타내지 않습니다. 이전 코드는 Git 이력에서 확인할 수 있습니다. 보안 상태는 [SECURITY.md](SECURITY.md)를 참고하세요.
