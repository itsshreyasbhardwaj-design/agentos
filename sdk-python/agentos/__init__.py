"""Python client for AgentOS.

Mirrors the TypeScript SDK's surface so the two stay recognisably the same API:

    from agentos import AgentOS

    client = AgentOS(base_url="http://127.0.0.1:8787", api_key="aos_...")
    execution = client.agents.run("research-agent", {"topic": "incident review"})
    final = client.executions.wait_for(execution["id"])
"""

from .client import (
    AgentOS,
    AgentOSError,
    Agents,
    Approvals,
    Executions,
    Metrics,
    Schedules,
    Tasks,
    Tools,
)

__all__ = [
    "AgentOS",
    "AgentOSError",
    "Agents",
    "Approvals",
    "Executions",
    "Metrics",
    "Schedules",
    "Tasks",
    "Tools",
]
__version__ = "0.1.0"
