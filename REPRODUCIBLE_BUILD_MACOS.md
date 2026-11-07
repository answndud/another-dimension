# macOS 재현 빌드 메모

> 이전 daemon 기반 제품의 기록입니다. 현재 브라우저 제품의 빌드 안내가 아닙니다.

현재 제품은 Rust daemon, Rust relay, Rust release tools와 정적 웹 UI로 구성됩니다.
Node.js/npm은 빌드·릴레이·설치에 사용하지 않습니다.

## 고정해야 하는 입력

- source commit
- `Cargo.lock`
- Rust toolchain과 macOS/Xcode Command Line Tools 버전
- `AD_RELEASE_SOURCE_DATE_EPOCH`

## 빌드

```sh
export CARGO_BUILD_JOBS=2
export CARGO_INCREMENTAL=0
export CARGO_TARGET_DIR="$PWD/.build-cache/cargo-target"
cargo build --release --locked --offline \
  -p another-dimension-daemon \
  -p another-dimension-relay \
  -p another-dimension-tools
scripts/build_web_static.sh
```

서명된 release는 외부 보관 signing key를 사용해 `scripts/build_release.sh`로
만듭니다. 결과물에는 Rust 실행 파일과 정적 UI만 들어가며 별도 JavaScript
런타임을 포함하지 않습니다.

## 현재 비보장

이 절차는 입력을 고정하지만 서로 다른 Mac에서 byte-for-byte 동일한 Rust
바이너리가 나온다는 증거는 아닙니다. 공개 배포 승인은 clean-builder 비교,
signing key 신뢰 경로와 독립 검토를 별도로 요구합니다.
