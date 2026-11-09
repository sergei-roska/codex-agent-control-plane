import datetime
import json
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE_PATH = ROOT / "state.json"
DB = "file:.runtime/projects/c65886082e/state.sqlite?mode=ro"
CONTEXT = "3ccf85ff-a20a-4eec-990e-ca54e99ec1dd"
OLD_RUN = "bcc2e028-174d-42a9-86d3-56137df31600"
TERMINAL = {"TASK_STATE_COMPLETED", "TASK_STATE_FAILED", "TASK_STATE_CANCELED"}


def utc_now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def save(state):
    tmp = STATE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, ensure_ascii=True, separators=(",", ":")))
    tmp.replace(STATE_PATH)


def emit(state, key, event):
    if key in state["alerts"]:
        return
    event["detectedAt"] = utc_now()
    event["sentAt"] = None
    state["alerts"][key] = event
    save(state)
    print(json.dumps(event, ensure_ascii=True, separators=(",", ":")), flush=True)


def artifact_result(raw):
    disposition = "unknown"
    detail = raw or ""
    try:
        for artifact in json.loads(raw or "[]"):
            for part in artifact.get("parts", []):
                text = part.get("text", "")
                if not text:
                    continue
                detail = text[:800].replace("\n", " ")
                if "Partial result:" in text or "Acceptance: rejected" in text or "Acceptance: unverifiable" in text:
                    disposition = "partial"
                elif "Acceptance: accepted" in text:
                    disposition = "accepted"
                break
    except Exception:
        pass
    return disposition, detail


conn = sqlite3.connect(DB, uri=True, timeout=2)
conn.row_factory = sqlite3.Row
if STATE_PATH.exists():
    state = json.loads(STATE_PATH.read_text())
else:
    known = {row["id"]: row["status_state"] for row in conn.execute("select id,status_state from tasks where context_id=?", (CONTEXT,))}
    seen = [row[0] for row in conn.execute("select event_id from staging_events")]
    live = {row["key"]: row["updated_at"] for row in conn.execute("select key,updated_at from live_activity where ended_at is null")}
    last = conn.execute("select coalesce(max(created_at),'') from staging_events").fetchone()[0]
    state = {"knownRuns": known, "seenEventIds": seen, "lastEventAt": last, "liveActivity": live, "stalled": [], "alerts": {}}
    save(state)
seen = set(state["seenEventIds"])
stalled = set(state.get("stalled", []))
print("WATCH_READY", flush=True)
while True:
    try:
        known = state["knownRuns"]
        runs = set(known)
        for row in conn.execute("select id,status_state from tasks where context_id=?", (CONTEXT,)):
            run_id = row["id"]
            if run_id not in known and run_id != OLD_RUN:
                known[run_id] = row["status_state"]
                runs.add(run_id)
        for row in conn.execute("select event_id,type,run_id,attempt_id,status,payload_json,created_at from staging_events where created_at>? order by created_at", (state["lastEventAt"],)):
            state["lastEventAt"] = max(state["lastEventAt"], row["created_at"])
            event_id = row["event_id"]
            if event_id in seen:
                continue
            seen.add(event_id)
            if row["run_id"] not in runs or row["run_id"] == OLD_RUN:
                continue
            payload = row["payload_json"] or ""
            low = (row["type"] + " " + payload).lower()
            if any(word in low for word in ("eperm", "wakeup socket", "permissionconfig", "permission resolver", "read-only filesystem")):
                emit(state, "event:" + event_id, {"kind": "ipc_or_permission_failure", "runId": row["run_id"], "eventId": event_id, "attemptId": row["attempt_id"], "eventType": row["type"], "status": row["status"], "createdAt": row["created_at"], "evidence": payload[:1000]})
            elif row["type"] in ("owner_decision_required", "decision_required", "human_decision_required"):
                emit(state, "event:" + event_id, {"kind": "human_decision", "runId": row["run_id"], "eventId": event_id, "eventType": row["type"], "status": row["status"], "createdAt": row["created_at"], "evidence": payload[:1000]})
        for row in conn.execute("select id,status_state,status,artifacts from tasks where context_id=?", (CONTEXT,)):
            run_id = row["id"]
            previous = known.get(run_id)
            current = row["status_state"]
            if previous and current != previous:
                known[run_id] = current
                if run_id != OLD_RUN and current in TERMINAL:
                    disposition, detail = artifact_result(row["artifacts"])
                    emit(state, "terminal:" + run_id, {"kind": "run_terminal", "runId": run_id, "state": current, "disposition": disposition, "status": row["status"], "detail": detail})
        now = datetime.datetime.now(datetime.timezone.utc)
        for row in conn.execute("select key,run_id,role,updated_at,phase,summary from live_activity where ended_at is null"):
            run_id = row["run_id"]
            if run_id not in known or run_id == OLD_RUN:
                continue
            try:
                age = (now - datetime.datetime.fromisoformat(row["updated_at"].replace("Z", "+00:00"))).total_seconds()
            except Exception:
                continue
            tag = row["key"]
            if age > 300 and tag not in stalled:
                stalled.add(tag)
                emit(state, "stall:" + tag, {"kind": "activity_stalled", "runId": run_id, "role": row["role"], "phase": row["phase"], "updatedAt": row["updated_at"], "summary": row["summary"][:400]})
        state["seenEventIds"] = list(seen)
        state["stalled"] = list(stalled)
        save(state)
        quota = state.get("quota", {})
        checked = quota.get("checkedAt")
        elapsed = 60
        if checked:
            try:
                checked_at = datetime.datetime.fromisoformat(checked.replace("Z", "+00:00"))
                elapsed = (now - checked_at).total_seconds()
            except Exception:
                pass
        if elapsed >= 60:
            try:
                completed = subprocess.run(
                    ["node", str(ROOT / "quota-once.js")],
                    cwd=ROOT.parents[2],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
                primary = json.loads(completed.stdout) if completed.returncode == 0 else None
            except Exception:
                primary = None
            if isinstance(primary, dict) and isinstance(primary.get("usedPercent"), (int, float)):
                checked_at = utc_now()
                state["quota"] = {
                    "usedPercent": primary["usedPercent"],
                    "windowDurationMins": primary.get("windowDurationMins"),
                    "resetsAt": primary.get("resetsAt"),
                    "checkedAt": checked_at,
                }
                save(state)
                if primary["usedPercent"] >= 90:
                    emit(state, "quota-threshold:" + str(primary.get("resetsAt")), {
                        "kind": "quota_threshold",
                        "usedPercent": primary["usedPercent"],
                        "windowDurationMins": primary.get("windowDurationMins"),
                        "resetsAt": primary.get("resetsAt"),
                    })
                    state["stoppedAt"] = utc_now()
                    state["stopReason"] = "quota threshold reached"
                    save(state)
                    sys.exit(0)
        time.sleep(12)
    except Exception as exc:
        print(json.dumps({"kind": "watch_error", "detectedAt": utc_now(), "error": type(exc).__name__ + ": " + str(exc)[:200]}, ensure_ascii=True), flush=True)
        time.sleep(12)
