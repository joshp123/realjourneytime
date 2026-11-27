#!/bin/bash
# Download the whole year and reduce each day as it lands; keeps going until every day is done.
cd "$(dirname "$0")"
./kv78_fetch.sh &
FETCH=$!
while kill -0 $FETCH 2>/dev/null; do ./reduce_nl.sh | grep -v 'REDUCE DONE'; sleep 300; done
./reduce_nl.sh
echo "YEAR DONE"
