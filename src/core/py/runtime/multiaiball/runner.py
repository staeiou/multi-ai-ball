"""The run itself: arguments, key preflight, concurrency, progress, export.

``run()`` is the only thing a generated ``experiment.py`` calls. Everything it
needs arrives as data, so the generated script stays readable: models, a task
source, an optional parser, and a retry policy you can edit.
"""
import argparse
import asyncio
import functools
import glob
import json
import os
import sys
from datetime import datetime

import aiometer
import httpx
from tqdm import tqdm

from .http import ApiAttemptError, RateGate, RetryPolicy, call_api
from .output import output_filename, read_frame, write
from .parsing import apply_parser
from .store import ResultStore, context_column, parameter_column
from .tasks import substitute_sentinels


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Auditomatic experiment runner")
    parser.add_argument("--output", "-o", choices=sorted(["csv", "tsv", "json", "jsonl", "excel", "parquet"]),
                        default="csv", help="Export format (default: csv)")
    parser.add_argument("--concurrent", "-c", type=int, default=10,
                        help="Simultaneous requests (default: 10)")
    parser.add_argument("--rate-limit", "-r", type=float, default=5.0,
                        help="Max requests/second, retries included (default: 5.0)")
    parser.add_argument("--timeout", "-t", type=int, default=90,
                        help="Per-request timeout in seconds (default: 90)")
    parser.add_argument("--output-file", "-f", help="Output filename (generated if omitted)")
    parser.add_argument("--resume", action="store_true",
                        help="Continue the most recent run in this directory")
    parser.add_argument("--db-file", help="Database to write or resume from")
    parser.add_argument("--max-retries", type=int,
                        help="Override the script's RetryPolicy retry count")
    parser.add_argument("--backoff-max", type=float,
                        help="Override the script's RetryPolicy backoff ceiling, in seconds")
    return parser.parse_args(argv)


def resolve_db_path(args):
    """Where results go: an explicit file, the run being resumed, or a new one.

    ``--resume`` on its own used to be accepted and ignored, which silently
    started a fresh database and re-ran every call the user was trying not to
    repeat. It now names the most recent database here, and says so.
    """
    if args.db_file:
        return args.db_file
    if args.resume:
        existing = sorted(glob.glob("results_*.db"), key=os.path.getmtime)
        if not existing:
            print("--resume found no results_*.db here. "
                  "Pass --db-file to name one, or drop --resume to start fresh.")
            sys.exit(1)
        print(f"Resuming {existing[-1]}")
        return existing[-1]
    return f"results_{datetime.now():%Y%m%d_%H%M%S}.db"


def check_api_keys(models):
    """Verify every key the models need is set, or exit saying which is missing."""
    print("Checking API keys...")
    needed = {}
    keyless = []
    for model in models:
        env_var = model.get("api_key_env")
        (needed.setdefault(env_var, []).append(model["name"]) if env_var
         else keyless.append(model["name"]))

    missing = [name for name in sorted(needed) if not os.getenv(name)]
    for name in sorted(needed):
        if name not in missing:
            print(f"  {name}: OK ({len(needed[name])} models)")
    if keyless:
        print(f"  No key required: {len(keyless)} models")

    if missing:
        print("\nMissing API keys:")
        for name in missing:
            print(f"  {name} (needed for {len(needed[name])} models)")
        print("\nSet them with:")
        for name in missing:
            print(f"  export {name}='your-key-here'")
        sys.exit(1)

    print(f"All {len(models)} models ready\n")


def build_request(model, task):
    """Fill the key and the two sentinels the exporter left in this model's request."""
    key = os.getenv(model["api_key_env"], "") if model.get("api_key_env") else ""
    headers = {}
    for name, value in model["headers"].items():
        if "{{API_KEY}}" not in value:
            headers[name] = value
        elif key:
            headers[name] = value.replace("{{API_KEY}}", key)
    body = substitute_sentinels(model["body"], task.get("system_prompt"), task["prompt"])
    return headers, body


async def _run_one(client, gate, store, model, task, parser, namespace, policy, bar, counts):
    task_id = f"config{model['config_index']}_{task['task_id']}"
    if await store.already_done(task_id):
        counts["skipped"] += 1
        bar.update(1)
        bar.set_postfix(ok=counts["ok"], failed=counts["fail"])
        return

    started = asyncio.get_event_loop().time()
    row = {
        "task_id": task_id,
        "config_index": model["config_index"],
        "model_name": model["name"],
        "display_name": model["display_name"],
        "repeat_index": task.get("repeat_index", 0),
        "prompt": task["prompt"],
        "system_prompt": task.get("system_prompt"),
    }
    # Namespaced rather than merged in: a dataset column called "prompt" and a
    # request parameter called "text" both collided with something before.
    row.update((context_column(k), v) for k, v in task["context"].items())
    row.update((parameter_column(k), v) for k, v in model.get("parameters", {}).items())

    try:
        headers, body = build_request(model, task)
        result = await call_api(client, gate, model, headers, body, policy,
                                on_retry=lambda s: bar.write(
                                    f"Retry {s.attempt_number} {model['name']}: {s.outcome.exception()}"))
        row.update(
            success=1,
            http_status=result["http_status"],
            response_headers=result["response_headers"],
            response_data=result["response_data"],
            extracted=result["extracted"],
            reasoning=result["reasoning"],
            parsed=apply_parser(result["extracted"], parser, namespace),
        )
        counts["ok"] += 1
    except ApiAttemptError as error:
        row.update(success=0, error=str(error), http_status=error.status,
                   response_headers=error.headers, response_data=error.response_data)
        counts["fail"] += 1
        bar.write(f"FAILED {model['name']}: {str(error)[:100]}")

    row["duration_seconds"] = round(asyncio.get_event_loop().time() - started, 3)
    try:
        await store.save(row)
    except Exception as error:
        # A row we cannot store must not take down a run that is otherwise
        # working; the failure is reported and the remaining tasks continue.
        bar.write(f"WARN: could not save {task_id}: {error}")

    bar.update(1)
    bar.set_postfix(ok=counts["ok"], failed=counts["fail"])


async def _main(models, tasks, parser, namespace, policy, args):
    db_path = resolve_db_path(args)
    # Declaration order, not set order, so the schema is stable across runs and
    # --resume never has to migrate a column it already had.
    parameters = dict.fromkeys(
        parameter_column(k) for model in models for k in model.get("parameters", {})
    )
    store = await ResultStore(
        db_path,
        extra_columns=[*(context_column(c) for c in tasks.context_columns), *parameters],
    ).open()

    work = [(model, task) for task in tasks for model in models]
    counts = {"ok": 0, "fail": 0, "skipped": 0}
    gate = RateGate(args.rate_limit)

    print(f"{len(work)} calls | {args.concurrent} concurrent | {args.rate_limit}/s")
    print(f"Database: {db_path}\n")

    async with httpx.AsyncClient(timeout=args.timeout) as client:
        with tqdm(total=len(work), desc="Running") as bar:
            # partial, not lambda: aiometer rejects lambdas outright, because the
            # usual loop-variable capture bug makes every one of them run the
            # same task.
            await aiometer.run_all(
                [
                    functools.partial(_run_one, client, gate, store, model, task,
                                      parser, namespace, policy, bar, counts)
                    for model, task in work
                ],
                max_at_once=args.concurrent,
            )

    if counts["skipped"]:
        print(f"\nSkipped {counts['skipped']} calls already completed in {db_path}")

    print("\nResults by configuration:")
    for index, name, total, ok in await store.summary():
        rate = (ok or 0) / total * 100 if total else 0
        print(f"  [{index}] {name}: {ok or 0}/{total} ({rate:.0f}%)")
    await store.close()

    path = write(
        read_frame(db_path, unstack_column="parsed" if (parser or {}).get("unstackJson") else None),
        output_filename(db_path, args.output, args.output_file),
        args.output,
    )
    print(f"\nWrote {path}")
    print(f"Database: {db_path}  (SELECT * FROM results WHERE success = 0;)")


def run(models, tasks, parser=None, namespace=None, policy=None, argv=None):
    """Run every model against every task. See ``experiment.py`` for the data."""
    args = parse_args(argv)
    policy = policy or RetryPolicy()
    if args.max_retries is not None:
        policy.max_retries = args.max_retries
    if args.backoff_max is not None:
        policy.backoff_max = args.backoff_max
    check_api_keys(models)
    asyncio.run(_main(models, tasks, parser, namespace, policy, args))
