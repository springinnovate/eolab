"""Private child-process protocol for installed operations, never user code."""

import json
import sys

from job_service.operations_registry import OPERATIONS

MAX_MESSAGE_BYTES = 65536


def main() -> None:
    """Validate the process boundary and emit one bounded JSON reply.

    Inputs arrive on stdin; no path/module is accepted from a public request.
    Exceptions produce a safe failure envelope, never a traceback or inputs.
    """
    try:
        payload = sys.stdin.buffer.read(MAX_MESSAGE_BYTES + 1)
        if len(payload) > MAX_MESSAGE_BYTES:
            raise ValueError("Oversized process input")
        request = json.loads(payload)
        operation = OPERATIONS[request["operation"]]
        inputs = operation.input_model.model_validate(request["inputs"])
        result = operation.result_model.model_validate(operation.execute(inputs))
        reply = {"ok": True, "value": result.model_dump(mode="json")}
        encoded = json.dumps(reply, allow_nan=False).encode()
        if len(encoded) > MAX_MESSAGE_BYTES:
            raise ValueError("Oversized process output")
    except Exception:
        encoded = b'{"ok":false}'
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
