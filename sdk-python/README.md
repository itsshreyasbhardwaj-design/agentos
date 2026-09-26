# agentos-sdk (Python)

Python client for [AgentOS](https://github.com/itsshreyasbhardwaj-design/agentos).

Standard library only — no dependencies.

```bash
pip install agentos-sdk
```

```python
from agentos import AgentOS, AgentOSError

client = AgentOS(base_url="http://127.0.0.1:8787", api_key="aos_...")

execution = client.agents.run("research-agent", {"topic": "incident review"})
final = client.executions.wait_for(execution["id"])

if final["status"] == "awaiting_approval":
    for approval in client.approvals.list_pending()["items"]:
        print(approval["impact"])          # what the agent wants to do
        client.approvals.approve(approval["id"], note="looks fine")
    final = client.executions.wait_for(execution["id"], stop_on_approval=False)

print(final["output"], final["usage"]["costMicroUsd"], "microUSD")
```

Errors keep the server's code, so you can branch on them:

```python
try:
    client.agents.run("researcher", "go")
except AgentOSError as error:
    if error.code == "limit_exceeded":
        ...
    elif error.retryable:
        ...
```

## Tests

```bash
python3 -m unittest discover -s tests -v          # offline, uses a stub transport
AGENTOS_API_KEY=aos_... python3 -m unittest tests.test_live -v   # against a live API
```
