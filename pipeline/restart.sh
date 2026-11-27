#!/bin/bash
# Restart the site server (8765) and the journeys service (8766), each in its own session, and wait until both answer.
cd "$(dirname "$0")"
pkill -f 'serve.py 8765' || true
pkill -f 'journeys.mjs 8766' || true
sleep 1
python3 -c "
import subprocess
subprocess.Popen(['nix', 'shell', 'nixpkgs#nodejs', '-c', 'node', '--max-old-space-size=8000', 'journeys.mjs', '8766'],
                 stdout=open('/tmp/rjt/journeys.log', 'w'), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)
subprocess.Popen(['uv', 'run', 'python', 'serve.py', '8765'], stdout=open('/tmp/rjt/serve.log', 'w'),
                 stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, start_new_session=True)"
until grep -qE 'serving|Traceback' /tmp/rjt/serve.log 2>/dev/null && grep -qE 'journeys on|Error' /tmp/rjt/journeys.log 2>/dev/null; do sleep 2; done
cat /tmp/rjt/serve.log; grep -v unpacking /tmp/rjt/journeys.log
