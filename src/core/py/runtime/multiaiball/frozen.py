"""Run a MultAIBall frozen run (experiment.json + cases.csv).

The browser decided everything: which rows run, which are worked examples
(already compiled into ``constantBlock``), every model's request body with
its effective parameters. This module fills each case into the templates,
substitutes the two sentinels in each model's body, and hands the calls to
the runner. Nothing is derived here that the browser already derived; the
parity test in the app (src/core/py.test.ts) checks that the bodies built
here equal the bodies the browser built for the same coordinates.
"""
import csv
import json
import sys

from .runner import run
from .tasks import fill, substitute_sentinels

# Where the answer and the reasoning live in each shape's response.
EXTRACT_PATHS = {
    "anthropic-messages": (["content[?(@.type=='text')].text"], ["content[?(@.type=='thinking')].thinking"]),
    "openai-chat": (["choices[0].message.content"], ["choices[0].message.reasoning_content", "choices[0].message.reasoning"]),
}

STRUCTURAL_KEYS = ("model", "messages", "system", "input", "stream")


def shape_of(model):
    return "anthropic-messages" if model["provider"] == "anthropic" else "openai-chat"


def load_experiment(json_path):
    with open(json_path, encoding="utf-8") as handle:
        experiment = json.load(handle)
    if experiment.get("format") != "multiaiball-experiment":
        raise SystemExit(f"{json_path} is not a MultAIBall experiment file")
    return experiment


def load_cases(csv_path):
    """cases.csv -> [{ordinal, label, bindings}] in file order."""
    cases = []
    with open(csv_path, encoding="utf-8", newline="") as handle:
        for record in csv.DictReader(handle):
            ordinal = int(record.pop("ordinal"))
            label = record.pop("label")
            cases.append({"ordinal": ordinal, "label": label, "bindings": record})
    return cases


def system_channel(run_def, bindings):
    """Rendered system template, then the constant block; empty parts dropped.
    Mirrors render.ts systemChannel."""
    parts = [fill(run_def["systemTemplate"], bindings), run_def.get("constantBlock", "")]
    return "\n\n".join(part for part in parts if part)


def models_from(experiment):
    run_def = experiment["run"]
    env = experiment.get("apiKeyEnv", {})
    models = []
    for index, model in enumerate(run_def["models"]):
        extract, reasoning = EXTRACT_PATHS[shape_of(model)]
        parameters = {k: v for k, v in model["body"].items() if k not in STRUCTURAL_KEYS}
        models.append({
            "config_index": index,
            "name": model["id"],
            "display_name": model["id"],
            "provider": model["provider"],
            "api_key_env": env.get(model["provider"]),
            "url": model["url"],
            "headers": model["headers"],
            "body": model["body"],
            "parameters": parameters,
            "extract_paths": extract,
            "reasoning_paths": reasoning,
        })
    return models


class FrozenTasks:
    """One task per (case, repeat), in case-major order like the browser."""

    def __init__(self, run_def, cases):
        self.run_def = run_def
        self.cases = cases
        self.repeats = max(1, int(run_def.get("repeats", 1)))
        columns = []
        for case in cases:
            for key in case["bindings"]:
                if key not in columns:
                    columns.append(key)
        self.binding_columns = columns

    @property
    def context_columns(self):
        return ["ordinal", "label", *self.binding_columns]

    def __iter__(self):
        for case_index, case in enumerate(self.cases):
            prompt = fill(self.run_def["itemTemplate"], case["bindings"])
            system = system_channel(self.run_def, case["bindings"])
            context = {"ordinal": case["ordinal"], "label": case["label"], **case["bindings"]}
            for repeat in range(self.repeats):
                yield {
                    "task_id": f"case{case_index}_r{repeat}",
                    "prompt": prompt,
                    "system_prompt": system if system else None,
                    "context": context,
                    "repeat_index": repeat,
                }


def coordinate_at(run_def, case_count, index):
    """index -> (case_index, model_index, repeat), the browser's order."""
    repeats = max(1, int(run_def.get("repeats", 1)))
    per_case = len(run_def["models"]) * repeats
    case_index, rest = divmod(index, per_case)
    if case_index >= case_count:
        raise IndexError(index)
    return case_index, rest // repeats, rest % repeats


def body_for(experiment, cases, index):
    """The exact body for one coordinate: what the browser sent for it."""
    run_def = experiment["run"]
    case_index, model_index, _ = coordinate_at(run_def, len(cases), index)
    case = cases[case_index]
    model = run_def["models"][model_index]
    prompt = fill(run_def["itemTemplate"], case["bindings"])
    system = system_channel(run_def, case["bindings"])
    return substitute_sentinels(model["body"], system, prompt)


def canonical(value):
    """Cross-language comparison form; the app's render.ts canonicalJson."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main(json_path="experiment.json", csv_path="cases.csv", argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    experiment = load_experiment(json_path)
    if "--verify-parsers" in argv:
        from .parsing import verify_corpus
        corpus = experiment.get("parserCorpus")
        if corpus:
            verify_corpus(corpus)
        else:
            print("No JSON parser in this run; nothing to verify.")
        return
    if "--bodies" in argv:
        # Debug/parity aid: print the canonical body for the given indices.
        indices = [int(a) for a in argv[argv.index("--bodies") + 1:] if a.isdigit()]
        cases = load_cases(csv_path)
        for index in indices:
            print(canonical(body_for(experiment, cases, index)))
        return
    run_def = experiment["run"]
    cases = load_cases(csv_path)
    tasks = FrozenTasks(run_def, cases)
    from .http import RetryPolicy
    policy = RetryPolicy(max_retries=int(run_def.get("retries", 2)), backoff_min=1, backoff_max=30)
    run(models_from(experiment), tasks, parser=experiment.get("parser"), policy=policy, argv=argv)
