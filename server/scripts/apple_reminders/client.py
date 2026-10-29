#!/usr/bin/env python3
"""Server to Mac delivery over existing SSH, with no shell interpolation."""
import argparse
import json
import subprocess
from receiver import validate

MAC="max@MacBook-Pro-Maksim.local"
RECEIVER="/Users/max/.local/share/taskflow-apple-reminders/receiver.py"

def send(payload):
    result=subprocess.run(["ssh","-o","BatchMode=yes","-o","ConnectTimeout=5",
                           MAC,"/usr/bin/python3",RECEIVER],
                          input=json.dumps(validate(payload),ensure_ascii=False),
                          text=True,capture_output=True,timeout=100,check=True)
    return json.loads(result.stdout)

def main(mode):
    p=argparse.ArgumentParser(description="Apple Reminder via the owner's Mac")
    p.add_argument("--title",required=True)
    p.add_argument("--at",help="ISO 8601 with timezone; default +60 seconds")
    p.add_argument("--notes",default="")
    p.add_argument("--key",help="Stable event ID prevents duplicate reminders")
    a=p.parse_args()
    print(json.dumps(send(dict(title=a.title,at=a.at,notes=a.notes,key=a.key,mode=mode)),ensure_ascii=False))
