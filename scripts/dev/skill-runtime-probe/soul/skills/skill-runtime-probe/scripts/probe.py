#!/usr/bin/env python3
"""Sandbox contract: arguments arrive as an Artifact, the result must be written to
$TULIP_OUTPUT_DIR/result.json, and the container has no network."""

import json
import os
import platform
import sys

with open(os.path.join(os.environ["TULIP_INPUT_DIR"], "0-input.json"), encoding="utf-8") as handle:
    arguments = json.load(handle)

message = arguments.get("message") or "no message"
print(f"probe.py received: {message}", file=sys.stderr)

with open(
    os.path.join(os.environ["TULIP_OUTPUT_DIR"], "result.json"), "w", encoding="utf-8"
) as handle:
    json.dump(
        {
            "ok": True,
            "runtime": "python",
            "interpreter": f"Python {platform.python_version()}",
            "echoed": message,
        },
        handle,
    )
