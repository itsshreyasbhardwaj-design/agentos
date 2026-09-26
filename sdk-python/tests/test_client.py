"""Tests for the Python SDK.

The transport is exercised against a stub opener rather than a live server, so
the suite runs anywhere; `test_live.py` covers the real round trip when an API
is reachable.
"""

import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agentos import AgentOS, AgentOSError  # noqa: E402


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
        return False


class StubOpener:
    """Records requests and replays canned responses."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        response = self.responses.pop(0) if self.responses else {"ok": True}
        if isinstance(response, Exception):
            raise response
        return FakeResponse(json.dumps(response).encode())


def client(responses):
    opener = StubOpener(responses)
    return AgentOS(base_url="http://api.test", api_key="aos_test", opener=opener), opener


def http_error(status, code, message):
    body = json.dumps({"error": {"code": code, "message": message, "requestId": "req_1"}}).encode()
    return urllib.error.HTTPError("http://api.test", status, message, {}, io.BytesIO(body))


class TestTransport(unittest.TestCase):
    def test_requires_an_api_key(self):
        with self.assertRaises(ValueError):
            AgentOS(api_key="")

    def test_sends_the_bearer_token(self):
        c, opener = client([{"status": "ok"}])
        c.health()
        self.assertEqual(opener.requests[0].get_header("Authorization"), "Bearer aos_test")

    def test_preserves_the_server_error_code(self):
        c, _ = client([http_error(403, "policy_denied", "tool is not allowed")])
        with self.assertRaises(AgentOSError) as caught:
            c.agents.get("x")
        self.assertEqual(caught.exception.code, "policy_denied")
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.request_id, "req_1")
        self.assertFalse(caught.exception.retryable)

    def test_retries_a_transient_get(self):
        c, opener = client([http_error(503, "provider_unavailable", "down"), {"status": "ok"}])
        self.assertEqual(c.health()["status"], "ok")
        self.assertEqual(len(opener.requests), 2)

    def test_does_not_retry_a_post(self):
        c, opener = client([http_error(503, "provider_unavailable", "down")])
        with self.assertRaises(AgentOSError):
            c.agents.run("a", {"x": 1})
        # A run is not idempotent unless the caller supplies a key; retrying it
        # blindly could start the agent twice.
        self.assertEqual(len(opener.requests), 1)


class TestAgents(unittest.TestCase):
    def test_run_passes_the_idempotency_key_as_a_header(self):
        c, opener = client([{"id": "exec_1", "status": "queued"}])
        c.agents.run("researcher", {"topic": "x"}, idempotency_key="run-1")
        request = opener.requests[0]
        self.assertEqual(request.get_header("Idempotency-key"), "run-1")
        self.assertEqual(request.method, "POST")
        self.assertEqual(json.loads(request.data)["input"], {"topic": "x"})

    def test_url_encodes_the_agent_reference(self):
        c, opener = client([{}])
        c.agents.get("my agent/slug")
        self.assertIn("my%20agent/slug", opener.requests[0].full_url)

    def test_builds_list_query_strings(self):
        c, opener = client([{"items": []}])
        c.executions.list(status=["running", "failed"], limit=10)
        url = opener.requests[0].full_url
        self.assertIn("status=running", url)
        self.assertIn("status=failed", url)
        self.assertIn("limit=10", url)

    def test_omits_absent_query_parameters(self):
        c, opener = client([{"items": []}])
        c.agents.list()
        self.assertNotIn("cursor", opener.requests[0].full_url)


class TestExecutions(unittest.TestCase):
    def test_wait_for_returns_on_a_terminal_status(self):
        c, _ = client([
            {"id": "exec_1", "status": "running"},
            {"id": "exec_1", "status": "completed", "output": "done"},
        ])
        result = c.executions.wait_for("exec_1", poll_interval=0)
        self.assertEqual(result["status"], "completed")

    def test_wait_for_stops_when_a_human_is_needed(self):
        c, _ = client([{"id": "exec_1", "status": "awaiting_approval"}])
        result = c.executions.wait_for("exec_1", poll_interval=0)
        self.assertEqual(result["status"], "awaiting_approval")

    def test_wait_for_can_keep_waiting_through_an_approval(self):
        c, _ = client([
            {"id": "exec_1", "status": "awaiting_approval"},
            {"id": "exec_1", "status": "completed"},
        ])
        result = c.executions.wait_for("exec_1", poll_interval=0, stop_on_approval=False)
        self.assertEqual(result["status"], "completed")

    def test_wait_for_times_out(self):
        c, _ = client([{"id": "exec_1", "status": "running"}] * 5)
        with self.assertRaises(AgentOSError) as caught:
            c.executions.wait_for("exec_1", timeout=-1, poll_interval=0)
        self.assertEqual(caught.exception.code, "timeout")

    def test_replay_defaults_to_the_recorded_strategy(self):
        c, opener = client([{"id": "exec_2", "mode": "replay"}])
        c.executions.replay("exec_1")
        self.assertEqual(json.loads(opener.requests[0].data)["strategy"], "recorded")

    def test_stream_events_stops_when_the_execution_settles(self):
        c, _ = client([
            [{"seq": 1, "type": "execution.started"}],
            {"id": "exec_1", "status": "completed"},
            [],
        ])
        events = list(c.executions.stream_events("exec_1", poll_interval=0))
        self.assertEqual([e["seq"] for e in events], [1])


class TestApprovals(unittest.TestCase):
    def test_approve_sends_the_edited_arguments(self):
        c, opener = client([{"approval": {}, "execution": {}}])
        c.approvals.approve("apr_1", note="ok", edited_arguments={"url": "https://safe"})
        body = json.loads(opener.requests[0].data)
        self.assertTrue(body["approve"])
        self.assertEqual(body["editedArguments"], {"url": "https://safe"})

    def test_reject_sends_approve_false(self):
        c, opener = client([{"approval": {}, "execution": {}}])
        c.approvals.reject("apr_1", note="too risky")
        body = json.loads(opener.requests[0].data)
        self.assertFalse(body["approve"])
        self.assertEqual(body["note"], "too risky")


if __name__ == "__main__":
    unittest.main(verbosity=2)
