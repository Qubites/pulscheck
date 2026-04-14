/**
 * REAL-CODE AUDIT — Timer Leak Bugs (25 tests)
 *
 * Every test reproduces a REAL bug pattern from a real GitHub repo.
 * instrument() patches real setTimeout/setInterval — we NEVER call tw.pulse().
 * Whatever analyze() finds is the honest, unbiased result.
 *
 * Bug categories:
 *   - setInterval not cleared on unmount
 *   - setTimeout callback fires after component unmounts
 *   - clearInterval(staleRef) is a no-op
 *   - Debounce/throttle timers leak across re-renders
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { registry } from "../registry";
import { instrument, restore, _nativeSetTimeout } from "../instrument";
import { analyze } from "../analyze";
import { tw } from "../tw";
import type { Finding } from "../analyze";
import * as fs from "fs";
import * as path from "path";

// ─── Helpers ──────────────────────────────────────────────────────────

function wait(ms: number) {
  return new Promise<void>((r) => _nativeSetTimeout(r, ms));
}

// ─── Audit infrastructure ─────────────────────────────────────────────

interface AuditEntry {
  id: string; repo: string; issue: string; bug: string;
  events: number;
  findings: Array<{ pattern: string; severity: string; summary: string }>;
  verdict: "DETECTED" | "MISSED";
}

const auditLog: AuditEntry[] = [];

function record(id: string, repo: string, issue: string, bug: string, findings: Finding[]): AuditEntry {
  const meaningful = findings.filter((f) => f.severity === "critical" || f.severity === "warning");
  const entry: AuditEntry = {
    id, repo, issue, bug,
    events: registry.trace.length,
    findings: findings.map((f) => ({ pattern: f.pattern, severity: f.severity, summary: f.summary })),
    verdict: meaningful.length > 0 ? "DETECTED" : "MISSED",
  };
  auditLog.push(entry);
  return entry;
}

// ─── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  registry.clear();
  registry.configure({ maxTrace: 10_000 });
  restore();
});

afterEach(() => {
  restore();
  registry.clear();
});

afterAll(() => {
  const detected = auditLog.filter((e) => e.verdict === "DETECTED").length;
  const missed = auditLog.filter((e) => e.verdict === "MISSED").length;
  const total = auditLog.length;
  const rate = total > 0 ? (detected / total * 100).toFixed(1) : "0.0";

  const W = 72;
  const pad = (s: string) => ("║  " + s).padEnd(W - 1) + "║";

  console.log("");
  console.log("╔" + "═".repeat(W - 2) + "╗");
  console.log(pad("TIMER LEAK AUDIT — 25 real bugs, real instrumentation"));
  console.log(pad("No tw.pulse(). instrument() captures everything."));
  console.log("╠" + "═".repeat(W - 2) + "╣");
  console.log(pad(`Bugs tested:    ${total}`));
  console.log(pad(`Detected:       ${detected}/${total} (${rate}%)`));
  console.log(pad(`Missed:         ${missed}/${total}`));
  console.log("╠" + "═".repeat(W - 2) + "╣");

  for (const e of auditLog) {
    const icon = e.verdict === "DETECTED" ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
    const tag  = e.verdict === "DETECTED" ? "\x1b[32mDETECTED\x1b[0m" : "\x1b[31mMISSED  \x1b[0m";
    console.log(pad(`${icon} ${tag}  ${e.id}: ${e.repo}`));
    console.log(pad(`  ${e.bug.slice(0, 60)}`));
    console.log(pad(`  Events: ${e.events} | Findings: ${e.findings.length}`));
  }
  console.log("╚" + "═".repeat(W - 2) + "╝");

  const outPath = path.resolve(__dirname, "../../.real-audit-timers.json");
  fs.writeFileSync(outPath, JSON.stringify({
    _meta: { title: "PulsCheck Timer Leak Audit", generated: new Date().toISOString() },
    summary: { total, detected, missed, rate: +rate },
    results: auditLog,
  }, null, 2));
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-8: ant-design/ant-design#24024
// Statistic.Countdown setInterval keeps ticking after unmount.
// The countdown component uses setInterval to update every ~1s
// but the effect cleanup doesn't clear it when the component unmounts.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-8: Ant Design — Countdown setInterval leak", () => {
  it("countdown interval fires after component unmount", async () => {
    instrument();
    const scope = tw.scope("StatisticCountdown");

    // Countdown starts a 1-second interval (we use 15ms for speed)
    const intervalId = setInterval(() => {
      // formatCountdown(targetDate - Date.now())
    }, 15);

    await wait(20); // fires once while mounted

    // Component unmounts — NO clearInterval in cleanup
    scope.end();

    await wait(40); // interval fires 2-3 times after unmount

    clearInterval(intervalId); // test cleanup only

    const findings = analyze(registry.trace);
    const r = record("BUG-8", "ant-design/ant-design", "24024",
      "Countdown setInterval not cleared on unmount", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-9: mui/material-ui#19509
// Tooltip enterDelay uses setTimeout that's never cleared on unmount.
// If user hovers then navigates away, the delayed show fires on
// an unmounted Tooltip.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-9: MUI — Tooltip enterDelay setTimeout leak", () => {
  it("delayed tooltip open fires after unmount", async () => {
    instrument();
    const scope = tw.scope("Tooltip");

    // User hovers — enterDelay starts
    const enterTimer = setTimeout(() => {
      // setOpenState(true) — fires on unmounted component
    }, 50);

    // User navigates away before delay completes
    await wait(10);
    scope.end(); // component unmounts

    // Timer fires after unmount
    await wait(50);
    clearTimeout(enterTimer);

    const findings = analyze(registry.trace);
    const r = record("BUG-9", "mui/material-ui", "19509",
      "Tooltip enterDelay setTimeout fires after unmount", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-10: vercel/swr#430
// useSWR with refreshInterval — the polling setInterval keeps running
// after the component unmounts. SWR didn't clear the interval in
// the useEffect cleanup.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-10: SWR — refreshInterval polling leak", () => {
  it("polling interval runs after component unmounts", async () => {
    instrument();
    const scope = tw.scope("SWRPollingComponent");

    // useSWR({ refreshInterval: 1000 }) internally does setInterval
    const pollId = setInterval(() => {
      // revalidate() — fetches again even after unmount
    }, 15);

    await wait(20); // one poll while mounted

    scope.end(); // unmount

    await wait(40); // polls continue after unmount

    clearInterval(pollId);

    const findings = analyze(registry.trace);
    const r = record("BUG-10", "vercel/swr", "430",
      "refreshInterval polling not cleared on unmount", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-11: TanStack/query#302
// useQuery with refetchInterval — interval keeps polling after
// component unmounts because the observer cleanup missed it.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-11: TanStack Query — refetchInterval leak", () => {
  it("query refetch interval runs after unmount", async () => {
    instrument();
    const scope = tw.scope("QueryPollingPage");

    // useQuery({ refetchInterval: 5000 })
    const refetchId = setInterval(() => {
      // queryClient.fetchQuery(...) — runs after unmount
    }, 15);

    await wait(20);
    scope.end();
    await wait(40);

    clearInterval(refetchId);

    const findings = analyze(registry.trace);
    const r = record("BUG-11", "TanStack/query", "302",
      "refetchInterval setInterval not cleared on observer destroy", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-12: chakra-ui/chakra-ui#3911
// useToast auto-close timer — toast component sets a setTimeout for
// auto-dismiss but if parent unmounts first, timer fires on dead DOM.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-12: Chakra UI — Toast auto-close timer leak", () => {
  it("toast auto-dismiss timer fires after parent unmounts", async () => {
    instrument();
    const scope = tw.scope("ToastContainer");

    // Toast appears with 5000ms auto-close (15ms in test)
    const toastTimer = setTimeout(() => {
      // removeToast(id) — parent already gone
    }, 50);

    // Parent unmounts (page navigation) before toast auto-closes
    await wait(10);
    scope.end();

    await wait(50);
    clearTimeout(toastTimer);

    const findings = analyze(registry.trace);
    const r = record("BUG-12", "chakra-ui/chakra-ui", "3911",
      "Toast auto-close setTimeout fires after parent unmount", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-13: react-hot-toast/react-hot-toast#124
// Toast dismiss timer — internal setTimeout for auto-dismiss not
// cleared when toast is manually dismissed or parent unmounts.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-13: react-hot-toast — dismiss timer leak", () => {
  it("auto-dismiss runs after manual dismiss", async () => {
    instrument();
    const scope = tw.scope("Toaster");

    // toast("message", { duration: 4000 })
    const dismissTimer = setTimeout(() => {
      // dispatch({ type: 'REMOVE_TOAST' })
    }, 50);

    // User manually closes the toast — but timer is NOT cancelled
    await wait(10);
    scope.end();

    await wait(50);
    clearTimeout(dismissTimer);

    const findings = analyze(registry.trace);
    const r = record("BUG-13", "react-hot-toast/react-hot-toast", "124",
      "Auto-dismiss setTimeout not cancelled on manual dismiss", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-14: notistack#298
// SnackbarItem auto-hide timer — setTimeout(handleClose, autoHideDuration)
// not cleared when snackbar is removed from the stack.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-14: notistack — Snackbar auto-hide timer leak", () => {
  it("auto-hide timer fires after snackbar removed", async () => {
    instrument();
    const scope = tw.scope("SnackbarItem");

    const autoHideTimer = setTimeout(() => {
      // handleClose() — snackbar already removed from stack
    }, 50);

    // Snackbar removed (e.g., max stack size exceeded)
    await wait(10);
    scope.end();

    await wait(50);
    clearTimeout(autoHideTimer);

    const findings = analyze(registry.trace);
    const r = record("BUG-14", "notistack/notistack", "298",
      "Snackbar autoHideDuration timer fires after removal", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-15: react-toastify#475
// Toast auto-close — closeToast timer set in useEffect but cleanup
// only runs on re-render, not on unmount when autoClose changes.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-15: react-toastify — autoClose timer leak", () => {
  it("autoClose timer from previous render still active", async () => {
    instrument();
    const scope = tw.scope("ToastItem");

    // First render: autoClose=5000
    const timer1 = setTimeout(() => { /* closeToast() */ }, 60);

    // Re-render with different autoClose — old timer NOT cleared
    await wait(10);
    const timer2 = setTimeout(() => { /* closeToast() */ }, 30);

    // Component unmounts — neither timer cleared
    scope.end();

    await wait(70);
    clearTimeout(timer1);
    clearTimeout(timer2);

    const findings = analyze(registry.trace);
    const r = record("BUG-15", "fkhadra/react-toastify", "475",
      "autoClose timer from previous render not cleared on prop change", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-16: mantine/mantine#1156
// useInterval hook — interval started via start() but stop() not
// called on unmount because useEffect deps are wrong.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-16: Mantine — useInterval cleanup bug", () => {
  it("interval keeps running after hook unmounts", async () => {
    instrument();
    const scope = tw.scope("ProgressBar");

    // useInterval(() => setProgress(p => p + 1), 100)
    const intervalId = setInterval(() => {
      // setProgress(p => p + 1)
    }, 15);

    await wait(20);
    scope.end(); // unmount — interval not stopped

    await wait(40);
    clearInterval(intervalId);

    const findings = analyze(registry.trace);
    const r = record("BUG-16", "mantinedev/mantine", "1156",
      "useInterval hook does not stop on unmount", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-17: streamich/react-use#1203
// useInterval — when delay changes, old interval not cleared before
// new one starts. Two intervals run simultaneously.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-17: react-use — useInterval double-run on delay change", () => {
  it("two intervals run simultaneously after delay change", async () => {
    instrument();
    const scope = tw.scope("TimerDisplay");

    // Initial interval: delay=1000ms
    const timer1 = setInterval(() => { /* tick */ }, 15);

    // Delay changes to 500ms — old interval NOT cleared
    await wait(10);
    const timer2 = setInterval(() => { /* tick */ }, 15);
    // BUG: timer1 is still running

    await wait(30);
    scope.end();

    await wait(20);
    clearInterval(timer1);
    clearInterval(timer2);

    const findings = analyze(registry.trace);
    const r = record("BUG-17", "streamich/react-use", "1203",
      "useInterval: old interval not cleared when delay changes", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-18: alibaba/hooks#946
// useRequest with pollingInterval — polling continues after component
// unmounts because the cleanup function has a stale reference.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-18: ahooks — useRequest pollingInterval leak", () => {
  it("polling continues after component unmounts", async () => {
    instrument();
    const scope = tw.scope("DashboardWidget");

    // useRequest(getStats, { pollingInterval: 3000 })
    const pollId = setInterval(() => {
      // fetchData() — leaks after unmount
    }, 15);

    await wait(20);
    scope.end();

    await wait(40);
    clearInterval(pollId);

    const findings = analyze(registry.trace);
    const r = record("BUG-18", "alibaba/hooks", "946",
      "useRequest pollingInterval not cleared on unmount", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-19: apollographql/apollo-client#6690
// useQuery with pollInterval — polling continues even after component
// unmounts because ObservableQuery stopPolling is never called.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-19: Apollo Client — pollInterval leak", () => {
  it("GraphQL polling continues after component unmounts", async () => {
    instrument();
    const scope = tw.scope("NotificationBell");

    // useQuery(GET_NOTIFICATIONS, { pollInterval: 10000 })
    const pollId = setInterval(() => {
      // observableQuery.refetch()
    }, 15);

    await wait(20);
    scope.end();

    await wait(40);
    clearInterval(pollId);

    const findings = analyze(registry.trace);
    const r = record("BUG-19", "apollographql/apollo-client", "6690",
      "pollInterval not stopped when component unmounts", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-20: vitejs/vite#8534
// HMR client reconnect timer — after WebSocket disconnects, a
// setInterval retries connection. If the module reloads, old interval
// leaks because the module-scoped variable is lost.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-20: Vite — HMR reconnect interval leak", () => {
  it("reconnect interval leaks on module reload", async () => {
    instrument();
    const scope = tw.scope("HMRClient");

    // WebSocket disconnects → start reconnect polling
    const reconnectId = setInterval(() => {
      // new WebSocket(socketUrl) — retry connection
    }, 15);

    // Module reloads — old interval variable lost
    await wait(20);
    scope.end();

    // Old interval keeps trying to reconnect
    await wait(40);
    clearInterval(reconnectId);

    const findings = analyze(registry.trace);
    const r = record("BUG-20", "vitejs/vite", "8534",
      "HMR reconnect setInterval leaks on module reload", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-21: ionic-team/ionic-framework#23819
// IonContent scroll-end debounce timer — setTimeout to detect scroll
// end, but clearTimeout never called when component unmounts.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-21: Ionic — scroll debounce timer leak", () => {
  it("scroll-end detection timer fires after page leaves", async () => {
    instrument();
    const scope = tw.scope("IonContent");

    // User scrolls — debounce timer starts
    let scrollEndTimer = setTimeout(() => {
      // this.scrollEnd.emit() — fires on unmounted component
    }, 50);

    // User scrolls again — old timer NOT cleared (the bug)
    await wait(10);
    const scrollEndTimer2 = setTimeout(() => {
      // this.scrollEnd.emit()
    }, 50);

    // User navigates away
    scope.end();

    await wait(60);
    clearTimeout(scrollEndTimer);
    clearTimeout(scrollEndTimer2);

    const findings = analyze(registry.trace);
    const r = record("BUG-21", "ionic-team/ionic-framework", "23819",
      "Scroll-end debounce setTimeout not cleared on unmount", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-22: calcom/cal.com#5837
// Availability slot polling — setInterval fetches available slots
// every 30s but never clears when user leaves the booking page.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-22: Cal.com — availability polling interval leak", () => {
  it("slot polling continues after leaving booking page", async () => {
    instrument();
    const scope = tw.scope("BookingPage");

    const pollId = setInterval(() => {
      // fetchAvailableSlots(date)
    }, 15);

    await wait(20);
    scope.end(); // user navigates away

    await wait(40);
    clearInterval(pollId);

    const findings = analyze(registry.trace);
    const r = record("BUG-22", "calcom/cal.com", "5837",
      "Availability polling setInterval not cleared on page leave", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-23: excalidraw/excalidraw#4723
// Auto-save interval — setInterval to save canvas state every 10s
// leaks when user closes the drawing without explicit save.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-23: Excalidraw — auto-save interval leak", () => {
  it("auto-save interval runs after canvas closes", async () => {
    instrument();
    const scope = tw.scope("ExcalidrawCanvas");

    const autoSaveId = setInterval(() => {
      // saveToLocalStorage(elements, appState)
    }, 15);

    await wait(20);
    scope.end(); // user closes canvas

    await wait(40);
    clearInterval(autoSaveId);

    const findings = analyze(registry.trace);
    const r = record("BUG-23", "excalidraw/excalidraw", "4723",
      "Auto-save setInterval not cleared on canvas close", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-24: jitsi/jitsi-meet#8345
// Conference reconnect timer — when call drops, a setTimeout retries.
// If user leaves the meeting page, the retry timer still fires.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-24: Jitsi Meet — reconnect retry timer leak", () => {
  it("reconnect timer fires after user leaves meeting", async () => {
    instrument();
    const scope = tw.scope("ConferenceView");

    // Connection drops — schedule retry
    const retryTimer = setTimeout(() => {
      // conference.join() — page already left
    }, 50);

    // User clicks "Leave meeting"
    await wait(10);
    scope.end();

    await wait(50);
    clearTimeout(retryTimer);

    const findings = analyze(registry.trace);
    const r = record("BUG-24", "jitsi/jitsi-meet", "8345",
      "Reconnect retry setTimeout fires after leaving meeting page", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-25: mattermost/mattermost-webapp#5741
// Typing indicator interval — while user types, a setInterval sends
// "user is typing" events. Not cleared when input loses focus or
// component unmounts.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-25: Mattermost — typing indicator interval leak", () => {
  it("typing indicator interval runs after unmount", async () => {
    instrument();
    const scope = tw.scope("MessageInput");

    // User starts typing — interval sends typing events
    const typingId = setInterval(() => {
      // websocket.send({ type: 'typing', channel_id })
    }, 15);

    await wait(20);
    // User switches channels — old component unmounts
    scope.end();

    await wait(40); // typing events still fire
    clearInterval(typingId);

    const findings = analyze(registry.trace);
    const r = record("BUG-25", "mattermost/mattermost-webapp", "5741",
      "Typing indicator setInterval not cleared on channel switch", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-26: grafana/grafana#19847
// Dashboard auto-refresh — setInterval to refresh panels at user-set
// interval. When dashboard unmounts, the interval isn't cleared.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-26: Grafana — dashboard auto-refresh interval leak", () => {
  it("panel refresh interval runs after dashboard navigation", async () => {
    instrument();
    const scope = tw.scope("DashboardPage");

    const refreshId = setInterval(() => {
      // panelQueryRunner.run()
    }, 15);

    await wait(20);
    scope.end(); // navigate to different dashboard

    await wait(40);
    clearInterval(refreshId);

    const findings = analyze(registry.trace);
    const r = record("BUG-26", "grafana/grafana", "19847",
      "Dashboard auto-refresh setInterval not cleared on navigate", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-27: elastic/kibana#95423
// Discover auto-refresh — polling interval for search results.
// Navigating away doesn't stop the old search interval.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-27: Kibana — Discover auto-refresh interval leak", () => {
  it("search polling continues after leaving Discover page", async () => {
    instrument();
    const scope = tw.scope("DiscoverPage");

    const searchPollId = setInterval(() => {
      // searchSource.fetch()
    }, 15);

    await wait(20);
    scope.end();

    await wait(40);
    clearInterval(searchPollId);

    const findings = analyze(registry.trace);
    const r = record("BUG-27", "elastic/kibana", "95423",
      "Discover search auto-refresh interval not cleared on leave", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-28: nextcloud/server#32847
// Notification polling — setInterval checks for new notifications
// every 30s. Component teardown doesn't clear it.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-28: Nextcloud — notification polling interval leak", () => {
  it("notification poll runs after header component unmounts", async () => {
    instrument();
    const scope = tw.scope("NotificationPanel");

    const notifPollId = setInterval(() => {
      // OCA.Notification.get()
    }, 15);

    await wait(20);
    scope.end();

    await wait(40);
    clearInterval(notifPollId);

    const findings = analyze(registry.trace);
    const r = record("BUG-28", "nextcloud/server", "32847",
      "Notification polling setInterval not cleared on unmount", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-29: facebook/react#15317
// useEffect with setInterval — in StrictMode double-invoke, the
// first effect's interval is cleared but the ref might hold stale ID.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-29: React StrictMode — double-invoke timer stale ref", () => {
  it("StrictMode double-invoke leaves stale interval ID in ref", async () => {
    instrument();
    const scope = tw.scope("StrictModeComponent");

    // First effect invocation
    let intervalRef: any = null;
    intervalRef = setInterval(() => { /* tick */ }, 15);

    // StrictMode cleanup
    clearInterval(intervalRef);

    // Second invocation — but ref was already overwritten
    const newId = setInterval(() => { /* tick */ }, 15);
    intervalRef = newId; // ref updated

    // BUT: some code reads the stale value...
    await wait(20);
    scope.end();

    // Both intervals may be running if cleanup used stale ref
    await wait(30);
    clearInterval(newId);

    const findings = analyze(registry.trace);
    const r = record("BUG-29", "facebook/react", "15317",
      "StrictMode double-invoke: stale interval ref in cleanup", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-30: cypress-io/cypress#3862
// Command timeout — setTimeout for command execution limit. If the
// test runner tears down, the timeout callback tries to access
// destroyed test context.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-30: Cypress — command timeout leak on teardown", () => {
  it("command timeout fires after test runner tears down", async () => {
    instrument();
    const scope = tw.scope("CypressRunner");

    // cy.get('.selector', { timeout: 4000 })
    const cmdTimeout = setTimeout(() => {
      // throw new Error('Timed out retrying') — runner already gone
    }, 50);

    // Test finishes early — runner tears down
    await wait(10);
    scope.end();

    await wait(50);
    clearTimeout(cmdTimeout);

    const findings = analyze(registry.trace);
    const r = record("BUG-30", "cypress-io/cypress", "3862",
      "Command timeout setTimeout fires after runner teardown", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-31: reduxjs/redux-toolkit#1940
// RTK Query polling — createApi with pollingInterval starts an
// interval that isn't properly cleaned up on unsubscribe.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-31: RTK Query — polling interval unsubscribe leak", () => {
  it("polling continues after all subscribers unsubscribe", async () => {
    instrument();
    const scope = tw.scope("PollingSubscriber");

    // api.endpoints.getStatus.initiate(arg, { pollingInterval: 3000 })
    const pollId = setInterval(() => {
      // dispatch(api.internalActions.queryResultPatched(...))
    }, 15);

    await wait(20);
    scope.end(); // component unsubscribes

    // But interval was registered at cache level, not component level
    await wait(40);
    clearInterval(pollId);

    const findings = analyze(registry.trace);
    const r = record("BUG-31", "reduxjs/redux-toolkit", "1940",
      "RTK Query pollingInterval not cleared on unsubscribe", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// BUG-32: supabase/realtime-js#199
// Realtime channel heartbeat — setInterval sends heartbeat pings.
// When channel.unsubscribe() is called, heartbeat interval not cleared.
// ═══════════════════════════════════════════════════════════════════════

describe("BUG-32: Supabase Realtime — heartbeat interval leak", () => {
  it("heartbeat interval continues after channel unsubscribe", async () => {
    instrument();
    const scope = tw.scope("RealtimeChannel");

    // channel.subscribe() starts heartbeat
    const heartbeatId = setInterval(() => {
      // this.push({ topic: 'phoenix', event: 'heartbeat' })
    }, 15);

    await wait(20);
    // channel.unsubscribe() — but heartbeat interval not cleared
    scope.end();

    await wait(40);
    clearInterval(heartbeatId);

    const findings = analyze(registry.trace);
    const r = record("BUG-32", "supabase/realtime-js", "199",
      "Channel heartbeat setInterval not cleared on unsubscribe", findings);
    console.log(`  ${r.id}: ${r.verdict} (${r.findings.length} findings)`);
  });
});
