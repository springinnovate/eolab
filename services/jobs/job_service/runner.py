"""Private child-process protocol for installed operations, never user code."""

import json
import sys
import traceback

from job_service.operations_registry import OPERATIONS

MAX_MESSAGE_BYTES = 65536
# Bounded inline results include display outlines (256 KiB compact GeoJSON)
# plus JSON spacing/envelope. Requests keep the separate 64 KiB ceiling.
MAX_RESULT_BYTES = 512 * 1024


def main() -> None:
    """Validate the process boundary and emit one bounded JSON reply.

    Inputs arrive as UTF-8 JSON bytes on binary stdin; json.loads decodes the bytes
    into Python values. The extra byte detects oversized messages before parsing.
    No path/module is accepted from a public request.
    Exceptions produce a safe public failure envelope. Tracebacks go only to
    inherited service stderr for operators; local variables are not captured.
    """
    try:
        payload: bytes = sys.stdin.buffer.read(MAX_MESSAGE_BYTES + 1)
        if len(payload) > MAX_MESSAGE_BYTES:
            raise ValueError("Oversized process input")
        request = json.loads(payload)
        operation = OPERATIONS[request["operation"]]
        inputs = operation.input_model.model_validate(request["inputs"])
        result = operation.result_model.model_validate(operation.execute(inputs))
        reply = {"ok": True, "value": result.model_dump(mode="json")}
        encoded = json.dumps(reply, allow_nan=False).encode()
        if len(encoded) > MAX_RESULT_BYTES:
            raise ValueError("Oversized process output")
    except Exception:
        traceback.print_exc(file=sys.stderr)
        encoded = b'{"ok":false}'
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    main()
