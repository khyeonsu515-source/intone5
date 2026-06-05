/*
  =====================================================================
  action_popup.js
  =====================================================================

  이 파일은 브라우저 오른쪽 위의 확장 프로그램 아이콘을 클릭했을 때
  열리는 팝업 창(action_popup.html)에서 실행됩니다.

  이 파일이 하는 일:
  1. 팝업이 열리는 순간 background.js에 현재 상태를 요청합니다.
  2. background.js가 저장소에 상태를 저장하면, 그 변화를 감지해서
     팝업 화면을 자동으로 업데이트합니다.
  3. 분석 단계를 순서대로 보여주는 진행 표시기를 관리합니다.

  ★ 다른 파일과의 관계
     - action_popup.html이 이 파일을 불러옵니다.
     - background.js에 GET_CURRENT_STATUS 메시지를 보내 상태를 요청합니다.
     - background.js가 chrome.storage에 상태를 저장할 때마다
       chrome.storage.onChanged 이벤트로 변화를 감지해 화면을 갱신합니다.

  =====================================================================
*/


// background.js와 이 파일이 같은 키 이름을 사용해야 저장된 데이터를 올바르게 읽음
const STATUS_STORAGE_KEY = "currentAnalysisStatus";

/*
  stageOrder: 분석이 진행되는 순서를 나타내는 배열입니다.
  팝업에서 각 단계의 인덱스를 비교해서 "완료됨/진행 중/대기 중"을 구분합니다.
  예) 현재 단계가 "extracting"(인덱스 2)이면
      인덱스 0,1은 is-done(완료), 인덱스 2는 is-active(진행 중), 3,4,5는 미완료
*/
const stageOrder = [
  "link_detected",   // 0: 링크 위에 마우스 올라감
  "hover_confirmed", // 1: 1초 이상 머묾 확인
  "extracting",      // 2: 기사 본문 다운로드 중
  "news_checking",   // 3: 뉴스 기사인지 AI 판별 중
  "analyzing",       // 4: 신뢰도·어그로도 분석 중
  "complete",        // 5: 분석 완료
  "not_article"      // 6: 뉴스 기사가 아닌 것으로 판별
];

/*
  아래 변수들은 HTML 요소 참조를 담을 것입니다.
  하지만 아직 DOM이 로드되기 전이므로 일단 선언만 합니다.
  DOMContentLoaded 이벤트 안에서 실제 요소를 찾아서 대입합니다.

  let을 쓴 이유: const는 선언과 동시에 값을 넣어야 하는데,
  DOM이 로드되기 전에는 요소를 찾을 수 없으므로 let을 사용합니다.
*/
let labelElement;   // "대기 중", "분석 완료" 등 현재 상태 텍스트를 표시하는 요소
let detailElement;  // 상태에 대한 부가 설명 텍스트 요소
let urlElement;     // 현재 분석 중인 URL을 표시하는 요소
let timeElement;    // 마지막 업데이트 시각을 표시하는 요소
let stepElements;   // <ol id="steps"> 안의 모든 <li> 요소들의 배열


// ─────────────────────────────────────────────
// DOM이 완전히 로드된 후 초기화
// ─────────────────────────────────────────────

/*
  DOMContentLoaded: 브라우저가 HTML 파싱을 완전히 마쳤을 때 발생하는 이벤트입니다.
  이 시점 이후에야 getElementById 같은 함수로 요소를 찾을 수 있습니다.
  이 이벤트 밖에서 요소를 찾으려 하면 아직 만들어지지 않아서 null이 반환됩니다.
*/
document.addEventListener("DOMContentLoaded", () => {
  // HTML 요소들을 찾아서 변수에 저장
  // 이후 renderStatus()에서 이 변수들을 통해 화면 내용을 바꿉니다.
  labelElement  = document.getElementById("status-label");
  detailElement = document.getElementById("status-detail");
  urlElement    = document.getElementById("status-url");
  timeElement   = document.getElementById("status-time");

  // querySelectorAll은 조건에 맞는 모든 요소를 NodeList로 반환합니다.
  // NodeList는 배열처럼 생겼지만 .forEach 외에 .map 등의 메서드가 없어서
  // Array.from()으로 진짜 배열로 변환해서 사용합니다.
  // action_popup.html의 <ol id="steps"> 안에 있는 6개의 <li> 요소가 담깁니다.
  stepElements = Array.from(document.querySelectorAll("#steps li"));

  // 팝업이 열리자마자 background.js에서 현재 상태를 가져와 화면에 표시
  loadStatus();
});


// ─────────────────────────────────────────────
// 저장소 변화 감지 — 실시간 화면 업데이트
// ─────────────────────────────────────────────

/*
  chrome.storage.onChanged: 브라우저 저장소의 어떤 값이 바뀌면 이 이벤트가 발생합니다.
  background.js의 updateStatus()가 저장소에 새 상태를 저장할 때마다 여기가 호출됩니다.
  덕분에 팝업을 닫지 않아도 분석이 진행되면서 화면이 자동으로 갱신됩니다.

  매개변수:
    changes  - 변경된 항목들. { "키이름": { oldValue: 이전값, newValue: 새값 } } 형태
    areaName - 어느 저장소인지 ("local", "sync", "session" 중 하나)
*/
chrome.storage.onChanged.addListener((changes, areaName) => {
  // "local" 저장소에서 STATUS_STORAGE_KEY 키가 바뀐 경우에만 처리
  // sync 저장소 변경 등 관계없는 이벤트는 무시
  if (areaName === "local" && changes[STATUS_STORAGE_KEY]) {
    // changes[STATUS_STORAGE_KEY].newValue : 새로 저장된 상태 객체
    renderStatus(changes[STATUS_STORAGE_KEY].newValue);
  }
});


// ─────────────────────────────────────────────
// background.js에 현재 상태를 요청하는 함수
// ─────────────────────────────────────────────

/*
  loadStatus: 팝업이 처음 열릴 때 호출됩니다.
  chrome.runtime.sendMessage로 background.js에 "지금 상태 알려줘"라는 메시지를 보냅니다.

  chrome.storage.onChanged만 사용하면 팝업이 열리는 시점에 이미 저장된 상태를
  초기값으로 표시할 수 없습니다. 그래서 이 함수로 최초 1회 직접 요청합니다.
*/
function loadStatus() {
  // background.js에 GET_CURRENT_STATUS 메시지를 보냄
  // 두 번째 인수는 background.js가 sendResponse()를 호출할 때 실행되는 콜백
  chrome.runtime.sendMessage({ type: "GET_CURRENT_STATUS" }, (response) => {

    // chrome.runtime.lastError: 메시지 전송 자체가 실패한 경우 (background.js와 통신 불가)
    // response?.ok : 응답이 있고 ok가 true인지 확인 (?. 로 response가 null이어도 안전)
    if (chrome.runtime.lastError || !response?.ok) {
      // 상태를 가져오지 못했어도 기본 메시지를 표시해서 팝업이 빈 화면으로 보이지 않게 함
      renderStatus({
        stage:     "idle",
        label:     "상태를 불러오지 못했습니다",
        detail:    "확장 프로그램을 다시 로드한 뒤 시도하세요.",
        url:       "",
        updatedAt: Date.now()
      });
      return;
    }

    // 정상 응답 — response.status에 현재 상태 객체가 담겨 있음
    renderStatus(response.status);
  });
}


// ─────────────────────────────────────────────
// 받아온 상태 데이터로 팝업 화면을 갱신하는 함수
// ─────────────────────────────────────────────

/*
  renderStatus: 상태 객체를 받아서 팝업의 모든 UI 요소를 업데이트합니다.
  이 함수는 두 곳에서 호출됩니다:
    1. loadStatus()의 콜백 (팝업 최초 열릴 때)
    2. chrome.storage.onChanged 이벤트 (저장소 값이 바뀔 때마다)

  매개변수 status 객체 구조:
    stage     - 단계 식별자 (예: "analyzing")
    label     - 표시할 텍스트 (예: "신뢰도·어그로도 분석 중")
    detail    - 부가 설명 (예: "신뢰도 72/100, 어그로도 38/100")
    url       - 분석 중인 URL
    updatedAt - 업데이트 시각 (밀리초 타임스탬프)
*/
function renderStatus(status = {}) {
  // status가 undefined로 오면 빈 객체를 기본값으로 사용
  const stage = status.stage || "idle";

  // stageOrder 배열에서 현재 단계의 위치(인덱스)를 찾음
  // indexOf()는 찾으면 인덱스(0~5), 못 찾으면 -1을 반환
  const activeIndex = stageOrder.indexOf(stage);
  const terminalStage = stage === "complete" || stage === "not_article";

  // 각 텍스트 요소 내용 갱신
  // .textContent는 innerHTML과 달리 HTML 태그를 텍스트로 그대로 표시해서 XSS 위험이 없음
  labelElement.textContent  = status.label  || "대기 중";
  detailElement.textContent = status.detail || "링크 위에 마우스를 1초 동안 올려두면 시작합니다.";
  urlElement.textContent    = status.url    || "";

  // updatedAt이 있으면 "업데이트: HH:MM:SS" 형식으로 표시
  // new Date(밀리초)로 날짜 객체를 만들고 .toLocaleTimeString()으로 시간 문자열로 변환
  timeElement.textContent = status.updatedAt
    ? `업데이트: ${new Date(status.updatedAt).toLocaleTimeString()}`
    : "";

  /*
    각 단계 <li> 요소에 클래스를 적절히 붙이거나 떼어냅니다.
    classList.toggle(클래스명, 조건): 조건이 true면 클래스 추가, false면 제거

    action_popup.html의 <li data-stage="link_detected">링크 인식</li> 처럼
    각 <li>에는 data-stage 속성이 있어서 이 속성으로 stageOrder 내 위치를 알아냅니다.

    예시 (현재 단계가 "extracting", activeIndex=2):
      link_detected  (stepIndex=0): is-active=false, is-done=true  → 파란색 완료
      hover_confirmed(stepIndex=1): is-active=false, is-done=true  → 파란색 완료
      extracting     (stepIndex=2): is-active=true,  is-done=false → 보라색 진행 중
      news_checking  (stepIndex=3): is-active=false, is-done=false → 회색 미완료
      ...
  */
  stepElements.forEach((element) => {
    // element.dataset.stage: <li data-stage="...">의 data-stage 속성 값
    const stepIndex = stageOrder.indexOf(element.dataset.stage);

    // is-active: 이 단계가 현재 진행 중인 단계인지
    element.classList.toggle("is-active", stepIndex === activeIndex && !terminalStage);

    // is-done: 이 단계가 현재 단계보다 앞에 있는지 (이미 완료된 단계)
    // stepIndex >= 0 조건은 stageOrder에 없는 단계(indexOf = -1)가 done으로 처리되지 않도록 방지
    element.classList.toggle("is-done", activeIndex > stepIndex && stepIndex >= 0);
  });

  // "오류" 상태에서는 진행 단계 표시를 모두 초기화
  // 오류는 정상적인 분석 흐름 밖에 있으므로 단계 표시가 의미가 없음
  if (stage === "error") {
    stepElements.forEach((element) => {
      element.classList.remove("is-active", "is-done");
    });
  }
}
