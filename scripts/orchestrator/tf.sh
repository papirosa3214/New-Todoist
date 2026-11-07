#!/bin/sh
if [ -n "$3" ]; then curl -s -X "$1" -H "Authorization: Bearer $T" -H "Content-Type: application/json" --data @"$3" "http://localhost:3001$2"; else curl -s -X "$1" -H "Authorization: Bearer $T" "http://localhost:3001$2"; fi
