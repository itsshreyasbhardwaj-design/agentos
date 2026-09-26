"""HTTP client for the AgentOS REST API. Standard library only."""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable, Dict, Iterator, List, Optional, Sequence

JsonDict = Dict[str, Any]

TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})

#: Errors worth retrying. Everything else means the request itself was wrong and
#: will fail identically on a second attempt.
RETRYABLE_CODES = frozenset(
    {"timeout", "provider_unavailable", "rate_limited", "internal"}
)


class AgentOSError(Exception):
    """An error returned by the AgentOS API, with its code preserved.

    The ``code`` is stable and safe to branch on (``approval_required``,
    ``limit_exceeded``, ``policy_denied`` …); the message is for humans and may
    change.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        status: int = 0,
        details: Optional[JsonDict] = None,
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}
        self.request_id = request_id

    @property
    def retryable(self) -> bool:
        return self.code in RETRYABLE_CODES


def _query(params: JsonDict) -> str:
    pairs: List[tuple] = []
    for key, value in params.items():
        if value is None:
            continue
        if isinstance(value, (list, tuple)):
            pairs.extend((key, str(item)) for item in value)
        elif isinstance(value, bool):
            pairs.append((key, "true" if value else "false"))
        else:
            pairs.append((key, str(value)))
    encoded = urllib.parse.urlencode(pairs)
    return f"?{encoded}" if encoded else ""


class _Transport:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float,
        max_retries: int,
        opener: Optional[Callable[..., Any]] = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.max_retries = max_retries
        self._opener = opener or urllib.request.urlopen

    def request(
        self,
        method: str,
        path: str,
        body: Optional[Any] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Any:
        payload = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"{self.base_url}{path}",
            data=payload,
            method=method,
            headers={
                "content-type": "application/json",
                "accept": "application/json",
                "authorization": f"Bearer {self.api_key}",
                "user-agent": "agentos-python/0.1.0",
                **(headers or {}),
            },
        )

        attempt = 0
        while True:
            attempt += 1
            try:
                with self._opener(request, timeout=self.timeout) as response:
                    raw = response.read().decode("utf-8")
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as error:
                raw = error.read().decode("utf-8", errors="replace")
                try:
                    parsed = json.loads(raw).get("error", {})
                except (ValueError, AttributeError):
                    parsed = {}
                failure = AgentOSError(
                    parsed.get("code", "internal"),
                    parsed.get("message", f"HTTP {error.code}"),
                    status=error.code,
                    details=parsed.get("details"),
                    request_id=parsed.get("requestId"),
                )
                # Retry only what the server says is transient, and only for
                # methods that are safe to repeat.
                if (
                    failure.retryable
                    and method in ("GET", "HEAD")
                    and attempt <= self.max_retries
                ):
                    time.sleep(min(2 ** (attempt - 1) * 0.2, 5.0))
                    continue
                raise failure from error
            except urllib.error.URLError as error:
                if attempt <= self.max_retries and method in ("GET", "HEAD"):
                    time.sleep(min(2 ** (attempt - 1) * 0.2, 5.0))
                    continue
                raise AgentOSError(
                    "provider_unavailable", f"could not reach {self.base_url}: {error.reason}"
                ) from error


class Agents:
    def __init__(self, transport: _Transport) -> None:
        self._t = transport

    def create(
        self,
        slug: str,
        name: str,
        spec: JsonDict,
        description: str = "",
        labels: Optional[Dict[str, str]] = None,
    ) -> JsonDict:
        return self._t.request(
            "POST",
            "/v1/agents",
            {
                "slug": slug,
                "name": name,
                "description": description,
                "spec": spec,
                "labels": labels or {},
            },
        )

    def list(
        self, limit: int = 50, cursor: Optional[str] = None, search: Optional[str] = None
    ) -> JsonDict:
        return self._t.request(
            "GET", f"/v1/agents{_query({'limit': limit, 'cursor': cursor, 'search': search})}"
        )

    def get(self, agent_ref: str) -> JsonDict:
        return self._t.request("GET", f"/v1/agents/{urllib.parse.quote(agent_ref)}")

    def update(self, agent_ref: str, **patch: Any) -> JsonDict:
        return self._t.request("PATCH", f"/v1/agents/{urllib.parse.quote(agent_ref)}", patch)

    def publish(self, agent_ref: str, changelog: str = "", force: bool = False) -> JsonDict:
        return self._t.request(
            "POST",
            f"/v1/agents/{urllib.parse.quote(agent_ref)}/publish",
            {"changelog": changelog, "force": force},
        )

    def rollback(self, agent_ref: str, version_id: str) -> JsonDict:
        return self._t.request(
            "POST",
            f"/v1/agents/{urllib.parse.quote(agent_ref)}/rollback",
            {"versionId": version_id},
        )

    def versions(self, agent_ref: str) -> List[JsonDict]:
        return self._t.request("GET", f"/v1/agents/{urllib.parse.quote(agent_ref)}/versions")

    def metrics(
        self, agent_ref: str, since: Optional[int] = None, until: Optional[int] = None
    ) -> JsonDict:
        return self._t.request(
            "GET",
            f"/v1/agents/{urllib.parse.quote(agent_ref)}/metrics{_query({'since': since, 'until': until})}",
        )

    def run(
        self,
        agent_ref: str,
        agent_input: Any,
        idempotency_key: Optional[str] = None,
        labels: Optional[Dict[str, str]] = None,
        version_id: Optional[str] = None,
    ) -> JsonDict:
        """Start a run. Returns as soon as it is queued — it executes on a worker."""
        body: JsonDict = {"input": agent_input}
        if labels:
            body["labels"] = labels
        if version_id:
            body["versionId"] = version_id
        headers = {"idempotency-key": idempotency_key} if idempotency_key else None
        return self._t.request(
            "POST", f"/v1/agents/{urllib.parse.quote(agent_ref)}/run", body, headers
        )


class Executions:
    def __init__(self, transport: _Transport) -> None:
        self._t = transport

    def list(
        self,
        agent_id: Optional[str] = None,
        status: Optional[Sequence[str]] = None,
        limit: int = 50,
        cursor: Optional[str] = None,
    ) -> JsonDict:
        return self._t.request(
            "GET",
            f"/v1/executions{_query({'agentId': agent_id, 'status': status, 'limit': limit, 'cursor': cursor})}",
        )

    def get(self, execution_id: str) -> JsonDict:
        return self._t.request("GET", f"/v1/executions/{execution_id}")

    def events(self, execution_id: str, since_seq: int = 0, limit: int = 1000) -> List[JsonDict]:
        return self._t.request(
            "GET",
            f"/v1/executions/{execution_id}/events{_query({'sinceSeq': since_seq, 'limit': limit})}",
        )

    def trace(self, execution_id: str) -> JsonDict:
        return self._t.request("GET", f"/v1/executions/{execution_id}/trace")

    def pause(self, execution_id: str, reason: str = "") -> JsonDict:
        return self._t.request("POST", f"/v1/executions/{execution_id}/pause", {"reason": reason})

    def resume(self, execution_id: str) -> JsonDict:
        return self._t.request("POST", f"/v1/executions/{execution_id}/resume", {})

    def cancel(self, execution_id: str, reason: str = "") -> JsonDict:
        return self._t.request("POST", f"/v1/executions/{execution_id}/cancel", {"reason": reason})

    def retry(self, execution_id: str) -> JsonDict:
        return self._t.request("POST", f"/v1/executions/{execution_id}/retry", {})

    def replay(self, execution_id: str, strategy: str = "recorded") -> JsonDict:
        """Re-run a past execution. ``recorded`` replays the transcript for free
        and never executes a side-effecting tool."""
        return self._t.request(
            "POST", f"/v1/executions/{execution_id}/replay", {"strategy": strategy}
        )

    def wait_for(
        self,
        execution_id: str,
        timeout: float = 120.0,
        poll_interval: float = 0.5,
        stop_on_approval: bool = True,
    ) -> JsonDict:
        """Block until the execution settles.

        Returns as soon as it reaches a terminal state, or (by default) as soon
        as it is waiting for a human — because that can take arbitrarily long
        and is not a failure.
        """
        deadline = time.monotonic() + timeout
        while True:
            execution = self.get(execution_id)
            status = execution["status"]
            if status in TERMINAL_STATUSES:
                return execution
            if stop_on_approval and status == "awaiting_approval":
                return execution
            if time.monotonic() > deadline:
                raise AgentOSError(
                    "timeout",
                    f"execution {execution_id} was still {status} after {timeout}s",
                    details={"status": status},
                )
            time.sleep(poll_interval)

    def stream_events(self, execution_id: str, since_seq: int = 0, poll_interval: float = 0.5) -> Iterator[JsonDict]:
        """Yield events as they are recorded, until the execution settles.

        Polls rather than holding an SSE connection open: simpler, and it
        survives a proxy that buffers or drops long-lived responses.
        """
        seq = since_seq
        while True:
            for event in self.events(execution_id, since_seq=seq):
                seq = max(seq, event["seq"])
                yield event
            if self.get(execution_id)["status"] in TERMINAL_STATUSES:
                for event in self.events(execution_id, since_seq=seq):
                    yield event
                return
            time.sleep(poll_interval)


class Approvals:
    def __init__(self, transport: _Transport) -> None:
        self._t = transport

    def list_pending(self, agent_id: Optional[str] = None, limit: int = 50) -> JsonDict:
        return self._t.request(
            "GET", f"/v1/approvals{_query({'agentId': agent_id, 'limit': limit})}"
        )

    def get(self, approval_id: str) -> JsonDict:
        return self._t.request("GET", f"/v1/approvals/{approval_id}")

    def decide(
        self,
        approval_id: str,
        approve: bool,
        note: str = "",
        edited_arguments: Optional[JsonDict] = None,
    ) -> JsonDict:
        body: JsonDict = {"approve": approve}
        if note:
            body["note"] = note
        if edited_arguments is not None:
            body["editedArguments"] = edited_arguments
        return self._t.request("POST", f"/v1/approvals/{approval_id}/decide", body)

    def approve(
        self, approval_id: str, note: str = "", edited_arguments: Optional[JsonDict] = None
    ) -> JsonDict:
        return self.decide(approval_id, True, note, edited_arguments)

    def reject(self, approval_id: str, note: str = "") -> JsonDict:
        return self.decide(approval_id, False, note)


class Tasks:
    def __init__(self, transport: _Transport) -> None:
        self._t = transport

    def create(
        self,
        agent_ref: str,
        title: str,
        task_input: Any,
        depends_on: Optional[Sequence[str]] = None,
    ) -> JsonDict:
        return self._t.request(
            "POST",
            "/v1/tasks",
            {
                "agentRef": agent_ref,
                "title": title,
                "input": task_input,
                "dependsOn": list(depends_on or []),
            },
        )

    def list(self, status: Optional[Sequence[str]] = None, limit: int = 50) -> JsonDict:
        return self._t.request("GET", f"/v1/tasks{_query({'status': status, 'limit': limit})}")

    def get(self, task_id: str) -> JsonDict:
        return self._t.request("GET", f"/v1/tasks/{task_id}")


class Schedules:
    def __init__(self, transport: _Transport) -> None:
        self._t = transport

    def create(
        self,
        agent_ref: str,
        name: str,
        kind: str,
        expression: str,
        timezone: str = "UTC",
        schedule_input: Any = None,
    ) -> JsonDict:
        return self._t.request(
            "POST",
            "/v1/schedules",
            {
                "agentRef": agent_ref,
                "name": name,
                "kind": kind,
                "expression": expression,
                "timezone": timezone,
                "input": schedule_input if schedule_input is not None else {},
            },
        )

    def list(self, agent_id: Optional[str] = None, limit: int = 50) -> JsonDict:
        return self._t.request(
            "GET", f"/v1/schedules{_query({'agentId': agent_id, 'limit': limit})}"
        )

    def set_enabled(self, schedule_id: str, enabled: bool) -> JsonDict:
        return self._t.request("PATCH", f"/v1/schedules/{schedule_id}", {"enabled": enabled})

    def delete(self, schedule_id: str) -> JsonDict:
        return self._t.request("DELETE", f"/v1/schedules/{schedule_id}")


class Tools:
    def __init__(self, transport: _Transport) -> None:
        self._t = transport

    def list(self) -> List[JsonDict]:
        return self._t.request("GET", "/v1/tools")


class Metrics:
    def __init__(self, transport: _Transport) -> None:
        self._t = transport

    def overview(self, since: Optional[int] = None, until: Optional[int] = None) -> JsonDict:
        return self._t.request("GET", f"/v1/metrics/overview{_query({'since': since, 'until': until})}")

    def cost_by_agent(self, since: Optional[int] = None, until: Optional[int] = None) -> List[JsonDict]:
        return self._t.request("GET", f"/v1/metrics/cost-by-agent{_query({'since': since, 'until': until})}")

    def cost_by_model(self, since: Optional[int] = None, until: Optional[int] = None) -> List[JsonDict]:
        return self._t.request("GET", f"/v1/metrics/cost-by-model{_query({'since': since, 'until': until})}")

    def tool_usage(self, since: Optional[int] = None, until: Optional[int] = None) -> List[JsonDict]:
        return self._t.request("GET", f"/v1/metrics/tool-usage{_query({'since': since, 'until': until})}")


class AgentOS:
    """Client for an AgentOS deployment."""

    def __init__(
        self,
        base_url: str = "http://127.0.0.1:8787",
        api_key: str = "",
        timeout: float = 30.0,
        max_retries: int = 2,
        opener: Optional[Callable[..., Any]] = None,
    ) -> None:
        if not api_key:
            raise ValueError("api_key is required")
        self._t = _Transport(base_url, api_key, timeout, max_retries, opener)
        self.agents = Agents(self._t)
        self.executions = Executions(self._t)
        self.approvals = Approvals(self._t)
        self.tasks = Tasks(self._t)
        self.schedules = Schedules(self._t)
        self.tools = Tools(self._t)
        self.metrics = Metrics(self._t)

    def health(self) -> JsonDict:
        return self._t.request("GET", "/healthz")

    def search(self, query: str, limit: int = 20) -> JsonDict:
        return self._t.request("GET", f"/v1/search{_query({'q': query, 'limit': limit})}")
