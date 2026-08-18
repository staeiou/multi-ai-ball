"""One API attempt, retried and rate-limited.

The policy is deliberately small and lives in one place:

* Every *API-attempt* failure is retried -- network and timeout errors, any
  non-2xx response, invalid JSON, provider error envelopes (including an HTTP
  200 body carrying ``{"error": ...}``), and a 2xx response with no answer in
  it. Providers signal overload in all of these ways.
* Nothing else is retried. Parser, database, request-construction and
  programming errors are not ``ApiAttemptError``, so they propagate untouched
  instead of being silently attempted five times.
* The rate limit is taken per *physical* request, retries included. Metering
  task starts instead would let a retry storm ignore the configured rate.
* Backoff is exponential with jitter, so a batch that fails together does not
  march through its retries in lockstep and give up at the same instant.
"""
import json
import re

import httpx
from aiolimiter import AsyncLimiter
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_random_exponential,
)


class ApiAttemptError(Exception):
    """An API-attempt failure that is safe to retry.

    Carries the response evidence so an exhausted retry is still inspectable in
    the database and in exported results.
    """

    def __init__(self, message, status=None, headers=None, response_data=None):
        super().__init__(message)
        self.status = status
        self.headers = headers
        self.response_data = response_data


class RateGate:
    """Global cap on physical requests per second, shared by every task.

    ``AsyncLimiter(1, 1 / rate)`` paces requests evenly; ``AsyncLimiter(rate, 1)``
    would allow a full burst at the top of each second. Build it inside the
    running event loop.
    """

    def __init__(self, requests_per_second):
        self._limiter = (
            AsyncLimiter(1, 1.0 / requests_per_second)
            if requests_per_second and requests_per_second > 0
            else None
        )

    async def acquire(self):
        if self._limiter is not None:
            await self._limiter.acquire()


def response_headers_for_storage(response):
    """Preserve duplicate response headers as an ordered list of pairs."""
    return list(response.headers.multi_items())


def parse_api_response(response):
    """Return ``(data, status, headers)`` for a good attempt; raise for a bad one."""
    status = response.status_code
    headers = response_headers_for_storage(response)
    raw_text = response.text

    try:
        data = response.json()
    except json.JSONDecodeError as error:
        raise ApiAttemptError(
            f"Invalid JSON response (HTTP {status}): {error}", status, headers, raw_text
        ) from error

    if not 200 <= status < 300:
        raise ApiAttemptError(f"HTTP {status}: {raw_text[:200]}", status, headers, data)

    if isinstance(data, dict) and data.get("error") is not None:
        raise ApiAttemptError(f"API error: {data['error']}", status, headers, data)

    return data, status, headers


_FILTER_PATH = re.compile(r"^(.+?)\[\?\(@\.(.+?)==(?:'|\")(.+?)(?:'|\")\)\]\.(.+)$")


def get_value_at_path(obj, path):
    """Resolve ``choices[0].message.content`` or ``content[?(@.type=='x')].text``.

    Matches the app's own path resolver. Returns ``None`` rather than raising
    when a path does not fit the response.
    """
    if not isinstance(obj, (dict, list)) or not path:
        return None
    try:
        filtered = _FILTER_PATH.match(path)
        if filtered:
            array_path, field, value, rest = filtered.groups()
            array = get_value_at_path(obj, array_path)
            if not isinstance(array, list):
                return None
            match = next(
                (i for i in array if isinstance(i, dict) and i.get(field) == value), None
            )
            return get_value_at_path(match, rest) if match is not None else None

        current = obj
        for part in (p for p in re.split(r"[.\[\]]", path) if p):
            if current is None:
                return None
            if part.isdigit():
                index = int(part)
                if not isinstance(current, list) or index >= len(current):
                    return None
                current = current[index]
            else:
                if not isinstance(current, dict):
                    return None
                current = current.get(part)
        return current
    except Exception:
        return None


def _first_match(data, paths):
    """First non-empty value among ``paths``. Filter paths yield lists; join them."""
    for path in paths or []:
        value = get_value_at_path(data, path)
        if value is None:
            continue
        if isinstance(value, list):
            value = " ".join(str(v) for v in value if v) or None
        if value:
            return value
    return None


async def request_once(client, gate, model, headers, body):
    """Issue one physical request, waiting for a rate-limit token first."""
    await gate.acquire()
    try:
        return await client.post(model["url"], json=body, headers=headers)
    except httpx.RequestError as error:
        # Transport failure. httpx.RequestError deliberately excludes
        # InvalidURL, so a malformed request is a bug and is not retried.
        raise ApiAttemptError(f"Network error: {error}") from error


def _extract(data, model, status, headers):
    """Pull the answer (and any reasoning) out of a successful response."""
    paths = model["extract_paths"]
    answer = _first_match(data, paths)
    if answer is None:
        choices = data.get("choices") if isinstance(data, dict) else None
        if choices and choices[0].get("finish_reason") == "length":
            message = "Response truncated (finish_reason=length) - increase max_tokens"
        else:
            message = f"Could not extract answer. Tried: {', '.join(paths)}"
        raise ApiAttemptError(message, status, headers, data)

    return {
        "success": True,
        "response_data": data,
        "http_status": status,
        "response_headers": headers,
        "extracted": str(answer),
        "reasoning": _first_match(data, model.get("reasoning_paths")),
        "attempted_paths": paths,
        "error": None,
    }


async def call_api(client, gate, model, headers, body, policy, on_retry=None):
    """Call one model, retrying every API-attempt failure per ``policy``.

    ``policy`` is a ``RetryPolicy``. On success returns the result dict; when the
    retries are exhausted the final ``ApiAttemptError`` is raised with its status,
    headers and body still attached.
    """
    async for attempt in AsyncRetrying(
        retry=retry_if_exception_type(ApiAttemptError),
        stop=stop_after_attempt(policy.max_retries + 1),
        wait=wait_random_exponential(min=policy.backoff_min, max=policy.backoff_max),
        before_sleep=on_retry,
        reraise=True,
    ):
        with attempt:
            response = await request_once(client, gate, model, headers, body)
            data, status, response_headers = parse_api_response(response)
            return _extract(data, model, status, response_headers)


class RetryPolicy:
    """How hard to try. Edit these in ``experiment.py``.

    ``max_retries`` counts *retries*, so each call makes up to
    ``max_retries + 1`` physical attempts.
    """

    def __init__(self, max_retries=5, backoff_min=1, backoff_max=60):
        self.max_retries = max_retries
        self.backoff_min = backoff_min
        self.backoff_max = backoff_max
