#!/usr/bin/env python3
"""Reproducible aggregate metrics from the frozen Harness SQLite snapshot."""
import json
import sqlite3
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

DB = Path(sys.argv[1]) if len(sys.argv) > 1 else Path('/tmp/harness-audit-20261019-jlcuqqwq/snapshot.sqlite')
CAPTURE = '2026-10-19T08:33:51.211293Z'
WINDOWS = {
    '2026-10-18': ('2026-10-17T21:00:00Z', '2026-10-18T21:00:00Z'),
    '2026-10-19': ('2026-10-18T21:00:00Z', CAPTURE),
}
TOKEN_KEYS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens']


def dt(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))


def overlap(start, end, lo, hi):
    a, b = max(start, lo), min(end, hi)
    return max(0.0, (b-a).total_seconds())


def concurrency_stats(intervals):
    events = []
    for a, b in intervals:
        events.extend([(a, 1), (b, -1)])
    events.sort(key=lambda item: (item[0], item[1]))
    active = peak = 0
    overlap_ms = 0.0
    previous = None
    for at, change in events:
        if previous is not None and active >= 2:
            overlap_ms += (at - previous).total_seconds() * 1000
        active += change
        peak = max(peak, active)
        previous = at
    return peak, round(overlap_ms)


def main():
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    usage = [dict(r) for r in db.execute('SELECT * FROM usage_ledger')]
    journals = [dict(r) for r in db.execute('SELECT * FROM dispatch_journal')]
    executions = [dict(r) for r in db.execute('SELECT * FROM writer_executions')]
    out = {'source': 'frozen SQLite snapshot; row counts/tokens attributed by started_at; elapsed intervals from all ledger rows overlapping each calendar window, clipped to boundaries', 'capture_utc': CAPTURE, 'timezone': 'Europe/Chisinau (UTC+03:00)', 'windows_utc': {}, 'token_semantics': {'inputTokens': 'reported input total including cached input', 'cachedInputTokens': 'cached portion of inputTokens', 'uncachedInputTokens': 'inputTokens - cachedInputTokens where both known and consistent', 'outputTokens': 'reported output tokens', 'reasoningOutputTokens': 'reasoning subset of outputTokens; not additive', 'totalTokens': 'reported server total; not recomputed', 'attribution': 'row attributed wholly to started_at day; no prorating; missing values stay unknown'}, 'days': {}}
    for day, (los, his) in WINDOWS.items():
        lo, hi = dt(los), dt(his)
        out['windows_utc'][day] = [los, his]
        rows = []
        for r in usage:
            if not r['started_at']:
                continue
            st = dt(r['started_at'])
            if lo <= st < hi:
                rows.append(r)
        # Count/token rows stay attributed by started_at. Elapsed intervals instead come from
        # every ledger row overlapping this day, including rows started on the prior day.
        intervals = []
        worker_intervals = []
        role = defaultdict(lambda: {'rows': 0, 'elapsed_ms_sum_clipped': 0, 'turns_known_sum': 0, 'turns_unknown_rows': 0})
        for r in usage:
            if r['started_at'] and r['elapsed_ms'] is not None:
                st = dt(r['started_at']); en = st + __import__('datetime').timedelta(milliseconds=r['elapsed_ms'])
                secs = overlap(st, en, lo, hi)
                if secs:
                    clipped = (max(st, lo), min(en, hi))
                    role[r['role']]['elapsed_ms_sum_clipped'] += round(secs * 1000)
                    intervals.append(clipped)
                    if r['kind'] == 'worker_turn': worker_intervals.append(clipped)
        tokens = {k: {'known_rows': 0, 'unknown_rows': 0, 'sum': 0} for k in TOKEN_KEYS + ['uncachedInputTokens']}
        role_tokens = defaultdict(lambda: {'known_total_tokens': 0, 'unknown_total_token_rows': 0})
        startup = {'known_rows': 0, 'unknown_rows': 0, 'cold_start_true': 0, 'cold_start_false': 0}
        queue = {'known_rows': 0, 'unknown_rows': 0, 'sum_ms': 0}
        req_known = retries_known = req_sum = retries_sum = 0
        for r in rows:
            rr = role[r['role']]; rr['rows'] += 1
            if r['turns'] is None: rr['turns_unknown_rows'] += 1
            else: rr['turns_known_sum'] += r['turns']
            if r['model_requests'] is not None: req_known += 1; req_sum += r['model_requests']
            if r['retries'] is not None: retries_known += 1; retries_sum += r['retries']
            for fld, obj in [('startup_ms', startup), ('queue_wait_ms', queue)]:
                if r[fld] is None: obj['unknown_rows'] += 1
                else:
                    obj['known_rows'] += 1
                    if fld == 'queue_wait_ms': obj['sum_ms'] += r[fld]
            if r['cold_start'] is None: pass
            elif r['cold_start']: startup['cold_start_true'] += 1
            else: startup['cold_start_false'] += 1
            vals = json.loads(r['tokens_json']) if r['tokens_json'] else {}
            for k in TOKEN_KEYS:
                v = vals.get(k)
                if isinstance(v, (int, float)):
                    tokens[k]['known_rows'] += 1; tokens[k]['sum'] += v
                    if k == 'totalTokens': role_tokens[r['role']]['known_total_tokens'] += v
                else:
                    tokens[k]['unknown_rows'] += 1
                    if k == 'totalTokens': role_tokens[r['role']]['unknown_total_token_rows'] += 1
            iv, cv = vals.get('inputTokens'), vals.get('cachedInputTokens')
            unc = iv-cv if isinstance(iv, (int,float)) and isinstance(cv, (int,float)) and iv >= cv else None
            if unc is None: tokens['uncachedInputTokens']['unknown_rows'] += 1
            else: tokens['uncachedInputTokens']['known_rows'] += 1; tokens['uncachedInputTokens']['sum'] += unc
        # Union and concurrency sweep avoid double-counting overlapping turns.
        intervals.sort(); union = 0.0; cur = None
        for a,b in intervals:
            if cur is None: cur=(a,b)
            elif a <= cur[1]: cur=(cur[0], max(cur[1],b))
            else: union += (cur[1]-cur[0]).total_seconds(); cur=(a,b)
        if cur: union += (cur[1]-cur[0]).total_seconds()
        peak, overlap_ms = concurrency_stats(intervals)
        worker_peak, worker_overlap_ms = concurrency_stats(worker_intervals)
        # elapsed and known-token shares by work class; reasoning remains within output.
        groups = {'engineering': {'engineer','recovery-engineer','senior-engineer'}, 'coordinator': {'coordinator'}, 'explorer': {'explorer'}, 'review': {'auditor','verifier'}}
        elapsed_total = sum(x['elapsed_ms_sum_clipped'] for x in role.values())
        token_total = tokens['totalTokens']['sum']
        role_shares = {}
        for name, names in groups.items():
            elapsed = sum(role[x]['elapsed_ms_sum_clipped'] for x in names if x in role)
            known_tokens = sum(role_tokens[x]['known_total_tokens'] for x in names)
            role_shares[name] = {'elapsed_ms': elapsed, 'elapsed_share': elapsed/elapsed_total if elapsed_total else None, 'known_total_tokens': known_tokens, 'known_total_token_share': known_tokens/token_total if token_total else None}
        day_j = [j for j in journals if j['created_at'] and lo <= dt(j['created_at']) < hi]
        day_e = [e for e in executions if e['created_at'] and lo <= dt(e['created_at']) < hi]
        outcomes = Counter(); outcomes_by_role = defaultdict(Counter); statuses = Counter(); lane_states = Counter(); integrated_paths = 0;
        for j in day_j:
            if j['result_json']:
                try:
                    x=json.loads(j['result_json']); statuses[x.get('status','unknown')]+=1
                    lane=(x.get('writerExecution') or {}).get('lane') or {}
                    if lane.get('state'): lane_states[lane['state']]+=1
                    if lane.get('state') == 'integrated': integrated_paths += len(lane.get('attemptedPaths') or [])
                    for a in x.get('artifacts',[]) or []:
                        try:
                            report=json.loads(a.get('text',''))
                            if isinstance(report,dict) and report.get('outcome'):
                                outcomes[report['outcome']]+=1; outcomes_by_role[j['role']][report['outcome']]+=1
                        except Exception: pass
                except Exception: statuses['unparseable']+=1
            else: statuses['no_result']+=1
        delta_count=Counter(); changed_paths=0
        for e in day_e:
            if e['delta_json']:
                try:
                    d=json.loads(e['delta_json']); delta_count['known'] += bool(d.get('known'))
                    delta_count['head_changed'] += bool(d.get('headChanged'))
                    delta_count['empty_changed_paths'] += not bool(d.get('changedPaths'))
                    changed_paths += len(d.get('changedPaths') or [])
                except Exception: delta_count['unparseable']+=1
            else: delta_count['unknown']+=1
        long = [r for r in rows if r['elapsed_ms'] is not None and r['elapsed_ms'] >= 3600000]
        out['days'][day] = {
            'usage_rows': len(rows), 'usage_rows_by_kind': dict(Counter(r['kind'] for r in rows)), 'usage_rows_by_role': dict(Counter(r['role'] for r in rows)),
            'roles': dict(role), 'elapsed_ms_sum_clipped': sum(x['elapsed_ms_sum_clipped'] for x in role.values()),
            'elapsed_union_ms': round(union*1000), 'peak_concurrent_usage_rows': peak, 'overlap_ms_at_concurrency_ge_2': overlap_ms, 'worker_peak_concurrency': worker_peak, 'worker_overlap_ms_at_concurrency_ge_2': worker_overlap_ms, 'elapsed_token_shares_by_role_group': role_shares,
            'dispatches_attempts_created': len(day_j), 'distinct_assignments_dispatched': len({j['assignment_id'] for j in day_j}), 'repeat_assignment_attempts': len(day_j)-len({j['assignment_id'] for j in day_j}), 'dispatch_states': dict(Counter(j['state'] for j in day_j)),
            'worker_model_request_counts': {'known_rows': req_known, 'unknown_rows': len(rows)-req_known, 'known_sum': req_sum},
            'retry_counts': {'known_rows': retries_known, 'unknown_rows': len(rows)-retries_known, 'known_sum': retries_sum},
            'tokens': tokens, 'startup': startup, 'queue_wait': queue,
            'writer_executions_created': len(day_e), 'writer_executions_by_role': dict(Counter(e['role'] for e in day_e)), 'writer_execution_states': dict(Counter(e['state'] for e in day_e)),
            'writer_delta_evidence': {'known_delta_rows': delta_count['known'], 'unknown_delta_rows': delta_count['unknown'], 'head_changed_rows': delta_count['head_changed'], 'no_changed_paths_rows': delta_count['empty_changed_paths'], 'reported_changed_path_occurrences': changed_paths},
            'dispatch_result_statuses': dict(statuses), 'dispatch_writer_lane_states': dict(lane_states), 'integrated_attempted_path_occurrences': integrated_paths, 'reported_task_outcomes': dict(outcomes), 'reported_task_outcomes_by_role': {k: dict(v) for k,v in outcomes_by_role.items()},
            'long_running_rows_ge_1h': len(long), 'long_running_elapsed_ms_total': sum(r['elapsed_ms'] for r in long), 'elapsed_intervals_crossing_snapshot': sum(dt(r['started_at']) + __import__('datetime').timedelta(milliseconds=r['elapsed_ms']) > dt(CAPTURE) for r in rows if r['started_at'] and r['elapsed_ms'] is not None),
            'caveat': 'rows counted by started_at; dispatches/executions by created_at; token values are whole-row attribution. Snapshot-end running work appears only if already recorded.'
        }
    # Overall ledger coverage diagnostics at snapshot, without copying task text.
    out['snapshot_inventory'] = {'usage_rows_total':len(usage), 'live_activity_rows_total': db.execute('SELECT COUNT(*) FROM live_activity').fetchone()[0], 'unfinished_live_activity_rows': db.execute('SELECT COUNT(*) FROM live_activity WHERE ended_at IS NULL').fetchone()[0], 'dispatch_journal_rows_total':len(journals), 'dispatch_states_total':dict(Counter(j['state'] for j in journals)), 'writer_execution_rows_total':len(executions), 'writer_states_total':dict(Counter(e['state'] for e in executions))}
    print(json.dumps(out, indent=2, sort_keys=True))

if __name__ == '__main__': main()
