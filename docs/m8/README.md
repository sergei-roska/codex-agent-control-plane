# M8 experiment

Run `node scripts/m8-experiment.js` to regenerate the offline [experiment result](experiment-result.json). It executes application contracts and does not score prompt quality.

Run `node scripts/m8-experiment.js --live` for the model-backed baseline/candidate comparison recorded in [live-eval-result.json](live-eval-result.json). It requires a working Codex App Server and model access. The command creates and removes temporary workspaces for cases that write files; it never promotes a prompt.

For an optional MLflow Tracking export, create an experiment on a reachable MLflow server and set `M8_MLFLOW_TRACKING_URI` and `M8_MLFLOW_EXPERIMENT_ID` before running the offline command. The exporter uses `runs/create` and `runs/log-batch` to store sanitized trace fields, correlation IDs, status, and feedback as bounded run parameters. Unset configuration or an export failure leaves local evidence and marks production adoption deferred. This integration does not write MLflow GenAI traces or dedicated feedback records.

The local verification used MLflow 3.16.1. These are the verified setup and readback steps, using disposable `/tmp` storage:

```sh
UV_CACHE_DIR=/tmp/m8-uv-cache uv venv /tmp/m8-mlflow-venv
UV_CACHE_DIR=/tmp/m8-uv-cache uv pip install --python /tmp/m8-mlflow-venv/bin/python 'mlflow>=3.6,<4'
mkdir -p /tmp/m8-mlflow/artifacts
MLFLOW_DISABLE_AGENT_HINT=1 /tmp/m8-mlflow-venv/bin/mlflow server \
  --backend-store-uri sqlite:////tmp/m8-mlflow/mlflow.db \
  --artifacts-destination /tmp/m8-mlflow/artifacts \
  --host 127.0.0.1 --port 5017
```

In another terminal, create an experiment and use its returned `experiment_id`:

```sh
curl -sS -X POST http://127.0.0.1:5017/api/2.0/mlflow/experiments/create \
  -H 'content-type: application/json' \
  -d '{"name":"m8-sanitized-integration"}'
M8_MLFLOW_TRACKING_URI=http://127.0.0.1:5017 \
M8_MLFLOW_EXPERIMENT_ID=1 node scripts/m8-experiment.js
curl -sS -X POST http://127.0.0.1:5017/api/2.0/mlflow/runs/search \
  -H 'content-type: application/json' \
  -d '{"experiment_ids":["1"],"max_results":100,"order_by":["attributes.start_time DESC"]}'
```

The displayed ID `1` was the value returned in the verified empty local store; replace it with the value from your own server. The readback contained all 11 sanitized parameters, including correlation IDs and outcome feedback. Stop the server and remove the temporary paths after verification.

See [acceptance](acceptance.md) and the [release note](release-notes.md) for the result and limits.
