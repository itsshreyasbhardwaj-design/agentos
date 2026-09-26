"""End-to-end test against a running AgentOS API.

Skipped unless AGENTOS_API_KEY is set, so the default test run needs no server:

    AGENTOS_SEED_DEMO=true pnpm dev:api           # in another shell
    AGENTOS_API_KEY=<printed key> python3 -m unittest tests.test_live -v
"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from agentos import AgentOS, AgentOSError  # noqa: E402

API_KEY = os.environ.get("AGENTOS_API_KEY")
BASE_URL = os.environ.get("AGENTOS_URL", "http://127.0.0.1:8787")


@unittest.skipUnless(API_KEY, "set AGENTOS_API_KEY to run the live test")
class TestLive(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = AgentOS(base_url=BASE_URL, api_key=API_KEY or "")

    def test_health(self):
        self.assertEqual(self.client.health()["status"], "ok")

    def test_lists_the_demo_agents(self):
        slugs = {a["slug"] for a in self.client.agents.list()["items"]}
        self.assertIn("data-analysis-agent", slugs)

    def test_runs_an_agent_to_completion(self):
        execution = self.client.agents.run("data-analysis-agent", "compute 21 * 2")
        self.assertEqual(execution["status"], "queued")

        final = self.client.executions.wait_for(execution["id"], timeout=30)
        self.assertEqual(final["status"], "completed")
        self.assertGreater(final["usage"]["modelCalls"], 0)

        trace = self.client.executions.trace(execution["id"])
        self.assertGreater(len(trace["nodes"]), 0)
        self.assertTrue(any(node["kind"] == "model" for node in trace["nodes"]))

    def test_idempotency_key_collapses_duplicate_runs(self):
        first = self.client.agents.run("data-analysis-agent", "one plus one", idempotency_key="py-live-1")
        second = self.client.agents.run("data-analysis-agent", "one plus one", idempotency_key="py-live-1")
        self.assertEqual(first["id"], second["id"])

    def test_approval_gate_pauses_and_resumes(self):
        execution = self.client.agents.run(
            "code-review-agent", "review the pull-request and post the findings"
        )
        paused = self.client.executions.wait_for(execution["id"], timeout=30)
        self.assertEqual(paused["status"], "awaiting_approval")

        pending = [
            a for a in self.client.approvals.list_pending()["items"]
            if a["executionId"] == execution["id"]
        ]
        self.assertEqual(len(pending), 1)
        self.assertTrue(pending[0]["destructive"])

        self.client.approvals.approve(pending[0]["id"], note="approved from the python sdk")
        final = self.client.executions.wait_for(execution["id"], timeout=30, stop_on_approval=False)
        self.assertEqual(final["status"], "completed")
        self.assertEqual(final["usage"]["approvals"], 1)

    def test_replay_costs_nothing(self):
        execution = self.client.agents.run("data-analysis-agent", "compute 8 * 8")
        self.client.executions.wait_for(execution["id"], timeout=30)

        replay = self.client.executions.replay(execution["id"])
        final = self.client.executions.wait_for(replay["id"], timeout=30)
        self.assertEqual(final["mode"], "replay")
        self.assertEqual(final["status"], "completed")
        self.assertEqual(final["usage"]["costMicroUsd"], 0)

    def test_unknown_agent_raises_not_found(self):
        with self.assertRaises(AgentOSError) as caught:
            self.client.agents.get("no-such-agent")
        self.assertEqual(caught.exception.code, "not_found")


if __name__ == "__main__":
    unittest.main(verbosity=2)
