#!/usr/bin/env python3
"""Mac receiver. JSON stdin only; AppleScript arguments are never evaluated as code."""
import datetime
import fcntl
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import uuid

LOOKUP = """
on run argv
 tell application "Reminders"
  repeat with r in reminders of default list
   if body of r contains item 1 of argv then return id of r
  end repeat
 end tell
 return ""
end run
"""
NORMAL = """
on run argv
 set alertTime to (current date) + (item 3 of argv as real)
 tell application "Reminders"
  set r to make new reminder at end of reminders of default list with properties {name:item 1 of argv, body:item 2 of argv, due date:alertTime, remind me date:alertTime}
  return id of r
 end tell
end run
"""
RENAME = """
on run argv
 tell application "Reminders"
  set r to first reminder whose id is item 1 of argv
  set name of r to item 2 of argv
  set body of r to item 3 of argv
  return id of r
 end tell
end run
"""

COMPLETE = """
on run argv
 tell application "Reminders"
  set r to first reminder whose id is item 1 of argv
  set completed of r to true
  return id of r
 end tell
end run
"""

def validate(p):
    if not isinstance(p,dict):
        raise ValueError("Expected a JSON object")
    title=p.get("title","")
    if not isinstance(title,str) or not title.strip() or len(title)>200:
        raise ValueError("title must contain 1..200 characters")
    mode=p.get("mode","normal")
    if mode not in ("normal","urgent"):
        raise ValueError("mode must be normal or urgent")
    at=p.get("at") or (datetime.datetime.now().astimezone()+datetime.timedelta(seconds=60)).isoformat()
    date=datetime.datetime.fromisoformat(at.replace("Z","+00:00"))
    if date.tzinfo is None:
        raise ValueError("at requires an explicit timezone")
    notes=p.get("notes","")
    key=p.get("key") or str(uuid.uuid4())
    if not isinstance(notes,str) or len(notes)>4000 or not isinstance(key,str) or not key or len(key)>200:
        raise ValueError("Invalid notes or idempotency key")
    operation=p.get("operation","create")
    if operation not in ("create","complete"):
        raise ValueError("Invalid operation")
    return dict(title=title,mode=mode,at=date.isoformat(),notes=notes,key=key,operation=operation)

def applescript(source,*args):
    return subprocess.run(["/usr/bin/osascript","-"]+list(args),input=source,
                          text=True,capture_output=True,check=True,timeout=40).stdout.strip()

def existing(marker):
    return applescript(LOOKUP,marker) or None

def create(p):
    marker="[TaskFlow event:"+p["key"]+"]"
    found=existing(marker)
    if p.get("operation")=="complete":
        if found:
            applescript(COMPLETE,found)
        return dict(id=found,completed=True)
    if found:
        return dict(id=found,mode=p["mode"],duplicate=True)
    notes=p["notes"]+"\n"+marker
    when=datetime.datetime.fromisoformat(p["at"])
    delay=max(5,when.timestamp()-time.time())
    if p["mode"]=="normal":
        rid=applescript(NORMAL,p["title"],notes,str(delay))
    else:
        # The saved native Shortcuts action has Urgent enabled. Its VTODO
        # output contains the new reminder UUID; rename only that reminder.
        with tempfile.TemporaryDirectory(prefix="taskflow-reminder-") as d:
            source=Path(d)/"date.txt"
            source.write_text(when.isoformat())
            result=subprocess.run(["/usr/bin/shortcuts","run","GeoPhotoMarks Urgent Failure",
                                   "--input-path",str(source)],capture_output=True,text=True,
                                  check=True,timeout=45)
        import re
        match=re.search(r"(?m)^UID:([A-Fa-f0-9-]{36})\r?$",result.stdout)
        if not match:
            raise RuntimeError("Shortcuts returned no reminder UID; inspect Reminders before retry")
        rid="x-apple-reminder://"+match.group(1)
        rid=applescript(RENAME,rid,p["title"],notes)
    return dict(id=rid,mode=p["mode"],at=p["at"],duplicate=False)

def main():
    p=validate(json.loads(sys.stdin.read(20000)))
    state=Path.home()/".local/state/taskflow-apple-reminders"
    state.mkdir(parents=True,exist_ok=True)
    with (state/"receiver.lock").open("w") as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        print(json.dumps(create(p),ensure_ascii=False))
if __name__=="__main__":
    main()
